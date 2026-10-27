window.testBackupStorageGate = async function (fail) {
  const assert=(v,label)=>{if(!v)throw Error(label);};await ShortsStorage.ready;await ShortsStorage.load('editor');await ShortsStorage.load('video');
  const editor=ShortsCore.createProject(),video=ShortsVideoCore.demo();editor.name='Old editor';video.title='Old video';
  assert((await ShortsStorage.save(editor)).ok && (await ShortsStorage.save(video,'video')).ok,'initial save');
  const next={editor:{...editor,name:'Imported editor'},video:{...video,title:'Imported video'}};
  const put=IDBObjectStore.prototype.put;
  if(fail)IDBObjectStore.prototype.put=function(value){if(this.name==='projects'&&value.id==='editor')throw new DOMException('quota','QuotaExceededError');return put.call(this,value);};
  await holdUXTransaction();
  const restoring=ShortsStorage.restoreBackup(next,[]).then(()=>true,()=>false);
  await new Promise(r=>setTimeout(r,20));
  const lateSave=ShortsStorage.save(video,'video');window.uxHold=false;
  const imported=await restoring;IDBObjectStore.prototype.put=put;
  const late=await lateSave;
  const db=ShortsProjectDB.createRepository(),head=await db.read('video');db.close();
  if(fail){assert(!imported && late.ok,'old pending autosave resumes on failed restore');assert(head.state.title==='Old video','failed import leaves original content');}
  else{assert(imported && !late.ok,'old autosave held through commit');assert(head.state.title==='Imported video','late old state cannot overwrite import');}
  return true;
};
void 0;
