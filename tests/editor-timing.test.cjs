'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto');
const C=require('../js/core.js'),V=require('../js/video-core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js'),T=require('../js/editor-timing.js');
function project(){const p=C.createProject();p.script='Исходный сценарий не совпадает со сценами.';p.sourceScript=p.script;p.scenes=[{id:'a',text:'один два'},{id:'b',text:''},{id:'c',text:'Три 🌌 four'}];p.selectedSceneId='b';return p;}
const edit=(p,type,value,id)=>T.edit(p,{type,value,id});
test('Reading uses edited scenes, exact 150 words/min, omitted empty rows and canonical SRT',()=>{
 const p=project(),before=structuredClone(p),{plan,byId}=T.compile(p);assert.deepEqual(p,before);assert.equal(p.version,1);
 assert.equal(plan.durationMs,1600);assert.deepEqual([...byId.values()].map(r=>[r.id,r.startMs,r.endMs]),[['a',0,800],['b',800,800],['c',800,1600]]);
 const changed=edit(p,'text','одно','a');assert.equal(T.compile(changed).plan.durationMs,1200);assert.equal(changed.script,p.script);
 assert.equal(P.generateSrt(plan),C.generateSrt(p.scenes));assert.equal(plan.subtitles.policy,'editor-scene');
});
test('explicit Manual upgrades only on action; null fallback and Reading preserve overrides and fields',()=>{
 let p=project();assert.equal(edit(p,'timing','reading'),p);p=edit(p,'timing','manual');assert.equal(p.version,2);
 Object.assign(p.scenes[0],{imageId:'original',visual:'image',camera:'pan-left',transition:'slide'});const before=structuredClone(p);
 p=edit(p,'duration','1,234','a');p=edit(p,'duration','.001','b');assert.equal(T.compile(p).plan.durationMs,2035);
 const r=edit(p,'timing','reading');assert.equal(T.compile(r).plan.durationMs,1600);assert.equal(r.scenes[0].durationMs,1234);
 assert.equal(T.compile(edit(r,'timing','manual')).plan.durationMs,2035);p=edit(p,'duration','','a');assert.equal(p.scenes[0].durationMs,null);assert.equal(T.compile(p).plan.durationMs,1601);
 for(const field of ['imageId','visual','camera','transition'])assert.equal(p.scenes[0][field],before.scenes[0][field]);
});
test('exact decimal seconds reject unsafe, fractional-ms, negative, nonfinite and nonnumeric values',()=>{
 for(const raw of ['0','-1','NaN','Infinity','1e3','1.2345','9007199254740.992','1x','1,2,3'])assert.throws(()=>T.parseSeconds(raw),{code:'EDITOR_INPUT'},raw);
 for(const [raw,ms] of [['',null],['  ',null],['0.001',1],[',5',500],['12,345',12345],['9007199254740.991',Number.MAX_SAFE_INTEGER]]){assert.equal(T.parseSeconds(raw),ms);assert.equal(T.parseSeconds(T.seconds(ms)),ms);}
 assert.equal(T.clock(12345),'0:12,345');assert.equal(T.clock(60000),'1:00');
});
test('reordering is immutable and preserves IDs, all scene fields, selection and original script',()=>{
 let p=edit(project(),'timing','manual');Object.assign(p.scenes[0],{durationMs:1234,imageId:'shared',imageName:'a.png',visual:'animated',camera:'pan-right',transition:'slide'});p.scenes[2].imageId='shared';
 const before=structuredClone(p);p=edit(p,'move',1,'a');assert.deepEqual(p.scenes,[before.scenes[1],before.scenes[0],before.scenes[2]]);assert.equal(p.selectedSceneId,'b');assert.equal(p.script,before.script);
 p=edit(p,'move',1,'a');const {plan,byId}=T.compile(p);assert.deepEqual(plan.timeline.map(s=>s.id),['c','a']);assert.deepEqual([...byId.values()].map(s=>[s.id,s.startMs,s.endMs]),[['b',0,0],['c',0,800],['a',800,2034]]);
 assert.ok(P.generateSrt(plan).indexOf('Три')<P.generateSrt(plan).indexOf('один'));assert.deepEqual(C.parseProject(p),p);
 const added=edit(p,'add');assert.equal(added.scenes.length,4);assert.equal(added.scenes[3].durationMs,null);assert.equal(edit(added,'remove',null,added.selectedSceneId).scenes.length,3);
});
test('both subtitle policies, disabled captions, Unicode and short chunks keep explicit failures',()=>{
 let p=edit(project(),'timing','manual');p=edit(p,'text','один два три four пять 🌌 семь','a');p=edit(p,'duration','0.001','a');
 assert.equal(T.compile(p).plan.subtitles.policy,'editor-scene');p=edit(p,'subtitle-mode','chunks');assert.throws(()=>T.compile(p),{code:'SUBTITLES'});
 const off=edit(p,'subtitle-enabled',false);assert.equal(T.compile(off).plan.cues.length,0);assert.equal(P.generateSrt(T.compile(off).plan),'');assert.equal(off.subtitles.mode,'chunks');
 p=edit(p,'duration','0.007','a');const plan=T.compile(p).plan;assert.equal(plan.subtitles.policy,'editor-chunks-6');assert.equal(plan.cues[0].endMs,6);assert.equal(plan.cues[1].endMs,7);assert.equal(plan.cues[1].text,'семь');
 for(const cue of plan.cues)assert.ok(cue.endMs>cue.startMs&&cue.startMs>=0&&cue.endMs<=plan.durationMs);
});
test('maximum safe millisecond boundaries use exact Editor cue portions; aggregate overflow fails',()=>{
 for(const durationMs of [Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER-5]){
  let p=edit(project(),'timing','manual');p.scenes=[{...p.scenes[0],text:'один два три',durationMs}];p.selectedSceneId='a';const plan=T.compile(p).plan;
  assert.equal(plan.cues[0].endMs,durationMs);assert.equal(plan.timeline[0].endMs,durationMs);
  p.scenes.push({...p.scenes[0],id:'other',durationMs:100});assert.throws(()=>T.compile(p));
 }
 const old=require('./fixtures/editor-timing/unsafe-cues-before.json');assert.notEqual(old.cues[0].endMs,old.durationMs,'frozen original bug is independently reproduced');
});
test('valid legacy identities survive plan calculation without conversion, mutation or regenerated IDs',()=>{
 const p=project();p.id='legacy project with spaces';p.scenes[0].id='legacy scene with spaces';p.selectedSceneId=p.scenes[0].id;
 const parsed=C.parseProject(p),before=JSON.stringify(parsed),result=T.compile(parsed);assert.equal(result.plan.timeline[0].id,p.scenes[0].id);assert.equal(JSON.stringify(parsed),before);assert.equal(parsed.version,1);
 assert.deepEqual(edit(parsed,'move',1,p.scenes[0].id).scenes.map(s=>s.id),['b',p.scenes[0].id,'c']);assert.throws(()=>edit(parsed,'timing','manual'),'DTO2 rejects incompatible identities explicitly instead of renaming them');
});
test('5000 scenes preserve identity and fallback; future DTO and too many scenes are rejected',()=>{
 const p=project();p.scenes=Array.from({length:5000},(_,i)=>({id:'s'+i,text:i%2?'':'слово'}));p.selectedSceneId='s4999';
 const plan=T.compile(p).plan;assert.equal(plan.timeline.length,2500);assert.equal(plan.durationMs,1000000);
 const moved=edit(p,'move',-1,'s4999');assert.equal(moved.scenes[4998].id,'s4999');assert.equal(moved.selectedSceneId,'s4999');assert.throws(()=>edit(p,'add'),{code:'EDITOR_INPUT'});assert.throws(()=>T.compile({...p,version:999}),{code:'UNSUPPORTED'});
});
test('frozen pre-integration code proves storage, Video, baseline and narrow save barriers remain protected',()=>{
 const hash=b=>createHash('sha256').update(b).digest('hex'),before=require('./fixtures/editor-timing/before.json');assert.equal(before.commit,'d4d8cd5bccd8ac466562363cdffbd4ef348b94c0');
 for(const name of ['js/app.js','index.html'])assert.equal(hash(fs.readFileSync('tests/fixtures/editor-timing/'+(name==='index.html'?'index-before.html':'app-before.js'))),before.files[name]);
 for(const [name,sha] of Object.entries(before.files))if(!['js/app.js','index.html','js/render-plan.js','js/render-adapters.js'].includes(name))assert.equal(hash(fs.readFileSync(name)),sha,name);
 const old=fs.readFileSync('tests/fixtures/editor-timing/app-before.js','utf8'),now=fs.readFileSync('js/app.js','utf8');
 const slice=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b));
 for(const [a,b,remove] of [
  ['  async function saveNow()', '  function changed()', '    if (timing.error) { showTimingError(); return false; }\n'],
  ['  function changed()', '  function confirmAction(', '    if (timing.error) showTimingError(); else lastGoodProject = project;\n'],
  ['  function toast(', '  async function saveNow()', ''],
  ['  // Flush the debounce', '  // Additive bridge', ''],
  ['    useScript({ title, scenes })', '  renderAll();', '']
 ])assert.equal(slice(now,a,b).replace(remove,''),slice(old,a,b),a+' unchanged except explicit calculation barrier');
 assert.ok(!/C\.(timeline|totalDuration|generateSrt)\(/.test(now),'no parallel scene timing or SRT calculation in UI');
});
