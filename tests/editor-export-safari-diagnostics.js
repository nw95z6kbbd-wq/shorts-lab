/* Failure-only native diagnosis; never used to rescue an export assertion. */
window.installEditorExportTrace=function(){
 const Native=window.MediaRecorder,Original=ShortsVideoRecorder.record,trace=window.editorExportTrace={recorders:[],contexts:[],progress:[]};
 const Tracked=new Proxy(Native,{get:(target,key)=>key==='isTypeSupported'?target.isTypeSupported.bind(target):Reflect.get(target,key),construct:(target,args)=>{
  const r=Reflect.construct(target,args),item={requested:args[1],actual:r.mimeType,tracks:args[0].getTracks().map(t=>({kind:t.kind,readyState:t.readyState,muted:t.muted,...t.getSettings()})),events:[]};trace.recorders.push(item);
  for(const name of ['start','dataavailable','pause','stop','error'])r.addEventListener(name,e=>{item.events.push({name,type:e.data?.type,size:e.data?.size,error:e.error?.message,state:r.state,contexts:trace.contexts.map(c=>({rate:c.sampleRate,time:c.currentTime,state:c.state}))});});return r;
 }});window.MediaRecorder=Tracked;
 ShortsVideoRecorder.record=options=>{
  const policy=options.recordingPolicy?Object.freeze({...options.recordingPolicy,onContext:c=>{trace.contexts.push(c);options.recordingPolicy.onContext?.(c);}}):null;
  return Original({...options,recordingPolicy:policy,onProgress:(fraction,ms)=>{trace.progress.push(ms);options.onProgress?.(fraction,ms);}});
 };
 return()=>{if(window.MediaRecorder===Tracked)window.MediaRecorder=Native;ShortsVideoRecorder.record=Original;};
};
window.setupEditorExportMatrix=function(){
 const button=document.createElement('button');button.id='exportMatrix';button.textContent='Codec diagnostics';button.style='position:fixed;top:0;left:0;z-index:25000';document.body.append(button);
 window.exportMatrixRows=[];
 button.onclick=()=>{window.exportMatrixPromise=(async()=>{
  const config=window.exportMatrixConfig,Audio=window.AudioContext||window.webkitAudioContext,context=new Audio(config.rate?{sampleRate:config.rate}:undefined),canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.style='position:fixed;bottom:0;left:0;width:90px;height:160px;z-index:24000';document.body.append(canvas);
  let stream,osc,mix,recorder,frame,timer;const events=[],chunks=[],row={config,supported:MediaRecorder.isTypeSupported(config.type)};
  try{
   const ctx=canvas.getContext('2d',{alpha:!config.opaque});ctx.fillRect(0,0,720,1280);let video;if(config.captureFirst)video=canvas.captureStream(24);await context.resume();const destination=context.createMediaStreamDestination();
   if(config.mixer){const voice=context.createBuffer(1,32000,16000),music=context.createBuffer(1,32000,16000);for(let i=0;i<32000;i++){voice.getChannelData(0)[i]=.08*Math.sin(2*Math.PI*440*i/16000);music.getChannelData(0)[i]=.08*Math.sin(2*Math.PI*880*i/16000);}mix=ShortsVideoAudio.connectMix(context,{voiceBuffer:voice,musicBuffer:music,voiceVolume:.65,musicVolume:.45,fadeIn:.3,fadeOut:.4,durationSeconds:1.2,destination,monitor:!!config.monitor});if(!config.lateAudio)mix.start(context.currentTime+.02);}
   else{osc=context.createOscillator();const gain=context.createGain();gain.gain.value=.01;osc.connect(gain);gain.connect(destination);if(!config.lateAudio)osc.start();}
   video||=canvas.captureStream(24);stream=config.fresh?new MediaStream([...video.getVideoTracks(),...destination.stream.getAudioTracks()]):video;if(!config.fresh)destination.stream.getAudioTracks().forEach(t=>stream.addTrack(t));
   Object.assign(row,{rate:context.sampleRate,tracks:stream.getTracks().map(t=>({kind:t.kind,...t.getSettings()}))});
   recorder=new MediaRecorder(stream,{mimeType:config.type,videoBitsPerSecond:2600000,audioBitsPerSecond:128000});row.actual=recorder.mimeType;
   await new Promise((resolve,reject)=>{
    for(const name of ['start','dataavailable','stop','error'])recorder.addEventListener(name,e=>{events.push({name,size:e.data?.size,error:e.error?.message,time:context.currentTime});if(name==='dataavailable'&&e.data.size)chunks.push(e.data);if(name==='stop')resolve();if(name==='error')reject(e.error||Error('native error'));});
    timer=setTimeout(()=>reject(Error('native matrix timeout')),6000);config.noSlice?recorder.start():recorder.start(250);if(config.lateAudio){if(mix)mix.start(context.currentTime+.02);else osc.start(context.currentTime+.02);}const start=context.currentTime;
    function draw(){const elapsed=context.currentTime-start;ctx.fillStyle=elapsed%1<.5?'#6633ee':'#331155';ctx.fillRect(0,0,720,1280);if(elapsed>=1.2)recorder.stop();else frame=requestAnimationFrame(draw);}frame=requestAnimationFrame(draw);
   });row.bytes=chunks.reduce((n,b)=>n+b.size,0);
  }catch(e){row.error=e.name+': '+e.message;}
  finally{clearTimeout(timer);cancelAnimationFrame(frame);if(recorder&&recorder.state!=='inactive')recorder.stop();osc?.stop();mix?.stop();stream?.getTracks().forEach(t=>t.stop());await context.close().catch(()=>{});canvas.remove();}
  row.events=events;exportMatrixRows.push(row);return row;
 })();};
};
