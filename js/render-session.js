(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ShortsRenderSessions = factory({
    adapters:root.ShortsRenderAdapters, plan:root.ShortsRenderPlan, media:root.ShortsMediaSessions,
    render:(...args)=>root.ShortsVideoRenderer.render(...args), record:options=>root.ShortsVideoRecorder.record(options),
    context:()=>{const Audio=root.AudioContext||root.webkitAudioContext;if(!Audio)throw new Error('AudioContext недоступен.');return new Audio();},
    mix:(...args)=>root.ShortsVideoAudio.connectMix(...args)
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (io) {
  'use strict';
  const MAX_DATA_BYTES = 16 * 1048576;
  const error = (code,message,cause) => Object.assign(new Error(message,cause?{cause}:undefined),{code});
  let sequence=0;
  const encoder=new TextEncoder(),receipts=new WeakMap();
  function immutable(value,budget={bytes:0},ancestors=new Set()) {
    const charge=n=>{budget.bytes+=n;if(budget.bytes>MAX_DATA_BYTES)throw error('DATA_BUDGET','Снимок и план превышают технический бюджет JSON 16 МиБ.');};
    const stringBytes=(text,key=false)=>{if(text.length>MAX_DATA_BYTES-budget.bytes)charge(MAX_DATA_BYTES+1);const cache=key?(budget.keys||=new Map()):(budget.strings||=new Map());if(cache.has(text))return cache.get(text);const size=encoder.encode(JSON.stringify(text)).length;if(cache.size<128)cache.set(text,size);return size;};
    if(value===null || typeof value==='boolean'){charge(value===null?4:value?4:5);return value;}
    if(typeof value==='number'){if(!Number.isFinite(value))throw error('DATA','В снимке есть нечисловое значение.');charge(JSON.stringify(value).length);return value;}
    if(typeof value==='string'){charge(stringBytes(value));return value;}
    if(!value || typeof value!=='object' || (!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))) || ancestors.has(value))throw error('DATA','Снимок и RenderPlan должны содержать только обычные JSON-данные без runtime-объектов и циклов.');
    ancestors.add(value);const array=Array.isArray(value),result=array?[]:{},keys=Reflect.ownKeys(value).filter(k=>!(array&&k==='length'));
    if(array&&(keys.length!==value.length||keys.some((k,i)=>k!==String(i))))throw error('DATA','Массив снимка содержит пропуски или дополнительные свойства.');
    charge(2+Math.max(0,keys.length-1));
    for(const key of keys){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw error('DATA','Свойства снимка должны быть обычными данными.');
      if(!array)charge(stringBytes(key,true)+1);
      Object.defineProperty(result,key,{value:immutable(descriptor.value,budget,ancestors),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(value);return Object.freeze(result);
  }
  function same(a,b) {
    if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
  }
  function create({slot,project,plan,projectId=project?.id,contentRevision,savedRevision=null,limits,signal,previewTimeMs=null,audioOnly=false}={}) {
    if(!['editor','video'].includes(slot)||typeof projectId!=='string'||!projectId||!Number.isSafeInteger(contentRevision)||contentRevision<0||(savedRevision!==null&&(!Number.isSafeInteger(savedRevision)||savedRevision<0)))throw error('IDENTITY','Укажите независимые slot, projectId, contentRevision и savedRevision (или null).');
    if(previewTimeMs!==null&&(!Number.isFinite(previewTimeMs)||previewTimeMs<0))throw error('OFFSET','Некорректная позиция кадра.');
    const certified=receipts.get(project)?.get(plan),budget={bytes:certified??0};
    const snapshot=certified===undefined?immutable(project,budget):project,frozenPlan=certified===undefined?immutable(plan,budget):plan;
    if(slot==='editor'&&snapshot.id!==projectId)throw error('IDENTITY','Идентификатор снимка Студии не совпадает с владельцем сессии.');
    let expected;try{expected=slot==='editor'?io.adapters.fromEditor(snapshot):io.adapters.fromVideo(snapshot);}catch(e){throw e.code?e:error('PROJECT',e.message||'Неподдерживаемые данные проекта.',e);}
    if(!io.plan.isPlan(frozenPlan)||!same(expected,frozenPlan))throw error('PLAN_MISMATCH','RenderPlan не соответствует слоту и этой редакции снимка проекта.');
    const identity=Object.freeze({slot,projectId,contentRevision,savedRevision,sessionId:'render-'+ ++sequence});
    const uses=new Set();let disposed=false,closing,cleanupFailure=null;
    const noJSON=()=>{throw error('RUNTIME','Управляющую сессию нельзя сохранять как данные проекта.');};
    // A preview owns the complete immutable DTO/plan, but only a bounded frame
    // window of originals. No audio is decoded and partial windows cannot record.
    const windowFrame=previewTimeMs===null?null:io.plan.frameAt(frozenPlan,previewTimeMs);
    const windowScenes=windowFrame?[windowFrame.scene,...(windowFrame.scene.transition!=='none'&&windowFrame.scene.index?[frozenPlan.timeline[windowFrame.scene.index-1]]:[])]:null;
    if(typeof audioOnly!=='boolean'||(audioOnly&&windowFrame))throw error('SCOPE','Несовместимая область подготовки медиа.');
    const needed=new Map();
    for(const scene of audioOnly?[]:(windowScenes||frozenPlan.timeline))if(scene.visual==='image')needed.set(scene.imageId,{id:scene.imageId,kind:'image'});
    for(const role of windowFrame?[]:['voice','music']){const id=frozenPlan.audio[role].assetId;if(id){if(needed.get(id)?.kind==='image')throw error('REFERENCES','Изображение нельзя использовать как аудио.');needed.set(id,{id,kind:'audio'});}}
    let renderable=true;try{io.plan.assertRenderable(frozenPlan);}catch(_){renderable=false;}
    const media=io.media.create({owner:identity,limits,...(slot==='editor'&&!windowFrame?{audioDurationMs:frozenPlan.durationMs}:{})});
    function alive(){if(disposed)throw error('STATE','Runtime-сессия закрыта.');}
    function acquire(){alive();return media.acquire();}
    function borrowed(lease){return {voiceBuffer:lease.audio(frozenPlan.audio.voice.assetId),musicBuffer:lease.audio(frozenPlan.audio.music.assetId),...io.plan.audioOptions(frozenPlan)};}
    function busy(){alive();if(uses.size)throw error('BUSY','Остановите текущего потребителя перед новым воспроизведением или записью.');}
    function finishUse(use){use.lease.release();uses.delete(use);}
    async function playAudio({offsetSeconds=0,startPaused=false}={}) {
      if(windowFrame)throw error('PREVIEW_ONLY','Сессия кадра не подготавливает аудио.');
      busy();if(!Number.isFinite(offsetSeconds)||offsetSeconds<0||offsetSeconds>frozenPlan.durationMs/1000)throw error('OFFSET','Некорректная позиция аудио.');
      if(typeof startPaused!=='boolean')throw error('AUDIO_PLAYBACK','Некорректное состояние запуска аудио.');
      const use={kind:'audio',lease:acquire(),abort:new AbortController()},options={...borrowed(use.lease),offsetSeconds};uses.add(use);
      let context,mix,stopPromise,timer,origin=0,offset=offsetSeconds,paused=startPaused,pausePromise=Promise.resolve(),lastClock=0,advancedAt=0;
      let nativeControl=Promise.resolve(),controlEpoch=0;
      const control=run=>{nativeControl=nativeControl.catch(()=>{}).then(()=>{if(use.abort.signal.aborted||disposed)throw error('CANCELLED','Операция аудио отменена.');return run();});return nativeControl;};
      const wall=io.now||(()=>performance.now());
      const positionMs=()=>{
        if(use.abort.signal.aborted)throw error('STATE','Воспроизведение закрыто.');
        if(context&&!paused){
          const value=context.currentTime,now=wall();
          if(!Number.isFinite(value)||value<lastClock)throw error('AUDIO_CLOCK','Часы аудиопотока недоступны или переместились назад.');
          if(value>lastClock)advancedAt=now;else if(now-advancedAt>=10000)throw error('AUDIO_CLOCK','Аудиопоток не продвигается. Нажмите Play ещё раз.');
          lastClock=value;
        }
        const time=paused?offset:offset+Math.max(0,(context?.currentTime??origin)-origin);
        if(!Number.isFinite(time))throw error('AUDIO_CLOCK','Часы аудиопотока недоступны.');
        if(context&&!paused&&context.state!=='running')throw error('AUDIO_CLOCK','Аудиопоток прерван. Нажмите Play ещё раз.');
        return Math.min(frozenPlan.durationMs,time*1000);
      };
      function startMix(){mix=io.mix(context,{...options,offsetSeconds:offset,destination:context.destination});origin=context.currentTime+.02;lastClock=context.currentTime;advancedAt=wall();mix.start(origin);}
      const stop=()=>{
        if(stopPromise)return stopPromise;use.abort.abort();clearTimeout(timer);
        stopPromise=(async()=>{
          try{mix?.stop();}catch(_){/* Closing the owned context still tears down its entire graph. */}
          // A late native suspend/resume must not change a context AFTER close
          // has released its lease. Wait for the owned control queue to settle.
          let deadline;try{await Promise.race([nativeControl.catch(()=>{}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(error('AUDIO_CLOSE','Браузер не завершил изменение состояния аудио; ресурсы удерживаются. Повторите очистку или перезагрузите страницу.')),3000);})]);}finally{clearTimeout(deadline);}
          if(context&&context.state!=='closed'){
            try{await context.close();}catch(e){throw error('AUDIO_CLOSE','Не удалось закрыть AudioContext; ресурсы удерживаются до повторной очистки.',e);}
            if(context.state!=='closed')throw error('AUDIO_CLOSE','AudioContext не подтвердил закрытие; повторите очистку.');
          }
          finishUse(use);
        })().catch(e=>{stopPromise=null;throw e;});return stopPromise;
      };
      use.stop=stop;
      try {
        if(options.voiceBuffer||options.musicBuffer){
          context=io.context();
          await new Promise((resolve,reject)=>{
            const cancelled=()=>reject(error('CANCELLED','Запуск аудио отменён.'));
            use.abort.signal.addEventListener('abort',cancelled,{once:true});
            timer=setTimeout(()=>reject(error('AUDIO_GESTURE','Браузер не разрешил звук. Запустите аудио явным нажатием.')),3000);
            nativeControl=Promise.resolve(context.resume());nativeControl.then(resolve,reject).finally(()=>use.abort.signal.removeEventListener('abort',cancelled));
          });clearTimeout(timer);
          if(disposed||use.abort.signal.aborted)throw error('CANCELLED','Запуск аудио отменён.');
          if(context.state!=='running')throw error('AUDIO_GESTURE','AudioContext не запущен пользовательским действием.');
          if(startPaused){pausePromise=control(()=>context.suspend());await pausePromise;}else startMix();
          if(disposed||use.abort.signal.aborted)throw error('CANCELLED','Запуск аудио отменён.');
        }
        return Object.freeze({stop,positionMs,
          pause(){
            if(use.abort.signal.aborted)return Promise.reject(error('STATE','Воспроизведение закрыто.'));
            controlEpoch++;
            if(paused&&context?.state==='suspended')return pausePromise;
            let clockError;try{offset=positionMs()/1000;}catch(e){clockError=e;}
            paused=true;mix?.stop();mix=null;
            pausePromise=context?control(()=>context.suspend()):Promise.resolve();return clockError?pausePromise.then(()=>{throw clockError;}):pausePromise;
          },
          async resume(){
            await pausePromise;if(use.abort.signal.aborted||disposed)throw error('CANCELLED','Воспроизведение отменено.');
            if(!paused)return;const request=++controlEpoch;
            await control(async()=>{
              if(request!==controlEpoch)throw error('CANCELLED','Позиция воспроизведения устарела.');
              await context?.resume();
              if(use.abort.signal.aborted||disposed||request!==controlEpoch)throw error('CANCELLED','Воспроизведение отменено.');
              if(context&&context.state!=='running')throw error('AUDIO_GESTURE','Нажмите Play, чтобы разрешить звук.');
              if(context)startMix();paused=false;
            });
          },
          async seek(ms){
            if(!Number.isSafeInteger(ms)||ms<0||ms>frozenPlan.durationMs)throw error('OFFSET','Некорректная позиция аудио.');
            const wasPaused=paused;await this.pause();offset=ms/1000;if(!wasPaused)await this.resume();
          },toJSON:noJSON});
      }catch(e){await stop();throw e.code?e:error('AUDIO_PLAYBACK',e.message||'Не удалось запустить аудио.',e);}
    }
    async function record({canvas,onProgress,onFormat,signal:external}={}){
      if(windowFrame||audioOnly)throw error('PREVIEW_ONLY','Для записи нужна полная подготовка медиа.');
      busy();io.plan.assertRenderable(frozenPlan);
      const use={kind:'record',lease:acquire(),abort:new AbortController()};uses.add(use);
      const stop=()=>use.abort.abort();use.stop=stop;external?.addEventListener('abort',stop,{once:true});if(external?.aborted)stop();
      try{return await io.record({canvas,plan:frozenPlan,resources:use.lease.resources,...borrowed(use.lease),format:frozenPlan.exportSettings.format,signal:use.abort.signal,onProgress,onFormat});}
      finally{external?.removeEventListener('abort',stop);finishUse(use);}
    }
    function close(cancelled){
      if(closing)return closing;disposed=true;signal?.removeEventListener('abort',lifetimeAbort);
      // Each owned consumer retains its lease until graph/context/recorder cleanup
      // actually finishes. External borrowers must release their own leases.
      const ending=cancelled?media.cancel():media.dispose();
      const stopping=[...uses].map(use=>Promise.resolve().then(()=>use.stop()));
      closing=Promise.allSettled(stopping).then(results=>{const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;return ending;}).then(()=>{cleanupFailure=null;}).catch(e=>{cleanupFailure=e;closing=null;throw e;});return closing;
    }
    function cancel(){return close(true);}
    function lifetimeAbort(){cancel().catch(e=>{cleanupFailure=e;});}
    signal?.addEventListener('abort',lifetimeAbort,{once:true});if(signal?.aborted)lifetimeAbort();
    return Object.freeze({identity,snapshot,plan:frozenPlan,
      prepare:options=>{alive();return media.prepare([...needed.values()],options);}, acquire,
      renderFrame(canvas,time){alive();if(audioOnly)throw error('AUDIO_ONLY','Аудиосессия не подготавливает изображения.');io.plan.assertRenderable(frozenPlan);if(windowFrame&&io.plan.frameAt(frozenPlan,time).scene.id!==windowFrame.scene.id)throw error('FRAME_WINDOW','Подготовьте окно новой сцены.');if([...uses].some(use=>use.kind==='record'))throw error('BUSY','Canvas занят записью сессии.');const lease=acquire();try{return io.render(canvas,frozenPlan,time,lease.resources);}finally{lease.release();}},
      playAudio,record,cancel,dispose:()=>close(false),
      status(){const s=media.status();return Object.freeze({...s,state:s.state==='ready'&&s.consumers?'use':s.state,identity,renderable,disposed,dataBytes:budget.bytes,neededMedia:needed.size,previewSceneId:windowFrame?.scene.id||null,ownedConsumers:uses.size,error:cleanupFailure?{code:cleanupFailure.code,message:cleanupFailure.message}:s.error});},toJSON:noJSON});
  }
  return Object.freeze({create,createAudio:options=>create({...options,audioOnly:true}),snapshotData:(project,plan)=>{const budget={bytes:0};const data=Object.freeze({project:immutable(project,budget),plan:immutable(plan,budget)});if(!data.project||typeof data.project!=='object'||!data.plan||typeof data.plan!=='object')throw error('DATA','Снимок проекта и план должны быть JSON-объектами.');receipts.set(data.project,new WeakMap([[data.plan,budget.bytes]]));return data;},createPreview:options=>{if(!Number.isFinite(options?.timeMs)||options.timeMs<0)throw error('OFFSET','Укажите позицию кадра в миллисекундах.');return create({...options,previewTimeMs:options.timeMs});},MAX_DATA_BYTES});
});
