'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),V=require('../js/video-core.js'),P=require('../js/render-plan.js');
function harness(){
 const events=[];const tracks=[{kind:'video',stopped:false,stop(){this.stopped=true;}}],instances=[],frames=[];let captures=0;
 class Recorder{
  static isTypeSupported(type){return type.startsWith('video/mp4');}
  constructor(_stream,options){this.mimeType=options.mimeType;this.state='inactive';instances.push(this);}
  start(){this.state='recording';queueMicrotask(()=>{if(this.state==='recording')this.ondataavailable?.({data:new Blob([new Uint8Array(64)],{type:this.mimeType})});});}
  pause(){events.push('pause');this.state='paused';queueMicrotask(()=>this.onpause?.());}
  requestData(){events.push('requestData');queueMicrotask(()=>{events.push('flush acknowledged');this.ondataavailable?.({data:new Blob([new Uint8Array(16)],{type:this.mimeType})});});}
  stop(){events.push('stop');this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array(32)],{type:this.mimeType})});this.onstop?.();}
 }
 const stream={getVideoTracks:()=>tracks,getTracks:()=>tracks},canvas={captureStream(){captures++;return stream;}};
 const context=vm.createContext({HTMLCanvasElement:{prototype:{captureStream(){}}},MediaRecorder:Recorder,ShortsVideoCore:V,ShortsRenderPlan:P,ShortsVideoRenderer:{render:(_canvas,_plan,ms)=>frames.push(ms)},Blob,Uint8Array,DOMException,Error,Object,performance:{now:()=>0},document:{hidden:false,addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout,requestAnimationFrame:fn=>setTimeout(()=>fn(20000),1),cancelAnimationFrame:clearTimeout});context.window=context;vm.runInContext(fs.readFileSync('js/video-recorder.js','utf8'),context);
 return{events,record:context.ShortsVideoRecorder.record,canvas,tracks,instances,frames,captures:()=>captures};
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
 try{for(const [old,next] of [["plan?.source?.mode !== 'editor'","plan?.source?.mode === 'editor'"],['recordingPolicy.maxBytes','recordingPolicy.maxBytes * 2'],['formats = recordingPolicy.mimeTypes.filter','formats = support.formats.filter']]){
  assert.ok(source.includes(old));const file=path.join(folder,'video-recorder.js');fs.writeFileSync(file,source.replace(old,next));assert.throws(()=>cp.execFileSync('python',['tests/recorder_clock_guard.py',file],{stdio:'pipe'}));
 }}finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('Editor AVC finalization waits for acknowledged drain before stop; default Video keeps single-stop behavior',async()=>{
 const e=harness();const result=await e.record({canvas:e.canvas,plan:editor(),recordingPolicy:policy(1000)});
 assert.deepEqual(e.events,['pause','requestData','flush acknowledged','stop']);assert.equal(result.blob.size,112);assert.equal(result.extension,'mp4');
 const v=harness();await v.record({canvas:v.canvas,plan:A.fromVideo(V.demo())});assert.deepEqual(v.events,['stop']);
});
