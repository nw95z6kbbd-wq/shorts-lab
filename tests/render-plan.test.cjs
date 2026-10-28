'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/core.js'),V=require('../js/video-core.js'),P=require('../js/render-plan.js'),A=require('../js/render-adapters.js');
const golden=require('./fixtures/render-plan/legacy-plans.json'),baseline=require('./fixtures/studio-safety/projects-1.4.0.json');
const context={module:{exports:{}},require:()=>C};vm.runInNewContext(fs.readFileSync('tests/fixtures/render-plan/video-core-before.js','utf8'),context);
const old=context.module.exports,plain=value=>JSON.parse(JSON.stringify(value));
const frameValue=f=>({time:f.time,sceneId:f.scene.id,sceneIndex:f.scene.index,sceneStartMs:f.scene.startMs,sceneEndMs:f.scene.endMs,cue:f.cue,activeWord:f.activeWord,localMs:f.localMs});
function editor(){const p=C.upgradeProject(baseline.editor);p.scenes=[{...p.scenes[0],text:'Раз два три.'},{...p.scenes[1],text:'Четыре пять.'}];p.selectedSceneId=p.scenes[0].id;return p;}

test('frozen before-refactor plans, SRT and boundary frames match the legacy facade exactly',()=>{
 for(const f of golden.cases){
  const before=JSON.stringify(f.draft),plan=V.makePlan(f.draft);
  assert.deepEqual(plan,f.plan,f.name);assert.equal(V.generateSrt(plan),f.srt,f.name);
  for(const sample of f.frames)assert.deepEqual(frameValue(V.frameAt(plan,sample.t)),sample.value,f.name+' at '+sample.t);
  const shared=A.fromVideo(f.draft);assert.deepEqual(P.legacyView(shared,f.draft),f.plan);assert.equal(P.generateSrt(shared),f.srt);
  assert.equal(JSON.stringify(f.draft),before,'input not mutated');
 }
});
test('independent old implementation matches timing/cues/frames over deterministic varied inputs',()=>{
 let seed=13;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 for(let n=0;n<200;n++){
  const d={...baseline.video,timing:n%2?'manual':'auto',durationSeconds:[.5,3,15,18,20,30,60][n%7]};
  d.scenes=Array.from({length:1+n%12},(_,i)=>({id:'s'+i,text:i%5?'слово '.repeat(Math.floor(random()*35)):'…',durationSeconds:.5+random()*2,visual:i%3?'animated':'image',imageId:i%3?null:'shared',camera:['zoom-in','zoom-out','pan-left','pan-right','static'][i%5],transition:['none','slide','zoom','crossfade'][i%4]}));
  const expected=plain(old.makePlan(d)),actual=V.makePlan(d);assert.deepEqual(actual,expected);assert.equal(V.generateSrt(actual),old.generateSrt(expected));
  for(const time of [-1,0,1,...expected.timeline.flatMap(s=>[s.startMs,s.endMs-1,s.endMs]),expected.durationMs+50])assert.deepEqual(V.frameAt(actual,time),plain(old.frameAt(expected,time)));
 }
});
test('editor reads edited scenes, keeps IDs/order, uses 150 wpm and never expands to audio length',()=>{
 const p=editor();p.script='Исходный сценарий совершенно другой.';p.sourceScript='Ещё более ранний текст.';
 const before=JSON.stringify(p),plan=A.fromEditor(p);
 assert.equal(plan.durationMs,2000);assert.deepEqual(plan.output,{width:V.WIDTH,height:V.HEIGHT,fps:V.FPS});assert.deepEqual(plan.timeline.map(s=>[s.id,s.text,s.startMs,s.endMs]),[[p.scenes[0].id,'Раз два три.',0,1200],[p.scenes[1].id,'Четыре пять.',1200,2000]]);
 assert.equal(P.generateSrt(plan),C.generateSrt(p.scenes));assert.equal(plan.audio.durationFromAudio,false);assert.equal(plan.audio.music.loop,false);assert.equal(plan.audio.voice.loop,false);
 assert.equal(JSON.stringify(p),before);assert.deepEqual(A.fromEditor(p),plan);assert.deepEqual(JSON.parse(JSON.stringify(plan)),plan);
});
test('editor manual milliseconds override only in explicit mode; null falls back to reading',()=>{
 const p=editor();p.scenes[0].durationMs=1234;p.scenes[1].durationMs=null;
 assert.equal(A.fromEditor(p).durationMs,2000);p.timing='manual';
 const plan=A.fromEditor(p);assert.deepEqual(plan.timeline.map(s=>[s.startMs,s.endMs]),[[0,1234],[1234,2034]]);
 assert.equal(P.frameAt(plan,1233).scene.id,p.scenes[0].id);assert.equal(P.frameAt(plan,1234).scene.id,p.scenes[1].id);
 assert.equal(P.frameAt(plan,999999).time,2033);assert.equal(P.frameAt(plan,500).activeWord,-1);
 for(const s of plan.timeline)assert.ok(Number.isSafeInteger(s.startMs)&&Number.isSafeInteger(s.endMs));
 p.scenes[0].durationMs=Number.MAX_SAFE_INTEGER;assert.throws(()=>A.fromEditor(p),{code:'TIMING'});
});
test('zero/short/long text and intentional silent images retain explicit timing semantics',()=>{
 const p=editor();p.scenes[0].text='… 🌌';p.scenes[1].text='а';let plan=A.fromEditor(p);
 assert.equal(plan.durationMs,400);assert.equal(plan.timeline.length,1);assert.deepEqual(plan.omittedScenes,[{id:p.scenes[0].id,reason:'zero-reading-duration'}]);
 p.scenes[1].text='';plan=A.fromEditor(p);assert.equal(plan.durationMs,0);assert.deepEqual(plan.cues,[]);assert.throws(()=>P.frameAt(plan,0),{code:'EMPTY'});
 p.timing='manual';p.scenes[0].durationMs=1;p.scenes[0].visual='image';p.scenes[0].imageId='photo';plan=A.fromEditor(p);assert.equal(plan.durationMs,1);assert.equal(P.frameAt(plan,0).cue.text,'… 🌌');
 p.scenes=Array.from({length:5000},(_,i)=>({...p.scenes[0],id:'manual-'+i,text:'слово '.repeat(51),durationMs:1000}));
 plan=A.fromEditor(p);assert.equal(plan.timeline.length,5000);assert.equal(plan.durationMs,5000000);assert.ok(plan.timeline.every(s=>s.text.length>280));
});
test('subtitle policies are explicit: editor scene SRT, optional editor chunks, video chunks',()=>{
 const p=editor();p.scenes[0].text='Раз два три четыре пять шесть семь восемь девять десять.';
 const scene=A.fromEditor(p),video=A.fromVideo({...baseline.video,scenes:p.scenes});
 assert.equal(scene.subtitles.policy,'editor-scene');assert.equal(scene.timeline[0].cues.length,1);assert.equal(video.subtitles.policy,'video-chunks-6');assert.equal(video.timeline[0].cues.length,2);
 assert.equal(scene.subtitles.highlight,'none');assert.equal(video.subtitles.highlight,'estimated-word');
 p.subtitles.mode='chunks';const chunks=A.fromEditor(p);assert.equal(chunks.subtitles.policy,'editor-chunks-6');assert.equal(chunks.timeline[0].cues.length,2);assert.equal(P.frameAt(chunks,500).activeWord,-1);
 p.subtitles.enabled=false;assert.equal(P.generateSrt(A.fromEditor(p)),'');
});
test('adapters retain independent media, camera, transitions, gains and exact legacy fades',()=>{
 const p=editor();Object.assign(p.scenes[0],{visual:'image',imageId:'editor-image',camera:'pan-right',transition:'slide'});p.audio.voice.assetId='editor-voice';p.audio.music.assetId='editor-music';p.audio.music.volume=.19;p.audio.music.fadeInMs=1234;
 const v={...baseline.video,voiceAssetId:'video-voice',musicAssetId:'video-music',musicFadeIn:.1234567,musicVolume:.37};
 const ep=A.fromEditor(p),vp=A.fromVideo(v);assert.deepEqual(ep.media.map(m=>m.assetId),['editor-image','editor-voice','editor-music']);assert.deepEqual(vp.media.map(m=>m.assetId),['baseline-original-image','video-voice','video-music']);
 assert.equal(ep.timeline[0].camera,'pan-right');assert.equal(ep.timeline[0].transition,'slide');assert.equal(ep.timeline[0].imageId,'editor-image');
 assert.equal(P.audioOptions(ep).fadeIn,1.234);assert.equal(P.audioOptions(vp).fadeIn,.1234567);assert.equal(P.audioOptions(vp).musicVolume,.37);
 assert.deepEqual(ep.exportSettings,p.exportSettings);assert.equal(ep.audio.policy,'start-at-zero-clip-at-plan-end');
});
test('appearance is namespaced and exact: manual themes never map to video themes',()=>{
 for(const theme of ['cosmos','dusk','minimal'])for(const caption of ['accent','classic','outline'])for(const size of ['small','medium','large']){
  const p=editor();p.style={theme,caption,size};const plan=A.fromEditor(p);
  assert.deepEqual(plan.appearance.requested,{namespace:'editor',theme,caption,size});assert.equal(plan.theme,theme);assert.equal(plan.caption,caption);assert.equal(plan.appearance.supported,true);assert.deepEqual(plan.appearance.limitations,[]);
  assert.doesNotThrow(()=>P.assertRenderable(plan));assert.throws(()=>P.assertRenderable({...plan,appearance:{...plan.appearance,supported:false}}),{code:'APPEARANCE'});assert.throws(()=>P.legacyView(plan,baseline.video),{code:'POLICY'});
 }
 for(const theme of ['space','mystery','sunrise','neon']){const plan=A.fromVideo({...baseline.video,theme});assert.equal(plan.theme,theme);assert.equal(plan.appearance.resolved.theme,theme);assert.doesNotThrow(()=>P.assertRenderable(plan));}
});
test('legacy editor remains unmodified, invalid/future data is refused deterministically',()=>{
 const old=JSON.stringify(baseline.editor),plan=A.fromEditor(baseline.editor);assert.equal(plan.source.dtoVersion,1);assert.equal(JSON.stringify(baseline.editor),old);assert.equal(P.generateSrt(plan),C.generateSrt(baseline.editor.scenes));
 const p=editor();assert.throws(()=>A.fromEditor({...p,version:999}),{code:'UNSUPPORTED'});p.scenes[1].id=p.scenes[0].id;assert.throws(()=>A.fromEditor(p));
 for(const durationSeconds of [0,-1,61,NaN,Infinity])assert.throws(()=>A.fromVideo({...baseline.video,durationSeconds}));
 assert.throws(()=>A.fromVideo({...baseline.video,scenes:Array.from({length:13},(_,i)=>({id:'v'+i,text:'a'}))}));
 assert.throws(()=>A.fromVideo({...baseline.video,scenes:[{id:'v',text:'a'.repeat(281)}]}));
});

test('editor calculation does not read clocks or generate missing project IDs',()=>{
 const p=plain(baseline.editor);delete p.updatedAt;const NativeDate=global.Date;
 try{global.Date=class{constructor(){throw Error('clock consulted');}static now(){throw Error('clock consulted');}};assert.deepEqual(A.fromEditor(p),A.fromEditor(p));}
 finally{global.Date=NativeDate;}
 assert.equal(p.updatedAt,undefined);delete p.id;assert.throws(()=>A.fromEditor(p),/идентификатор проекта/);
});

test('editor short chunks cannot silently create zero-length SRT cues or switch policy',()=>{
 const p=editor();p.timing='manual';p.scenes=[{...p.scenes[0],text:'Раз два три четыре пять шесть семь.',durationMs:1}];p.selectedSceneId=p.scenes[0].id;p.subtitles.mode='chunks';
 const before=JSON.stringify(p);assert.throws(()=>A.fromEditor(p),{code:'SUBTITLES'});assert.equal(JSON.stringify(p),before);
 p.subtitles.mode='scene';const plan=A.fromEditor(p);assert.equal(plan.cues.length,1);assert.equal(plan.cues[0].endMs-plan.cues[0].startMs,1);
 p.subtitles.mode='chunks';p.scenes[0].durationMs=2;assert.throws(()=>A.fromEditor(p),{code:'SUBTITLES'});p.scenes[0].durationMs=4;assert.ok(A.fromEditor(p).cues.every(c=>c.endMs>c.startMs));
});
