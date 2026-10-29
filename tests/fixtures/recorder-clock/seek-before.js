window.seekRuntimeVideoFrame = function (element, time, timeoutMs = 4000) {
 return new Promise((resolve,reject)=>{
  let ended=false,seeked=false,presented=false,frame,paintQueued=false,metadata;
  const usesFrames=typeof element.requestVideoFrameCallback==='function';
  const paint=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):((fn)=>setTimeout(fn,0));
  const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);element.removeEventListener('seeked',onSeek);element.removeEventListener('error',onError);if(frame!=null)element.cancelVideoFrameCallback?.(frame);error?reject(error):resolve(metadata||{mediaTime:element.currentTime});};
  const ready=()=>{if(ended||!seeked||!presented||element.readyState<2||paintQueued)return;paintQueued=true;paint(()=>paint(()=>finish()));};
  const onError=()=>finish(Error('Recorded video seek decode error: '+element.error?.code+' '+element.error?.message));
  const onSeek=()=>{seeked=true;if(!usesFrames)presented=true;ready();};
  const onFrame=(_now,data)=>{if(ended)return;frame=null;if(Number.isFinite(data.mediaTime)&&Math.abs(data.mediaTime-time)<=.1){metadata={mediaTime:data.mediaTime};presented=true;ready();}else frame=element.requestVideoFrameCallback(onFrame);};
  const timer=setTimeout(()=>finish(Error('Runtime requested frame presentation timeout at '+time)),timeoutMs);
  element.addEventListener('seeked',onSeek);element.addEventListener('error',onError);
  if(usesFrames)frame=element.requestVideoFrameCallback(onFrame);
  try{element.currentTime=time;}catch(error){finish(error);}
 });
};
