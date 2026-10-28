/* Real browser consumers; all writes below are test-owned staged corrupt inputs. */
// Match the UI's document-bound probe and explicitly wait for decoded data.
// loadedmetadata alone is not proof that a frame/seek pipeline is ready.
window.mountRuntimeRecordedVideo = function (element, document = window.document) {
  element.style='position:fixed;right:100px;bottom:0;width:90px;height:160px;z-index:20000';
  document.body.append(element);
  return () => { element.pause();element.removeAttribute('src');element.load();element.remove(); };
};
window.waitRuntimeVideoFrame = function (element, timeoutMs = 4000) {
  return new Promise((resolve,reject) => {
    let finished=false;
    const events=['loadeddata','canplay','canplaythrough','error'];
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);for(const event of events)element.removeEventListener(event,check);error?reject(error):resolve();};
    const check=()=>{if(element.error)finish(Error('Recorded video frame decode error: '+element.error.code+' '+element.error.message));else if(element.readyState>=2&&element.videoWidth>0&&element.videoHeight>0)finish();};
    const timer=setTimeout(()=>finish(Error('Runtime video frame readiness timeout')),timeoutMs);
    for(const event of events)element.addEventListener(event,check);
    check();
  });
};
window.prepareRuntimeSessionChecks = async function () {
  const P=ShortsRenderPlan,A=ShortsRenderAdapters,S=ShortsRenderSessions,M=ShortsMediaSessions;
  const assert=(ok,text)=>{if(!ok)throw Error('Runtime: '+text);},delay=()=>new Promise(r=>setTimeout(r,0));
  const wait=async fn=>{for(let i=0;i<200&&!fn();i++)await delay();assert(fn(),'async operation started');};
  const expect=async(p,code)=>{let caught;try{await p;}catch(e){caught=e;}assert(caught?.code===code,'expected '+code+', got '+caught?.code+': '+caught?.message);};
  const sessions=[],leases=[],gates=[],staged=[];let playback;
  const trace={phase:'prepare'};
  window.runtimeSessionDiagnostics=()=>({trace:{...trace},contexts,maxContexts,urls:urls.size,pool:M.statistics(),sessions:sessions.map(s=>s.status())});
  const before=await backupRepositorySnapshot(),editor=ShortsEditor.backupSnapshot(),video=ShortsVideoBackup.snapshot();
  const originalURL={create:URL.createObjectURL,revoke:URL.revokeObjectURL},urls=new Set();
  const OriginalAudio=window.AudioContext||window.webkitAudioContext,descriptors=new Map();let contexts=0,maxContexts=0;
  URL.createObjectURL=function(...args){const url=originalURL.create.apply(this,args);urls.add(url);return url;};
  URL.revokeObjectURL=function(url){urls.delete(url);return originalURL.revoke.call(this,url);};
  const TrackedAudio=new Proxy(OriginalAudio,{construct(target,args){const c=Reflect.construct(target,args);contexts++;maxContexts=Math.max(maxContexts,contexts);const close=c.close.bind(c);let pending;c.close=()=>pending||(pending=close().finally(()=>{contexts--;}));return c;}});
  for(const key of ['AudioContext','webkitAudioContext']){descriptors.set(key,Object.getOwnPropertyDescriptor(window,key));if(window[key])window[key]=TrackedAudio;}
  const create=(slot,p,extra={})=>{const s=S.create({slot,project:p,plan:slot==='editor'?A.fromEditor(p):A.fromVideo(p),projectId:p.id||'test-video-owner',contentRevision:9,savedRevision:before.heads[slot==='editor'?0:1].revision,...extra});sessions.push(s);return s;};
  const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});const g={promise,resolve};gates.push(g);return g;};
  const originalImage=ShortsVideoMedia.decodeImage,originalAudio=ShortsVideoRecorder.decodeAudio;
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.style='position:fixed;right:0;bottom:0;width:90px;height:160px;z-index:20000';document.body.append(canvas);
  const button=(id,top,action)=>{const b=document.createElement('button');b.id=id;b.textContent=id;b.style='position:fixed;left:20px;top:'+top+'px;z-index:20000';b.onclick=action;document.body.append(b);return b;};
  const controls=[];let report={};
  async function cleanup(){
    ShortsVideoMedia.decodeImage=originalImage;ShortsVideoRecorder.decodeAudio=originalAudio;
    for(const g of gates)g.resolve();for(const l of leases)l.release();await playback?.stop();await Promise.all(sessions.map(s=>s.dispose()));
    for(const id of staged)ShortsStorage.discard(id);for(const b of controls)b.remove();canvas.remove();
    for(const [key,d] of descriptors){if(d)Object.defineProperty(window,key,d);else delete window[key];}
    URL.createObjectURL=originalURL.create;URL.revokeObjectURL=originalURL.revoke;
  }
  try {
    assert(M.statistics().sessions===0,'modules have no background sessions');
    const e=create('editor',editor),v=create('video',video);await Promise.all([e.prepare(),v.prepare()]);
    assert(contexts===0&&maxContexts===1,'actual image/audio preparation is serial and never starts playback');
    assert(e.status().renderable&&v.status().renderable,'both explicit profiles are supported');
    const unsupported={...e.plan,appearance:{...e.plan.appearance,supported:false}};await expect(ShortsVideoRecorder.record({canvas,plan:unsupported}),'APPEARANCE');
    e.renderFrame(canvas,0);
    assert(JSON.stringify(e.snapshot)===JSON.stringify(editor)&&JSON.stringify(v.plan)===JSON.stringify(A.fromVideo(video)),'pure unchanged DTO/plan');
    let refused=false;try{JSON.stringify(v);}catch(err){refused=err.code==='RUNTIME';}assert(refused,'runtime object serialization refused');
    const lease=v.acquire();leases.push(lease);
    const ctx=canvas.getContext('2d'),pixels=()=>new Uint32Array(ctx.getImageData(0,0,720,1280).data.buffer);
    for(const time of [0,1999,2000,2100,4000,5999]){
      v.renderFrame(canvas,time);const actual=pixels();ShortsVideoRenderer.render(canvas,A.fromVideo(video),time,lease.resources);const expected=pixels();
      assert(actual.length===expected.length&&actual.every((x,i)=>x===expected[i]),'test consumer pixels at '+time);
    }
    lease.release();
    // A real decoder allocates the bitmap/URL, then its result is intentionally late.
    const imageGate=gate();let imageStarted=false;
    ShortsVideoMedia.decodeImage=async blob=>{const resource=await originalImage(blob);imageStarted=true;await imageGate.promise;return resource;};
    const old=create('video',video),oldPrep=old.prepare();const oldFailure=expect(oldPrep,'CANCELLED');await wait(()=>imageStarted);const oldEnd=old.cancel();
    const changed=structuredClone(video);changed.scenes[0].imageId=video.scenes[1].imageId;
    ShortsVideoMedia.decodeImage=originalImage;const next=create('video',changed,{contentRevision:10}),nextPrep=next.prepare();await oldFailure;imageGate.resolve();await oldEnd;await nextPrep;
    assert(old.status().state==='cancelled'&&next.status().state==='ready','late image never activates obsolete session');await next.dispose();
    const audioGate=gate();let audioStarted=false;
    ShortsVideoRecorder.decodeAudio=async blob=>{const buffer=await originalAudio(blob);audioStarted=true;await audioGate.promise;return buffer;};
    const audioProject=structuredClone(editor);audioProject.scenes.forEach(s=>{s.visual='animated';});
    const audio=create('editor',audioProject),audioPrep=audio.prepare();const audioFailure=expect(audioPrep,'CANCELLED');await wait(()=>audioStarted);const audioEnd=audio.cancel();await audioFailure;audioGate.resolve();await audioEnd;ShortsVideoRecorder.decodeAudio=originalAudio;
    const missing=structuredClone(video);missing.scenes[0].imageId='missing-runtime-image';await expect(create('video',missing).prepare(),'MISSING_ORIGINAL');
    const corrupt=structuredClone(editor);ShortsStorage.stage('runtime-corrupt-audio',new Blob(['not audio'],{type:'audio/wav'}),'broken.wav','voice');staged.push('runtime-corrupt-audio');corrupt.audio.voice.assetId='runtime-corrupt-audio';await expect(create('editor',corrupt).prepare(),'AUDIO_DECODE');
    const small=create('video',video,{limits:{maxImages:1}});await expect(small.prepare(),'IMAGE_COUNT');
    const independent=v.acquire();leases.push(independent);let ended=false;const eLease=e.acquire();leases.push(eLease);const eEnd=e.dispose().then(()=>{ended=true;});await delay();assert(!ended,'active external consumer pins resources');eLease.release();await eEnd;assert(independent.resources.images.get(video.scenes[0].imageId),'closing Editor cannot close Video image');v.renderFrame(canvas,0);independent.release();
    const inputs={editor,video},assets=await ShortsStorage.captureBackup(inputs,64*1048576),zip=await ShortsBackupFormat.exportArchive(inputs,assets,ShortsProduct.version),restored=await ShortsBackupFormat.importArchive(zip);
    assert(JSON.stringify(restored.projects)===JSON.stringify(inputs),'DTO and ZIP stay plain and unchanged');
    report={pixels:6,realDecodeRaces:true,zipVersion:restored.manifest.version,preparedWithoutAutoplay:true};
    controls.push(button('runtimeAudioStart',20,()=>{window.runtimeAudioPromise=v.playAudio().then(p=>{playback=p;v.renderFrame(canvas,0);return true;});}));
    controls.push(button('runtimeRecordStart',65,()=>{window.runtimeRecordPromise=(async()=>{
      trace.phase='stop-playback';await playback?.stop();trace.phase='capabilities';const support=ShortsVideoRecorder.capabilities(true,'webm');trace.capabilities=support;
      if(!support.supported)return{skipped:'Canvas/MediaRecorder codec unavailable'};
      trace.phase='recording';const result=await v.record({canvas,onFormat:type=>{trace.format=type;},onProgress:(fraction,ms)=>{trace.progress={fraction,ms};}});window.runtimeRecordedBlob=result.blob;trace.blob={size:result.blob.size,type:result.mimeType};trace.phase='metadata';
      const url=URL.createObjectURL(result.blob),element=document.createElement('video');element.muted=true;element.playsInline=true;const unmount=mountRuntimeRecordedVideo(element);let timer;
      const probe=()=>({connected:element.isConnected,readyState:element.readyState,networkState:element.networkState,seeking:element.seeking,currentTime:element.currentTime,error:element.error?{code:element.error.code,message:element.error.message}:null});
      try {
        const metadata=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Runtime recorded metadata timed out')),15000);const check=()=>{if(element.error)reject(Error('Recorded video decode error'));else if(element.videoWidth&&Number.isFinite(element.duration)&&element.duration>0)resolve({width:element.videoWidth,height:element.videoHeight,duration:element.duration,type:result.mimeType});};for(const event of ['loadedmetadata','loadeddata','durationchange','error'])element.addEventListener(event,check);element.src=url;element.load();});clearTimeout(timer);
        trace.metadata=metadata;trace.metadataProbe=probe();trace.phase='frame-readiness';
        await waitRuntimeVideoFrame(element);trace.frameReadyProbe=probe();trace.phase='frame-validation';
        assert(metadata.width===720&&metadata.height===1280&&metadata.duration>5.5&&metadata.duration<7.5,'actual complete runtime export');
        const sample=document.createElement('canvas');sample.width=sample.height=1;const x=sample.getContext('2d'),colors=[];
        for(const t of [.5,2.7,4.8]){trace.seek=t;assert(element.isConnected,'recorded probe participates in document media rendering');trace.probe=probe();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{trace.probe=probe();reject(Error('Runtime video seek timeout'));},4000);element.onseeked=()=>{clearTimeout(timeout);trace.probe=probe();resolve();};element.currentTime=t;});x.drawImage(element,300,400,100,100,0,0,1,1);colors.push([...x.getImageData(0,0,1,1).data].slice(0,3));}
        trace.colors=colors;const [r,b,g]=colors;assert(r[0]>r[2]*1.5&&b[2]>b[0]*1.5&&g[1]>g[0]*1.5,'actual session image order');return {...metadata,frameReadiness:{metadata:trace.metadataProbe.readyState,seek:trace.frameReadyProbe.readyState}};
      }finally{clearTimeout(timer);unmount();URL.revokeObjectURL(url);}
    })();window.runtimeRecordPromise.catch(e=>{trace.recordFailure={phase:trace.phase,...ShortsRuntimeDiagnostics.failure(e)};});}));
    window.finishRuntimeSessionChecks=async()=>{
      try {
        const recording=await window.runtimeRecordPromise;trace.phase='release';await playback?.stop();await Promise.all(sessions.map(s=>s.dispose()));
        assert(contexts===0&&urls.size===0,'all owned contexts and object URLs closed');assert(M.statistics().sessions===0&&M.statistics().residentBytes===0,'global working set fully released');
        assert(JSON.stringify(await backupRepositorySnapshot())===JSON.stringify(before),'all IndexedDB heads, original bytes and IDs untouched');return{...report,recording,maxContexts};
      }finally{await cleanup();}
    };
    return report;
  }catch(e){await cleanup();throw e;}
};
