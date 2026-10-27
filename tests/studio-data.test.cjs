'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/core.js'),V=require('../js/video-core.js'),Z=require('../js/zip-store.js');
const context={window:{},ShortsCore:C,ShortsVideoCore:V};vm.runInNewContext(fs.readFileSync('js/project-db.js','utf8'),context);
const DB=context.window.ShortsProjectDB,F=require('../js/backup-format.js')(Z,DB);
const baseline=JSON.parse(fs.readFileSync('tests/fixtures/studio-safety/projects-1.4.0.json'));
const plain=value=>JSON.parse(JSON.stringify(value));
function studio(){
 const p=C.upgradeProject(baseline.editor);
 Object.assign(p.scenes[0],{text:'Редактируемая сцена 🌌',durationMs:12501,visual:'image',imageId:'shared-image',imageName:'red.png',camera:'pan-right',transition:'slide'});
 p.audio.voice={assetId:'voice-original',name:'voice.wav',volume:.91};
 p.audio.music={assetId:'music-original',name:'music.wav',volume:.13,fadeInMs:2345,fadeOutMs:3456};
 p.subtitles={enabled:false,mode:'chunks'};p.exportSettings={format:'webm',profile:'shorts-720p'};p.timing='manual';
 return p;
}
test('frozen 1.4.0 projects normalize byte-for-byte without upgrading or mutating inputs',()=>{
 for(const slot of ['editor','video']){const p=plain(baseline[slot]),before=JSON.stringify(p);assert.deepEqual(plain(DB.normalize(slot,p)),p);assert.equal(JSON.stringify(p),before);}
 const before=JSON.stringify(baseline.editor),up=C.upgradeProject(baseline.editor);
 assert.equal(up.version,2);assert.equal(up.id,baseline.editor.id);assert.equal(up.updatedAt,baseline.editor.updatedAt);assert.equal(JSON.stringify(baseline.editor),before);
 assert.deepEqual(up.scenes.map(s=>s.id),baseline.editor.scenes.map(s=>s.id));
});
test('Studio DTO 2 retains every media/editing field through repeated normalization and JSON round trips',()=>{
 const p=studio(),before=JSON.stringify(p);assert.deepEqual(C.parseProject(p),p);assert.deepEqual(C.parseProject(JSON.stringify(p)),p);assert.deepEqual(C.upgradeProject(p),p);assert.equal(JSON.stringify(p),before);
 assert.deepEqual([...DB.references('editor',p)],['shared-image','voice-original','music-original']);
 p.scenes[1].imageId='shared-image';assert.equal(DB.references('editor',p).filter(id=>id==='shared-image').length,1);
 p.audio.music.assetId='voice-original';assert.equal(DB.references('editor',p).length,2);
});
test('Studio retains manual limits rather than video limits and fills defaults only in explicit v2 reads',()=>{
 const p=studio();p.script='я'.repeat(1000000);p.sourceScript=p.script;p.scenes=Array.from({length:5000},(_,i)=>({id:'scene-'+i,text:'я'.repeat(300)}));p.selectedSceneId=p.scenes[0].id;
 const result=C.parseProject(p);assert.equal(result.scenes.length,5000);assert.equal(result.script.length,1000000);assert.equal(result.scenes[0].text.length,300);assert.equal(result.scenes[0].durationMs,null);
 p.scenes[0].durationMs=900000;assert.equal(C.parseProject(p).scenes[0].durationMs,900000);
});
test('future formats/fields, temporary resources and invalid timings cannot be silently downgraded',()=>{
 for(const version of [0,3,100])assert.throws(()=>C.parseProject({...studio(),version}),{code:'UNSUPPORTED'});
 assert.throws(()=>DB.normalize('video',{...baseline.video,version:2}),{code:'UNSUPPORTED'});
 for(const mutate of [p=>p.future={secret:'x'},p=>p.scenes[0].future=1,p=>p.audio.music.future=1,p=>p.exportSettings.profile='future-codec']){
  const p=studio();mutate(p);assert.throws(()=>C.parseProject(p),{code:'UNSUPPORTED'});
 }
 for(const mutate of [p=>p.scenes[0].durationMs=1.5,p=>p.audio.music.fadeInMs=-1,p=>p.audio.voice.volume=NaN,p=>p.audio.voice.assetId='blob:temporary',p=>p.scenes[1].id=p.scenes[0].id,p=>p.audio.music=new Blob(['runtime'])]){
  const p=studio();mutate(p);assert.throws(()=>C.parseProject(p));
 }
 const p=studio();p.audio.voice.assetId='shared-image';assert.throws(()=>DB.references('editor',p),{code:'INVALID'});
 assert.throws(()=>DB.validateRecord({id:'editor',schemaVersion:1,state:{...baseline.editor,version:3},previous:{state:baseline.editor}}),{code:'UNSUPPORTED'});
});
test('frozen ZIP produced by untouched 1.4.0 imports with original bytes and both independent drafts',async()=>{
 const bundle=await F.importArchive(new Blob([fs.readFileSync('tests/fixtures/studio-safety/backup-1.4.0.zip')]));
 assert.deepEqual(plain(bundle.projects),{editor:baseline.editor,video:baseline.video});assert.equal(bundle.warnings.length,0);
 assert.deepEqual(Buffer.from(await bundle.assets.get('baseline-original-image').blob.arrayBuffer()),fs.readFileSync('tests/fixtures/backup-media/red.png'));
});
test('ZIP v1 explicitly rejects DTO 2, including metadata-only drafts, instead of silently producing partial backup',async()=>{
 for(const editor of [studio(),C.upgradeProject(baseline.editor)]){
  const projects={editor,video:baseline.video},before=JSON.stringify(projects);
  await assert.rejects(F.exportArchive(projects,new Map(),'1.4.0',undefined,1),/ZIP.*1.*Студии/);
  assert.throws(()=>F.states(projects,[],true,1),/ZIP.*1.*Студии/);assert.equal(JSON.stringify(projects),before);
 }
});

test('missing version is corruption eligible for recovery, while a declared unknown version remains unsupported',()=>{
 for(const slot of ['editor','video'])for(const value of [null,{}, {broken:true}, {version:null}])assert.throws(()=>DB.normalize(slot,value),e=>e.code!=='UNSUPPORTED');
 for(const slot of ['editor','video'])assert.throws(()=>DB.normalize(slot,{version:999}),{code:'UNSUPPORTED'});
});
