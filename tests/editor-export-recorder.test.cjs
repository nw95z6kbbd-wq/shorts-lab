'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),V=require('../js/video-core.js'),P=require('../js/render-plan.js');
function harness({holdClock=false}={}){
 const contexts=[];class Audio {constructor(){this.state="suspended";this.currentTime=0;contexts.push(this);}async resume(){this.state="running";}async close(){this.state="closed";}createMediaStreamDestination(){return{stream:{getAudioTracks:()=>[{kind:"audio",stopped:false,stop(){this.stopped=true;}}]}};}}
 const requests=[],rates=[],events=[];const tracks=[{kind:'video',requestFrame(){requests.push(true);},stopped:false,stop(){this.stopped=true;}}],instances=[],frames=[];let captures=0,rafs=0;
 class Recorder{
  static isTypeSupported(type){return type.startsWith('video/mp4');}
  constructor(_stream,options){this.mimeType=options.mimeType;this.state='inactive';instances.push(this);}
  start(){this.state='recording';queueMicrotask(()=>{if(this.state==='recording')this.ondataavailable?.({data:new Blob([new Uint8Array(64)],{type:this.mimeType})});});}
  pause(){events.push('pause');this.state='paused';queueMicrotask(()=>this.onpause?.());}
  requestData(){events.push('requestData');queueMicrotask(()=>{events.push('flush acknowledged');this.ondataavailable?.({data:new Blob([new Uint8Array(16)],{type:this.mimeType})});});}
  stop(){events.push('stop');this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array(32)],{type:this.mimeType})});this.onstop?.();}
 }
 const stream={getVideoTracks:()=>tracks.filter(t=>t.kind==="video"),getTracks:()=>tracks,addTrack:t=>tracks.push(t)},canvas={getContext:()=>({getImageData:()=>new Uint8Array(4)}),captureStream(rate){rates.push(rate);captures++;return stream;}};
 const context=vm.createContext({AudioContext:Audio,ShortsVideoAudio:{connectMix:()=>({start(){},stop(){}})},HTMLCanvasElement:{prototype:{captureStream(){}}},MediaRecorder:Recorder,ShortsVideoCore:V,ShortsRenderPlan:P,ShortsVideoRenderer:{render:(_canvas,_plan,ms)=>frames.push(ms)},Blob,Uint8Array,DOMException,Error,Object,performance:{now:()=>0},document:{hidden:false,addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout,requestAnimationFrame:fn=>{rafs++;return setTimeout(()=>{if(!holdClock)for(const c of contexts)if(c.state==="running")c.currentTime+=.5;fn(20000);},1);},cancelAnimationFrame:clearTimeout});context.window=context;vm.runInContext(fs.readFileSync('js/video-recorder.js','utf8'),context);
 return{requests,rates,scheduled:()=>rafs,contexts,events,record:context.ShortsVideoRecorder.record,canvas,tracks,instances,frames,captures:()=>captures};
}
function editor(){const p=C.upgradeProject(C.createProject(true));p.timing='manual';p.scenes=p.scenes.slice(0,1);p.scenes[0].durationMs=1000;return A.fromEditor(p);}
const policy=maxBytes=>Object.freeze({mimeTypes:Object.freeze(['video/mp4;codecs=avc1.42001f']),maxBytes});
test('actual shared recorder rejects output over Editor cap and stops its capture tracks',async()=>{
 const f=harness();await assert.rejects(f.record({canvas:f.canvas,plan:editor(),recordingPolicy:policy(32)}),{code:'OUTPUT_BUDGET'});assert.equal(f.instances.length,1);assert.equal(f.instances[0].state,'inactive');assert.ok(f.tracks.every(t=>t.stopped));
});
test('default Video callers retain format/finalization/output behavior without an Editor policy',async()=>{
 const f=harness(),result=await f.record({canvas:f.canvas,plan:A.fromVideo(V.demo())});assert.equal(result.extension,'mp4');assert.equal(result.blob.size,96);assert.equal(result.durationMs,18000);assert.ok(f.tracks.every(t=>t.stopped));
});
test('Video cannot receive Editor-only recording limits or candidate overrides',async()=>{
 const f=harness();await assert.rejects(f.record({canvas:f.canvas,plan:A.fromVideo(V.demo()),recordingPolicy:policy(1000)}),/политика записи Editor/);assert.equal(f.captures(),0);assert.equal(f.instances.length,0);
});
test('historical guard still rejects changes to approved Editor options, codec selection and output cap',()=>{
 const source=fs.readFileSync('js/video-recorder.js','utf8'),cp=require('node:child_process'),os=require('node:os'),path=require('node:path'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'export-guard-'));
 try{for(const [old,next] of [["plan?.source?.mode !== 'editor'","plan?.source?.mode === 'editor'"],['recordingPolicy.maxBytes','recordingPolicy.maxBytes * 2'],['formats = recordingPolicy.mimeTypes.filter','formats = support.formats.filter'],['context.currentTime > initial','context.currentTime >= initial'],['requestEditorFrame(elapsed)','requestEditorFrame(0)']]){
  assert.ok(source.includes(old));const file=path.join(folder,'video-recorder.js');fs.writeFileSync(file,source.replace(old,next));assert.throws(()=>cp.execFileSync('python',['tests/recorder_clock_guard.py',file],{stdio:'pipe'}));
 }}finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('Editor AVC stops in the final committed render task; default Video keeps its deferred stop',async()=>{
 const e=harness();const result=await e.record({canvas:e.canvas,plan:editor(),recordingPolicy:policy(1000)});
 assert.deepEqual(e.events,['stop']);assert.deepEqual(e.rates,[0]);assert.equal(e.requests.length,2);assert.equal(result.blob.size,96);assert.equal(result.extension,'mp4');
 const v=harness();await v.record({canvas:v.canvas,plan:A.fromVideo(V.demo())});assert.deepEqual(v.events,['stop']);assert.deepEqual(v.rates,[24]);assert.equal(v.requests.length,0);
});

test('Editor AAC waits for a real audio quantum, remains cancellable, and anchors all media after device warm-up',async()=>{
 const until=async check=>{for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,1));}throw Error('native clock condition timed out');};
 const f=harness({holdClock:true}),abort=new AbortController();const recording=f.record({canvas:f.canvas,plan:editor(),voiceBuffer:{duration:1},recordingPolicy:policy(1000),signal:abort.signal}),outcome=recording.catch(e=>e);
 try{
  await until(()=>f.scheduled()>0);assert.equal(f.contexts[0].currentTime,0);assert.equal(f.instances.length,0,'running alone must not start the encoder');
  f.contexts[0].currentTime=.01;await until(()=>f.instances.length===1);f.contexts[0].currentTime=1.1;
  const result=await recording;assert.equal(result.extension,'mp4');assert.equal(f.contexts[0].state,'closed');assert.ok(f.tracks.every(t=>t.stopped));
 }finally{abort.abort();await outcome;}
 const cancelled=harness({holdClock:true}),stop=new AbortController(),pending=cancelled.record({canvas:cancelled.canvas,plan:editor(),voiceBuffer:{duration:1},recordingPolicy:policy(1000),signal:stop.signal});
 const rejection=assert.rejects(pending,{name:'AbortError'});await until(()=>cancelled.scheduled()>0);stop.abort();await rejection;assert.equal(cancelled.instances.length,0);assert.equal(cancelled.contexts[0].state,'closed');assert.ok(cancelled.tracks.every(t=>t.stopped));
});
