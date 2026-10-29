(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.ShortsExportInspector=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX_BYTES=64*1048576,MAX_NODES=200000,MAX_SAMPLES=1000000;
 const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
 function inspectBytes(input){
  const b=input instanceof Uint8Array?input:new Uint8Array(input),v=new DataView(b.buffer,b.byteOffset,b.byteLength);let nodes=0;
  if(!b.length||b.length>MAX_BYTES)fail('OUTPUT_BUDGET','Записанный файл пуст или превышает 64 МиБ.');
  const check=(at,size,end=b.length)=>{if(!Number.isSafeInteger(at)||!Number.isSafeInteger(size)||size<0||at<0||at+size>end)fail('CONTAINER','Записанный контейнер обрезан или содержит неверные размеры.');};
  const u16=p=>{check(p,2);return v.getUint16(p);},u32=p=>{check(p,4);return v.getUint32(p);};
  const u64=p=>{check(p,8);const n=v.getUint32(p)*4294967296+v.getUint32(p+4);if(!Number.isSafeInteger(n))fail('CONTAINER','Слишком большое значение в контейнере.');return n;};
  const text=(p,n)=>{check(p,n);return String.fromCharCode(...b.subarray(p,p+n));};
  const tick=()=>{if(++nodes>MAX_NODES)fail('CONTAINER','Превышен рабочий предел структуры контейнера.');};
  function mp4(){
   function boxes(start,end){const result=[];for(let p=start;p<end;){tick();check(p,8,end);let size=u32(p),head=8;if(size===1){check(p,16,end);size=u64(p+8);head=16;}else if(size===0)size=end-p;if(size<head)fail('CONTAINER','Неверный MP4 box.');check(p,size,end);result.push({type:text(p+4,4),start:p,data:p+head,end:p+size,size});p+=size;}return result;}
   const children=box=>boxes(box.data,box.end),find=(list,type,required=true)=>{const a=list.filter(x=>x.type===type);if(a.length>1||required&&!a.length)fail('CONTAINER','Некорректная структура MP4: '+type);return a[0];};
   const table=(box,stride,offset=8)=>{check(box.data,offset,box.end);const n=u32(box.data+4);if(n>MAX_SAMPLES)fail('CONTAINER','Слишком большая таблица MP4.');check(box.data+offset,n*stride,box.end);return Array.from({length:n},(_,i)=>box.data+offset+i*stride);};
   const top=boxes(0,b.length),ftyp=find(top,'ftyp'),moov=find(top,'moov'),mdats=top.filter(x=>x.type==='mdat');
   if(ftyp.size<16||!mdats.length||(ftyp.end-ftyp.data)%4)fail('CONTAINER','В MP4 отсутствуют заголовок или медиаданные.');
   const brands=[text(ftyp.data,4)];for(let p=ftyp.data+8;p<ftyp.end;p+=4)brands.push(text(p,4));if(!brands.some(brand=>['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','dash','cmfc','M4V '].includes(brand)))fail('CONTAINER','ISO BMFF не объявляет совместимость с MP4.');
   const inData=(p,n)=>mdats.some(m=>p>=m.data&&p+n<=m.end);
   const movie=children(moov),mvhd=find(movie,'mvhd');check(mvhd.data,32,mvhd.end);
   const movieScale=u32(mvhd.data+(b[mvhd.data]===1?20:12));if(!movieScale)fail('CONTAINER','Нет шкалы времени MP4.');
   const tracks=new Map(),defaults=new Map();
   const mvex=find(movie,'mvex',false);if(mvex)for(const x of children(mvex).filter(x=>x.type==='trex')){check(x.data,24,x.end);defaults.set(u32(x.data+4),{duration:u32(x.data+12),size:u32(x.data+16)});}
   function aac(esds){
    const descriptor=(p,end)=>{check(p,2,end);const tag=b[p++];let size=0,done=false;for(let i=0;i<4;i++){check(p,1,end);const byte=b[p++];size=size*128+(byte&127);if(!(byte&128)){done=true;break;}}if(!done)fail('CONTAINER','Неверный AAC descriptor.');check(p,size,end);return{tag,data:p,end:p+size};};
    check(esds.data,4,esds.end);let d=descriptor(esds.data+4,esds.end);if(d.tag!==3)fail('CODEC','В MP4 нет описания AAC.');check(d.data,3,d.end);const flags=b[d.data+2];let p=d.data+3;if(flags&128)p+=2;if(flags&64){check(p,1,d.end);p+=1+b[p];}if(flags&32)p+=2;
    d=descriptor(p,d.end);if(d.tag!==4||b[d.data]!==64)fail('CODEC','Аудиодорожка MP4 не является MPEG-4 AAC.');check(d.data,13,d.end);const asc=descriptor(d.data+13,d.end);if(asc.tag!==5)fail('CODEC','Отсутствует AudioSpecificConfig AAC.');check(asc.data,2,asc.end);
    if(b[asc.data]>>>3!==2)fail('CODEC','Для совместимого MP4 требуется AAC-LC.');
    const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350],rateIndex=((b[asc.data]&7)<<1)|(b[asc.data+1]>>>7),channels=(b[asc.data+1]>>>3)&15;
    if(rateIndex===15||!rates[rateIndex]||![1,2].includes(channels))fail('CODEC','Неподдерживаемая конфигурация AAC.');return{codec:'aac',profile:'AAC-LC',sampleRate:rates[rateIndex],channels};
   }
   for(const trak of movie.filter(x=>x.type==='trak')){
    const tc=children(trak),tkhd=find(tc,'tkhd'),mdia=children(find(tc,'mdia')),mdhd=find(mdia,'mdhd'),hdlr=find(mdia,'hdlr');check(tkhd.data,24,tkhd.end);check(mdhd.data,24,mdhd.end);check(hdlr.data,12,hdlr.end);
    const id=u32(tkhd.data+(b[tkhd.data]===1?20:12)),scale=u32(mdhd.data+(b[mdhd.data]===1?20:12)),handler=text(hdlr.data+8,4);
    if(!scale||tracks.has(id)||!['vide','soun'].includes(handler))fail('CONTAINER','Неподдерживаемая или повторная дорожка MP4.');
    const minf=children(find(mdia,'minf')),stbl=children(find(minf,'stbl')),stsd=find(stbl,'stsd');check(stsd.data,8,stsd.end);
    const entries=boxes(stsd.data+8,stsd.end);if(u32(stsd.data+4)!==1||entries.length!==1)fail('CODEC','Требуется одно описание кодека дорожки MP4.');
    const e=entries[0],t={id,kind:handler==='vide'?'video':'audio',scale,first:Infinity,end:0,count:0,bytes:0,codec:null};
    if(handler==='vide'){
     check(e.start,86,e.end);if(!['avc1','avc3'].includes(e.type))fail('CODEC','В MP4 требуется видео H.264; получен '+e.type+'.');
     const avcc=find(boxes(e.start+86,e.end),'avcC');check(avcc.data,7,avcc.end);if(b[avcc.data]!==1)fail('CODEC','Неверный AVC configuration.');
     let p=avcc.data+6;const sps=b[avcc.data+5]&31;if(!sps)fail('CODEC','Отсутствует SPS H.264.');for(let i=0;i<sps;i++){const n=u16(p);p+=2;check(p,n,avcc.end);if(n<4||(b[p]&31)!==7)fail('CODEC','Повреждён SPS H.264.');p+=n;}check(p,1,avcc.end);const pps=b[p++];if(!pps)fail('CODEC','Отсутствует PPS H.264.');for(let i=0;i<pps;i++){const n=u16(p);p+=2;check(p,n,avcc.end);if(!n||(b[p]&31)!==8)fail('CODEC','Повреждён PPS H.264.');p+=n;}
     Object.assign(t,{codec:'h264',width:u16(e.start+32),height:u16(e.start+34)});
    }else{
     check(e.start,36,e.end);if(e.type!=='mp4a')fail('CODEC','В MP4 требуется аудио AAC; получен '+e.type+'.');const version=u16(e.start+16),offset=version===0?36:version===1?52:0;if(!offset)fail('CODEC','Неподдерживаемое описание AAC.');Object.assign(t,aac(find(boxes(e.start+offset,e.end),'esds')));
    }
    tracks.set(id,t);
    const stsz=find(stbl,'stsz',false),stts=find(stbl,'stts',false),stsc=find(stbl,'stsc',false),co=find(stbl,'stco',false)||find(stbl,'co64',false);
    if(stsz&&stts){
     check(stsz.data,12,stsz.end);const fixed=u32(stsz.data+4),count=u32(stsz.data+8);if(count>MAX_SAMPLES)fail('CONTAINER','Слишком много MP4 samples.');if(!fixed)check(stsz.data+12,count*4,stsz.end);
     let duration=0,total=0;for(const p of table(stts,8)){const n=u32(p),d=u32(p+4);if(!n||!d)fail('CONTAINER','Нулевой интервал MP4.');total+=n;duration+=n*d;}if(total!==count)fail('CONTAINER','Таблицы длительности и кадров MP4 не совпадают.');
     if(count){if(!co||!stsc)fail('CONTAINER','Отсутствуют адреса медиаданных MP4.');const offsets=table(co,co.type==='co64'?8:4),mapping=table(stsc,12);let sample=0,group=0;if(!mapping.length||u32(mapping[0])!==1)fail('CONTAINER','Некорректная карта MP4 chunks.');
      for(let i=0;i<offsets.length;i++){while(group+1<mapping.length&&u32(mapping[group+1])<=i+1)group++;const n=u32(mapping[group]+4);if(!n||sample+n>count)fail('CONTAINER','Некорректное число MP4 samples.');let size=0;for(let j=0;j<n;j++)size+=fixed||u32(stsz.data+12+(sample++)*4);if(fixed)sample+=n;const at=co.type==='co64'?u64(offsets[i]):u32(offsets[i]);if(!size||!inData(at,size))fail('CONTAINER','Медиаданные MP4 обрезаны.');t.bytes+=size;}
      if(sample!==count)fail('CONTAINER','Часть кадров MP4 отсутствует.');t.count=count;t.first=0;t.end=duration/scale*1000;
     }
    }
   }
   function add(t,pts,duration,size,at){if(!duration||!size||!inData(at,size))fail('CONTAINER','Фрагмент MP4 не содержит полного sample.');t.first=Math.min(t.first,pts/t.scale*1000);t.end=Math.max(t.end,(pts+duration)/t.scale*1000);t.count++;t.bytes+=size;if(t.count>MAX_SAMPLES)fail('CONTAINER','Слишком много MP4 samples.');}
   for(const moof of top.filter(x=>x.type==='moof')){
    let implicit=moof.start;
    for(const traf of children(moof).filter(x=>x.type==='traf')){
     const list=children(traf),tfhd=find(list,'tfhd'),tfdt=find(list,'tfdt');check(tfhd.data,8,tfhd.end);const flags=u32(tfhd.data)&0xffffff,t=tracks.get(u32(tfhd.data+4));if(!t)fail('CONTAINER','Фрагмент неизвестной дорожки MP4.');
     let p=tfhd.data+8,base=flags&1?u64(p):flags&0x20000?moof.start:implicit;if(flags&1)p+=8;if(flags&2)p+=4;let duration=defaults.get(t.id)?.duration||0,size=defaults.get(t.id)?.size||0;if(flags&8){duration=u32(p);p+=4;}if(flags&16){size=u32(p);p+=4;}if(flags&32)p+=4;check(tfhd.data,p-tfhd.data,tfhd.end);
     check(tfdt.data,8,tfdt.end);let time=b[tfdt.data]===1?u64(tfdt.data+4):u32(tfdt.data+4),dataAt;
     for(const run of list.filter(x=>x.type==='trun')){
      check(run.data,8,run.end);const f=u32(run.data)&0xffffff,n=u32(run.data+4);if(n>MAX_SAMPLES)fail('CONTAINER','Слишком большой MP4 fragment.');let q=run.data+8;if(f&1){check(q,4,run.end);dataAt=base+v.getInt32(q);q+=4;}if(f&4)q+=4;dataAt??=base;
      for(let i=0;i<n;i++){tick();const d=f&256?u32(q):duration;if(f&256)q+=4;const z=f&512?u32(q):size;if(f&512)q+=4;if(f&1024)q+=4;let c=0;if(f&2048){check(q,4,run.end);c=b[run.data]===1?v.getInt32(q):u32(q);q+=4;}check(run.data,q-run.data,run.end);add(t,time+c,d,z,dataAt);dataAt+=z;time+=d;}
     }
     implicit=dataAt??base;
    }
   }
   return finish('mp4',[...tracks.values()]);
  }
  function webm(){
   const vint=(p,id=false)=>{check(p,1);let n=1,mask=128;while(n<=8&&!(b[p]&mask)){mask>>=1;n++;}if(n>8||id&&n>4)fail('CONTAINER','Некорректный EBML vint.');check(p,n);let value=id?b[p]:b[p]&(~mask),unknown=!id&&(b[p]&(~mask))===mask-1;for(let i=1;i<n;i++){value=value*256+b[p+i];unknown=unknown&&b[p+i]===255;}if(!unknown&&!Number.isSafeInteger(value))fail('CONTAINER','Переполнение EBML.');return{value,n,unknown};};
   function elements(start,end){const a=[];for(let p=start;p<end;){tick();const id=vint(p,true),size=vint(p+id.n),data=p+id.n+size.n;let stop=size.unknown?end:data+size.value;if(size.unknown&&id.value===0x1f43b675){let q=data;while(q<end){const child=vint(q,true);if([0x1f43b675,0x1c53bb6b,0x1549a966,0x1654ae6b,0x114d9b74,0x1254c367].includes(child.value))break;const length=vint(q+child.n);if(length.unknown)fail('CONTAINER','Неизвестный размер внутри WebM cluster.');const next=q+child.n+length.n+length.value;check(q,next-q,end);q=next;}stop=q;}if(size.unknown&&![0x18538067,0x1f43b675].includes(id.value))fail('CONTAINER','Неподдерживаемый неизвестный размер EBML.');check(data,stop-data,end);a.push({id:id.value,data,end:stop});p=stop;}return a;}
   const list=box=>elements(box.data,box.end),get=(a,id,required=false)=>{const found=a.filter(e=>e.id===id);if(found.length>1||required&&!found.length)fail('CONTAINER','Повторный или отсутствующий EBML элемент.');return found[0];};
   const integer=e=>{if(!e||e.end-e.data>8)fail('CONTAINER','Неверное целое EBML.');let n=0;for(let p=e.data;p<e.end;p++)n=n*256+b[p];if(!Number.isSafeInteger(n))fail('CONTAINER','Переполнение EBML integer.');return n;};
   const string=e=>text(e.data,e.end-e.data),top=elements(0,b.length),head=list(get(top,0x1a45dfa3,true));if(string(get(head,0x4282,true))!=='webm')fail('CONTAINER','Контейнер не является WebM.');
   const segment=list(get(top,0x18538067,true)),info=list(get(segment,0x1549a966,true)),scale=get(info,0x2ad7b1)?integer(get(info,0x2ad7b1)):1000000,tracks=new Map();if(!scale||scale>1000000000)fail('CONTAINER','Неверная шкала времени WebM.');
   for(const e of list(get(segment,0x1654ae6b,true)).filter(x=>x.id===0xae)){
    const a=list(e),id=integer(get(a,0xd7,true)),kind=integer(get(a,0x83,true)),codec=string(get(a,0x86,true)),t={id,kind:kind===1?'video':kind===2?'audio':'unknown',codec,first:Infinity,end:0,count:0,bytes:0,defaultDuration:get(a,0x23e383)?integer(get(a,0x23e383))/1000000:1000/24};
    if(tracks.has(id))fail('CONTAINER','Повторный номер WebM track.');
    if(kind===1){const video=list(get(a,0xe0,true));Object.assign(t,{width:integer(get(video,0xb0,true)),height:integer(get(video,0xba,true)),codec:{V_VP8:'vp8',V_VP9:'vp9'}[codec]});if(!t.codec)fail('CODEC','Неподдерживаемый видеокодек WebM.');}
    else if(kind===2){if(codec!=='A_OPUS')fail('CODEC','Требуется Opus в WebM.');t.codec='opus';const audio=list(get(a,0xe1,true));t.channels=get(audio,0x9f)?integer(get(audio,0x9f)):1;t.sampleRate=48000;const privateData=get(a,0x63a2,true);check(privateData.data,19,privateData.end);if(text(privateData.data,8)!=='OpusHead'||b[privateData.data+8]!==1||b[privateData.data+9]!==t.channels||![1,2].includes(t.channels)||b[privateData.data+18]!==0)fail('CODEC','Неверное описание Opus.');}
    else fail('CODEC','Неподдерживаемая дорожка WebM.');tracks.set(id,t);
   }
   function block(e,clusterTime,blockDuration){
    const track=vint(e.data),t=tracks.get(track.value);if(!t)fail('CONTAINER','WebM block ссылается на неизвестную дорожку.');let p=e.data+track.n;check(p,3,e.end);const time=(clusterTime+v.getInt16(p))*scale/1000000,flags=b[p+2];p+=3;
    const lacing=(flags&6)>>1,sizes=[];if(!lacing)sizes.push(e.end-p);else{
     check(p,1,e.end);const n=b[p++]+1;let total=0;
     if(lacing===2){if((e.end-p)%n)fail('CONTAINER','Неверный fixed lace.');for(let i=0;i<n;i++)sizes.push((e.end-p)/n);}
     else{for(let i=0;i<n-1;i++){let size=0;if(lacing===1){let value;do{check(p,1,e.end);value=b[p++];size+=value;}while(value===255);}else{const x=vint(p);p+=x.n;size=i?sizes[i-1]+x.value-(2**(7*x.n-1)-1):x.value;}if(size<1)fail('CONTAINER','Неверный размер lace.');sizes.push(size);total+=size;}sizes.push(e.end-p-total);}
    }
    let at=time;for(const size of sizes){tick();check(p,size,e.end);if(!size)fail('CONTAINER','Пустой WebM packet.');let duration=blockDuration?blockDuration/sizes.length:t.defaultDuration;
     if(t.codec==='opus'){const toc=b[p],config=toc>>>3,frames=(toc&3)===0?1:(toc&3)===3?(size>1?b[p+1]&63:0):2;const samples=config>=16?120*(2**(config&3)):config>=12?480*(2**(config&1)):(config&3)===3?2880:480*(2**(config&3));if(!frames||frames*samples>5760)fail('CONTAINER','Неверный Opus packet.');duration=frames*samples/48;}
     t.first=Math.min(t.first,at);t.end=Math.max(t.end,at+duration);t.count++;t.bytes+=size;if(t.count>MAX_SAMPLES)fail('CONTAINER','Слишком много WebM packets.');p+=size;at+=duration;
    }if(p!==e.end)fail('CONTAINER','Неверные размеры WebM lacing.');
   }
   for(const c of segment.filter(e=>e.id===0x1f43b675)){
    const a=list(c),time=integer(get(a,0xe7,true));for(const e of a){if(e.id===0xa3)block(e,time);else if(e.id===0xa0){const group=list(e),d=get(group,0x9b);block(get(group,0xa1,true),time,d?integer(d)*scale/1000000:0);}}
   }
   return finish('webm',[...tracks.values()]);
  }
  function finish(container,tracks){
   const video=tracks.filter(t=>t.kind==='video'),audio=tracks.filter(t=>t.kind==='audio');if(video.length!==1||audio.length>1)fail('CONTAINER','Требуется одна видеодорожка и не больше одной смешанной аудиодорожки.');
   for(const t of tracks)if(!t.count||!t.bytes||!Number.isFinite(t.first)||t.end<=t.first)fail('INCOMPLETE','В файле нет полного медиапотока.');
   const clean=t=>{const {scale,defaultDuration,...result}=t;return result;};
   return Object.freeze({container,extension:container,bytes:b.length,video:Object.freeze(clean(video[0])),audio:audio[0]?Object.freeze(clean(audio[0])):null,durationMs:video[0].end-video[0].first});
  }
  if(b.length>=4&&u32(0)===0x1a45dfa3)return webm();
  if(b.length>=8&&text(4,4)==='ftyp')return mp4();
  fail('CONTAINER','Записанные байты не являются поддерживаемым MP4 или WebM.');
 }
 function assertExpected(info,{durationMs,width=720,height=1280,fps=24,hasAudio}={}){
  if(!Number.isSafeInteger(durationMs)||durationMs<=0||width!==720||height!==1280||fps!==24||typeof hasAudio!=='boolean')fail('SETTINGS','Неверные ожидаемые параметры записанного файла.');
  const tolerance=Math.min(250,Math.max(2000/fps,durationMs*.05));
  if(info.video.width!==width||info.video.height!==height)fail('OUTPUT_DIMENSIONS','Фактическое разрешение видео не совпадает с 720×1280.');
  if(Boolean(info.audio)!==hasAudio)fail('OUTPUT_AUDIO','Количество звуковых дорожек не соответствует проекту.');
  for(const t of [info.video,...(info.audio?[info.audio]:[])])if(Math.abs(t.end-t.first-durationMs)>tolerance||t.first>tolerance||t.count<(t.kind==='video'?Math.max(2,Math.floor(durationMs/1000*4)):2))fail('INCOMPLETE','Записанный медиапоток неполный или его длительность не соответствует плану.');
  return info;
 }
 async function inspect(blob,expected,{signal}={}){
  signal?.throwIfAborted();if(!(blob instanceof Blob)||blob.size>MAX_BYTES)fail('OUTPUT_BUDGET','Видео превышает предел 64 МиБ.');
  const bytes=new Uint8Array(await blob.arrayBuffer());signal?.throwIfAborted();return assertExpected(inspectBytes(bytes),expected);
 }
 async function playback(blob,info,expected,{signal,timeoutMs=10000}={}){
  signal?.throwIfAborted();const video=document.createElement('video'),url=URL.createObjectURL(blob);video.muted=true;video.playsInline=true;video.preload='auto';video.setAttribute('aria-hidden','true');video.style='position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none';document.body.append(video);
  try{
   return await new Promise((resolve,reject)=>{
    let finished=false;const events=['loadedmetadata','durationchange','loadeddata','error'];
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const name of events)video.removeEventListener(name,check);error?reject(error):resolve(value);};
    const abort=()=>finish(signal.reason||new DOMException('Проверка отменена.','AbortError'));
    const check=()=>{if(video.error){finish(Object.assign(new Error('Браузер не декодирует записанный файл.'),{code:'OUTPUT_DECODE'}));return;}
     if(video.readyState<2||!Number.isFinite(video.duration)||video.duration<=0)return;
     const tolerance=Math.min(250,Math.max(2000/expected.fps,expected.durationMs*.05));
     if(video.videoWidth!==expected.width||video.videoHeight!==expected.height||Math.abs(video.duration*1000-expected.durationMs)>tolerance){finish(Object.assign(new Error('Метаданные воспроизводимого файла не совпадают с планом.'),{code:'INCOMPLETE'}));return;}
     finish(null,Object.freeze({width:video.videoWidth,height:video.videoHeight,durationMs:video.duration*1000}));
    };
    const timer=setTimeout(()=>finish(Object.assign(new Error('Браузер не подтвердил готовность записанного файла.'),{code:'OUTPUT_DECODE'})),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});for(const name of events)video.addEventListener(name,check);if(signal?.aborted){abort();return;}video.src=url;video.load();check();
   });
  }finally{video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
 }
 return Object.freeze({inspect,inspectBytes,assertExpected,playback,MAX_BYTES});
});
