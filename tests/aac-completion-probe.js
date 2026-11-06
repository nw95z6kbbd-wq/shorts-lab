/* Isolated experiment; no app imports, storage, guessed encoder delay or fix. */
(function(root) {
 'use strict';
 const N=144000,RATE=48000,CONFIG={codec:'mp4a.40.2',sampleRate:RATE,numberOfChannels:2,bitrate:128000};
 const VARIANTS=Object.freeze([
  {id:'partial',full:false,zeros:0,finish:'once'},
  {id:'full',full:true,zeros:0,finish:'once'},
  {id:'full-zero-1',full:true,zeros:1,finish:'once'},
  {id:'full-zero-2',full:true,zeros:2,finish:'once'},
  {id:'full-zero-3',full:true,zeros:3,finish:'once'},
  {id:'partial-task',full:false,zeros:0,finish:'task'},
  {id:'partial-double-flush',full:false,zeros:0,finish:'double'},
  {id:'full-zero-2-double-flush',full:true,zeros:2,finish:'double'},
  {id:'partial-flush-then-drain',full:true,zeros:2,finish:'staged'}
 ]);
 const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
 function sourceControl() {
  const s=root.SafariAACProbe.stimulus(144337);
  return {pcm:s.pcm.slice(0,N*2),markers:s.markers.map(m=>({...m,frames:Math.min(m.frames,N-m.start)}))};
 }
 function initialize(raw) {
  if(raw.byteLength!==N*8)throw Error('Unexpected source size');
  const view=new DataView(raw),pcm=new Float32Array(N*2);
  for(let i=0;i<pcm.length;i++){pcm[i]=view.getFloat32(i*4,true);if(!Number.isFinite(pcm[i]))throw Error('Non-finite PCM');}
  sources={original:{pcm,markers:[]},control:sourceControl()};
 }
 let sources;
 async function run(sourceId,id) {
  if(!sources||!sources[sourceId])throw Error('Unloaded synthetic source');
  const v=VARIANTS.find(v=>v.id===id);if(!v)throw Error('Unknown variant');
  const result={schema:1,sourceId,variant:{...v},config:{...CONFIG},sourceFrames:N,inputs:[],chunks:[],events:[],error:null};
  let encoder,phase='configure',failed,bytes=0,descriptionBytes=0,created=0,closed=0;
  const start=performance.now(),deadline=start+25000;
  const event=name=>result.events.push({name,phase,ms:performance.now()-start,packets:result.chunks.length});
  let rejectFailure;const failure=new Promise((_,reject)=>{rejectFailure=reject;});failure.catch(()=>{});
  async function wait(promise) {
   let timer;try{return await Promise.race([promise,failure,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Experiment deadline')),Math.max(1,deadline-performance.now()));})]);}
   finally{clearTimeout(timer);}
  }
  async function feed(from,end) {
   for(let offset=from;offset<end;){
    if(failed)throw failed;
    while(encoder.encodeQueueSize>=2){let done;const pending=new Promise(resolve=>{done=resolve;encoder.addEventListener('dequeue',done,{once:true});if(encoder.encodeQueueSize<2)done();});try{await wait(pending);}finally{encoder.removeEventListener('dequeue',done);}}
    const n=Math.min(1024-(offset%1024),end-offset),data=new Float32Array(n*2),copied=Math.max(0,Math.min(n,N-offset));
    for(let c=0;c<2;c++)for(let i=0;i<copied;i++)data[c*n+i]=sources[sourceId].pcm[(offset+i)*2+c];
    const timestamp=Math.round(offset/RATE*1e6),frame=new AudioData({format:'f32-planar',sampleRate:RATE,numberOfChannels:2,numberOfFrames:n,timestamp,data});created++;
    result.inputs.push({timestamp:frame.timestamp,requestedTimestamp:timestamp,duration:frame.duration??null,
      sampleRate:frame.sampleRate,numberOfChannels:frame.numberOfChannels,offset,frames:frame.numberOfFrames,
      sourceFrames:copied,zeroFrames:n-copied,phase});
    try{encoder.encode(frame);}finally{frame.close();closed++;}
    offset+=n;
   }
  }
  async function flush(name) {phase=name;event('flush-called');await wait(encoder.flush());event('flush-resolved');}
  try {
   if(typeof AudioEncoder!=='function'||!(await wait(AudioEncoder.isConfigSupported(CONFIG))).supported)throw Error('AAC encoder unavailable');
   encoder=new AudioEncoder({output(chunk,metadata){try{
    descriptionBytes+=metadata?.decoderConfig?.description?.byteLength||0;
    if(result.chunks.length>=512||(bytes+=chunk.byteLength)>2*1048576||descriptionBytes>2*1048576||metadata?.decoderConfig?.description?.byteLength>65536)throw Error('Output budget');
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
    result.chunks.push({timestamp:chunk.timestamp,duration:chunk.duration??null,durationPresent:chunk.duration!=null,type:chunk.type,
     phase,ms:performance.now()-start,dataBase64:bytes64(data),metadata:root.SafariAACProbe.metadataRecord(metadata)});
   }catch(e){failed=e;rejectFailure(e);}},error(e){failed=e;rejectFailure(e);}});
   encoder.configure(CONFIG);phase='feed-source';
   const end=(v.full?Math.ceil(N/1024)*1024:N)+v.zeros*1024;
   if(v.finish==='staged'){await feed(0,N);await flush('flush-before-drain');phase='feed-drain';await feed(N,end);}
   else await feed(0,end);
   await flush('flush-final');
   if(v.finish==='task'||v.finish==='double'){phase='after-flush-task';await pause();event('task-complete');}
   if(v.finish==='double')await flush('flush-repeat');
   if(failed)throw failed;
  }catch(e){result.error={type:e.name,phase};}
  finally{
   phase='close';event('close-called');if(encoder&&encoder.state!=='closed')encoder.close();
   phase='after-close-task';await pause();event('after-close-task');
   if(failed&&!result.error)result.error={type:failed.name,phase};
   result.resources={created,closed,encoderClosed:!encoder||encoder.state==='closed'};
  }
  return result;
 }
 function bytes64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
 const api={N,RATE,CONFIG,VARIANTS,initialize,run,sourceControl};
 if(typeof module==='object')module.exports=api;else root.AACCompletionExperiment=api;
})(globalThis);
