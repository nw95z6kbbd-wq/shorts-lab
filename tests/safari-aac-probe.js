/* Synthetic, test-only WebCodecs probe. Does not load the application or storage. */
(function(root){
 'use strict';
 const RATE=48000,CONFIG=Object.freeze({codec:'mp4a.40.2',sampleRate:RATE,numberOfChannels:2,bitrate:128000});
 const LENGTHS=Object.freeze([1023,1024,1025,2048,48000,144337]);
 function stimulus(frames){
  if(!LENGTHS.includes(frames))throw Error('Unapproved synthetic length');
  const width=Math.min(1024,Math.floor(frames/6)),margin=Math.min(240,Math.floor(frames/20));
  const markers=[margin,Math.floor((frames-width)/2),frames-margin-width].map((start,i)=>({name:['start','middle','end'][i],start,frames:width}));
  const pcm=new Float32Array(frames*2);let state=0x74a51d32,left=0,right=0;
  for(let i=0;i<frames;i++){
   const noise=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2147483648-1;};
   left=.6*left+.4*noise();right=.6*right+.4*noise();
   const marker=markers.find(m=>i>=m.start&&i<m.start+m.frames);
   const window=marker?Math.sin(Math.PI*(i-marker.start+.5)/marker.frames)**2:0;
   const gain=.025+.75*window;pcm[i*2]=left*gain;pcm[i*2+1]=right*gain;
  }
  return{pcm,markers};
 }
 function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
 function bytes(value){return ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice():new Uint8Array(value).slice();}
 function pcm64(pcm){const out=new Uint8Array(pcm.length*4),view=new DataView(out.buffer);pcm.forEach((v,i)=>view.setFloat32(i*4,v,true));return base64(out);}
 // Parse the descriptor tree, not a byte-pattern search. No priming inference.
 function ascFromDescription(raw){
  if(raw.length<2||raw.length>65536)throw Error('Description size');
  raw=Uint8Array.from(raw);
  if(raw[0]!==3)return raw.slice();
  function descriptor(at,end){let tag=raw[at++],length=0,done=false;for(let i=0;i<4;i++){if(at>=end)throw Error('Descriptor bounds');const b=raw[at++];length=length*128+(b&127);if(!(b&128)){done=true;break;}}if(!done||at+length>end)throw Error('Descriptor length');return{tag,start:at,end:at+length};}
  const es=descriptor(0,raw.length);if(es.tag!==3||es.end!==raw.length||es.start+3>es.end)throw Error('ES descriptor');
  const flags=raw[es.start+2];let at=es.start+3;if(flags&128)at+=2;if(flags&64){if(at>=es.end)throw Error('URL bounds');at+=1+raw[at];}if(flags&32)at+=2;
  const dc=descriptor(at,es.end);if(dc.tag!==4||dc.start+13>dc.end||raw[dc.start]!==64||(raw[dc.start+1]>>>2)!==5)throw Error('Decoder descriptor');
  const asc=descriptor(dc.start+13,dc.end);if(asc.tag!==5||asc.end!==dc.end||asc.end-asc.start<2)throw Error('ASC descriptor');
  if(dc.end<es.end){const sl=descriptor(dc.end,es.end);if(sl.tag!==6||sl.end!==es.end)throw Error('SL descriptor');}
  return raw.slice(asc.start,asc.end);
 }
 function delayFields(value){
  const fields={};for(const key of Object.keys(value||{}).slice(0,64))if(/delay|priming|padding|preskip|leadingframes|trailingframes/i.test(key)){
   const v=value[key];fields[key.slice(0,80)]=typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'?v:{type:typeof v};
  }return fields;
 }
 function metadataRecord(metadata={}){
  const dc=metadata.decoderConfig,record={keys:Object.keys(metadata).slice(0,64),delayFields:delayFields(metadata)};
  if(dc){record.decoderConfig={keys:Object.keys(dc).slice(0,64),codec:dc.codec,sampleRate:dc.sampleRate,numberOfChannels:dc.numberOfChannels,delayFields:delayFields(dc)};
   if(dc.description){const raw=bytes(dc.description);record.decoderConfig.descriptionBase64=base64(raw);record.decoderConfig.descriptionKind=raw[0]===3?'ES_Descriptor':'AudioSpecificConfig';
    try{record.decoderConfig.ascBase64=base64(ascFromDescription(raw));}catch(e){record.decoderConfig.ascError=e.name;}
   }
  }return record;
 }
 async function decode(chunks,config){
  const result={frames:[],error:null},pieces=[];let samples=0,failed;
  const decoder=new AudioDecoder({output(frame){try{if(frame.sampleRate!==RATE||frame.numberOfChannels!==2||samples+frame.numberOfFrames>200000)throw Error('Decoded budget/config');
   const out=new Float32Array(frame.numberOfFrames*2);for(let c=0;c<2;c++){const plane=new Float32Array(frame.numberOfFrames);frame.copyTo(plane,{planeIndex:c,format:'f32-planar'});plane.forEach((v,i)=>out[i*2+c]=v);}
   result.frames.push({timestamp:frame.timestamp,duration:frame.duration,numberOfFrames:frame.numberOfFrames,sampleRate:frame.sampleRate,numberOfChannels:frame.numberOfChannels});pieces.push(out);samples+=frame.numberOfFrames;
  }catch(e){failed=e;}finally{frame.close();}},error(e){failed=e;}});
  try{decoder.configure(config);for(const chunk of chunks){decoder.decode(new EncodedAudioChunk(chunk));if(failed)throw failed;}await decoder.flush();if(failed)throw failed;
   const pcm=new Float32Array(samples*2);let at=0;for(const piece of pieces){pcm.set(piece,at);at+=piece.length;}result.pcmBase64=pcm64(pcm);
  }catch(e){result.error=e.name;}finally{if(decoder.state!=='closed')decoder.close();}return result;
 }
 async function capture(frames,repeat){
  const {pcm,markers}=stimulus(frames),result={schema:1,frames,repeat,config:{...CONFIG},apis:{AudioEncoder:typeof AudioEncoder,AudioDecoder:typeof AudioDecoder,AudioData:typeof AudioData,EncodedAudioChunk:typeof EncodedAudioChunk},stage:'support',markers,inputPCMBase64:pcm64(pcm),inputs:[],chunks:[],decodes:{},error:null};
  let failed,total=0;const native=[];let encoder;
  try{
   if(typeof AudioEncoder!=='function'||typeof AudioDecoder!=='function')throw new Error('WebCodecs unavailable');
   result.supported=(await AudioEncoder.isConfigSupported(CONFIG)).supported;if(!result.supported)throw new Error('AAC unavailable');
   result.stage='encode';encoder=new AudioEncoder({output(chunk,metadata){try{if(native.length>=512||(total+=chunk.byteLength)>2*1048576)throw Error('Encoded budget');
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);const item={timestamp:chunk.timestamp,type:chunk.type,data};if(chunk.duration!=null)item.duration=chunk.duration;native.push(item);
    result.chunks.push({timestamp:chunk.timestamp,duration:chunk.duration??null,type:chunk.type,dataBase64:base64(data),metadata:metadataRecord(metadata)});
   }catch(e){failed=e;}},error(e){failed=e;}});encoder.configure(CONFIG);
   for(let offset=0;offset<frames;offset+=1024){if(failed)throw failed;const n=Math.min(1024,frames-offset),data=new Float32Array(n*2);for(let c=0;c<2;c++)for(let i=0;i<n;i++)data[c*n+i]=pcm[(offset+i)*2+c];
    const timestamp=Math.round(offset/RATE*1e6),frame=new AudioData({format:'f32-planar',sampleRate:RATE,numberOfChannels:2,numberOfFrames:n,timestamp,data});result.inputs.push({offset,numberOfFrames:n,timestamp});try{encoder.encode(frame);}finally{frame.close();}
   }await encoder.flush();if(failed)throw failed;encoder.close();encoder=null;
   result.stage='configuration';const descriptions=result.chunks.map(c=>c.metadata.decoderConfig).filter(Boolean),dc=descriptions.find(c=>c.descriptionBase64);if(!dc||!native.length)throw Error('No decoder configuration/chunks');
   const raw=Uint8Array.from(atob(dc.descriptionBase64),c=>c.charCodeAt(0)),asc=ascFromDescription(raw);
   result.stage='decode';const actual={codec:dc.codec,sampleRate:dc.sampleRate,numberOfChannels:dc.numberOfChannels};
   result.decodes.asReported=await decode(native,{...actual,description:raw});
   result.decodes.normalizedASC=await decode(native,{...actual,description:asc});result.stage='complete';
  }catch(e){result.error=e.name;}finally{if(encoder&&encoder.state!=='closed')encoder.close();}
  return result;
 }
 const api={RATE,CONFIG,LENGTHS,stimulus,ascFromDescription,metadataRecord,capture,pcm64};
 if(typeof module==='object')module.exports=api;else root.SafariAACProbe=api;
})(globalThis);
