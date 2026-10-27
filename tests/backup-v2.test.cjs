'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
const C=require('../js/core.js'),V=require('../js/video-core.js'),Z=require('../js/zip-store.js');
const context={window:{},ShortsCore:C,ShortsVideoCore:V};vm.runInNewContext(fs.readFileSync('js/project-db.js','utf8'),context);
const DB=context.window.ShortsProjectDB,F=require('../js/backup-format.js')(Z,DB);
const oldZ=require('./fixtures/zip-v1/zip-store.js'),oldF=require('./fixtures/zip-v1/backup-format.js')(oldZ,DB);
const baseline=require('./fixtures/studio-safety/projects-1.4.0.json'),plain=x=>JSON.parse(JSON.stringify(x));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const projects={editor:C.upgradeProject(baseline.editor),video:plain(baseline.video)},assets=new Map();
 for(const [i,name] of ['red.png','blue.jpg','green.webp'].entries()){
  const id=['shared-image','studio-inactive','video-only'][i],type=['image/png','image/jpeg','image/webp'][i];
  assets.set(id,{id,kind:'image',name,blob:new Blob([fs.readFileSync('tests/fixtures/backup-media/'+name)],{type})});
 }
 const e=projects.editor;e.script='Исходный сценарий не совпадает со сценами. '+('длинный '.repeat(80));e.sourceScript='Первоначальная редакция.';
 e.scenes=[{...e.scenes[0],text:'Правка второй сцены.',visual:'image',imageId:'shared-image',imageName:'red.png',durationMs:12501,camera:'pan-right',transition:'slide'},
  {...e.scenes[1],text:'Первая сцена теперь вторая.',visual:'animated',imageId:'studio-inactive',imageName:'blue.jpg',durationMs:null,camera:'zoom-out',transition:'none'},
  {...e.scenes[0],id:'studio-shared-again',text:'',visual:'image',imageId:'shared-image',imageName:'red.png',durationMs:1,camera:'static',transition:'zoom'}];
 e.selectedSceneId=e.scenes[1].id;e.timing='manual';e.subtitles={enabled:false,mode:'chunks'};e.style={theme:'dusk',caption:'outline',size:'large'};e.exportSettings={format:'webm',profile:'shorts-720p'};
 const wav=Buffer.alloc(100);wav.write('RIFF');wav.write('WAVE',8); // bytes are format-layer fixtures; real WAVs are exercised in browsers.
 for(const [id,kind,name,type] of [['shared-audio','voice','voice.wav','audio/wav'],['studio-music','music','music.wav','audio/wav'],['video-music','music','same-content.m4a','audio/mp4']])assets.set(id,{id,kind,name,blob:new Blob([wav],{type})});
 e.audio.voice={assetId:'shared-audio',name:'voice.wav',volume:.93};e.audio.music={assetId:'studio-music',name:'music.wav',volume:.17,fadeInMs:1234,fadeOutMs:2345};
 projects.video.scenes[0].imageId='shared-image';projects.video.scenes[0].imageName='red.png';projects.video.scenes[0].visual='image';
 projects.video.scenes[1].imageId='video-only';projects.video.scenes[1].imageName='green.webp';projects.video.scenes[1].visual='image';
 projects.video.voiceAssetId='shared-audio';projects.video.voiceName='voice.wav';projects.video.musicAssetId='video-music';projects.video.musicName='same-content.m4a';
 return {projects:F.states(projects),assets};
}
async function archive(){const f=fixture();return {...f,zip:await F.exportArchive(f.projects,f.assets,'1.4.0')};}
async function rewrite(zip,change,version=2){
 const files=[...(await Z.read(zip,2)).entries].map(([path,e])=>({path,blob:e.blob}));await change(files);return Z.create(files,undefined,version);
}
async function changeProject(files,mutate){
 const p=JSON.parse(await files[1].blob.text());mutate(p);files[1].blob=new Blob([JSON.stringify(p)]);
 const m=JSON.parse(await files[0].blob.text());m.project.size=files[1].blob.size;m.project.sha256=hash(Buffer.from(await files[1].blob.arrayBuffer()));files[0].blob=new Blob([JSON.stringify(m)]);
}
test('ZIP v1 checkpoint sources and original frozen archive remain independent and unchanged',async()=>{
 const source=require('./fixtures/zip-v1/source.json');assert.equal(source.commit,'1bc8eeeb5a501d4c92ec35c3c99bed1706dcc2dc');
 for(const [name,sha] of Object.entries(source.files))assert.equal(hash(fs.readFileSync('tests/fixtures/zip-v1/'+name)),sha);
 const blob=new Blob([fs.readFileSync('tests/fixtures/studio-safety/backup-1.4.0.zip')]);
 const old=await oldF.importArchive(blob),current=await F.importArchive(blob);assert.deepEqual(current.projects,old.projects);assert.deepEqual(current.manifest,old.manifest);assert.equal(current.projects.editor.version,1);
 for(const [id,a] of old.assets)assert.deepEqual(Buffer.from(await current.assets.get(id).blob.arrayBuffer()),Buffer.from(await a.blob.arrayBuffer()));
});
test('frozen ZIP 2 example restores expected DTOs and valid original PNG/JPG/WebP/WAV hashes',async()=>{
 const expected=require('./fixtures/zip-v2/expected.json'),bundle=await F.importArchive(new Blob([fs.readFileSync('tests/fixtures/zip-v2/editor2-video1.shorts.zip')]));
 assert.equal(bundle.manifest.version,2);assert.deepEqual(plain(bundle.projects),expected.projects);
 for(const a of expected.assets){const actual=bundle.assets.get(a.id);for(const key of ['kind','name','type','size','sha256'])assert.equal(actual[key],a[key]);assert.equal(hash(Buffer.from(await actual.blob.arrayBuffer())),a.sha256);}
});
test('v1-only projects still export ZIP 1 readable by the frozen old client, including empty drafts',async()=>{
 for(const editor of [plain(baseline.editor),C.createProject()]){
  const projects={editor,video:V.parseDraft(V.demo())};const zip=await F.exportArchive(projects,new Map(),'1.4.0');
  const restored=await oldF.importArchive(zip);assert.equal(restored.manifest.version,1);assert.deepEqual(plain(restored.projects),plain(F.states(projects)));assert.equal(editor.version,1);
 }
});
test('DTO 2 round trip retains every supported field, inactive references, shared originals, bytes and MIME',async()=>{
 const {projects,assets,zip}=await archive(),before=JSON.stringify(projects),b=await F.importArchive(zip);
 assert.equal(b.manifest.version,2);assert.deepEqual(plain(b.projects),plain(projects));assert.equal(JSON.stringify(projects),before);assert.equal(b.warnings.length,0);
 assert.deepEqual([...F.usage(b.projects).keys()].sort(),[...assets.keys()].sort());
 for(const [id,a] of assets){const restored=b.assets.get(id);assert.equal(restored.type,a.blob.type);assert.equal(restored.blob.type,a.blob.type);assert.equal(restored.name,a.name);assert.deepEqual(Buffer.from(await restored.blob.arrayBuffer()),Buffer.from(await a.blob.arrayBuffer()));}
 const z=await Z.read(zip,2),raw=JSON.parse(Buffer.from(await z.bytes('project.json')).toString());assert.equal(raw.version,2);assert.equal(raw.editor.version,2);assert.equal(raw.video.version,1);
 assert.equal(z.entries.size,6,'three image payloads plus one shared audio payload plus two JSONs');
 await assert.rejects(oldF.importArchive(zip),/будущая версия/);
});
test('v2 remaps both modes, preserves shared/distinct identities and remains stable over repeated imports/exports',async()=>{
 const {zip}=await archive(),bundle=await F.importArchive(zip),a=await F.remap(bundle),b=await F.remap(bundle);
 assert.deepEqual(a.projects,b.projects);assert.deepEqual(a.assets.map(a=>a.id),b.assets.map(a=>a.id));
 assert.equal(a.projects.editor.scenes[0].imageId,a.projects.video.scenes[0].imageId);assert.equal(a.projects.editor.scenes[0].imageId,a.projects.editor.scenes[2].imageId);
 assert.equal(a.projects.editor.audio.voice.assetId,a.projects.video.voiceAssetId);assert.ok(a.projects.editor.scenes[1].imageId.startsWith('backup2-'));
 assert.notEqual(a.projects.editor.audio.music.assetId,a.projects.video.musicAssetId);
 assert.deepEqual(a.projects.editor.scenes.map(s=>s.id),bundle.projects.editor.scenes.map(s=>s.id));
 const again=await F.remap(await F.importArchive(await F.exportArchive(a.projects,new Map(a.assets.map(a=>[a.id,a])),'1.4.0')));
 assert.deepEqual(again.projects,a.projects);assert.deepEqual(again.assets.map(a=>a.id),a.assets.map(a=>a.id));
 const same=fixture();same.assets.set('studio-music',{...same.assets.get('shared-audio'),id:'studio-music'});
 const distinct=await F.remap(await F.importArchive(await F.exportArchive(same.projects,same.assets,'test')));assert.notEqual(distinct.projects.editor.audio.voice.assetId,distinct.projects.editor.audio.music.assetId,'identical content/metadata do not collapse distinct logical IDs');
});
test('DTO 2 without assets and completely empty projects are valid ZIP 2 without implicit data upgrades',async()=>{
 const e=C.upgradeProject(C.createProject()),v=V.parseDraft({...V.demo(),scenes:[]});
 const b=await F.importArchive(await F.exportArchive({editor:e,video:v},new Map(),'test'));assert.equal(b.manifest.version,2);assert.deepEqual(plain(b.projects),plain(F.states({editor:e,video:v})));assert.equal(b.assets.size,0);
});
test('v2 supports more than v1 media/entry limits while preserving v1 structural limits',async()=>{
 const f=fixture();f.projects.editor.scenes=[];
 for(let i=0;i<40;i++){const id='many-'+i;f.projects.editor.scenes.push({id:'scene-'+i,text:'',visual:'animated',imageId:id,durationMs:1000});f.assets.set(id,{id,name:id+'.png',kind:'image',blob:new Blob([String(i)],{type:'image/png'})});}
 f.projects.editor.selectedSceneId='scene-0';const normalized=F.states(f.projects),zip=await F.exportArchive(normalized,f.assets,'test'),b=await F.importArchive(zip);
 assert.equal(b.projects.editor.scenes.length,40);assert.ok(b.assets.size>14);assert.ok((await Z.read(zip,2)).entries.size>32);await assert.rejects(Z.read(zip),/число файлов/);
 const downgraded=await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.version=1;files[0].blob=new Blob([JSON.stringify(m)]);});await assert.rejects(F.importArchive(downgraded),/число файлов/);
});
test('missing active/inactive originals, contradictory types and image mode without a link cannot produce success',async()=>{
 for(const id of ['shared-image','studio-inactive','shared-audio','studio-music','video-only','video-music']){
  const f=fixture(),before=JSON.stringify(f.projects);f.assets.delete(id);await assert.rejects(F.exportArchive(f.projects,f.assets,'test'),/Нет исходного файла/);assert.equal(JSON.stringify(f.projects),before);
 }
 const f=fixture();f.projects.editor.scenes[0].imageId=null;await assert.rejects(F.exportArchive(f.projects,f.assets,'test'),/нет исходного изображения/);
 f.projects.editor.scenes[0].imageId='shared-audio';await assert.rejects(F.exportArchive(f.projects,f.assets,'test'),/изображение и аудио/);
});
test('future/mismatched ZIP/DTO versions and significant unknown or invalid fields are rejected before remap',async()=>{
 const {zip}=await archive();
 for(const mutate of [p=>p.version=1,p=>p.version=3,p=>p.editor.version=999,p=>p.video.version=999,p=>p.editor.scenes[0].future=1,p=>p.editor.audio.music.future=1,p=>p.video.futureSetting=true,p=>p.editor.scenes[0].durationMs=1.1,p=>p.video.scenes[0].camera='future',p=>p.editor.audio.voice.assetId='blob:temporary']){
  await assert.rejects(F.importArchive(await rewrite(zip,files=>changeProject(files,mutate))));
 }
 for(const version of [0,3,'2',null])await assert.rejects(F.importArchive(await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.version=version;files[0].blob=new Blob([JSON.stringify(m)]);})),/будущая версия/);
 const f=fixture();f.projects.editor.secretToken='SECRET';await assert.rejects(F.exportArchive(f.projects,f.assets,'test'));
 delete f.projects.editor.secretToken;f.projects.video.secretToken='SECRET';await assert.rejects(F.exportArchive(f.projects,f.assets,'test'),/Неподдерживаемое поле/);
 delete f.projects.video.secretToken;f.projects.editor.version=1;await assert.rejects(F.exportArchive(f.projects,f.assets,'test'),/DTO 2.*DTO 1/);
});
test('v2 validates manifest/project/payload integrity, exact referenced set and duplicate IDs',async()=>{
 const {zip}=await archive();
 for(const mutate of [
  async files=>{files[0].blob=new Blob(['{broken']);},async files=>{files[1].blob=new Blob(['{broken']);},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.project.sha256='0'.repeat(64);files[0].blob=new Blob([JSON.stringify(m)]);},
  async files=>{files[2].blob=new Blob(['corrupt original']);},async files=>{files.pop();},
  async files=>{files.push({path:'assets/'+'f'.repeat(64)+'.bin',blob:new Blob(['extra'])});},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.assets[1].id=m.assets[0].id;files[0].blob=new Blob([JSON.stringify(m)]);},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.assets[0].kind='voice';files[0].blob=new Blob([JSON.stringify(m)]);},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.assets[0].size+=1;files[0].blob=new Blob([JSON.stringify(m)]);},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.assets[0].sha256=[m.assets[0].sha256];files[0].blob=new Blob([JSON.stringify(m)]);},
  async files=>{const m=JSON.parse(await files[0].blob.text());m.project.sha256=[m.project.sha256];files[0].blob=new Blob([JSON.stringify(m)]);},
 ])await assert.rejects(F.importArchive(await rewrite(zip,mutate)));
 const incomplete=await F.importArchive(zip);incomplete.assets.delete('studio-inactive');await assert.rejects(F.remap(incomplete),/Нет исходного файла/);
});
test('v2 count, directory, logical amplification and payload limits are bounded before large allocations',async()=>{
 const {zip}=await archive();
 await assert.rejects(F.importArchive(await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.assets=Array(513).fill(m.assets[0]);files[0].blob=new Blob([JSON.stringify(m)]);})),/лимит/);
 await assert.rejects(F.importArchive(await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.assets.forEach(a=>a.size=32*1048576);files[0].blob=new Blob([JSON.stringify(m)]);})),/64 МиБ/);
 let touched=false;await assert.rejects(Z.read({size:64*1048576+1,slice(){touched=true;}},2),/объём/);assert.equal(touched,false);
 await assert.rejects(Z.create(Array(515).fill({path:'project.json',blob:new Blob([])}),undefined,2),/число файлов/);
 await assert.rejects(Z.create([{path:'project.json',blob:{size:32*1048576+1,arrayBuffer(){touched=true;}}}],undefined,2),/объём/);assert.equal(touched,false);
 const bytes=new Uint8Array(await zip.arrayBuffer());new DataView(bytes.buffer).setUint32(bytes.length-10,65537,true);await assert.rejects(F.importArchive(new Blob([bytes])),/каталог/);
});
test('the complete v2 512-original/514-entry profile round trips; the next reference or oversized manifest fails',async()=>{
 const editor=C.upgradeProject(C.createProject()),video=DB.normalize('video',{...V.demo(),scenes:[]}),assets=new Map(),png=fs.readFileSync('tests/fixtures/backup-media/red.png');
 editor.scenes=Array.from({length:512},(_,i)=>{
  const id='max-'+i;assets.set(id,{id,kind:'image',name:id+'.png',blob:new Blob([png,Uint8Array.of(i&255,i>>>8)],{type:'image/png'})});
  return {id:'s-'+i,text:'',visual:'animated',imageId:id,durationMs:1};
 });editor.selectedSceneId='s-0';
 const zip=await F.exportArchive({editor,video},assets,'test'),bundle=await F.importArchive(zip);
 assert.equal((await Z.read(zip,2)).entries.size,514);assert.equal(bundle.assets.size,512);assert.deepEqual(plain(bundle.projects),plain(F.states({editor,video})));
 for(const [id,a] of assets)assert.deepEqual(Buffer.from(await bundle.assets.get(id).blob.arrayBuffer()),Buffer.from(await a.blob.arrayBuffer()));
 editor.scenes.push({id:'s-513',text:'',imageId:'too-many'});await assert.rejects(F.exportArchive({editor,video},assets,'test'),/максимум 512/);editor.scenes.pop();
 for(const a of assets.values())a.name='x'.repeat(1024);
 await assert.rejects(F.exportArchive({editor,video},assets,'test'),/manifest/);
});
test('v2 unsafe/duplicate paths, encrypted entries and inconsistent sizes are still rejected',async()=>{
 const {zip}=await archive(),source=new Uint8Array(await zip.arrayBuffer());
 for(const attack of ['path','duplicate','encrypted','overflow','overlap']){
  const bytes=source.slice(),d=new DataView(bytes.buffer),start=d.getUint32(bytes.length-6,true);let pos=start;const records=[];
  for(let i=0;i<d.getUint16(bytes.length-12,true);i++){records.push(pos);pos+=46+d.getUint16(pos+28,true);}
  const a=records[2],b=records[3],n=d.getUint16(a+28,true),local=d.getUint32(a+42,true);
  if(attack==='path'){const name=Buffer.from('../'+'x'.repeat(n-3));bytes.set(name,a+46);bytes.set(name,local+30);}
  if(attack==='duplicate'){bytes.set(bytes.slice(a+46,a+46+n),b+46);bytes.set(bytes.slice(a+46,a+46+n),d.getUint32(b+42,true)+30);}
  if(attack==='encrypted')d.setUint16(a+8,0x801,true);if(attack==='overflow')d.setUint32(a+24,0xffffffff,true);if(attack==='overlap')d.setUint32(a+42,0,true);
  await assert.rejects(F.importArchive(new Blob([bytes])),undefined,attack);
 }
});
