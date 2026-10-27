window.seedBackupFixture = async function (files, editorVersion = 1) {
  await ShortsStorage.ready;
  await ShortsStorage.load('editor');await ShortsStorage.load('video');
  let editor=ShortsCore.createProject();editor.name='Независимая Студия ZIP';editor.script='Ручной сценарий. Вторую сцену я отредактировал отдельно.';editor.sourceScript=editor.script;editor.scenes=ShortsCore.createScenes(editor.script);editor.scenes[1].text='Отдельная правка ручной сцены';editor.selectedSceneId=editor.scenes[1].id;editor.style={caption:'outline',size:'large',theme:'minimal'};
  const video=ShortsVideoCore.demo();video.title='Видео ZIP с исходниками';video.timing='manual';video.format='webm';video.theme='neon';video.caption='classic';video.volume=.65;video.musicVolume=.45;video.musicFadeIn=.4;video.musicFadeOut=.7;video.edited=true;
  video.scenes=video.scenes.slice(0,3).map((scene,i)=>({...scene,durationSeconds:2,visual:'image',imageId:'zip-fixture-image-'+i,imageName:files[i].name,camera:['zoom-in','pan-left','zoom-out'][i],transition:['crossfade','slide','zoom'][i]}));
  for(const [i,file] of files.entries()){
    const id=i<3?'zip-fixture-image-'+i:i===3?'zip-fixture-voice':'zip-fixture-music';
    const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)),kind=i<3?'image':i===3?'voice':'music';
    ShortsStorage.stage(id,new Blob([bytes],{type:file.type}),file.name,kind);
    if(i>=3){video[(i===3?'voice':'music')+'AssetId']=id;video[(i===3?'voice':'music')+'Name']=file.name;}
  }
  if(editorVersion===2){
    editor=ShortsCore.upgradeProject(editor);editor.timing='manual';editor.subtitles={enabled:false,mode:'chunks'};editor.exportSettings={format:'webm',profile:'shorts-720p'};
    Object.assign(editor.scenes[0],{durationMs:12501,visual:'image',imageId:'zip-fixture-image-0',imageName:files[0].name,camera:'pan-right',transition:'slide'});
    Object.assign(editor.scenes[1],{durationMs:null,visual:'animated',imageId:'zip-fixture-image-1',imageName:files[1].name,camera:'zoom-out',transition:'none'});
    const file=files[2],blob=new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.type});
    ShortsStorage.stage('zip-studio-image',blob,'studio-green.webp','image');
    editor.scenes.push({...editor.scenes[0],id:'studio-private-scene',text:'Отдельный исходник Студии',imageId:'zip-studio-image',imageName:'studio-green.webp',durationMs:70001});
    editor.audio.voice={assetId:'zip-fixture-voice',name:files[3].name,volume:.93};
    const music=files[4];ShortsStorage.stage('zip-studio-music',new Blob([Uint8Array.from(atob(music.base64),c=>c.charCodeAt(0))],{type:music.type}),'studio-music.wav','music');
    editor.audio.music={assetId:'zip-studio-music',name:'studio-music.wav',volume:.17,fadeInMs:1234,fadeOutMs:2345};
  }
  const a=await ShortsStorage.save(editor),b=await ShortsStorage.save(video,'video');
  if(!a.ok || !b.ok)throw Error(a.error || b.error);
};
window.backupFixtureSnapshot = async function () {
  const editor=ShortsEditor.backupSnapshot(),video=ShortsVideoBackup.snapshot(),hashes={};
  for(const id of new Set([...ShortsProjectDB.references('editor',editor),...ShortsProjectDB.references('video',video)])){
    const file=await ShortsStorage.asset(id);if(!file?.blob)throw Error('Missing '+id);
    hashes[id]=await ShortsBackupFormat.sha256(new Uint8Array(await file.blob.arrayBuffer()));
  }
  const result=structuredClone(video);
  result.scenes.forEach(scene=>{if(scene.imageId)scene.imageId=hashes[scene.imageId];});
  for(const role of ['voice','music'])if(result[role+'AssetId'])result[role+'AssetId']=hashes[result[role+'AssetId']];
  const manual=structuredClone(editor);
  if(manual.version===2){manual.scenes.forEach(s=>{if(s.imageId)s.imageId=hashes[s.imageId];});for(const role of ['voice','music'])if(manual.audio[role].assetId)manual.audio[role].assetId=hashes[manual.audio[role].assetId];}
  return{editor:manual,video:result};
};
window.backupRepositorySnapshot = async function () {
  const repo=ShortsProjectDB.createRepository(),heads=[await repo.read('editor'),await repo.read('video')];repo.close();
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('shorts-studio.projects',ShortsProjectDB.DATABASE_VERSION);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  const files=await new Promise((resolve,reject)=>{const tx=db.transaction('assets','readonly'),q=tx.objectStore('assets').getAll();tx.oncomplete=()=>resolve(q.result);tx.onabort=()=>reject(tx.error);});db.close();
  const assets=[];
  for(const a of files){const {bytes,blob,...metadata}=a;assets.push({...metadata,sha256:await ShortsBackupFormat.sha256(new Uint8Array(bytes || await blob.arrayBuffer()))});}
  return{heads,assets};
};
void 0;
