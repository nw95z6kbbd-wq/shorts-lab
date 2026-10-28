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
  function immutable(value,budget={bytes:0},ancestors=new Set()) {
    const charge=n=>{budget.bytes+=n;if(budget.bytes>MAX_DATA_BYTES)throw error('DATA_BUDGET','Снимок и план превышают технический бюджет JSON 16 МиБ.');};
    const stringBytes=text=>{if(text.length>MAX_DATA_BYTES-budget.bytes)charge(MAX_DATA_BYTES+1);return new TextEncoder().encode(JSON.stringify(text)).length;};
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
      if(!array)charge(stringBytes(key)+1);
      Object.defineProperty(result,key,{value:immutable(descriptor.value,budget,ancestors),enumerable:true,writable:true,configurable:true});
    }
    ancestors.delete(value);return Object.freeze(result);
  }
  function same(a,b) {
    if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
  }
  function create({slot,project,plan,projectId=project?.id,contentRevision,savedRevision=null,limits,signal}={}) {
    if(!['editor','video'].includes(slot)||typeof projectId!=='string'||!projectId||!Number.isSafeInteger(contentRevision)||contentRevision<0||(savedRevision!==null&&(!Number.isSafeInteger(savedRevision)||savedRevision<0)))throw error('IDENTITY','Укажите независимые slot, projectId, contentRevision и savedRevision (или null).');
    const budget={bytes:0},snapshot=immutable(project,budget),frozenPlan=immutable(plan,budget);
    if(slot==='editor'&&snapshot.id!==projectId)throw error('IDENTITY','Идентификатор снимка Студии не совпадает с владельцем сессии.');
    let expected;try{expected=slot==='editor'?io.adapters.fromEditor(snapshot):io.adapters.fromVideo(snapshot);}catch(e){throw e.code?e:error('PROJECT',e.message||'Неподдерживаемые данные проекта.',e);}
    if(!io.plan.isPlan(frozenPlan)||!same(expected,frozenPlan))throw error('PLAN_MISMATCH','RenderPlan не соответствует слоту и этой редакции снимка проекта.');
    const identity=Object.freeze({slot,projectId,contentRevision,savedRevision,sessionId:'render-'+ ++sequence});
    const uses=new Set();let disposed=false,closing,cleanupFailure=null;
    const noJSON=()=>{throw error('RUNTIME','Управляющую сессию нельзя сохранять как данные проекта.');};
    const needed=new Map();
    for(const scene of frozenPlan.timeline)if(scene.visual==='image')needed.set(scene.imageId,{id:scene.imageId,kind:'image'});
    for(const role of ['voice','music']){const id=frozenPlan.audio[role].assetId;if(id){if(needed.get(id)?.kind==='image')throw error('REFERENCES','Изображение нельзя использовать как аудио.');needed.set(id,{id,kind:'audio'});}}
    let renderable=true;try{io.plan.assertRenderable(frozenPlan);}catch(_){renderable=false;}
    const media=io.media.create({owner:identity,limits});
    function alive(){if(disposed)throw error('STATE','Runtime-сессия закрыта.');}
    function acquire(){alive();return media.acquire();}
    function borrowed(lease){return {voiceBuffer:lease.audio(frozenPlan.audio.voice.assetId),musicBuffer:lease.audio(frozenPlan.audio.music.assetId),...io.plan.audioOptions(frozenPlan)};}
    function busy(){alive();if(uses.size)throw error('BUSY','Остановите текущего потребителя перед новым воспроизведением или записью.');}
    function finishUse(use){use.lease.release();uses.delete(use);}
    async function playAudio({offsetSeconds=0}={}) {
      busy();if(!Number.isFinite(offsetSeconds)||offsetSeconds<0||offsetSeconds>frozenPlan.durationMs/1000)throw error('OFFSET','Некорректная позиция аудио.');
      const use={kind:'audio',lease:acquire(),abort:new AbortController()},options={...borrowed(use.lease),offsetSeconds};uses.add(use);
      let context,mix,stopPromise,timer;
      const stop=()=>{
        if(stopPromise)return stopPromise;use.abort.abort();clearTimeout(timer);
        stopPromise=(async()=>{
          try{mix?.stop();}catch(_){/* Closing the owned context still tears down its entire graph. */}
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
            Promise.resolve(context.resume()).then(resolve,reject).finally(()=>use.abort.signal.removeEventListener('abort',cancelled));
          });clearTimeout(timer);
          if(disposed||use.abort.signal.aborted)throw error('CANCELLED','Запуск аудио отменён.');
          if(context.state!=='running')throw error('AUDIO_GESTURE','AudioContext не запущен пользовательским действием.');
          mix=io.mix(context,{...options,destination:context.destination});mix.start(context.currentTime+.02);
        }
        return Object.freeze({stop,toJSON:noJSON});
      }catch(e){await stop();throw e.code?e:error('AUDIO_PLAYBACK',e.message||'Не удалось запустить аудио.',e);}
    }
    async function record({canvas,onProgress,onFormat,signal:external}={}){
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
      renderFrame(canvas,time){alive();io.plan.assertRenderable(frozenPlan);if([...uses].some(use=>use.kind==='record'))throw error('BUSY','Canvas занят записью сессии.');const lease=acquire();try{return io.render(canvas,frozenPlan,time,lease.resources);}finally{lease.release();}},
      playAudio,record,cancel,dispose:()=>close(false),
      status(){const s=media.status();return Object.freeze({...s,state:s.state==='ready'&&s.consumers?'use':s.state,identity,renderable,disposed,dataBytes:budget.bytes,neededMedia:needed.size,ownedConsumers:uses.size,error:cleanupFailure?{code:cleanupFailure.code,message:cleanupFailure.message}:s.error});},toJSON:noJSON});
  }
  return Object.freeze({create,MAX_DATA_BYTES});
});
