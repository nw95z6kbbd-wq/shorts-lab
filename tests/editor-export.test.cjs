'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js'),E=require('../js/editor-profile.js');
const mediaFactory=require('../js/media-session.js'),runtimeFactory=require('../js/render-session.js'),factory=require('../js/editor-export.js'),I=require('../js/export-inspector.js');
const read=name=>fs.readFileSync('tests/fixtures/editor-export/'+name),delay=()=>new Promise(r=>setImmediate(r));
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay();}throw Error('condition timed out');}
function project(){const p=C.upgradeProject(C.createProject());p.timing='manual';p.scenes=[0,1,2].map(i=>({id:'scene-'+i,text:'Сцена '+i,durationMs:i===2?334:333,visual:'image',imageId:'original',imageName:'original.png',camera:'pan-left',transition:'crossfade'}));p.selectedSceneId=p.scenes[1].id;p.script='Исходный сценарий отличается от сцен';p.audio.voice.assetId='voice';p.audio.music.assetId='music';return p;}
function setup(){
 const png=fs.readFileSync('tests/fixtures/backup-media/red.png'),width=png.readUInt32BE(16),height=png.readUInt32BE(20),originals=new Map([['original',{kind:'image',blob:new Blob([png],{type:'image/png'})}],['voice',{kind:'voice',blob:new Blob(['voice'])}],['music',{kind:'music',blob:new Blob(['music'])}]]),events=[],states=[],progress=[];
 let decodeGate,recordGate,inspectGate,recordError,inspectError,received,reads=0,disposed=0,decodeError,commitError,ownedContext,blobType='video/mp4';
 const media=mediaFactory({original:async id=>{reads++;return originals.get(id);},image:async()=>{await decodeGate?.promise;if(decodeError)throw decodeError;return{image:{width,height},width,height,dispose(){disposed++;}};},audio:async()=>({numberOfChannels:1,length:16000,duration:1,sampleRate:16000})});
 const runtime=runtimeFactory({adapters:A,plan:P,media,render:()=>events.push('frame'),record:async options=>{events.push('record');received=options;if(ownedContext)options.recordingPolicy.onContext(ownedContext);const aborted=new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true}));options.onFormat('video/mp4;codecs=avc1.42001f,mp4a.40.2');options.onProgress(.5,500);if(recordGate)await Promise.race([recordGate.promise,aborted]);if(recordError)throw recordError;options.onProgress(.99,1000);return{blob:new Blob([read('classic.mp4')],{type:blobType}),mimeType:'video/mp4',extension:'mp4',width:1,height:2,durationMs:99};}});
 const api=factory({adapters:A,plan:P,profile:{layout:(_ctx,text)=>{if(text.length>500)throw Object.assign(Error('text too large'),{code:'TEXT_OVERFLOW'});}},runtime,media,supported:()=>true,recorder:{capabilities:()=>({capture:true,mediaRecorder:true,audio:true})},fonts:async()=>{},yield:async()=>{},inspector:{...I,inspect:async(...args)=>{await inspectGate?.promise;if(inspectError)throw inspectError;return I.inspect(...args);},playback:async()=>({width:720,height:1280,durationMs:1000})}});
 const controller=api.create({onState:s=>states.push(s),onProgress:p=>progress.push(p)}),canvas={width:720,height:1280,style:{},getContext:()=>({getImageData(){if(commitError)throw commitError;return new Uint8Array(4);}})};
 return{api,controller,canvas,media,originals,states,progress,events,recordOptions:()=>received,reads:()=>reads,disposed:()=>disposed,setDecodeGate:g=>decodeGate=g,setRecordGate:g=>recordGate=g,setInspectGate:g=>inspectGate=g,setRecordError:e=>recordError=e,setInspectError:e=>inspectError=e,setDecodeError:e=>decodeError=e,setContext:c=>ownedContext=c,setBlobType:t=>blobType=t,setCommitError:e=>commitError=e};
}
test('independent classic/fragmented MP4 fixtures prove H.264/AAC and actual sample coverage, silent MP4 needs no AAC',()=>{
 for(const name of ['classic.mp4','fragmented.mp4']){const r=I.inspectBytes(read(name));assert.equal(r.container,'mp4');assert.equal(r.video.codec,'h264');assert.equal(r.audio.codec,'aac');assert.equal(r.video.count,24);assert.ok(r.audio.count>=47);I.assertExpected(r,{durationMs:1000,hasAudio:true});}
 const silent=I.inspectBytes(read('silent.mp4'));assert.equal(silent.audio,null);I.assertExpected(silent,{durationMs:1000,hasAudio:false});assert.throws(()=>I.assertExpected(silent,{durationMs:1000,hasAudio:true}),{code:'OUTPUT_AUDIO'});
});
test('generic MP4 VP9/Opus, mutated AAC descriptors and truncated media never become compatible MP4',()=>{
 assert.throws(()=>I.inspectBytes(read('wrong-codecs.mp4')),{code:'CODEC'});assert.throws(()=>I.inspectBytes(read('h264-opus.mp4')),{code:'CODEC'});
 const bytes=read('classic.mp4'),esds=bytes.indexOf('esds'),copy=Buffer.from(bytes);const descriptor=copy.indexOf(Buffer.from([5,128,128,128]),esds),asc=descriptor+5;assert.ok(descriptor>0&&asc<esds+64);assert.equal(copy[asc]>>>3,2);copy[asc]=(5<<3)|(copy[asc]&7);assert.throws(()=>I.inspectBytes(copy),{code:'CODEC'});
 for(const name of ['classic.mp4','fragmented.mp4','vp9-opus.webm']){const b=read(name);assert.throws(()=>I.inspectBytes(b.subarray(0,b.length-37)));}
 const valid=I.inspectBytes(bytes);assert.throws(()=>I.assertExpected(valid,{durationMs:3000,hasAudio:true}),{code:'INCOMPLETE'});assert.throws(()=>I.assertExpected({...valid,video:{...valid.video,width:360}},{durationMs:1000,hasAudio:true}),{code:'OUTPUT_DIMENSIONS'});
});
test('real WebM fixture detects VP9/Opus, packet extents and does not depend on MIME or extension',()=>{
 const r=I.inspectBytes(read('vp9-opus.webm'));assert.equal(r.container,'webm');assert.equal(r.video.codec,'vp9');assert.equal(r.audio.codec,'opus');assert.ok(r.video.count>=23);I.assertExpected(r,{durationMs:1000,hasAudio:true});
 assert.throws(()=>I.inspectBytes(Buffer.from('video/mp4')),{code:'CONTAINER'});assert.throws(()=>I.inspectBytes(Buffer.from([0x1a,0x45,0xdf,0xa3,0xff])));
});
test('format policy excludes generic MP4, respects explicit WebM and AAC availability',()=>{
 const api=factory({supported:type=>type==='video/mp4'||type.includes('webm')||type.startsWith('video/mp4;codecs=avc1')&&!type.includes('mp4a')});
 assert.ok(api.formats(true).every(t=>t.startsWith('video/webm')));assert.ok(api.formats(false).some(t=>t.startsWith('video/mp4')));assert.ok(api.formats(false,'webm').every(t=>t.startsWith('video/webm')));assert.throws(()=>api.formats(true,'mp4'),{code:'FORMAT'});
});
test('prepare freezes edited scenes and IDs/order, does not start audio/recording; start returns only measured validated result',async()=>{
 const f=setup(),p=project(),before=JSON.stringify(p),prepared=await f.controller.prepare({project:p,canvas:f.canvas,contentRevision:7,savedRevision:2});
 assert.equal(f.controller.status().state,'ready');assert.deepEqual(f.events,['frame']);assert.equal(JSON.stringify(p),before);p.scenes.reverse();p.scenes[0].text='later edit';assert.equal(prepared.plan.timeline[0].id,'scene-0');assert.equal(prepared.identity.savedRevision,2);assert.equal(prepared.identity.contentRevision,7);
 const result=await f.controller.start();assert.equal(result.width,720);assert.equal(result.durationMs,1000);assert.equal(result.videoCodec,'h264');assert.equal(result.audioCodec,'aac');assert.equal(result.plannedDurationMs,1000);assert.equal(f.recordOptions().plan,prepared.plan);assert.equal(f.recordOptions().voiceVolume,.7);assert.equal(f.recordOptions().musicVolume,.25);assert.ok(f.recordOptions().voiceBuffer&&f.recordOptions().musicBuffer);assert.deepEqual(f.states.map(s=>s.state),['preparing','ready','recording','finalizing','validating','complete']);assert.equal(f.progress.at(-1).fraction,1);assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().sessions,0);assert.throws(()=>JSON.stringify(f.controller),{code:'RUNTIME'});
 await f.controller.dispose();await f.controller.dispose();assert.equal(f.controller.status().state,'disposed');
});
test('all cues preflight before source decode; missing/corrupt media report scene, and resource excess refuses before reads',async()=>{
 for(const kind of ['overflow','missing','decode','count','empty','future']){
  const f=setup(),p=project();if(kind==='overflow')p.scenes[2].text='x'.repeat(1000);if(kind==='missing')p.scenes[1].imageId='absent';if(kind==='decode')f.setDecodeError(Error('bad image'));if(kind==='count')p.scenes=Array.from({length:17},(_,i)=>({...p.scenes[0],id:'s'+i,imageId:'image'+i}));if(kind==='empty')p.scenes=[];if(kind==='future')p.version=999;
  const before=JSON.stringify(p);await assert.rejects(f.controller.prepare({project:p,canvas:f.canvas}),e=>{if(kind==='overflow')assert.equal(e.sceneNumber,3);if(kind==='missing')assert.equal(e.sceneNumber,2);return true;});assert.equal(JSON.stringify(p),before);if(['overflow','count','empty','future'].includes(kind))assert.equal(f.reads(),0);await f.controller.dispose();assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().sessions,0);
 }
});
test('cancel native decode and replace snapshot; late completion cannot mark new job ready or reuse released images',async()=>{
 const f=setup(),g=gate(),p=project();f.setDecodeGate(g);const old=f.controller.prepare({project:p,canvas:f.canvas});const outcome=old.catch(e=>e);await until(()=>f.reads()>0);const next=structuredClone(p);next.id='different-project';next.scenes.reverse();const current=f.controller.prepare({project:next,canvas:f.canvas,contentRevision:9});g.resolve();await outcome;const ready=await current;assert.equal(ready.plan.source.projectId,'different-project');assert.equal(ready.plan.timeline[0].id,'scene-2');assert.equal(f.states.filter(s=>s.state==='ready').length,1);await f.controller.cancel();await f.controller.cancel();assert.equal(f.media.statistics().sessions,0);assert.equal(f.media.statistics().residentBytes,0);
});
test('cancel recording and validation; repeat prepare/start succeeds and stale progress cannot attach',async()=>{
 for(const phase of ['record','inspect']){
  const f=setup(),g=gate(),p=project();await f.controller.prepare({project:p,canvas:f.canvas});if(phase==='record')f.setRecordGate(g);else f.setInspectGate(g);
  const running=f.controller.start();const observed=running.catch(e=>e);await until(()=>f.controller.status().state===(phase==='record'?'recording':'validating'));const old=f.recordOptions();const cleanup=f.controller.cancel();g.resolve();await observed;await cleanup;const progress=f.progress.length;old.onProgress(.8,800);assert.equal(f.progress.length,progress);assert.equal(f.controller.status().hasResult,false);assert.equal(f.media.statistics().sessions,0);
  f.setRecordGate(null);f.setInspectGate(null);await f.controller.prepare({project:p,canvas:f.canvas});assert.equal((await f.controller.start()).container,'mp4');await f.controller.dispose();
 }
});
test('a partial/codec failure cannot emit success/100 percent or mutate original files or either DTO',async()=>{
 for(const phase of ['record','inspect']){
  const f=setup(),p=project(),before=JSON.stringify(p),files=[...f.originals.values()].map(x=>x.blob);await f.controller.prepare({project:p,canvas:f.canvas});if(phase==='record')f.setRecordError(Object.assign(Error('codec failed'),{code:'ENCODER'}));else f.setInspectError(Object.assign(Error('partial file'),{code:'INCOMPLETE'}));await assert.rejects(f.controller.start());assert.equal(f.controller.status().state,'error');assert.equal(f.controller.status().hasResult,false);assert.ok(f.progress.every(p=>p.fraction<1));assert.equal(JSON.stringify(p),before);assert.deepEqual([...f.originals.values()].map(x=>x.blob),files);assert.equal(f.media.statistics().sessions,0);await f.controller.dispose();
 }
});
test('legacy DTO remains DTO1, unknown runtime fields and invalid output budgets are refused',async()=>{
 const f=setup(),p=C.createProject(true),old=JSON.stringify(p);await f.controller.prepare({project:p,canvas:f.canvas});assert.equal(p.version,1);assert.equal(JSON.stringify(p),old);await f.controller.dispose();assert.throws(()=>f.api.create({maxOutputBytes:0}),{code:'LIMITS'});assert.throws(()=>f.api.create({maxOutputBytes:65*1048576}),{code:'LIMITS'});
 const g=setup();await assert.rejects(g.controller.start(),{code:'STATE'});await assert.rejects(g.controller.prepare({project:project(),canvas:{width:360,height:640}}),{code:'CANVAS'});await g.controller.dispose();
});

test('sub-frame scenes/cues are diagnosed for export without stretching or changing the saved DTO',async()=>{
 const f=setup(),p=project();p.scenes[1].durationMs=1;const before=JSON.stringify(p);await assert.rejects(f.controller.prepare({project:p,canvas:f.canvas}),e=>e.code==='EXPORT_TIMING'&&e.sceneNumber===2);assert.equal(JSON.stringify(p),before);assert.equal(f.reads(),0);await f.controller.dispose();
});

test('failed native recording context close pins its media until an explicit successful cleanup retry',async()=>{
 const f=setup();let rejects=true,attempts=0;const context={state:'running',async close(){attempts++;if(rejects)throw Error('native close rejected');this.state='closed';}};f.setContext(context);await f.controller.prepare({project:project(),canvas:f.canvas});await assert.rejects(f.controller.start(),{code:'AUDIO_CLOSE'});assert.equal(f.controller.status().hasResult,false);assert.equal(f.controller.status().cleanupPending,true);assert.equal(f.media.statistics().sessions,1);assert.ok(f.media.statistics().residentBytes>0);
 await assert.rejects(f.controller.cancel(),{code:'AUDIO_CLOSE'});assert.equal(f.media.statistics().sessions,1);rejects=false;await f.controller.cancel();assert.equal(context.state,'closed');assert.equal(f.media.statistics().sessions,0);assert.equal(f.media.statistics().residentBytes,0);assert.ok(attempts>=3);await f.controller.dispose();
});
test('external abort during validation cancels the whole job, not just the native capture loop',async()=>{
 const f=setup(),g=gate(),abort=new AbortController();await f.controller.prepare({project:project(),canvas:f.canvas});f.setInspectGate(g);const recording=f.controller.start({signal:abort.signal}),outcome=recording.catch(e=>e);await until(()=>f.controller.status().state==='validating');abort.abort();g.resolve();await outcome;await f.controller.cancel();assert.equal(f.controller.status().hasResult,false);assert.equal(f.media.statistics().sessions,0);await f.controller.dispose();
});

test('both the recorder MIME and Blob MIME must agree with actual container bytes',async()=>{
 const f=setup();f.setBlobType('video/webm');await f.controller.prepare({project:project(),canvas:f.canvas});await assert.rejects(f.controller.start(),{code:'CONTAINER'});assert.equal(f.controller.status().hasResult,false);assert.equal(f.media.statistics().sessions,0);assert.ok(f.progress.every(p=>p.fraction<1));await f.controller.dispose();
});

test('ready requires completed initial Canvas rasterization and failed commit releases prepared media',async()=>{
 const f=setup(),p=project(),before=JSON.stringify(p);f.setCommitError(Error('GPU readback failed'));await assert.rejects(f.controller.prepare({project:p,canvas:f.canvas}),{code:'CANVAS'});assert.equal(f.controller.status().state,'error');assert.ok(!f.states.some(s=>s.state==='ready'));assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().sessions,0);assert.equal(JSON.stringify(p),before);await f.controller.dispose();
});
