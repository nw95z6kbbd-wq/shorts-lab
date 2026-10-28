(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorImages=factory({media:root.ShortsMediaSessions,storage:root.ShortsStorage,id:()=>root.ShortsCore.id()});
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 const MAX_FILE=15*1048576,MAX_PENDING=64*1048576;
 function create({owner,valid,accept,onState=()=>{}}){
  let generation=0,current=null,tail=Promise.resolve();const accepted=new Map();
  function cancel(){generation++;const old=current;current=null;if(old){old.session?.cancel().catch(()=>{});onState(old.sceneId,'cancelled');}return old?.session?.dispose()||Promise.resolve();}
  function load(sceneId,file){
   cancel();const token=generation,projectId=owner(),request={sceneId,token,session:null};current=request;onState(sceneId,'loading');
   const operation=async()=>{
    if(token!==generation)return false;let session,id,attached=false;
    try{
     if(!file||!file.size||file.size>MAX_FILE)throw Error('Выберите PNG, JPEG или WebP размером до 15 МиБ.');
     if(file.name&&(file.name.length>200||/[\\/\u0000-\u001f\u007f]/.test(file.name)))throw Error('Имя изображения должно содержать до 200 символов без разделителей пути и управляющих знаков. Оригинал не изменён.');
     if(file.type&&!['image/png','image/jpeg','image/webp','application/octet-stream'].includes(file.type))throw Error('Недопустимый MIME изображения. Выберите PNG, JPEG или WebP.');
     let pending=0;for(const [key,size] of accepted){if(!io.storage.pending(key))accepted.delete(key);else pending+=size;}
     if(pending+file.size>MAX_PENDING)throw Error('Несохранённые оригиналы превышают 64 МиБ. Дождитесь успешного сохранения или сохраните ZIP; исходные данные не удалены.');
     if(!valid(sceneId,projectId))return false;
     id=io.id();io.storage.stage(id,file,file.name||'Изображение','image');
     session=io.media.create({owner:{slot:'editor',projectId,contentRevision:token},limits:{maxImages:1}});request.session=session;
     await session.prepare([{id,kind:'image'}]);
     if(token!==generation||!valid(sceneId,projectId))return false;
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
