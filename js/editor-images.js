(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorImages=factory({media:root.ShortsMediaSessions,storage:root.ShortsStorage,id:()=>root.ShortsCore.id(),crc32:bytes=>root.ShortsZip.crc32(bytes)});
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
 return Object.freeze({create,MAX_FILE,MAX_PENDING});
});
