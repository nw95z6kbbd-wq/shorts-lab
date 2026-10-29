/* Test-owned consumer: no production UI or persistence writes. */
window.prepareEditorCanvasRecording = async function(payload,{shortAudio=false}={}){
 window.editorRecordedBlob=null;
 const evidence=window.editorRecordingEvidence={entry:location.protocol==='file:'?'file':'http',events:[],render:{count:0,firstMs:null,lastMs:null,maxGapMs:0,scenes:{}}};
 const images=new Map(),buffers={};
 for(const file of payload){
  const blob=new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.type});
  if(file.type.startsWith('image/'))images.set(file.name.split('.')[0],await ShortsVideoMedia.decodeImage(blob));
  else buffers[file.name.split('.')[0]]=await ShortsVideoRecorder.decodeAudio(blob);
 }
 if(shortAudio)for(const key of Object.keys(buffers)){
  const original=buffers[key],short=new AudioBuffer({numberOfChannels:original.numberOfChannels,length:Math.round(original.sampleRate*.25),sampleRate:original.sampleRate});
  for(let channel=0;channel<original.numberOfChannels;channel++)short.copyToChannel(original.getChannelData(channel).subarray(0,short.length),channel);
  buffers[key]=short;
 }
 evidence.inputs={voiceSeconds:buffers.voice?.duration,musicSeconds:buffers.music?.duration};
 const p=ShortsCore.upgradeProject(ShortsCore.createProject(false));p.timing='manual';p.scenes=['red','blue','green'].map((id,i)=>({id:'editor-photo-'+i,text:'Моя сцена '+(i+1),durationMs:1000,visual:'image',imageId:id,imageName:id,camera:'static',transition:'none'}));p.selectedSceneId=p.scenes[0].id;
 p.audio.voice.assetId='voice';p.audio.music.assetId='music';p.audio.voice.volume=.65;p.audio.music.volume=.45;p.audio.music.fadeInMs=200;p.audio.music.fadeOutMs=300;
 const plan=ShortsRenderAdapters.fromEditor(p),resources={images:new Map([...images].map(([id,r])=>[id,r.image]))};
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.style='position:fixed;right:0;bottom:0;width:90px;height:160px;z-index:20000';document.body.append(canvas);
 const button=document.createElement('button');button.id='editorRecordProbe';button.textContent='Editor recording probe';button.style='position:fixed;left:20px;top:20px;z-index:20000';document.body.append(button);
 evidence.plan={durationMs:plan.durationMs,scenes:plan.timeline.map(s=>({id:s.id,startMs:s.startMs,endMs:s.endMs}))};
 evidence.canvas={width:canvas.width,height:canvas.height};
 // Failure-only observation of the exact same bytes. This cannot turn a failed
 // assertion into success: the native caller always rethrows its original error.
 window.reprobeEditorRecording=async()=>{
  const element=document.createElement('video');element.muted=true;element.playsInline=true;
  const unmount=mountRuntimeRecordedVideo(element),events=[],listeners=[];
  let timer,frame,count=0,lastMediaTime=null;
  const snapshot=()=>({width:element.videoWidth,height:element.videoHeight,duration:Number.isFinite(element.duration)?element.duration:String(element.duration),currentTime:element.currentTime,readyState:element.readyState});
  try{
   const serialized=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(window.editorRecordedBlob);});
   const source=runtimeRecordingDataURL(window.editorRecordedBlob.type,serialized);
   return await new Promise(resolve=>{
    let finished=false;
    const finish=(state,error)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({state,error,frames:count,lastMediaTime,events,video:snapshot()});};
    for(const name of ['loadedmetadata','durationchange','loadeddata','canplay','ended','error']){
     const fn=()=>{if(events.length<24)events.push({event:name,...snapshot()});if(name==='ended')finish('ended');if(name==='error')finish('error','Media decode error');};
     listeners.push([name,fn]);element.addEventListener(name,fn);
    }
    const observe=(_now,data)=>{count++;lastMediaTime=data.mediaTime;if(!finished)frame=element.requestVideoFrameCallback(observe);};
    if(element.requestVideoFrameCallback)frame=element.requestVideoFrameCallback(observe);
    timer=setTimeout(()=>finish('observation-timeout'),5000);
    element.src=source;element.load();element.play().catch(error=>finish('play-rejected',error.name+': '+error.message));
   });
  }finally{clearTimeout(timer);if(frame!=null)element.cancelVideoFrameCallback?.(frame);for(const [name,fn] of listeners)element.removeEventListener(name,fn);unmount();}
 };
 button.onclick=()=>{
  const started=performance.now();let previous;
  const NativeRecorder=window.MediaRecorder,recorders=[];let TrackedRecorder;
  const audioGlobals=[],contexts=[];
  evidence.audioContexts=[];
  const clocks=()=>contexts.map(context=>({state:context.state,time:context.currentTime,sampleRate:context.sampleRate}));
  for(const key of ['AudioContext','webkitAudioContext']){
   const Native=window[key];if(typeof Native!=='function')continue;
   const Tracked=new Proxy(Native,{construct:(target,args)=>{const context=Reflect.construct(target,args);contexts.push(context);evidence.audioContexts.push({createdMs:performance.now()-started});return context;}});
   audioGlobals.push({key,Native,Tracked});window[key]=Tracked;
  }
  evidence.recorders=recorders;
  if(typeof NativeRecorder==='function'){
   TrackedRecorder=new Proxy(NativeRecorder,{
    get:(target,key)=>key==='isTypeSupported'?target.isTypeSupported.bind(target):Reflect.get(target,key),
    construct:(target,args)=>{
     const recorder=Reflect.construct(target,args),trace={createdMs:performance.now()-started,requestedMime:args[1]?.mimeType,events:[],tracks:args[0].getTracks().map(t=>{const s=t.getSettings();return{kind:t.kind,readyState:t.readyState,muted:t.muted,width:s.width,height:s.height,frameRate:s.frameRate,sampleRate:s.sampleRate};})};
     if(recorders.length<8)recorders.push(trace);
     for(const event of ['start','pause','dataavailable','stop','error'])recorder.addEventListener(event,e=>{if(trace.events.length<32)trace.events.push({event,atMs:performance.now()-started,timecode:e.timecode,size:e.data?.size,state:recorder.state,audio:clocks()});});
     return recorder;
    }
   });
   window.MediaRecorder=TrackedRecorder;
  }
  window.editorRecordingPromise=ShortsVideoRecorder.capabilities(true,'webm').supported?ShortsVideoRecorder.record({canvas,plan,resources,voiceBuffer:buffers.voice,musicBuffer:buffers.music,...ShortsRenderPlan.audioOptions(plan),format:'webm',
   onFormat:type=>{evidence.mimeType=type;evidence.formatAtMs=performance.now()-started;},onProgress:(_fraction,ms)=>{
    const now=performance.now(),r=evidence.render,scene=ShortsRenderPlan.frameAt(plan,ms).scene.id;
    if(r.firstMs===null)evidence.audioAtFirstFrame=clocks();evidence.audioAtLastFrame=clocks();
    if(r.firstMs===null)r.firstMs=ms;r.lastMs=ms;r.count++;r.wallMs=now-started;r.maxGapMs=Math.max(r.maxGapMs,previous===undefined?0:now-previous);previous=now;
    const s=r.scenes[scene]||(r.scenes[scene]={count:0,firstMs:ms,lastMs:ms});s.count++;s.lastMs=ms;
   }}):Promise.resolve({skipped:true});
  window.editorRecordingPromise=window.editorRecordingPromise.finally(()=>{evidence.completedWallMs=performance.now()-started;if(TrackedRecorder&&window.MediaRecorder===TrackedRecorder)window.MediaRecorder=NativeRecorder;for(const {key,Native,Tracked} of audioGlobals)if(window[key]===Tracked)window[key]=Native;});
  window.editorRecordingPromise.catch(()=>{});
 };
 window.finishEditorCanvasRecording=async(expectedFrameTimes=null)=>{
  let video,unmount,stopTrace=()=>{};
  try{
   const result=await editorRecordingPromise;if(result.skipped)return{skipped:true};window.editorRecordedBlob=result.blob;
   evidence.blob={size:result.blob.size,type:result.blob.type,mimeType:result.mimeType};evidence.declared={width:result.width,height:result.height,durationMs:result.durationMs};
   video=document.createElement('video');video.crossOrigin='anonymous';video.muted=true;video.playsInline=true;unmount=mountRuntimeRecordedVideo(video);const serialized=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(result.blob);});const source=runtimeRecordingDataURL(result.mimeType,serialized);
   const probe=()=>({width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)?video.duration:String(video.duration),readyState:video.readyState,currentTime:video.currentTime});
   evidence.video=probe();
   const traceEvents=['loadedmetadata','durationchange','loadeddata','canplay','canplaythrough','error'],listeners=[];
   for(const event of traceEvents){const listener=()=>{evidence.video=probe();if(evidence.events.length<24)evidence.events.push({event,...probe()});};listeners.push([event,listener]);video.addEventListener(event,listener);}
   stopTrace=()=>{for(const [event,listener] of listeners)video.removeEventListener(event,listener);};
   await new Promise((resolve,reject)=>{
    const events=['loadedmetadata','durationchange','loadeddata','error'];
    const finish=error=>{clearTimeout(timer);for(const event of events)video.removeEventListener(event,check);error?reject(error):resolve();};
    const check=()=>{if(video.error)finish(Error('Editor video decode error'));else if(video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0)finish();};
    const timer=setTimeout(()=>finish(Error('Editor metadata timeout')),15000);
    for(const event of events)video.addEventListener(event,check);video.src=source;video.load();
   });
   await waitRuntimeVideoFrame(video);
   evidence.video=probe();
   if(video.videoWidth!==720||video.videoHeight!==1280||video.duration<2.7||video.duration>4)throw Error('Incomplete Editor recording');
   const sample=document.createElement('canvas');sample.width=sample.height=1;const x=sample.getContext('2d'),colors=[];
   const targets=[.5,1.5,2.5];
   if(expectedFrameTimes!==null&&(!Array.isArray(expectedFrameTimes)||expectedFrameTimes.length!==3||expectedFrameTimes.some((t,i)=>!Number.isFinite(t)||t<i||t-targets[i]>.1)))throw Error('Invalid independent frame expectations');
   for(const [i,time] of targets.entries()){await seekRuntimeVideoFrame(video,time,4000,expectedFrameTimes?.[i]??time);x.drawImage(video,300,350,100,100,0,0,1,1);colors.push([...x.getImageData(0,0,1,1).data].slice(0,3));}
   const [r,b,g]=colors;if(!(r[0]>r[2]*1.5&&b[2]>b[0]*1.5&&g[1]>g[0]*1.5))throw Error('Editor image order '+JSON.stringify(colors));
   evidence.video=probe();return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,type:result.mimeType,images:3,audio:'voice+music',source:plan.source.mode};
  }catch(error){const failure=new Error(error.message+' '+JSON.stringify({video:evidence.video,blob:evidence.blob,canvas:evidence.canvas,plan:evidence.plan,render:evidence.render,entry:evidence.entry,audioAtFirstFrame:evidence.audioAtFirstFrame,audioAtLastFrame:evidence.audioAtLastFrame,formatAtMs:evidence.formatAtMs,completedWallMs:evidence.completedWallMs}));failure.name=error.name;failure.code=error.code;failure.cause=error;throw failure;}finally{stopTrace();unmount?.();for(const r of images.values())r.dispose();canvas.remove();button.remove();}
 };
};
