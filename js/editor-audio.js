(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorAudio=factory({core:root.ShortsCore,media:root.ShortsMediaSessions,runtime:root.ShortsRenderSessions,storage:root.ShortsStorage});
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 const fail=(code,message)=>Object.assign(new Error(message),{code});
 const MAX_FILE=25*1048576,MAX_PENDING=64*1048576;
 async function checkType(file){
  const b=new Uint8Array(await file.slice(0,16).arrayBuffer()),text=(at,n)=>String.fromCharCode(...b.slice(at,at+n));
  const type=file.type.toLowerCase().split(';')[0];
  const allowed=text(0,4)==='RIFF'&&text(8,4)==='WAVE'?['audio/wav','audio/wave','audio/x-wav','audio/vnd.wave']:
    text(0,4)==='fLaC'?['audio/flac','audio/x-flac']:text(0,4)==='OggS'?['audio/ogg','application/ogg']:
    text(4,4)==='ftyp'?['audio/mp4','audio/x-m4a','audio/m4a','video/mp4']:
    text(0,3)==='ID3'?['audio/mpeg','audio/mp3']:null;
  if(type&&type!=='application/octet-stream'&&allowed&&!allowed.includes(type))throw fail('MEDIA_TYPE','MIME аудио не совпадает с его содержимым. Выберите исходный файл с корректным типом.');
 }
 function fadeMs(raw){
  const value=String(raw).trim();
  if(!/^(?:\d+(?:[.,]\d{1,3})?|[.,]\d{1,3})$/.test(value))throw fail('AUDIO_INPUT','Введите время затухания от 0 секунд, до трёх знаков после запятой.');
  const [whole,fraction='']=value.replace(',','.').split('.'),ms=BigInt(whole||'0')*1000n+BigInt(fraction.padEnd(3,'0'));
  if(ms>BigInt(Number.MAX_SAFE_INTEGER))throw fail('AUDIO_INPUT','Время затухания не помещается в целые миллисекунды.');return Number(ms);
 }
 function edit(project,role,patch){
  if(!['voice','music'].includes(role))throw fail('AUDIO_ROLE','Неизвестная звуковая дорожка.');
  const next=io.core.upgradeProject(project);
  next.audio[role]={...next.audio[role],...patch};
  return io.core.parseProject(next);
 }
 // Same storage staging and bounded native decoder as runtime preparation.
 // Only a successfully decoded original may become a saved DTO reference.
 function createUploads({owner,valid,accept,requirements=()=>null,onState=()=>{}}){
  let generation=0,tail=Promise.resolve();const current=new Map(),accepted=new Map();
  function cancel(role){const requests=role?[current.get(role)].filter(Boolean):[...current.values()];for(const request of requests){current.delete(request.role);request.session?.cancel().catch(()=>{});onState(request.role,'cancelled');}return Promise.all(requests.map(r=>r.session?.dispose()));}
  function load(role,file){
   cancel(role);const token=++generation,projectId=owner(),request={role,session:null};current.set(role,request);onState(role,'loading');
   const operation=async()=>{
    if(current.get(role)!==request)return false;let session,id,attached=false;
    try{
     if(!['voice','music'].includes(role))throw fail('AUDIO_ROLE','Неизвестная звуковая дорожка.');
     if(!file?.size||file.size>MAX_FILE)throw fail('FILE_SIZE','Выберите непустой аудиофайл размером до 25 МиБ.');
     if(!file.name||file.name.length>200||/[\\/\u0000-\u001f\u007f]/.test(file.name))throw fail('MEDIA_NAME','Имя аудио должно содержать до 200 символов без разделителей пути и управляющих знаков.');
     if(file.type&&!/^audio\//.test(file.type)&&!['application/octet-stream','video/mp4','video/webm','application/ogg'].includes(file.type))throw fail('MEDIA_TYPE','Тип файла не подходит для аудио. Выберите WAV, MP3, M4A, OGG или другой поддерживаемый браузером аудиофайл.');
     await checkType(file);if(current.get(role)!==request)return false;
     let pending=0;for(const [key,size] of accepted){if(!io.storage.pending(key))accepted.delete(key);else pending+=size;}
     if(pending+file.size>MAX_PENDING)throw fail('PENDING_BUDGET','Несохранённые аудиооригиналы превышают 64 МиБ. Дождитесь сохранения; прежние файлы не удалены.');
     if(!valid(projectId))return false;
     id=io.core.id();io.storage.stage(id,file,file.name,role);
     const config=requirements(role,id);
     session=io.media.create({owner:{slot:'editor',projectId,contentRevision:token},audioDurationMs:config?.durationMs??null});request.session=session;
     await session.prepare([{id,kind:'audio'},...(config?.otherIds||[]).map(id=>({id,kind:'audio'}))]);
     if(JSON.stringify(config)!==JSON.stringify(requirements(role,id)))throw fail('CANCELLED','Звуковой состав или длительность проекта изменились во время подготовки. Выберите файл повторно.');
     if(current.get(role)!==request||!valid(projectId))return false;
     const acceptedResult=accept(role,{assetId:id,name:file.name});
     attached=acceptedResult===true||acceptedResult?.accepted===true;
     if(attached){accepted.set(id,file.size);await acceptedResult?.ready;if(current.get(role)===request&&valid(projectId))onState(role,'ready');}return attached;
    }catch(error){if(current.get(role)===request)onState(role,'error',error);return false;}
    finally{await session?.dispose();if(id&&!attached)io.storage.discard(id);if(current.get(role)===request)current.delete(role);}
   };
   tail=tail.then(operation,operation);return tail;
  }
  return Object.freeze({load,cancel,retain(ids){for(const id of accepted.keys())if(!ids.has(id)){io.storage.discard(id);accepted.delete(id);}},async dispose(){await cancel();await tail;},status:()=>({loading:current.size>0,generation})});
 }
 function createPlayback({onState=()=>{}}={}){
  let active=null,key=null,generation=0,operation=0,tail=Promise.resolve(),failure=null,preparing=false;
  function close(){
   generation++;operation++;key=null;preparing=false;
   // Cancel synchronously, but do not admit a new owner until cleanup succeeds.
   active?.session.cancel().catch(()=>{});
   tail=tail.catch(()=>{}).then(async()=>{
    const old=active;await old?.session.dispose();if(active===old)active=null;failure=null;
   }).catch(e=>{failure=e;onState('error',e);throw e;});
   tail.catch(()=>{});return tail;
  }
  function update(project,plan,revision){
   const next=JSON.stringify([project.id,revision]);if(key===next)return tail;
   close();key=next;const token=generation;
   if(!plan||!['voice','music'].some(r=>plan.audio[r].assetId)){
    if(active){preparing=true;onState('loading');tail=tail.then(()=>{if(token===generation){preparing=false;onState('silent');}});tail.catch(()=>{});}
    else onState('silent');return tail;
   }
   let data;try{data=io.runtime.snapshotData(project,plan);}catch(e){tail=tail.then(()=>{if(token===generation){failure=e;onState('error',e);}});tail.catch(()=>{});return tail;}
   preparing=true;onState('loading');
   tail=tail.then(async()=>{
    if(token!==generation)return;
    if(failure)throw failure;
    const session=io.runtime.createAudio({slot:'editor',projectId:project.id,...data,contentRevision:revision,savedRevision:null});
    const item={session,handle:null};active=item;
    try{await session.prepare();if(token!==generation)return;preparing=false;onState('ready');}
    catch(e){if(token===generation){preparing=false;failure=e;onState('error',e);}await session.dispose();if(active===item)active=null;}
   });tail.catch(e=>{if(token===generation){failure=e;preparing=false;onState('error',e);}});return tail;
  }
  async function start(ms,{paused=false}={}){
   const item=active,token=generation,request=++operation;if(!item||preparing||failure)throw failure||fail('AUDIO_LOADING','Дождитесь подготовки аудио.');
   try{
   if(!item.handle){
    if(!item.starting){const pending=item.session.playAudio({offsetSeconds:ms/1000,startPaused:true});item.starting=pending;pending.then(()=>{if(item.starting===pending)item.starting=null;},()=>{if(item.starting===pending)item.starting=null;});}
    item.handle=await item.starting;
   }
   if(token!==generation){await item.handle.stop();throw fail('CANCELLED','Запуск аудио устарел.');}
   const current=()=>{if(token!==generation||request!==operation)throw fail('CANCELLED','Позиция запуска аудио устарела.');};
   current();if(paused)await item.handle.pause();current();await item.handle.seek(Math.floor(ms));current();if(!paused)await item.handle.resume();current();
   }catch(e){
    if(token===generation&&request===operation&&e.code!=='CANCELLED'&&item.handle){
     try{await item.handle.stop();item.handle=null;}catch(cleanup){failure=cleanup;onState('error',cleanup);throw cleanup;}
    }
    throw e;
   }
  }
  return Object.freeze({update,start,close,settled:()=>tail,
   pause(){operation++;return active?.handle?.pause()||Promise.resolve();},
   positionMs(){return active?.handle?.positionMs()??null;},
   status(){return {ready:!!active&&!preparing&&!failure,preparing,error:failure?{code:failure.code,message:failure.message}:null,active:active?.session.status()||null};},
   retry(){failure=null;key=null;}
  });
 }
 return Object.freeze({edit,fadeMs,createUploads,createPlayback,MAX_FILE,MAX_PENDING});
});
