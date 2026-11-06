'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
global.SafariAACProbe=require('./safari-aac-probe.js');
const P=require('./aac-completion-probe.js');
const input=zlib.gunzipSync(fs.readFileSync('tests/fixtures/aac-completion/input.f32le.gz'));
function initialize(){P.initialize(input.buffer.slice(input.byteOffset,input.byteOffset+input.byteLength));}
async function fakeRun(id,source='original',rejectFlush=false){
 const old={AudioEncoder:global.AudioEncoder,AudioData:global.AudioData},instances=[],frames=[];
 class Data{constructor(o){Object.assign(this,o);frames.push(this);}close(){assert.ok(!this.closed);this.closed=true;}}
 class Encoder extends EventTarget{
  static async isConfigSupported(){return{supported:true};}
  constructor(o){super();this.o=o;this.state='unconfigured';this.encodeQueueSize=0;instances.push(this);}
  configure(c){assert.deepEqual(c,P.CONFIG);this.state='configured';}
  encode(f){assert.equal(this.state,'configured');if(f.numberOfFrames===1024)this.o.output({timestamp:f.timestamp,duration:21333,type:'key',byteLength:2,copyTo:b=>b.set([1,2])},{});}
  flush(){if(rejectFlush)return Promise.reject(new Error('Synthetic error'));return Promise.resolve();}
  close(){this.state='closed';}
 }
 global.AudioEncoder=Encoder;global.AudioData=Data;
 try{return{result:await P.run(source,id),instances,frames};}finally{global.AudioEncoder=old.AudioEncoder;global.AudioData=old.AudioData;}
}
test('experiment has nine bounded, explicit completion strategies and no fixed priming',()=>{
 assert.equal(P.VARIANTS.length,9);assert.equal(new Set(P.VARIANTS.map(v=>v.id)).size,9);
 const s=fs.readFileSync('tests/aac-completion-probe.js','utf8');assert.doesNotMatch(s,/1600|localStorage|indexedDB|ShortsNativeMP4/);
});
test('all strategies preserve original PCM and only append zeros',async()=>{
 initialize();const original=new DataView(input.buffer,input.byteOffset,input.byteLength);
 for(const variant of P.VARIANTS){
  const {result:r,frames}=await fakeRun(variant.id);assert.equal(r.error,null);assert.equal(r.inputs.reduce((n,x)=>n+x.sourceFrames,0),144000);
  const total=(variant.full?144384:144000)+variant.zeros*1024;assert.equal(r.inputs.reduce((n,x)=>n+x.frames,0),total);
  for(const f of frames){const offset=Math.round(f.timestamp*48000/1e6);assert.ok(f.closed);for(let c=0;c<2;c++)for(let i=0;i<f.numberOfFrames;i++)assert.equal(f.data[c*f.numberOfFrames+i],offset+i<144000?original.getFloat32(((offset+i)*2+c)*4,true):0);}
  assert.equal(r.resources.created,r.resources.closed);assert.ok(r.resources.encoderClosed);
 }
});
test('partial baseline retains its 640-sample final input; full variant has exactly 384 appended zeros',async()=>{
 initialize();const partial=(await fakeRun('partial')).result,full=(await fakeRun('full')).result;
 assert.equal(partial.inputs.at(-1).frames,640);assert.equal(full.inputs.at(-1).frames,1024);assert.equal(full.inputs.at(-1).sourceFrames,640);assert.equal(full.inputs.at(-1).zeroFrames,384);
});
test('flush and task order is recorded; close always follows awaited flush',async()=>{
 initialize();for(const id of ['partial','partial-task','partial-double-flush','partial-flush-then-drain']){
  const r=(await fakeRun(id)).result,names=r.events.map(e=>e.name);const lastFlush=names.lastIndexOf('flush-resolved');assert.ok(lastFlush>=0&&names.indexOf('close-called')>lastFlush);
  if(id.includes('double')||id.includes('then-drain'))assert.equal(names.filter(n=>n==='flush-resolved').length,2);
  if(id==='partial-task')assert.ok(names.indexOf('task-complete')>lastFlush);
  if(id.includes('then-drain'))assert.equal(r.inputs.find(x=>x.phase==='feed-drain').frames,384);
 }
});
test('a failed flush preserves diagnostic inputs and releases frames/encoder',async()=>{
 initialize();const {result:r}=await fakeRun('partial','original',true);assert.ok(r.error);assert.equal(r.inputs.length,141);assert.equal(r.resources.created,r.resources.closed);assert.ok(r.resources.encoderClosed);
});
test('control is nonperiodic stereo, deterministic, and includes the last 640 samples',()=>{
 const a=P.sourceControl(),b=P.sourceControl();assert.deepEqual(a,b);assert.equal(a.pcm.length,288000);assert.ok(a.markers[2].start+a.markers[2].frames===144000);assert.notEqual(a.pcm[1000],a.pcm[1001]);
});
test('unknown sources/variants and invalid source sizes cannot run',async()=>{
 assert.throws(()=>P.initialize(new ArrayBuffer(8)));initialize();await assert.rejects(P.run('user-project','partial'));await assert.rejects(P.run('original','unknown'));
});
