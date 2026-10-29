(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsAudioWindow=factory({context:rate=>{const Offline=root.OfflineAudioContext||root.webkitOfflineAudioContext;if(!Offline)throw Error('OfflineAudioContext недоступен.');return new Offline(1,1,rate);},hash:async bytes=>Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')});
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 const fail=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
 // Layer III frame headers bound sample count BEFORE native allocation. This
 // is not partial decoding: decodeAudioData still decodes the entire MP3.
 function inspect(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);let p=0,samples=0,rate=0,channels=0,frames=0;
  if(b[0]===73&&b[1]===68&&b[2]===51){
   if(b.length<10||[6,7,8,9].some(i=>b[i]&128))throw fail('AUDIO_HEADER','Повреждён размер ID3 MP3.');
   p=10+((b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9])+((b[5]&16)?10:0);if(p>b.length)throw fail('AUDIO_HEADER','Неполный ID3 MP3.');
  }
  while(p<b.length){
   if(b.length-p===128&&b[p]===84&&b[p+1]===65&&b[p+2]===71)break;
   if(b[p]===0&&b.subarray(p).every(x=>x===0))break;
   if(p+4>b.length||b[p]!==255||(b[p+1]&224)!==224)throw fail('AUDIO_HEADER','Повреждены кадры MP3 или неподдерживаемые хвостовые метаданные.');
   const version=(b[p+1]>>3)&3,layer=(b[p+1]>>1)&3,index=b[p+2]>>4,ri=(b[p+2]>>2)&3;
   if(version===1||layer!==1||index===0||index===15||ri===3)throw fail('AUDIO_CODEC','Для ограниченной подготовки поддерживается MP3 Layer III с указанным битрейтом.');
   const sr=[44100,48000,32000][ri]/(version===3?1:version===2?2:4),ch=(b[p+3]>>6)===3?1:2;
   if(rate&&rate!==sr)throw fail('AUDIO_CODEC','Смена частоты дискретизации внутри MP3 пока не поддерживается.');
   rate=sr;channels=Math.max(channels,ch);
   const kbps=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index];
   const length=Math.floor((version===3?144:72)*kbps*1000/sr)+((b[p+2]>>1)&1);
   if(p+length>b.length)throw fail('AUDIO_HEADER','Неполный кадр MP3.');
   samples+=version===3?1152:576;frames++;p+=length;
  }
  if(!frames||!Number.isSafeInteger(samples))throw fail('AUDIO_HEADER','В MP3 нет проверяемых аудиокадров.');
  if(samples/rate>600+2304/rate)throw fail('AUDIO_DURATION','Длительность аудиодорожки превышает 600 секунд.');
  return {samples,sampleRate:rate,channels,frames,fullPcmBytes:samples*channels*4};
 }
 async function probe(blob){
  const head=new Uint8Array(await blob.slice(0,3).arrayBuffer());
  if(!(head[0]===73&&head[1]===68&&head[2]===51)&&!(head[0]===255&&(head[1]&224)===224&&(head[1]&6)===2))return null;
  if(blob.size>25*1048576)throw fail('FILE_SIZE','Аудио превышает 25 МиБ.');
  const bytes=await blob.arrayBuffer(),info=inspect(bytes);return {...info,bytes,hash:await io.hash(bytes)};
 }
 async function decode(info,durationMs){
  if(!Number.isSafeInteger(durationMs)||durationMs<0)throw fail('OFFSET','Некорректная длительность окна аудио.');
  const context=io.context(info.sampleRate);let full;
  try{full=await context.decodeAudioData(info.bytes);}
  catch(e){throw fail('AUDIO_DECODE','Не удалось декодировать MP3: повреждённый файл или неподдерживаемый кодек.');}
  try{
   if(!Number.isFinite(full.duration)||full.duration<=0||full.duration>600)throw fail('AUDIO_DURATION','Длительность аудиодорожки должна быть от доли секунды до 600 секунд.');
   if(!Number.isSafeInteger(full.length)||full.length<=0||full.sampleRate!==info.sampleRate||full.numberOfChannels>info.channels||full.numberOfChannels<1||full.length>info.samples)throw fail('AUDIO_PCM','Декодированный MP3 не соответствует проверенному числу сэмплов и каналов.');
   const length=Math.min(full.length,Math.max(1,Math.ceil(durationMs*full.sampleRate/1000)));
   let buffer=full;
   if(length<full.length){buffer=context.createBuffer(full.numberOfChannels,length,full.sampleRate);for(let c=0;c<full.numberOfChannels;c++)buffer.copyToChannel(full.getChannelData(c).subarray(0,length),c);}
   return {buffer,info:{sampleRate:full.sampleRate,channels:full.numberOfChannels,durationSeconds:full.duration,fullFrames:full.length,fullPcmBytes:full.length*full.numberOfChannels*4,retainedFrames:length,retainedPcmBytes:length*full.numberOfChannels*4}};
  }finally{full=null;}
 }
 return Object.freeze({inspect,probe,decode});
});
