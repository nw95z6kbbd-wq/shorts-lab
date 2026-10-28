'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js'),T=require('../js/editor-timing.js');
const mediaFactory=require('../js/media-session.js'),renderFactory=require('../js/render-session.js'),previewFactory=require('../js/editor-preview.js'),imagesFactory=require('../js/editor-images.js');
const png=fs.readFileSync('tests/fixtures/backup-media/red.png'),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
const delay=()=>new Promise(r=>setTimeout(r,0));
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function project(n=3){const p=C.upgradeProject(C.createProject());p.timing='manual';p.scenes=Array.from({length:n},(_,i)=>({id:'s'+i,text:'сцена '+i,durationMs:1000,visual:'image',imageId:'image'+i,imageName:'original.png',camera:'zoom-in',transition:'crossfade'}));p.selectedSceneId='s0';p.audio.voice.assetId='do-not-read-voice';return p;}
function fixture(){
 const originals=new Map(),reads=[],closed=[],decodes=[],stages=new Map();let decoding;
 const media=mediaFactory({original:async id=>{reads.push(id);return stages.get(id)||originals.get(id);},image:async blob=>{decodes.push(blob);if(decoding)await decoding.promise;return{image:{width,height},width,height,dispose(){closed.push(blob);}};},audio:()=>{throw Error('preview decoded audio');}});
 const runtime=renderFactory({adapters:A,plan:P,media,render:(canvas,plan,time,resources)=>{const frame=P.frameAt(plan,time);if(frame.scene.visual==='image')assert.ok(resources.images.has(frame.scene.imageId));canvas.frames.push({id:frame.scene.id,time});}});
 const storage={stage:(id,blob,name,kind)=>stages.set(id,{id,blob,name,kind}),pending:id=>stages.has(id),discard:id=>stages.delete(id)};
 return{media,runtime,reads,closed,decodes,storage,stages,originals,setGate:g=>decoding=g,seed:p=>p.scenes.forEach(s=>originals.set(s.imageId,{id:s.imageId,kind:'image',blob:new Blob([png],{type:'image/png'})}))};
}
const opts=(p,timeMs=0)=>({slot:'editor',project:p,plan:A.fromEditor(p),projectId:p.id,contentRevision:1,timeMs});
test('preview window uses full immutable plan but reads only current/previous images, no audio, no partial recording',async()=>{
 const f=fixture(),p=project(5000);f.seed(p);const s=f.runtime.createPreview(opts(p,3250000));await s.prepare();assert.deepEqual(f.reads,['image3250','image3249']);assert.equal(s.snapshot.scenes.length,5000);assert.equal(s.status().neededMedia,2);
 s.renderFrame({frames:[]},3250000);assert.throws(()=>s.renderFrame({frames:[]},3251000),{code:'FRAME_WINDOW'});
 await assert.rejects(s.record({}),{code:'PREVIEW_ONLY'});await assert.rejects(s.playAudio(),{code:'PREVIEW_ONLY'});await s.dispose();assert.equal(f.closed.length,2);assert.equal(f.media.statistics().residentBytes,0);
 const first=f.runtime.createPreview(opts(p));await first.prepare();assert.equal(first.status().neededMedia,1);await first.dispose();
 p.scenes[10].transition='none';const single=f.runtime.createPreview(opts(p,10000));await single.prepare();assert.equal(single.status().neededMedia,1);await single.dispose();
});
test('preview images deduplicate, inactive references stay data-only, wrong MIME and missing originals fail honestly',async()=>{
 const f=fixture(),p=project();p.scenes[1].imageId=p.scenes[0].imageId;f.seed(p);const s=f.runtime.createPreview(opts(p,1000));await s.prepare();assert.equal(s.status().neededMedia,1);await s.dispose();
 p.scenes[1].visual='animated';p.scenes[1].transition='none';const animated=f.runtime.createPreview(opts(p,1000));await animated.prepare();assert.equal(animated.status().neededMedia,0);await animated.dispose();
 f.originals.get('image0').blob=new Blob([png],{type:'image/jpeg'});const wrong=f.runtime.createPreview(opts(p));await assert.rejects(wrong.prepare(),{code:'MEDIA_TYPE'});await wrong.dispose();f.originals.delete('image0');const missing=f.runtime.createPreview(opts(p));await assert.rejects(missing.prepare(),{code:'MISSING_ORIGINAL'});await missing.dispose();assert.equal(f.media.statistics().sessions,0);
});
test('latest request wins during real asynchronous decode; one owner and bounded resources after repeated seek/cancel',async()=>{
 const f=fixture(),p=project();f.seed(p);const decoding=gate();f.setGate(decoding);const canvas={frames:[]},states=[],controller=previewFactory({runtime:f.runtime,plan:P}).create({canvas,onState:s=>states.push(s.state)});
 const first=controller.draw({project:p,plan:A.fromEditor(p),time:0,revision:1});for(let i=0;i<50&&!f.decodes.length;i++)await delay();assert.equal(f.decodes.length,1);
 const next=controller.draw({project:p,plan:A.fromEditor(p),time:2000,revision:2});assert.equal(await first,false);assert.equal(f.media.statistics().sessions,1);decoding.resolve();f.setGate(null);assert.equal(await next,true);assert.deepEqual(canvas.frames.map(f=>f.id),['s2']);assert.equal(f.media.statistics().sessions,1);
 for(let i=0;i<12;i++){await controller.draw({project:p,plan:A.fromEditor(p),time:i%3*1000,revision:2});await controller.suspend();}
 await controller.dispose();await controller.dispose();assert.equal(f.media.statistics().sessions,0);assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.decodes.length,f.closed.length);
});
test('staged uploads validate via the existing owner, preserve accepted originals and discard cancelled prospective files',async()=>{
 const f=fixture(),p=project(),accepted=[],states=[];let count=0;const images=imagesFactory({media:f.media,storage:f.storage,id:()=> 'upload'+ ++count}).create({owner:()=>p.id,valid:()=>true,accept:(id,img)=>{accepted.push({id,img});return true;},onState:(id,state)=>states.push(state)});
 const file=Object.assign(new Blob([png],{type:'image/png'}),{name:'original.png'});assert.equal(await images.load('s0',file),true);assert.equal(accepted[0].img.id,'upload1');assert.deepEqual(new Uint8Array(await f.stages.get('upload1').blob.arrayBuffer()),new Uint8Array(png));assert.equal(f.media.statistics().sessions,0);
 const g=gate();f.setGate(g);const second=images.load('s1',file);for(let i=0;i<50&&f.decodes.length<2;i++)await delay();const closing=images.cancel();g.resolve();assert.equal(await second,false);await closing;assert.ok(!f.stages.has('upload2'));assert.ok(f.stages.has('upload1'));
 images.retain(new Set(['upload1']));assert.ok(f.stages.has('upload1'));images.retain(new Set());assert.ok(!f.stages.has('upload1'));await images.dispose();assert.equal(f.media.statistics().residentBytes,0);
});
test('new visual actions upgrade only explicitly and preserve every other field / existing IDs',()=>{
 const old=C.createProject(true),before=JSON.stringify(old);T.compile(old);assert.equal(JSON.stringify(old),before);assert.equal(old.version,1);
 let p=T.edit(old,{type:'image',id:old.scenes[0].id,value:{id:'original',name:'x.png'}});assert.equal(p.version,2);assert.equal(p.scenes[0].id,old.scenes[0].id);assert.equal(p.scenes[0].visual,'image');
 p=T.edit(p,{type:'camera',id:p.scenes[0].id,value:'pan-right'});p=T.edit(p,{type:'transition',id:p.scenes[0].id,value:'slide'});const image=p.scenes[0].imageId;
 p=T.edit(p,{type:'visual',id:p.scenes[0].id,value:'animated'});assert.equal(p.scenes[0].imageId,image);assert.equal(p.scenes[0].camera,'pan-right');assert.equal(p.scenes[0].transition,'slide');
 assert.throws(()=>T.edit(p,{type:'camera',id:p.scenes[0].id,value:'new-camera'}));
});

test('precise additive runtime/source bridges retain the previous full preparation, recorder, mixer and storage',()=>{
 const {createHash}=require('node:crypto'),hash=b=>createHash('sha256').update(b).digest('hex'),before=require('./fixtures/editor-live/before.json'),bridges=require('./fixtures/editor-live/runtime-bridges.json');
 assert.equal(before.commit,'0ffcb4812e6389011701ea8f852ef367cbaf602a');
 for(const [file,sha] of Object.entries(before.files))assert.equal(hash(fs.readFileSync('tests/fixtures/editor-live/'+file.split('/').pop())),sha);
 for(const [file,entries] of Object.entries(bridges)){let s=fs.readFileSync(file,'utf8');for(const e of entries){assert.equal(s.split(e.new).length,2,file+' exact supported extension');s=s.replace(e.new,e.old);}assert.equal(hash(s),before.files[file],file+' full path unchanged');}
 const old=fs.readFileSync('tests/fixtures/editor-live/app.js','utf8'),now=fs.readFileSync('js/app.js','utf8');for(const [start,end] of [['  async function saveNow()', '  function changed()'],['  function changed()', '  function confirmAction('],['    backupSnapshot()', '    confirm:'],['    useScript(', '  renderAll();']]){const slice=s=>s.slice(s.indexOf(start),s.indexOf(end,s.indexOf(start)));assert.equal(slice(old),slice(now),start);}
});

test('preview working-set and JSON budgets reject before unbounded allocation, leaving originals intact',async()=>{
 const f=fixture(),p=project();f.seed(p);const s=f.runtime.createPreview({...opts(p,1000),limits:{maxImages:1}});await assert.rejects(s.prepare(),{code:'IMAGE_COUNT'});await s.dispose();assert.equal(f.reads.length,0);assert.equal(f.originals.size,3);
 const canvas={frames:[]},states=[],controller=previewFactory({runtime:f.runtime,plan:P}).create({canvas,onState:s=>states.push(s)});const plan=A.fromEditor(p);p.script='x'.repeat(16*1048576+1);assert.equal(await controller.draw({project:p,plan,time:0,revision:1}),false);assert.equal(states.at(-1).error.code,'DATA_BUDGET');assert.equal(f.media.statistics().sessions,0);await controller.dispose();
});
test('upload validation and the explicit staged-byte budget never accept or discard referenced originals on failure',async()=>{
 const f=fixture(),p=project(),events=[];let seq=0;const uploads=imagesFactory({media:f.media,storage:f.storage,id:()=> 'pending'+ ++seq}).create({owner:()=>p.id,valid:()=>true,accept:()=>true,onState:(id,s,e)=>events.push({s,e})});
 assert.equal(await uploads.load('s0',new Blob([png],{type:'image/svg+xml'})),false);assert.equal(f.stages.size,0);
 assert.equal(await uploads.load('s0',new Blob([png],{type:'image/jpeg'})),false);assert.equal(f.stages.size,0);
 const large=new Blob([png,new Uint8Array(15*1048576-png.length)],{type:'image/png'});
 for(let i=0;i<4;i++)assert.equal(await uploads.load('s'+i,large),true);
 const before=[...f.stages.keys()];assert.equal(await uploads.load('s4',large),false);assert.deepEqual([...f.stages.keys()],before);assert.match(events.at(-1).e.message,/64 МиБ/);await uploads.dispose();assert.equal(f.media.statistics().residentBytes,0);assert.deepEqual([...f.stages.keys()],before);
});
