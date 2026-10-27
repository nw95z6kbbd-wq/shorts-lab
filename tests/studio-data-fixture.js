/* Real IndexedDB assertions, shared by Chromium, WebKit and native Safari.
   Only unique test-owned database names; never deletes any database. */
window.testStudioDataSafety = async function (baseline, payload) {
  const C=ShortsCore,D=ShortsProjectDB,clone=v=>JSON.parse(JSON.stringify(v));
  const assert=(v,label)=>{if(!v)throw Error('Studio data safety: '+label);};
  // Safari WebDriver may reorder argument object keys. Compare every value and
  // key structurally, retaining array order, rather than JSON property order.
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const equal=(a,b,label)=>assert(JSON.stringify(canonical(a))===JSON.stringify(canonical(b)),label);
  const rejects=async(fn,code)=>{let caught;try{await fn();}catch(e){caught=e;}assert(caught&&(caught.code===code||caught.name===code),'expected '+code+', got '+(caught?.code||caught?.name));};
  const names=[],repositories=[];
  const repo=name=>{const r=D.createRepository(name);repositories.push(r);return r;};
  const unique=()=>{const name='studio-safety-'+C.id();names.push(name);return name;};
  const rawOpen=(name,version,create=false)=>new Promise((resolve,reject)=>{const q=indexedDB.open(name,version);q.onerror=()=>reject(q.error);q.onupgradeneeded=()=>{if(create)for(const s of ['projects','assets','meta','legacy-extra'])q.result.createObjectStore(s,{keyPath:'id'});};q.onsuccess=()=>resolve(q.result);});
  const rawWrite=async(name,store,values)=>{const db=await rawOpen(name);try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);for(const value of values)tx.objectStore(store).put(value);});}finally{db.close();}};
  const originals=payload.map(f=>({id:f.name,kind:f.type.startsWith('image/')?'image':f.name.startsWith('voice')?'voice':'music',name:f.name,blob:new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type})}));
  const image=originals.find(f=>f.name==='red.png'),voice=originals.find(f=>f.kind==='voice'),music=originals.find(f=>f.kind==='music');
  const as=(f,id)=>({...f,id}),originalBytes=async(f)=>Array.from(new Uint8Array(await f.blob.arrayBuffer()));
  const name=unique(),legacy=LegacyProjectDB.createRepository(name);repositories.push(legacy);
  const oldEditor=clone(baseline.editor),oldVideo=clone(baseline.video);oldVideo.scenes[0].imageId='shared';oldVideo.scenes[1].imageId='shared';oldVideo.scenes[1].visual='image';
  const recovery=clone(oldVideo);recovery.scenes[0].imageId='recovery';
  let db=await rawOpen(name,1,true);db.close();
  const head=(id,state,revision,previous=null)=>({id,schemaVersion:1,revision,state,previous,missingAssets:[],updatedAt:'2026-01-01T00:00:00.000Z'});
  await rawWrite(name,'projects',[head('editor',oldEditor,7),head('video',oldVideo,4,{state:recovery,revision:3,missingAssets:[]})]);
  await rawWrite(name,'meta',[{id:'legacy-v1',legacy:{editor:JSON.stringify(oldEditor),video:JSON.stringify(oldVideo)},completedAt:'frozen'}]);
  await rawWrite(name,'legacy-extra',[{id:'untouched',recovery:'must survive upgrade'}]);
  for(const id of ['shared','recovery'])await rawWrite(name,'assets',[{id,kind:'image',name:image.name,type:image.blob.type,size:image.blob.size,bytes:await image.blob.arrayBuffer()}]);
  await legacy.read('video'); // Actual shipped repository keeps a v1 connection open.
  const r=repo(name),beforeEditor=await legacy.read('editor'),beforeVideo=await legacy.read('video');
  equal(await r.read('editor'),beforeEditor,'upgrade must not rewrite legacy editor');equal(await r.read('video'),beforeVideo,'upgrade must not rewrite video/recovery');
  db=await rawOpen(name);assert(db.version===2,'physical writer fence');assert(db.objectStoreNames.contains('legacy-extra'),'extra store retained');db.close();
  await rejects(()=>legacy.save('video',{...oldVideo,title:'old writer GC'},4),'VersionError');
  assert(await r.asset('shared')&&await r.asset('recovery'),'old writer cannot delete originals');
  equal((await r.migration()).legacy.editor,JSON.stringify(oldEditor),'legacy recovery unchanged');
  let editor=C.upgradeProject(oldEditor);
  Object.assign(editor.scenes[0],{durationMs:12345,visual:'image',imageId:'shared',imageName:image.name,camera:'pan-left',transition:'slide'});
  Object.assign(editor.scenes[1],{durationMs:70001,visual:'image',imageId:'shared'});
  Object.assign(editor.scenes[2],{imageId:'manual-only',visual:'image'});
  editor.timing='manual';editor.audio.voice={assetId:'manual-voice',name:voice.name,volume:.87};editor.audio.music={assetId:'manual-music',name:music.name,volume:.18,fadeInMs:2345,fadeOutMs:3456};editor.subtitles={enabled:false,mode:'chunks'};editor.exportSettings={format:'webm',profile:'shorts-720p'};
  let e=await r.save('editor',editor,7,[as(image,'manual-only'),as(voice,'manual-voice'),as(music,'manual-music')]);
  assert(await r.asset('recovery'),'video previous snapshot protects its image during Studio save');
  equal(e.state,editor,'all DTO fields committed');equal(e.previous.state,oldEditor,'legacy recovery state retained');
  r.close();const reopened=repo(name);equal((await reopened.read('editor')).state,editor,'DTO survives reopen without changing IDs/settings');
  for(const [id,source] of [['shared',image],['manual-only',image],['manual-voice',voice],['manual-music',music]])equal(await originalBytes(await reopened.asset(id)),await originalBytes(source),'original bytes '+id);
  // A write in the other slot must retain BOTH manual snapshots and its media.
  let v=await reopened.save('video',{...oldVideo,title:'Independent video edit'},4);
  assert(await reopened.asset('manual-only')&&await reopened.asset('manual-voice')&&await reopened.asset('manual-music'),'video saving retains all Studio media');
  assert(await reopened.asset('shared'),'one file referenced by many scenes/modes');
  editor=clone(editor);editor.scenes[2].imageId=null;
  e=await reopened.save('editor',editor,e.revision);assert(await reopened.asset('manual-only'),'manual previous retains removed media');
  v=await reopened.save('video',{...v.state,title:'Another independent edit'},v.revision);assert(await reopened.asset('manual-only'),'other slot cannot collect recovery media');
  e=await reopened.save('editor',editor,e.revision);assert(!await reopened.asset('manual-only'),'collect only after last recoverable reference disappears');
  editor.scenes[0].imageId=null;e=await reopened.save('editor',editor,e.revision);e=await reopened.save('editor',editor,e.revision);assert(await reopened.asset('shared'),'second scene and other mode keep shared image');
  e=await reopened.save('editor',editor,e.revision,[as(image,'shared')]);
  equal(await originalBytes(await reopened.asset('shared')),await originalBytes(image),'identical original can be reused safely');
  const saved=clone(await reopened.read('editor'));
  for(const failure of ['quota','abort']){
    const put=IDBObjectStore.prototype.put,broken=clone(editor),id='failed-'+failure;broken.audio.voice.assetId=id;
    IDBObjectStore.prototype.put=function(value){
      if(this.name==='projects'){
        if(failure==='quota')throw new DOMException('full','QuotaExceededError');
        const q=put.call(this,value);q.onsuccess=()=>this.transaction.abort();return q;
      }return put.call(this,value);
    };
    try{await rejects(()=>reopened.save('editor',broken,e.revision,[as(voice,id)]),failure==='quota'?'QuotaExceededError':'AbortError');}finally{IDBObjectStore.prototype.put=put;}
    equal(await reopened.read('editor'),saved,failure+' rolls back head, revision and previous');assert(!await reopened.asset(id),failure+' rolls back new original');
    equal(await originalBytes(await reopened.asset('manual-voice')),await originalBytes(voice),failure+' leaves existing original intact');
  }
  await rejects(()=>reopened.save('editor',editor,e.revision,[{...as(image,'shared'),blob:new Blob(['replacement'])}]),'COLLISION');
  equal(await originalBytes(await reopened.asset('shared')),await originalBytes(image),'shared originals are immutable');equal(await reopened.read('editor'),saved,'collision rolls back head');
  const a=repo(name),b=repo(name),race=await Promise.allSettled([a.save('editor',{...editor,name:'Writer A'},e.revision),b.save('editor',{...editor,name:'Writer B'},e.revision)]);
  assert(race.filter(x=>x.status==='fulfilled').length===1&&race.filter(x=>x.status==='rejected'&&x.reason.code==='CONFLICT').length===1,'simultaneous CAS');
  const winner=race.find(x=>x.status==='fulfilled').value;equal(await reopened.read('editor'),winner,'head equals actual winning data');
  await rejects(()=>reopened.save('editor',{...editor,name:'Stale writer'},e.revision),'CONFLICT');equal(await reopened.read('editor'),winner,'stale writer has no side effects');
  const future={...clone(winner),state:{...clone(winner.state),version:999},previous:{state:oldEditor,revision:1,missingAssets:[]}};
  await rawWrite(name,'projects',[future]);
  await rejects(()=>reopened.save('editor',oldEditor,future.revision),'UNSUPPORTED');
  const stableVideo=await reopened.read('video');await rejects(()=>reopened.save('video',{...stableVideo.state,title:'Must roll back'},stableVideo.revision),'UNSUPPORTED');
  equal(await reopened.read('editor'),future,'future head not replaced by readable previous');equal(await reopened.read('video'),stableVideo,'unknown other slot prevents GC and partial writes');
  const media=await reopened.asset('shared');await rejects(()=>reopened.restoreBackup({editor:oldEditor,video:oldVideo},{editor:future.revision,video:stableVideo.revision},[{id:'shared',name:media.name,kind:media.kind,blob:media.blob}]),'UNSUPPORTED');
  equal(await reopened.read('editor'),future,'backup restore cannot overwrite future head');assert(await reopened.asset('manual-voice'),'future data originals retained');
  const futurePrevious={...clone(winner),previous:{state:{...clone(editor),version:999},revision:1}};
  await rawWrite(name,'projects',[futurePrevious]);await rejects(()=>reopened.save('video',stableVideo.state,stableVideo.revision),'UNSUPPORTED');equal(await reopened.read('editor'),futurePrevious,'unknown recovery version not discarded');
  // A legacy tab that refuses versionchange blocks the upgrade. Failure is safe,
  // including a late upgrade event after the user finally closes that tab.
  const blockedName=unique();const blocker=await rawOpen(blockedName,1,true);const blocked=repo(blockedName);
  await rejects(()=>blocked.read('editor'),'BLOCKED');blocker.close();
  db=await rawOpen(blockedName);assert(db.version===1,'failed blocked request must not perform a late upgrade');db.close();
  assert(!await blocked.read('editor'),'retry succeeds');blocked.close();db=await rawOpen(blockedName);assert(db.version===2,'retry upgrades exactly once');db.close();
  // A partially populated old schema is repaired without recreating stores.
  const partialName=unique();await new Promise((resolve,reject)=>{const q=indexedDB.open(partialName,1);q.onupgradeneeded=()=>q.result.createObjectStore('projects',{keyPath:'id'});q.onerror=()=>reject(q.error);q.onsuccess=()=>{q.result.close();resolve();};});
  await rawWrite(partialName,'projects',[head('editor',oldEditor,1)]);const partial=repo(partialName);equal((await partial.read('editor')).state,oldEditor,'existing partial schema data retained');assert(!await partial.migration(),'missing meta store created');partial.close();equal((await repo(partialName).read('editor')).state,oldEditor,'repeated upgrade/open is idempotent');
  // Transactions started by the old connection finish BEFORE the v2 fence.
  const busyName=unique();const busy=await rawOpen(busyName,1,true);busy.onversionchange=()=>busy.close();
  const busyBytes=await image.blob.arrayBuffer();
  let release=false;const tx=busy.transaction('assets','readwrite'),store=tx.objectStore('assets');
  const committed=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  store.put({id:'before-upgrade',bytes:busyBytes,type:image.blob.type,name:image.name,kind:'image'});
  function pump(){const q=store.count();q.onsuccess=()=>{if(!release)pump();};}pump();
  const busyRepo=repo(busyName),upgraded=busyRepo.read('editor');setTimeout(()=>{release=true;},50);await committed;await upgraded;
  equal(await originalBytes(await busyRepo.asset('before-upgrade')),await originalBytes(image),'old in-flight transaction committed before upgrade');
  for(const repository of repositories)repository.close();
  return {databases:names.length,checks:['v1 exact upgrade','v2 fields and original bytes','both modes and previous references','shared immutable originals','old-writer fence','blocked and late upgrade','partial schema and reopen','in-flight transaction','quota and abort rollback','CAS','future head/recovery protection']};
};

/* This adapter test runs on a fresh, test-only origin, with no application UI. */
window.seedStudioAdapterFixture = async function (baseline) {
  const repo=ShortsProjectDB.createRepository();
  await repo.migrate([{id:'editor',state:baseline.editor},{id:'video',state:baseline.video}],[],{editor:null,video:null});repo.close();
  const q=indexedDB.open('shorts-studio.projects',ShortsProjectDB.DATABASE_VERSION);
  await new Promise((resolve,reject)=>{q.onerror=()=>reject(q.error);q.onsuccess=resolve;});
  const db=q.result;
  await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),get=store.get('editor');get.onsuccess=()=>{const p=get.result;store.put({...p,state:{...p.state,version:999},previous:{state:p.state,revision:0}});};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
};
window.testStudioAdapterSafety = async function () {
  const assert=(v,label)=>{if(!v)throw Error('Studio adapter: '+label);};
  const repo=ShortsProjectDB.createRepository(),before=await repo.read('editor');
  const loaded=await ShortsStorage.load('editor');assert(loaded.writable===false&&!loaded.project,'future head blocks editing instead of falling back to previous');
  const result=await ShortsStorage.save(ShortsCore.createProject());assert(!result.ok,'automatic replacement refused');
  assert(JSON.stringify(await repo.read('editor'))===JSON.stringify(before),'future bytes and readable recovery unchanged');
  // Invalid new inputs return a failed save result, not an unhandled exception.
  const invalid=await ShortsStorage.save({...ShortsCore.createProject(),version:999});assert(!invalid.ok,'unsupported DTO is an explicit save failure');
  let denied=false;try{await ShortsStorage.captureBackup({editor:ShortsCore.upgradeProject(before.previous.state),video:ShortsVideoCore.demo()},64*1024*1024);}catch(e){denied=/ZIP.*1.*Студии/.test(e.message);}assert(denied,'adapter also refuses incomplete v2 ZIP');repo.close();return true;
};

window.seedStudioUiFixture = async function (baseline, payload) {
  const editor=ShortsCore.upgradeProject(baseline.editor),video=structuredClone(baseline.video),files=[];
  for(const [i,f] of payload.entries()){
    const kind=f.type.startsWith('image/')?'image':f.name.startsWith('voice')?'voice':'music',id='ui-'+f.name;
    files.push({id,kind,name:f.name,blob:new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type})});
    if(kind==='image')for(const state of [editor,video])Object.assign(state.scenes[i],{imageId:id,imageName:f.name,visual:'image',camera:'pan-right',transition:'slide'});
    else{editor.audio[kind].assetId=id;editor.audio[kind].name=f.name;video[kind+'AssetId']=id;video[kind+'Name']=f.name;}
  }
  editor.scenes[0].durationMs=12345;editor.timing='manual';editor.audio.voice.volume=.85;editor.audio.music.volume=.17;editor.audio.music.fadeInMs=2345;editor.audio.music.fadeOutMs=3456;editor.subtitles.enabled=false;editor.exportSettings.format='webm';
  const r=ShortsProjectDB.createRepository();await r.migrate([{id:'editor',state:editor},{id:'video',state:video}],files,{editor:null,video:null});r.close();return {editor,video:ShortsProjectDB.normalize('video',video)};
};
window.studioUiSnapshot = async function () {
  const r=ShortsProjectDB.createRepository(),editor=await r.read('editor'),video=await r.read('video'),hashes={};
  for(const id of new Set([...ShortsProjectDB.references('editor',editor.state),...ShortsProjectDB.references('video',video.state)])){
    const asset=await r.asset(id);if(!asset?.blob)throw Error('Lost original '+id);
    hashes[id]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await asset.blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  }
  r.close();return {editor:editor.state,video:video.state,hashes};
};
window.waitForStudioUiSave = async function (expected) {
  const r=ShortsProjectDB.createRepository(),deadline=Date.now()+10000;
  try{
    while(Date.now()<deadline){
      const p=await r.read('editor');
      if(p?.state.script===expected.script&&p.state.scenes[0].text===expected.sceneText)return true;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Studio autosave did not commit the expected script and scene');
  }finally{r.close();}
};

window.seedStudioRecoveryFixture = async function (baseline, payload) {
  const r=ShortsProjectDB.createRepository(),f=payload.find(f=>f.name==='red.png'),blob=new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type});
  const orphan=payload.find(f=>f.name==='voice.wav');window.recoveryOrphan=new Blob([Uint8Array.from(atob(orphan.base64),c=>c.charCodeAt(0))],{type:orphan.type});
  await r.migrate([{id:'editor',state:baseline.editor},{id:'video',state:baseline.video}],[{id:baseline.video.scenes[0].imageId,kind:'image',name:f.name,blob},{id:'unresolved-corrupt-audio',kind:'voice',name:orphan.name,blob:recoveryOrphan}],{editor:null,video:null});r.close();
  const q=indexedDB.open('shorts-studio.projects',ShortsProjectDB.DATABASE_VERSION);await new Promise((resolve,reject)=>{q.onsuccess=resolve;q.onerror=()=>reject(q.error);});
  const db=q.result;await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite'),s=tx.objectStore('projects');
    for(const slot of ['editor','video']){const get=s.get(slot);get.onsuccess=()=>{const p=get.result;s.put({...p,state:{broken:true,unresolvedAssetId:'unresolved-corrupt-audio'},previous:{state:p.state,revision:0,missingAssets:[]}});};}
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });db.close();
};
window.testStudioRecoverySafety = async function (baseline) {
  const loaded={editor:await ShortsStorage.load('editor'),video:await ShortsStorage.load('video')};
  for(const slot of ['editor','video']){
    if(!loaded[slot].writable||!loaded[slot].error?.includes('предыдущая')||JSON.stringify(loaded[slot].project)!==JSON.stringify(ShortsProjectDB.normalize(slot,baseline[slot])))throw Error('Corrupt head must recover the known previous '+slot+' state');
    const p=loaded[slot].project;
    if(slot==='editor')p.script+='\nПравка восстановленного сценария.';else p.title='Восстановленная версия видео';
    const result=await ShortsStorage.save(p,slot);if(!result.ok)throw Error(result.error);
    const r=ShortsProjectDB.createRepository(),head=await r.read(slot);if(head.revision!==2||JSON.stringify(head.state)!==JSON.stringify(p))throw Error('Recovered state was not committed intact');
    if(slot==='editor'){const a=await r.asset('unresolved-corrupt-audio');if(!a?.blob)throw Error('GC deleted an uncertain original before the other mode recovered');const actual=new Uint8Array(await a.blob.arrayBuffer()),expected=new Uint8Array(await recoveryOrphan.arrayBuffer());if(actual.length!==expected.length||!actual.every((b,i)=>b===expected[i]))throw Error('Uncertain original bytes changed');}r.close();
  }
  const r=ShortsProjectDB.createRepository(),a=await r.asset(baseline.video.scenes[0].imageId);r.close();if(!a?.blob?.size)throw Error('Recovery lost original image');return true;
};
