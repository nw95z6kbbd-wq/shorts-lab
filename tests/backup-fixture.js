window.seedBackupFixture = async function (files) {
  await ShortsStorage.ready;
  await ShortsStorage.load('editor');await ShortsStorage.load('video');
  const editor=ShortsCore.createProject();editor.name='Независимая Студия ZIP';editor.script='Ручной сценарий. Вторую сцену я отредактировал отдельно.';editor.sourceScript=editor.script;editor.scenes=ShortsCore.createScenes(editor.script);editor.scenes[1].text='Отдельная правка ручной сцены';editor.selectedSceneId=editor.scenes[1].id;editor.style={caption:'outline',size:'large',theme:'minimal'};
  const video=ShortsVideoCore.demo();video.title='Видео ZIP с исходниками';video.timing='manual';video.format='webm';video.theme='neon';video.caption='classic';video.volume=.65;video.musicVolume=.45;video.musicFadeIn=.4;video.musicFadeOut=.7;video.edited=true;
  video.scenes=video.scenes.slice(0,3).map((scene,i)=>({...scene,durationSeconds:2,visual:'image',imageId:'zip-fixture-image-'+i,imageName:files[i].name,camera:['zoom-in','pan-left','zoom-out'][i],transition:['crossfade','slide','zoom'][i]}));
  for(const [i,file] of files.entries()){
    const id=i<3?'zip-fixture-image-'+i:i===3?'zip-fixture-voice':'zip-fixture-music';
    const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)),kind=i<3?'image':i===3?'voice':'music';
    ShortsStorage.stage(id,new Blob([bytes],{type:file.type}),file.name,kind);
    if(i>=3){video[(i===3?'voice':'music')+'AssetId']=id;video[(i===3?'voice':'music')+'Name']=file.name;}
  }
  const a=await ShortsStorage.save(editor),b=await ShortsStorage.save(video,'video');
  if(!a.ok || !b.ok)throw Error(a.error || b.error);
};
window.backupFixtureSnapshot = async function () {
  const editor=ShortsEditor.backupSnapshot(),video=ShortsVideoBackup.snapshot(),hashes={};
  for(const id of ShortsProjectDB.references('video',video)){
    const file=await ShortsStorage.asset(id);if(!file?.blob)throw Error('Missing '+id);
    hashes[id]=await ShortsBackupFormat.sha256(new Uint8Array(await file.blob.arrayBuffer()));
  }
  const result=structuredClone(video);
  result.scenes.forEach(scene=>{if(scene.imageId)scene.imageId=hashes[scene.imageId];});
  for(const role of ['voice','music'])if(result[role+'AssetId'])result[role+'AssetId']=hashes[result[role+'AssetId']];
  return{editor,video:result};
};
void 0;
