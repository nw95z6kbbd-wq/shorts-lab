(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorImages=factory({media:root.ShortsMediaSessions,storage:root.ShortsStorage,id:()=>root.ShortsCore.id(),crc32:bytes=>root.ShortsZip.crc32(bytes),observer:callback=>new root.IntersectionObserver(callback),canvas:()=>root.document.createElement('canvas'),urls:root.URL});
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 const failure=(code,message)=>Object.assign(new Error(message),{code});
 const MAX_FILE=15*1048576,MAX_PENDING=64*1048576;
 const crc32=io.crc32||(typeof require==='function'?require('./zip-store.js').crc32:null);
 async function checkPNG(file,current){
  const signature=new Uint8Array(await file.slice(0,8).arrayBuffer());
  if(![137,80,78,71,13,10,26,10].every((v,i)=>signature[i]===v))return;
  let at=8,count=0,data=false;
  while(at+12<=file.size){
   if(!current())throw failure('CANCELLED','Проверка изображения отменена.');
   if(++count>4096)throw failure('IMAGE_STRUCTURE','PNG содержит больше 4096 блоков. Пересохраните изображение для безопасной проверки.');
   const head=new DataView(await file.slice(at,at+8).arrayBuffer()),size=head.getUint32(0),type=String.fromCharCode(...new Uint8Array(head.buffer,4,4));
   if(at+size+12>file.size)throw failure('IMAGE_INTEGRITY','PNG обрезан или имеет неверную структуру.');
   const bytes=new Uint8Array(await file.slice(at+4,at+8+size).arrayBuffer()),expected=new DataView(await file.slice(at+8+size,at+12+size).arrayBuffer()).getUint32(0);
   if(await crc32(bytes)!==expected)throw failure('IMAGE_INTEGRITY','Нарушена контрольная сумма блока PNG. Оригинал не принят.');
   if(count===1&&(type!=='IHDR'||size!==13))throw failure('IMAGE_STRUCTURE','В PNG отсутствует корректный заголовок IHDR.');
   if(type==='IDAT')data=true;
   at+=size+12;
   if(type==='IEND'){if(size!==0||!data||at!==file.size)throw failure('IMAGE_STRUCTURE','Некорректное окончание PNG.');return;}
  }
  throw failure('IMAGE_INTEGRITY','PNG не содержит полного окончания IEND.');
 }

 function create({owner,valid,accept,onState=()=>{}}){
  let generation=0,current=null,tail=Promise.resolve();const accepted=new Map();
  function cancel(){generation++;const old=current;current=null;if(old){old.session?.cancel().catch(()=>{});onState(old.sceneId,'cancelled');}return old?.session?.dispose()||Promise.resolve();}
  function load(sceneId,file){
   cancel();const token=generation,projectId=owner(),request={sceneId,token,session:null};current=request;onState(sceneId,'loading');
   const operation=async()=>{
    if(token!==generation)return false;let session,id,attached=false;
    try{
     if(!file||!file.size||file.size>MAX_FILE)throw failure('FILE_SIZE','Выберите PNG, JPEG или WebP размером до 15 МиБ.');
     if(file.name&&(file.name.length>200||/[\\/\u0000-\u001f\u007f]/.test(file.name)))throw failure('MEDIA_NAME','Имя изображения должно содержать до 200 символов без разделителей пути и управляющих знаков. Оригинал не изменён.');
     if(file.type&&!['image/png','image/jpeg','image/webp','application/octet-stream'].includes(file.type))throw failure('MEDIA_TYPE','Недопустимый MIME изображения. Выберите PNG, JPEG или WebP.');
     let pending=0;for(const [key,size] of accepted){if(!io.storage.pending(key))accepted.delete(key);else pending+=size;}
     if(pending+file.size>MAX_PENDING)throw failure('PENDING_BUDGET','Несохранённые оригиналы превышают 64 МиБ. Дождитесь успешного сохранения или сохраните ZIP; исходные данные не удалены.');
     await checkPNG(file,()=>token===generation);
     if(token!==generation)return false;
     if(!valid(sceneId,projectId)){onState(sceneId,'cancelled');return false;}
     id=io.id();io.storage.stage(id,file,file.name||'Изображение','image');
     session=io.media.create({owner:{slot:'editor',projectId,contentRevision:token},limits:{maxImages:1}});request.session=session;
     await session.prepare([{id,kind:'image'}]);
     if(token!==generation||!valid(sceneId,projectId)){if(token===generation)onState(sceneId,'cancelled');return false;}
     attached=accept(sceneId,{id,name:file.name||'Изображение'})===true;
     if(attached){accepted.set(id,file.size);onState(sceneId,'ready');}return attached;
    }catch(error){if(token===generation)onState(sceneId,'error',error);return false;}
    finally{await session?.dispose();if(id&&!attached)io.storage.discard(id);if(current===request)current=null;}
   };
   // Even uncancellable decodes finish cleanup before the next admission.
   tail=tail.then(operation,operation);return tail;
  }
  return Object.freeze({load,cancel,retain(ids){for(const key of accepted.keys())if(!ids.has(key)){io.storage.discard(key);accepted.delete(key);}},dispose:async()=>{await cancel();await tail;},status:()=>({generation,loading:!!current,ownedPending:accepted.size})});
 }
 // A view-only projection of originals. Never stage/discard files or retain a
 // full decoded original for each card: use the existing bounded media owner,
 // downsample once, then release its lease before admitting the next source.
 function createThumbnails(){
  const entries=new Map(),MAX_VISIBLE=8;let active=true,closed=false,running=false,serial=0,loading=null,queued=false;
  const current=request=>active&&!closed&&request.entry.visible&&entries.get(request.entry.target)===request.entry&&request.entry.generation===request.generation;
  function clear(entry){
   entry.generation=++serial;entry.state='idle';entry.image.hidden=true;entry.image.removeAttribute('src');entry.message.textContent='';
   entry.image.onload=entry.image.onerror=null;
   if(entry.url){io.urls.revokeObjectURL(entry.url);entry.url=null;}
   if(loading?.entry===entry)loading.session?.cancel().catch(()=>{});
  }
  function kick(){if(!queued){queued=true;queueMicrotask(()=>{queued=false;void pump();});}}
  async function pump(){
   if(running||!active||closed)return;running=true;
   try{while(active&&!closed){
    if([...entries.values()].filter(e=>e.state==='ready').length>=MAX_VISIBLE)break;
    const entry=[...entries.values()].find(e=>e.visible&&e.assetId&&e.state==='idle');if(!entry)break;
    const request={entry,generation:entry.generation,session:null};loading=request;entry.state='loading';
    let lease,canvas;
    try{
     const session=io.media.create({owner:{slot:'editor',projectId:entry.projectId,contentRevision:entry.generation},limits:{maxImages:1}});request.session=session;
     await session.prepare([{id:entry.assetId,kind:'image'}]);if(!current(request))continue;
     lease=session.acquire();const source=lease.resources.images.get(entry.assetId);
     canvas=io.canvas();canvas.width=116;canvas.height=144;
     const context=canvas.getContext('2d');if(!context)throw failure('CANVAS','Браузер не смог подготовить миниатюру.');
     const width=source.width||source.naturalWidth,height=source.height||source.naturalHeight,scale=Math.max(canvas.width/width,canvas.height/height);
     context.drawImage(source,(canvas.width-width*scale)/2,(canvas.height-height*scale)/2,width*scale,height*scale);
     const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(failure('CANVAS','Не удалось создать миниатюру.')),'image/png'));
     if(!current(request))continue;
     const url=io.urls.createObjectURL(blob);entry.url=url;
     // Completion also belongs to the same card/project/source generation.
     entry.image.onload=()=>{if(current(request)){entry.image.hidden=false;entry.message.textContent='';}};
     entry.image.onerror=()=>{if(current(request)){entry.image.hidden=true;entry.state='error';io.urls.revokeObjectURL(entry.url);entry.url=null;entry.image.removeAttribute('src');entry.message.textContent='Миниатюра недоступна. Оригинал не изменён.';kick();}};
     entry.image.src=url;entry.state='ready';
    }catch(error){if(current(request)){entry.state='error';entry.message.textContent='Миниатюра недоступна: '+(error.message||'ошибка изображения')+' Оригинал не изменён.';}}
    finally{if(canvas){canvas.width=0;canvas.height=0;}lease?.release();await request.session?.dispose();if(loading===request)loading=null;}
   }}finally{running=false;}
  }
  const observer=io.observer(changes=>{for(const change of changes){const entry=entries.get(change.target);if(!entry)continue;entry.visible=change.isIntersecting;if(!entry.visible)clear(entry);}kick();});
  return Object.freeze({
   track(target,image,message,{projectId,assetId,name,index}){
    if(closed)return;let entry=entries.get(target);
    if(!assetId){if(entry){clear(entry);entries.delete(target);observer.unobserve(target);kick();}return;}
    if(!entry){entry={target,image,message,visible:false,url:null,generation:++serial,state:'idle'};entries.set(target,entry);observer.observe(target);}
    if(entry.projectId!==projectId||entry.assetId!==assetId){clear(entry);entry.projectId=projectId;entry.assetId=assetId;}
    image.alt='Изображение сцены '+(index+1)+(name?' — '+name:'');kick();
   },
   remove(target){const entry=entries.get(target);if(entry){clear(entry);entries.delete(target);observer.unobserve(target);}kick();},
   suspend(){active=false;for(const entry of entries.values())clear(entry);},
   resume(){if(!closed){active=true;kick();}},
   dispose(){closed=true;active=false;observer.disconnect();for(const entry of entries.values())clear(entry);entries.clear();},
   status:()=>({tracked:entries.size,ready:[...entries.values()].filter(e=>e.state==='ready').length,preparing:!!loading,maxVisible:MAX_VISIBLE})
  });
 }
 return Object.freeze({create,createThumbnails,MAX_FILE,MAX_PENDING});
});
