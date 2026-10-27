window.testAtomicBackupRepository = async function () {
  const assert=(v,label)=>{if(!v)throw Error(label);},repo=ShortsProjectDB.createRepository('zip-atomic-test');
  const editor=ShortsCore.createProject(),video={...ShortsVideoCore.demo(),voiceAssetId:'old-voice',voiceName:'old.wav'};
  video.scenes[0].visual='image';video.scenes[0].imageId='old-image';
  await repo.migrate([{id:'editor',state:editor},{id:'video',state:video}],[{id:'old-image',blob:new Blob(['old image']),name:'old.png',kind:'image'},{id:'old-voice',blob:new Blob(['old voice']),name:'old.wav',kind:'voice'}],{});
  const before=JSON.stringify([await repo.read('editor'),await repo.read('video')]);
  const next={editor:{...editor,name:'Imported'},video:{...video,title:'Imported',voiceAssetId:'new-voice',musicAssetId:'new-music'}};
  next.video.scenes=next.video.scenes.map((s,i)=>i?{...s}:{...s,imageId:'new-image'});
  const files=[{id:'new-image',blob:new Blob(['new image']),name:'new.png',kind:'image'},{id:'new-voice',blob:new Blob(['new voice']),name:'new.wav',kind:'voice'},{id:'new-music',blob:new Blob(['new music']),name:'music.wav',kind:'music'}];
  const original=IDBObjectStore.prototype.put;
  for(const name of ['QuotaExceededError','AbortError']){
    IDBObjectStore.prototype.put=function(value){if(this.name==='projects'&&value.id==='video')throw new DOMException('fault',name);return original.call(this,value);};
    let caught=false;try{await repo.restoreBackup(next,{editor:1,video:1},files);}catch(e){caught=e.name===name;}finally{IDBObjectStore.prototype.put=original;}
    assert(caught,'injected '+name);assert(JSON.stringify([await repo.read('editor'),await repo.read('video')])===before,'both heads roll back');
    assert(!await repo.asset('new-image') && !await repo.asset('new-voice') && !await repo.asset('new-music'),'no partially written originals');
    assert(await (await repo.asset('old-image')).blob.text()==='old image','old bytes untouched');
  }
  // Abort after a new original actually completed its write request, rather
  // than only throwing before queued requests have reached the database.
  const add=IDBObjectStore.prototype.add;let wrote=false,aborted=false;
  IDBObjectStore.prototype.add=function(value){const request=add.call(this,value);if(this.name==='assets'&&value.id==='new-image')request.addEventListener('success',()=>{wrote=true;this.transaction.abort();});return request;};
  try{await repo.restoreBackup(next,{editor:1,video:1},files);}catch(e){aborted=e.name==='AbortError';}finally{IDBObjectStore.prototype.add=add;}
  assert(wrote&&aborted,'abort after a completed media write');
  assert(JSON.stringify([await repo.read('editor'),await repo.read('video')])===before && !await repo.asset('new-image') && !await repo.asset('new-music'),'completed requests roll back both heads and originals');
  let missing=false;try{await repo.restoreBackup(next,{editor:1,video:1},files.slice(1));}catch(_){missing=true;}assert(missing,'missing originals rejected');
  const a=await repo.restoreBackup(next,{editor:1,video:1},files);assert(a.every(r=>r.revision===2),'both revisions commit together');
  assert((await repo.read('video')).previous.state.voiceAssetId==='old-voice' && await repo.asset('old-voice'),'previous state and media retained');
  const repeated=await repo.restoreBackup(next,{editor:2,video:2},files);assert(repeated.every(r=>r.revision===3),'same import reuses identical original IDs');
  const damaged=files.map(f=>f.id==='new-image'?{...f,blob:new Blob(['conflict'])}:f);
  let collision=false;try{await repo.restoreBackup(next,{editor:3,video:3},damaged);}catch(e){collision=e.code==='COLLISION';}assert(collision && (await repo.read('editor')).revision===3,'collision never overwrites either slot');
  const races=await Promise.allSettled([repo.restoreBackup(next,{editor:3,video:3},files),repo.restoreBackup(next,{editor:3,video:3},files)]);
  assert(races.filter(r=>r.status==='fulfilled').length===1 && races.some(r=>r.status==='rejected'&&r.reason.code==='CONFLICT'),'simultaneous imports use CAS across both slots');
  repo.close();return true;
};
void 0;
