(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorExport=factory({
  adapters:root.ShortsRenderAdapters,plan:root.ShortsRenderPlan,profile:root.ShortsEditorProfile,runtime:root.ShortsRenderSessions,media:root.ShortsMediaSessions,
  recorder:root.ShortsVideoRecorder,inspector:root.ShortsExportInspector,supported:type=>typeof root.MediaRecorder?.isTypeSupported==='function'&&root.MediaRecorder.isTypeSupported(type),
  fonts:()=>root.document.fonts?.ready||Promise.resolve(),yield:()=>new Promise(resolve=>setTimeout(resolve,0))
 });
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 const MAX_OUTPUT_BYTES=64*1048576;
 const error=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
 function formats(hasAudio,preference='auto'){
  if(!['auto','webm'].includes(preference))throw error('FORMAT','Неподдерживаемая настройка формата Editor.');
  const mp4=['avc1.42001f','avc1.42E01E','avc1.4D401F'].map(codec=>'video/mp4;codecs='+codec+(hasAudio?',mp4a.40.2':''));
  const webm=['vp9','vp8'].map(codec=>'video/webm;codecs='+codec+(hasAudio?',opus':''));
  // A generic video/mp4 can encode VP9/Opus. It is never a compatible MP4 candidate.
  return Object.freeze((preference==='webm'?webm:[...mp4,...webm]).filter(type=>{try{return !!io.supported(type);}catch(_){return false;}}));
 }
 function create({onState=()=>{},onProgress=()=>{},maxOutputBytes=MAX_OUTPUT_BYTES}={}){
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>MAX_OUTPUT_BYTES)throw error('LIMITS','Предел результата должен быть от 1 байта до 64 МиБ.');
  const jobs=new Set();let active=null,generation=0,closed=false,state='idle',failure=null,lastResult=null,observerError=null;
  const emit=(callback,value)=>{try{callback(value);}catch(cause){observerError={code:'OBSERVER',message:cause.message||'Ошибка обработчика интерфейса.'};}};
  const current=job=>!closed&&active===job&&job.generation===generation&&!job.abort.signal.aborted;
  const publish=(job,next,reason=null)=>{if(!current(job))return;state=next;failure=reason;emit(onState,Object.freeze({state,jobId:job.id,error:reason?{code:reason.code||reason.name,message:reason.message,sceneId:reason.sceneId,sceneNumber:reason.sceneNumber,assetId:reason.assetId}:null}));};
  const check=job=>{if(!current(job))throw error('CANCELLED','Операция экспорта отменена или устарела.');};
  function describe(job,cause){
   if(cause.code==='CANCELLED'||cause.name==='AbortError')return cause;
   const index=cause.sceneId?job.data.project.scenes.findIndex(s=>s.id===cause.sceneId):cause.assetId?job.data.project.scenes.findIndex(s=>s.imageId===cause.assetId):-1;
   if(index>=0)return error(cause.code||'EXPORT','Сцена '+(index+1)+': '+cause.message,{sceneId:job.data.project.scenes[index].id,sceneNumber:index+1,assetId:cause.assetId,cause});
   const role=['voice','music'].find(role=>job.data.plan.audio[role].assetId&&job.data.plan.audio[role].assetId===cause.assetId);
   return error(cause.code||cause.name||'EXPORT',(role?(role==='voice'?'Озвучка: ':'Музыка: '):'')+(cause.message||'Не удалось подготовить видео.'),{assetId:cause.assetId,cause});
  }
  async function closeContexts(job){
   for(const context of job.contexts){if(context.state!=='closed'){try{await context.close();}catch(cause){throw error('AUDIO_CLOSE','Браузер не подтвердил закрытие аудиоконтекста; ресурсы удерживаются. Повторите отмену или очистку.',{cause});}if(context.state!=='closed')throw error('AUDIO_CLOSE','Аудиоконтекст ещё не закрыт; ресурсы удерживаются.');}}
   job.contexts.clear();job.pin?.release();job.pin=null;
  }
  function unlisten(job){job.external?.removeEventListener('abort',job.externalAbort);}
  async function retire(job){
   if(!job)return;job.abort.abort(error('CANCELLED','Экспорт отменён.'));unlisten(job);
   const closing=job.session?.cancel();await Promise.allSettled([job.preparation,job.recording]);await closeContexts(job);await closing;await job.session?.dispose();jobs.delete(job);
  }
  function prepare({project,canvas,contentRevision=0,savedRevision=null,signal}={}){
   if(closed)return Promise.reject(error('STATE','Контроллер экспорта закрыт.'));
   const previous=[...jobs],token=++generation;lastResult=null;
   let data;
   try{data=io.runtime.snapshotData(project,io.adapters.fromEditor(project));}
   catch(cause){active=null;state='error';failure=cause;return Promise.all(previous.map(retire)).then(()=>{throw cause;},cleanup=>{failure=cleanup;throw cleanup;});}
   const job={id:'editor-export-'+token,generation:token,data,canvas,abort:new AbortController(),session:null,external:signal,contexts:new Set(),pin:null};active=job;jobs.add(job);
   job.externalAbort=()=>{if(active===job){publish(job,'cancelled');generation++;state='cancelled';failure=null;void retire(job).catch(cause=>{failure=cause;state='error';});}};
   signal?.addEventListener('abort',job.externalAbort,{once:true});publish(job,'preparing');
   job.preparation=(async()=>{
    try{
     await Promise.all(previous.map(retire));if(signal?.aborted)job.externalAbort();check(job);
     const plan=data.plan;io.plan.assertRenderable(plan);
     if(!canvas||canvas.width!==720||canvas.height!==1280||typeof canvas.getContext!=='function')throw error('CANVAS','Для экспорта требуется отдельный Canvas 720×1280.');
     const support=io.recorder.capabilities(Boolean(plan.audio.voice.assetId||plan.audio.music.assetId),plan.exportSettings.format);
     const mimeTypes=formats(Boolean(plan.audio.voice.assetId||plan.audio.music.assetId),plan.exportSettings.format);
     if(!support.capture||!support.mediaRecorder||!mimeTypes.length)throw error('FORMAT','Браузер не поддерживает совместимый MP4 H.264/AAC или WebM. Предпросмотр и проект остаются доступны.');
     if((plan.audio.voice.assetId||plan.audio.music.assetId)&&!support.audio)throw error('AUDIO_UNSUPPORTED','Браузер не поддерживает запись смешанного аудио.');
     const uniqueImages=new Set(plan.timeline.filter(s=>s.visual==='image').map(s=>s.imageId));
     if(uniqueImages.size>io.media.DEFAULTS.maxImages)throw error('IMAGE_COUNT','Для полной записи допускается до '+io.media.DEFAULTS.maxImages+' уникальных активных изображений; в плане '+uniqueImages.size+'. Проект не изменён.');
     if(plan.durationMs<1000/plan.output.fps)throw error('EXPORT_TIMING','Общая длительность короче одного кадра 24 fps. Измените длительность явно.');
     const estimate=Math.ceil(plan.durationMs*(2600000+(plan.audio.voice.assetId||plan.audio.music.assetId?128000:0))/8000);
     if(estimate>maxOutputBytes)throw error('OUTPUT_BUDGET','Оценка результата по битрейту превышает рабочий предел '+(maxOutputBytes/1048576).toFixed(1)+' МиБ. Сократите ролик; проект не изменён.');
     if(canvas.style)canvas.style.fontSynthesis='initial';const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw error('CANVAS','Не удалось подготовить Canvas экспорта.');
     await io.fonts();check(job);const {namespace,...style}=plan.appearance.requested;
     let count=0;for(const scene of plan.timeline){
      if(scene.endMs-scene.startMs<1000/plan.output.fps)throw error('EXPORT_TIMING','Длительность сцены короче одного кадра 24 fps. Измените её явно.',{sceneId:scene.id});
      for(const cue of scene.cues){if(cue.endMs-cue.startMs<1000/plan.output.fps)throw error('EXPORT_TIMING','Интервал субтитра короче одного кадра 24 fps. Увеличьте длительность или явно выберите субтитры по сценам.',{sceneId:scene.id});try{io.profile.layout(ctx,cue.text,style);}catch(cause){throw Object.assign(cause,{sceneId:scene.id});}if(++count%8===0){await io.yield();check(job);}}
     }
     job.policy=Object.freeze({mimeTypes,maxBytes:maxOutputBytes,onContext:context=>job.contexts.add(context)});
     job.session=io.runtime.create({slot:'editor',projectId:data.project.id,...data,contentRevision,savedRevision,signal:job.abort.signal});
     await job.session.prepare();check(job);
     // Exercise each media/camera/transition path before starting any media
     // clock. Repeated scenes do not multiply GPU preparation or media owners.
     const paths=new Set();job.frameProbes=0;
     for(const scene of plan.timeline){
      const key=JSON.stringify([scene.visual,scene.visual==='image'?scene.imageId:null,scene.camera,scene.transition]);if(paths.has(key))continue;paths.add(key);
      const points=new Set([scene.startMs,Math.min(scene.endMs-1,scene.startMs+Math.ceil(1000/plan.output.fps)),scene.endMs-1]);
      for(const time of points){check(job);try{job.session.renderFrame(canvas,time);ctx.getImageData(0,0,canvas.width,canvas.height);job.frameProbes++;}catch(cause){throw Object.assign(error(cause.code||'CANVAS',cause.message||'Не удалось подготовить кадр Canvas.',{cause}),{sceneId:scene.id});}}
      await io.yield();check(job);
     }
     job.session.renderFrame(canvas,0);check(job);publish(job,'ready');
     return Object.freeze({jobId:job.id,plan:data.plan,identity:job.session.identity,formats:mimeTypes,estimatedBytes:estimate,omittedScenes:data.plan.omittedScenes,frameProbes:job.frameProbes});
    }catch(cause){
     await job.session?.dispose();jobs.delete(job);unlisten(job);const reason=describe(job,cause);if(current(job))publish(job,'error',reason);throw reason;
    }
   })();job.preparation.catch(()=>{});return job.preparation;
  }
  function start({signal}={}){
   const job=active;if(!job||!current(job)||state!=='ready')return Promise.reject(error('STATE','Сначала завершите подготовку. Запись запускается отдельным пользовательским действием.'));
   lastResult=null;publish(job,'recording');
   signal?.addEventListener('abort',job.externalAbort,{once:true});if(signal?.aborted){job.externalAbort();signal.removeEventListener('abort',job.externalAbort);return Promise.reject(error('CANCELLED','Запуск записи отменён.'));}
   // No await before session.record(): AudioContext.resume belongs to this click.
   job.pin=job.session.acquire();
   const recording=job.session.record({canvas:job.canvas,signal,recordingPolicy:job.policy,
    onFormat:type=>{if(current(job))emit(onProgress,Object.freeze({jobId:job.id,state:'recording',fraction:0,mimeType:type}));},
    onProgress:(fraction,timeMs)=>{if(current(job)){if(timeMs>=job.data.plan.durationMs)publish(job,'finalizing');emit(onProgress,Object.freeze({jobId:job.id,state,fraction:Math.min(.99,fraction),timeMs}));}}
   });
   job.recording=(async()=>{
    try{
     const raw=await recording;check(job);publish(job,'validating');await closeContexts(job);await job.session.dispose();jobs.delete(job);check(job);
     const plan=job.data.plan,expected={durationMs:plan.durationMs,...plan.output,hasAudio:!!(plan.audio.voice.assetId||plan.audio.music.assetId)};
     const info=await io.inspector.inspect(raw.blob,expected,{signal:job.abort.signal});check(job);
     if(!job.policy.mimeTypes.some(type=>type.startsWith('video/'+info.container)))throw error('FORMAT','Записан незапрошенный контейнер.');
     for(const value of [raw.mimeType,raw.blob.type].filter(Boolean)){const declared=String(value).split(';')[0].toLowerCase();if(declared!=='video/'+info.container)throw error('CONTAINER','MIME и фактический контейнер записанного файла не совпадают.');}
     const playback=await io.inspector.playback(raw.blob,info,expected,{signal:job.abort.signal});check(job);
     lastResult=Object.freeze({blob:raw.blob,container:info.container,extension:info.extension,mimeType:'video/'+info.container,videoCodec:info.video.codec,audioCodec:info.audio?.codec||null,width:playback.width,height:playback.height,durationMs:playback.durationMs,plannedDurationMs:plan.durationMs,bytes:raw.blob.size,streams:info,fallback:info.container==='webm'&&plan.exportSettings.format==='auto',jobId:job.id,identity:job.session.identity,validation:Object.freeze({sampleCoverage:true,browserMetadata:true,fullDecode:false})});
     publish(job,'complete');emit(onProgress,Object.freeze({jobId:job.id,state:'complete',fraction:1,timeMs:plan.durationMs}));unlisten(job);return lastResult;
    }catch(cause){
     try{await closeContexts(job);await job.session.dispose();jobs.delete(job);}catch(cleanup){unlisten(job);if(current(job))publish(job,'error',cleanup);throw cleanup;}unlisten(job);const reason=describe(job,cause);if(current(job)){lastResult=null;if(cause.name==='AbortError'||cause.code==='CANCELLED')publish(job,'cancelled');else publish(job,'error',reason);}throw reason;
    }finally{signal?.removeEventListener('abort',job.externalAbort);}
   })();job.recording.catch(()=>{});return job.recording;
  }
  async function cancel(){if(active)publish(active,'cancelled');generation++;state='cancelled';failure=null;lastResult=null;await Promise.all([...jobs].map(retire));}
  return Object.freeze({prepare,start,cancel,async dispose(){closed=true;await cancel();active=null;state='disposed';},status:()=>Object.freeze({state,generation,observerError,pendingJobs:jobs.size,cleanupPending:[...jobs].some(j=>j.pin),jobId:active?.id||null,identity:active?.session?.identity||null,error:failure?{code:failure.code||failure.name,message:failure.message}:null,hasResult:!!lastResult,session:active?.session?.status()||null}),toJSON(){throw error('RUNTIME','Контроллер экспорта нельзя сохранять в DTO или ZIP.');}});
 }
 return Object.freeze({create,formats,MAX_OUTPUT_BYTES});
});
