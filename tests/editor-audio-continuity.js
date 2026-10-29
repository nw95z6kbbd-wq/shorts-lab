/* Passive test-owned PCM meter; no production graph/clock implementation. */
window.editorBoundarySetup=async function(images,file){
 const p=ShortsCore.upgradeProject(ShortsCore.createProject());p.id=ShortsCore.id();p.name='Continuous music '+(images?'images':'animated');p.timing='manual';p.scenes=Array.from({length:4},(_,i)=>({id:'boundary-'+i,text:'',durationMs:2000,visual:'animated',imageId:null,imageName:'',camera:'pan-left',transition:'crossfade'}));p.selectedSceneId=p.scenes[0].id;
 await editorLiveImport(p);document.getElementById('tab-scenes').click();await editorLiveReady();audioCheck(await editorAudioUpload('music',file)==='ready','continuity MP3 upload');await editorAudioReady();editorAudioTap();
};
window.editorBoundaryArm=function(delayImage){
 const probe=window.editorBoundaryProbe={events:[],delayImage,entered:false,blocks:0,zeroBlocks:0,minRms:null,contextEvents:null};
 const connect=ShortsVideoAudio.connectMix,decode=ShortsVideoMedia.decodeImage;let release;
 probe.gate=new Promise(r=>release=r);probe.release=release;
 ShortsVideoMedia.decodeImage=async blob=>{if(probe.delayImage&&!probe.entered){probe.entered=true;await probe.gate;}return decode(blob);};
 ShortsVideoAudio.connectMix=(ctx,options)=>{
  const mix=connect(ctx,options);probe.context=ctx;
  return {start(when){probe.when=when;probe.events.push({event:'start',offset:options.offsetSeconds,when,clock:ctx.currentTime,wall:performance.now()});mix.start(when);},stop(){probe.events.push({event:'stop',clock:ctx.currentTime,wall:performance.now()});mix.stop();}};
 };
 probe.restore=()=>{ShortsVideoAudio.connectMix=connect;ShortsVideoMedia.decodeImage=decode;release();probe.node?.disconnect();probe.gain?.disconnect();probe.node?.port.close();};
};
window.editorBoundaryMeasure=async function(){
 const p=editorBoundaryProbe;let url;
 try{
  await editorLiveUntil(()=>p.context&&p.when!==undefined,'music source start');const ctx=p.context;
  audioCheck(!editorAudioTaps.at(-1).options.voiceBuffer&&editorAudioTaps.at(-1).options.musicBuffer,'music-only actual graph');
  audioCheck(ctx.audioWorklet&&window.AudioWorkletNode,'native passive audio meter');
  const code=`registerProcessor('studio-boundary-meter',class extends AudioWorkletProcessor{constructor(o){super();this.when=o.processorOptions.when;this.blocks=0;this.zeros=0;this.min=Infinity;}process(inputs){const d=inputs[0]?.[0],t=currentFrame/sampleRate-this.when;if(d&&t>=.5&&t<=6.5){let sum=0;for(let i=0;i<d.length;i++)sum+=d[i]*d[i];const rms=Math.sqrt(sum/d.length);this.blocks++;this.min=Math.min(this.min,rms);if(rms<.00001)this.zeros++;if(this.blocks%32===0)this.port.postMessage({blocks:this.blocks,zeroBlocks:this.zeros,minRms:this.min});}return true;}});`;
  url=URL.createObjectURL(new Blob([code],{type:'application/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);url=null;
  p.node=new AudioWorkletNode(ctx,'studio-boundary-meter',{processorOptions:{when:p.when}});p.gain=ctx.createGain();p.gain.gain.value=0;p.node.connect(p.gain);p.gain.connect(ctx.destination);editorAudioTaps.at(-1).analyser.connect(p.node);
  p.node.port.onmessage=e=>Object.assign(p,e.data);
  if(p.delayImage){
   await editorLiveUntil(()=>p.entered,'cold image decode entered');
   await editorLiveUntil(()=>ctx.currentTime-p.when>4.4,'audio advances during delayed image preparation');p.release();
   await editorLiveUntil(()=>editorCanvas.dataset.sceneId==='boundary-2'&&Math.abs(Number(editorCanvas.dataset.timeMs)-(ctx.currentTime-p.when)*1000)<125,'Canvas catches up after skipping a stale image window');
  }
  await editorLiveUntil(()=>ctx.currentTime-p.when>6.6,'cross three scene boundaries');
  const signal=editorAudioSignal(),events=structuredClone(p.events),controls=structuredClone(editorAudioContexts.at(-1).events),meter={blocks:p.blocks,zeroBlocks:p.zeroBlocks,minRms:p.minRms};
  audioCheck(events.length===1&&events[0].event==='start'&&events[0].offset===0,'automatic scene boundary restarted/stopped sources '+JSON.stringify(events));
  audioCheck(controls.length===0&&ctx.state==='running','automatic scene boundary controlled AudioContext '+JSON.stringify(controls));
  audioCheck(signal.rms>.0001&&Math.abs(signal.clock-signal.canvas)<125,'real signal and Canvas stay on the same clock '+JSON.stringify(signal));
  audioCheck(meter.blocks>=256&&meter.zeroBlocks===0&&meter.minRms>.00001,'PCM continuity '+JSON.stringify(meter));
  // Capture before the explicit user Pause; no WebDriver round trip can turn
  // this into a stop-at-project-end assertion.
  playPreview.click();await editorAudioPaused();return {images:p.delayImage,events,controls,meter,signal};
 }finally{if(url)URL.revokeObjectURL(url);p.restore();}
};
