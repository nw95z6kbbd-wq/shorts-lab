/* Test-only consumer; no new app controls or production persistence contract. */
window.exportCheck=(condition,message)=>{if(!condition)throw Error('Editor export: '+message);};
window.prepareEditorExportFixture=async function(payload,{format='auto',audio=true}={}){
 await window.ShortsEditorReady;await editorLiveUntil(()=>window.ShortsVideoRestored&&!document.body.inert,'startup');
 const p=ShortsCore.upgradeProject(ShortsCore.createProject());p.id=ShortsCore.id();p.name='Editor export '+format+' '+p.id.slice(-8);p.timing='manual';p.script='Исходный сценарий отличается от отредактированных сцен.';
 const ids=[];for(const file of payload){const id=ShortsCore.id();ids.push(id);ShortsStorage.stage(id,new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.type}),file.name,file.type.startsWith('image/')?'image':file.name.startsWith('voice')?'voice':'music');}
 p.scenes=payload.slice(0,3).map((file,i)=>({id:'export-scene-'+i,text:'Сцена '+(i+1),durationMs:1000,visual:'image',imageId:ids[i],imageName:file.name,camera:'static',transition:'crossfade'}));p.selectedSceneId=p.scenes[2].id;
 if(audio){p.audio.voice={assetId:ids[3],name:'voice.wav',volume:.65};p.audio.music={assetId:ids[4],name:'music.wav',volume:.45,fadeInMs:300,fadeOutMs:400};}
 p.exportSettings.format=format;await editorLiveImport(p);await editorTimingWaitForSave();document.getElementById('openVideoMode').click();await editorLiveUntil(()=>ShortsMediaSessions.statistics().sessions===0,'old preview teardown');
 window.exportOriginal=ShortsEditor.backupSnapshot();window.exportBefore=await studioUiSnapshot();window.exportStates=[];window.exportProgress=[];
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.style='position:fixed;left:0;bottom:0;width:360px;height:640px;z-index:24000';document.body.append(canvas);window.exportCanvas=canvas;
 const start=document.createElement('button');start.id='editorExportStart';start.textContent='Start test export';start.style='position:fixed;left:0;top:0;z-index:22000';document.body.append(start);
 window.exportNativeRecord=ShortsVideoRecorder.record;ShortsVideoRecorder.record=async options=>{window.exportRawBlob=null;const r=await exportNativeRecord(options);window.exportRawBlob=r.blob;return r;};
 window.exportJob=ShortsEditorExport.create({onState:s=>exportStates.push(s),onProgress:p=>exportProgress.push(p)});window.exportPrepared=await exportJob.prepare({project:exportOriginal,canvas,contentRevision:7,savedRevision:null});
 exportCheck(exportJob.status().state==='ready','prepare ready');exportCheck(!exportStates.some(s=>s.state==='recording'),'prepare must not record');
 start.onclick=()=>{window.exportPromise=exportJob.start();exportPromise.catch(()=>{});};
 return {formats:exportPrepared.formats,plan:exportPrepared.plan,ready:exportJob.status(),before:exportBefore};
};
window.finishEditorExportFixture=async function(){
 const result=await exportPromise;window.editorExportBlob=result.blob;exportCheck(result.width===720&&result.height===1280,'actual dimensions');exportCheck(Math.abs(result.durationMs-3000)<150,'actual duration '+result.durationMs);
 exportCheck(exportProgress.at(-1).fraction===1&&exportStates.at(-1).state==='complete','complete only after validation');
 exportCheck(result.videoCodec===(result.container==='mp4'?'h264':result.videoCodec),'actual AVC');if(result.container==='mp4'&&result.audioCodec)exportCheck(result.audioCodec==='aac','actual AAC');
 exportCheck(ShortsMediaSessions.statistics().sessions===0&&ShortsMediaSessions.statistics().residentBytes===0,'all export media released');
 exportCheck(JSON.stringify(await studioUiSnapshot())===JSON.stringify(exportBefore),'persisted projects and SHA-256 originals unchanged');
 exportCheck(JSON.stringify(ShortsEditor.backupSnapshot())===JSON.stringify(exportOriginal),'DTO did not change');
 const projects=ShortsBackupFormat.states({editor:exportBefore.editor,video:exportBefore.video}),assets=await ShortsStorage.captureBackup(projects,ShortsZip.LIMITS.archive),zip=await ShortsBackupFormat.exportArchive(projects,assets,ShortsProduct.version),roundtrip=await ShortsBackupFormat.importArchive(zip);
 exportCheck(JSON.stringify(roundtrip.projects)===JSON.stringify(projects),'ZIP project round-trip');
 for(const [id,file] of roundtrip.assets){const original=assets.get(id);exportCheck(file.blob.type===original.blob.type&&await ShortsBackupFormat.sha256(new Uint8Array(await file.blob.arrayBuffer()))===await ShortsBackupFormat.sha256(new Uint8Array(await original.blob.arrayBuffer())),'ZIP original bytes/MIME '+id);}

 const {blob,...info}=result;return{...info,states:exportStates.map(s=>s.state),pool:ShortsMediaSessions.statistics()};
};
window.disposeEditorExportFixture=async function(){await exportJob?.dispose();if(window.exportNativeRecord){ShortsVideoRecorder.record=exportNativeRecord;window.exportNativeRecord=null;}document.getElementById('editorExportStart')?.remove();exportCanvas?.remove();};
window.exerciseEditorExportErrors=async function(){
 const before=await studioUiSnapshot(),base=structuredClone(exportOriginal),canvas=exportCanvas,job=ShortsEditorExport.create(),rejected=[];
 for(const [name,modify,code] of [
  ['missing image',p=>p.scenes[1].imageId='missing-export-original','MISSING_ORIGINAL'],
  ['overflow',p=>p.scenes[2].text='Очень длинный текст '.repeat(500),'TEXT_OVERFLOW'],
  ['resource count',p=>p.scenes=Array.from({length:17},(_,i)=>({...p.scenes[0],id:'resource-'+i,imageId:'source-'+i})),'IMAGE_COUNT']
 ]){const p=structuredClone(base);modify(p);let error;try{await job.prepare({project:p,canvas});}catch(e){error=e;}exportCheck(error?.code===code,name+' '+error?.code);if(name==='missing image')exportCheck(error.sceneNumber===2,'scene diagnosis');rejected.push(name);}
 const native=ShortsVideoMedia.decodeImage;let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);ShortsVideoMedia.decodeImage=async blob=>{started();await gate;return native(blob);};
 try{
  const preparing=job.prepare({project:base,canvas});const outcome=preparing.catch(e=>e);await entered;const closing=job.cancel();release();await outcome;await closing;exportCheck(job.status().state==='cancelled','cancel decode');
 }finally{release();ShortsVideoMedia.decodeImage=native;}
 await job.prepare({project:base,canvas});await job.cancel();await job.cancel();await job.dispose();
 exportCheck(ShortsMediaSessions.statistics().sessions===0,'cancel resource leak');exportCheck(JSON.stringify(before)===JSON.stringify(await studioUiSnapshot()),'error mutated persisted data');return rejected;
};
