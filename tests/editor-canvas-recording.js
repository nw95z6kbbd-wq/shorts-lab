/* Test-owned consumer: no production UI or persistence writes. */
window.prepareEditorCanvasRecording = async function(payload){
 const images=new Map(),buffers={};
 for(const file of payload){
  const blob=new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.type});
  if(file.type.startsWith('image/'))images.set(file.name.split('.')[0],await ShortsVideoMedia.decodeImage(blob));
  else buffers[file.name.split('.')[0]]=await ShortsVideoRecorder.decodeAudio(blob);
 }
 const p=ShortsCore.upgradeProject(ShortsCore.createProject(false));p.timing='manual';p.scenes=['red','blue','green'].map((id,i)=>({id:'editor-photo-'+i,text:'Моя сцена '+(i+1),durationMs:1000,visual:'image',imageId:id,imageName:id,camera:'static',transition:'none'}));p.selectedSceneId=p.scenes[0].id;
 p.audio.voice.assetId='voice';p.audio.music.assetId='music';p.audio.voice.volume=.65;p.audio.music.volume=.45;p.audio.music.fadeInMs=200;p.audio.music.fadeOutMs=300;
 const plan=ShortsRenderAdapters.fromEditor(p),resources={images:new Map([...images].map(([id,r])=>[id,r.image]))};
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.style='position:fixed;right:0;bottom:0;width:90px;height:160px;z-index:20000';document.body.append(canvas);
 const button=document.createElement('button');button.id='editorRecordProbe';button.textContent='Editor recording probe';button.style='position:fixed;left:20px;top:20px;z-index:20000';document.body.append(button);
 button.onclick=()=>{window.editorRecordingPromise=ShortsVideoRecorder.capabilities(true,'webm').supported?ShortsVideoRecorder.record({canvas,plan,resources,voiceBuffer:buffers.voice,musicBuffer:buffers.music,...ShortsRenderPlan.audioOptions(plan),format:'webm'}):Promise.resolve({skipped:true});window.editorRecordingPromise.catch(()=>{});};
 window.finishEditorCanvasRecording=async()=>{
  let video,url,unmount;
  try{
   const result=await editorRecordingPromise;if(result.skipped)return{skipped:true};window.editorRecordedBlob=result.blob;
   video=document.createElement('video');video.crossOrigin='anonymous';video.muted=true;video.playsInline=true;unmount=mountRuntimeRecordedVideo(video);url=URL.createObjectURL(result.blob);
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Editor metadata timeout')),15000);const check=()=>{if(video.error){clearTimeout(timer);reject(Error('Editor video decode error'));}else if(video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0){clearTimeout(timer);resolve();}};for(const event of ['loadedmetadata','durationchange','loadeddata','error'])video.addEventListener(event,check);video.src=url;video.load();});
   await waitRuntimeVideoFrame(video);
   if(video.videoWidth!==720||video.videoHeight!==1280||video.duration<2.7||video.duration>4)throw Error('Incomplete Editor recording');
   const sample=document.createElement('canvas');sample.width=sample.height=1;const x=sample.getContext('2d'),colors=[];
   for(const time of [.5,1.5,2.5]){await seekRuntimeVideoFrame(video,time);x.drawImage(video,300,350,100,100,0,0,1,1);colors.push([...x.getImageData(0,0,1,1).data].slice(0,3));}
   const [r,b,g]=colors;if(!(r[0]>r[2]*1.5&&b[2]>b[0]*1.5&&g[1]>g[0]*1.5))throw Error('Editor image order '+JSON.stringify(colors));
   return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,type:result.mimeType,images:3,audio:'voice+music',source:plan.source.mode};
  }catch(error){error.message+=' '+JSON.stringify({entry:location.href,videoSource:video?.currentSrc,readyState:video?.readyState,currentTime:video?.currentTime,origin:location.origin});throw error;}finally{unmount?.();if(url)URL.revokeObjectURL(url);for(const r of images.values())r.dispose();canvas.remove();button.remove();}
 };
};
