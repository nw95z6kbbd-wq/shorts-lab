'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js'),V=require('../js/video-core.js');
// A deterministic model of the browser's independent media clock. This tests
// clocks/cancellation in the real recorder source; FFmpeg tests inspect real bytes.
async function simulate({audioDelay=0,audioRate=1,stalled=false,invalid=false,rewind=false,interruptAt,source='js/video-recorder.js',abortAt,earlyStop,withAudio=false,rejectFirst=false}={}){
 let clock=0,seq=0,encoderStart,encoderStop,mediaOrigin,settled=false,result,error,created=0,contextInstance;
 const audioTime=()=>invalid&&clock>=800?NaN:rewind&&clock>=800?0:Math.max(0,clock-audioDelay)/1000*audioRate;
 const tasks=new Map(),rendered=[],recorders=[],mixStarts=[];
 const schedule=(fn,ms)=>{const id=++seq;tasks.set(id,{fn,at:clock+ms});return id;};
 const track={kind:'video',stop(){this.stopped=true;}},tracks=[track],stream={getVideoTracks:()=>[track],getTracks:()=>tracks,addTrack:t=>tracks.push(t)};
 class Recorder{
  static isTypeSupported(type){return type.startsWith('video/mp4');}
  constructor(_stream,options){this.mimeType=options.mimeType;this.state='inactive';this.listeners=new Map();this.order=++created;recorders.push(this);}
  addEventListener(event,fn){let a=this.listeners.get(event);if(!a)this.listeners.set(event,a=[]);a.push(fn);}
  removeEventListener(event,fn){this.listeners.set(event,(this.listeners.get(event)||[]).filter(f=>f!==fn));}
  emit(event,e={}){for(const fn of [...this.listeners.get(event)||[]])fn(e);this['on'+event]?.(e);}
  start(){
   if(rejectFirst&&this.order===1)throw Error('first native encoder rejected start');this.state='recording';
   schedule(()=>{if(this.state==='inactive')return;encoderStart=clock;mediaOrigin=withAudio?audioTime():clock/1000;this.emit('start');},0);
   if(earlyStop!=null)schedule(()=>{this.state='inactive';this.emit('stop');},earlyStop);
  }
  stop(){encoderStop=clock;this.state='inactive';this.emit('dataavailable',{data:new Blob([JSON.stringify({start:encoderStart,stop:encoderStop,duration:((withAudio?audioTime():clock/1000)-mediaOrigin)*1000})],{type:this.mimeType})});this.emit('stop');}
 }
 class Audio{
  constructor(){this.state='suspended';contextInstance=this;}get currentTime(){return stalled?0:audioTime();}
  async resume(){this.state='running';}async close(){this.state='closed';}
  createMediaStreamDestination(){return{stream:{getAudioTracks:()=>[{kind:'audio',stop(){this.stopped=true;}}]}};}
 }
 const listeners=new Map(),document={hidden:false,addEventListener:(e,fn)=>listeners.set(e,fn),removeEventListener:e=>listeners.delete(e)};
 const context=vm.createContext({MediaRecorder:Recorder,HTMLCanvasElement:{prototype:{captureStream(){}}},AudioContext:Audio,ShortsVideoAudio:{connectMix:()=>({start:t=>mixStarts.push(t),stop(){}})},ShortsVideoCore:V,ShortsRenderPlan:P,ShortsVideoRenderer:{render:(_c,_p,ms)=>rendered.push({wall:clock,ms})},performance:{now:()=>clock},document,Blob,Uint8Array,DOMException,Error,setTimeout:(fn,ms)=>schedule(fn,ms),clearTimeout:id=>tasks.delete(id),requestAnimationFrame:fn=>schedule(()=>fn(clock),1000/30),cancelAnimationFrame:id=>tasks.delete(id)});context.window=context;
 vm.runInContext(fs.readFileSync(source,'utf8'),context);
 const p=C.upgradeProject(C.createProject(true));p.timing='manual';p.scenes=p.scenes.slice(0,3);p.scenes.forEach(s=>{s.durationMs=1000;s.transition='none';});
 const plan=A.fromEditor(p),controller=new AbortController();if(interruptAt!=null)schedule(()=>contextInstance.state='interrupted',interruptAt);if(abortAt!=null)schedule(()=>controller.abort(new DOMException('test abort','AbortError')),abortAt);
 const pending=context.ShortsVideoRecorder.record({canvas:{captureStream:()=>stream},plan,format:'mp4',signal:controller.signal,...(withAudio?{voiceBuffer:{}}:{})});pending.then(r=>{result=r;settled=true;},e=>{error=e;settled=true;});
 for(let i=0;!settled&&i<3000;i++){
  for(let m=0;m<12;m++)await Promise.resolve();if(settled)break;
  const next=[...tasks].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)throw Error('scheduler exhausted');tasks.delete(next[0]);clock=next[1].at;next[1].fn();
 }
 assert.ok(settled,'recorder settles within bounded virtual time');await pending.catch(()=>{});
 return{error,result,encoded:result&&JSON.parse(await result.blob.text()),rendered,recorders,mixStarts,track,listeners,contextInstance};
}
test('frozen recorder reproduces Safari clock mismatch: 3s rendered, only about 2.44s encoded',async()=>{
 const old=await simulate({withAudio:true,audioDelay:600,source:'tests/fixtures/render-plan/video-recorder-before.js'});assert.ifError(old.error);
 assert.equal(old.result.durationMs,3000);assert.equal(old.rendered.at(-1).ms,3000);assert.ok(old.encoded.duration<2700);
});
test('audio recording uses media time through startup lag and clock-rate drift, preserving the full plan and mix',async()=>{
 for(const options of [{withAudio:true},{withAudio:true,audioDelay:600},{withAudio:true,audioRate:.8},{withAudio:true,audioRate:1.25},{withAudio:true,audioDelay:600,rejectFirst:true}]){
  const r=await simulate(options);assert.ifError(r.error);assert.equal(r.result.durationMs,3000);assert.equal(r.rendered.at(-1).ms,3000);
  assert.ok(r.encoded.duration>=3000&&r.encoded.duration<3100,JSON.stringify({options,encoded:r.encoded}));
  assert.equal(r.mixStarts.length,1);assert.equal(r.mixStarts[0],.02);assert.equal(r.track.stopped,true);assert.equal(r.contextInstance.state,'closed');
 }
});
test('silent recording retains the exact historical frame/time sequence and encoded result',async()=>{
 const old=await simulate({source:'tests/fixtures/render-plan/video-recorder-before.js'}),now=await simulate();assert.ifError(now.error);assert.ifError(old.error);
 assert.deepEqual(now.rendered,old.rendered);assert.deepEqual(now.encoded,old.encoded);assert.equal(now.result.mimeType,old.result.mimeType);
});
test('stalled, interrupted, non-finite, backwards clocks and cancellation fail without a partial successful file',async()=>{
 for(const options of [{withAudio:true,stalled:true},{withAudio:true,interruptAt:500},{withAudio:true,invalid:true},{withAudio:true,rewind:true},{withAudio:true,audioDelay:600,abortAt:250},{earlyStop:300}]){
  const r=await simulate(options);assert.ok(r.error,JSON.stringify(options));assert.equal(r.result,undefined);assert.equal(r.track.stopped,true);assert.equal(r.listeners.size,0);
  if(options.withAudio)assert.equal(r.contextInstance.state,'closed');if(options.abortAt)assert.equal(r.error.name,'AbortError');
 }
});
test('the exact clock bridge rejects changes while all original eight runtime guard counterexamples remain mandatory',()=>{
 const cp=require('node:child_process');assert.match(cp.execFileSync('python',['tests/recorder_clock_guard.py','--self-test'],{encoding:'utf8'}),/3 audio clock mutations rejected/);
 assert.match(cp.execFileSync('python',['tests/render_guard.py'],{encoding:'utf8'}),/8 counterexamples/);
});
