'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js');
// Unit coverage for failure transport and strict bounds, not a substitute for
// the independently decoded real Chromium/Safari recordings.
async function probe({width=720,height=1280,duration=3}={}){
 let removed=0,unmounted=0,sampled=0;
 const video={videoWidth:width,videoHeight:height,duration,readyState:4,currentTime:0,listeners:new Map(),
  addEventListener(name,fn){let list=this.listeners.get(name);if(!list)this.listeners.set(name,list=[]);list.push(fn);},
  removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(f=>f!==fn));},
  load(){for(const fn of this.listeners.get('loadedmetadata')||[])fn();}};
 const element=()=>({style:{},remove(){removed++;},getContext(){return{drawImage(){},getImageData(){return{data:[[230,30,20,255],[20,30,230,255],[20,230,30,255]][sampled++]};}};}});
 const nodes=[];
 const document={body:{append(e){nodes.push(e);}},createElement(kind){return kind==='video'?video:element();}};
 class Reader{readAsDataURL(){this.result='data:video/webm;base64,AAAA';this.onload();}}
 const context=vm.createContext({ShortsCore:C,ShortsRenderAdapters:{fromEditor:p=>A.fromEditor(JSON.parse(JSON.stringify(p)))},ShortsRenderPlan:P,ShortsVideoMedia:{},
  ShortsVideoRecorder:{capabilities:()=>({supported:true}),record:async options=>{options.onFormat('video/webm');for(const t of [0,1000,2000,3000])options.onProgress(0,t);return{blob:new Blob(['test bytes'],{type:'video/webm'}),mimeType:'video/webm',width:720,height:1280,durationMs:3000};}},
  Blob,Map,Uint8Array,FileReader:Reader,performance,setTimeout,clearTimeout,location:{protocol:'http:'},document,
  mountRuntimeRecordedVideo:()=>()=>{unmounted++;},runtimeRecordingDataURL:(_,v)=>v,waitRuntimeVideoFrame:async()=>{},seekRuntimeVideoFrame:async(v,t)=>{v.currentTime=t;}});
 context.window=context;
 vm.runInContext(fs.readFileSync('tests/editor-canvas-recording.js','utf8'),context);
 await context.prepareEditorCanvasRecording([]);nodes.find(e=>e.id==='editorRecordProbe').onclick();
 let result,error;try{result=await context.finishEditorCanvasRecording();}catch(e){error=e;}
 return{result,error,evidence:context.editorRecordingEvidence,video,removed,unmounted};
}
test('readyState=4 cannot hide wrong dimensions or an incomplete Editor duration; failure retains exact numeric evidence',async()=>{
 for(const values of [{width:721},{height:1279},{duration:2.69},{duration:4.01}]){
  const r=await probe(values);assert.match(r.error?.message,/^Incomplete Editor recording /);const evidence=JSON.parse(r.error.message.slice('Incomplete Editor recording '.length));
  assert.equal(evidence.video.width,values.width??720);assert.equal(evidence.video.height,values.height??1280);assert.equal(evidence.video.duration,values.duration??3);assert.equal(evidence.video.readyState,4);
  assert.equal(evidence.blob.size,10);assert.equal(evidence.blob.mimeType,'video/webm');assert.equal(evidence.render.lastMs,3000);assert.equal(evidence.render.count,4);
  assert.ok(!r.error.message.includes('base64'));assert.equal(r.unmounted,1);assert.equal(r.removed,2);
  assert.ok([...r.video.listeners.values()].every(list=>list.length===0),'metadata listeners released even on failure');
 }
});
test('successful evidence preserves plan duration and all three scene observations independently of declared result metadata',async()=>{
 const r=await probe({duration:3.02});assert.ifError(r.error);assert.equal(r.result.duration,3.02);assert.equal(r.result.width,720);assert.equal(r.result.height,1280);
 assert.equal(r.evidence.plan.durationMs,3000);assert.equal(Object.keys(r.evidence.render.scenes).length,3);assert.equal(r.evidence.canvas.width,720);assert.equal(r.evidence.canvas.height,1280);
 assert.equal(r.unmounted,1);assert.equal(r.removed,2);
});
