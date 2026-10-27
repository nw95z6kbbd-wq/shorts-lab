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
window.testBackupCaptureBothModes = async function () {
  const assert=(v,label)=>{if(!v)throw Error('Capture: '+label);};await ShortsStorage.ready;await ShortsStorage.load('editor');await ShortsStorage.load('video');
  const editor=ShortsCore.upgradeProject(ShortsCore.createProject(true)),video=ShortsVideoCore.demo();
  Object.assign(editor.scenes[0],{visual:'animated',imageId:'capture-image'});editor.audio.voice.assetId='capture-voice';editor.audio.music.assetId='capture-music';
  Object.assign(video.scenes[0],{visual:'image',imageId:'capture-image'});video.voiceAssetId='capture-voice';
  const files=[['capture-image','image','image/png'],['capture-voice','voice','audio/wav'],['capture-music','music','audio/wav']].map(([id,kind,type])=>({id,kind,name:id,blob:new Blob([id],{type})}));
  for(const f of files)ShortsStorage.stage(f.id,f.blob,f.name,f.kind);
  await holdUXTransaction();const saves=[ShortsStorage.save(editor),ShortsStorage.save(video,'video')];setTimeout(()=>{window.uxHold=false;},40);
  const captured=await ShortsStorage.captureBackup({editor,video},64*1048576);
  assert((await Promise.all(saves)).every(r=>r.ok),'queued saves commit');assert(captured.size===3,'both modes include shared, inactive and private pending originals');
  for(const f of files){const a=captured.get(f.id);assert(a.blob.type===f.blob.type&&await a.blob.text()===await f.blob.text(),'captured original '+f.id);}
  const r=ShortsProjectDB.createRepository(),before=JSON.stringify([await r.read('editor'),await r.read('video')]);
  const missing=structuredClone(editor);missing.scenes[0].imageId='capture-missing';let denied=false;
  try{await ShortsStorage.captureBackup({editor:missing,video},64*1048576);}catch(e){denied=e.message.includes('capture-missing');}assert(denied,'missing inactive Studio original is an explicit error');
  denied=false;try{await ShortsStorage.captureBackup({editor,video},1);}catch(e){denied=e.code==='LIMIT';}assert(denied,'capture limit refuses partial media');
  assert(JSON.stringify([await r.read('editor'),await r.read('video')])===before,'failed captures leave both heads/recovery unchanged');
  for(const f of files)assert(await (await r.asset(f.id)).blob.text()===await f.blob.text(),'failed capture preserves original '+f.id);r.close();return true;
};
void 0;
