'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const factory=require('../js/native-mp4.js'),mediaFactory=require('../js/media-session.js'),I=require('../js/export-inspector.js'),C=require('../js/core.js'),A=require('../js/render-adapters.js');
const ref=require('./fixtures/editor-export/native-mux-reference.json'),original=fs.readFileSync('tests/fixtures/editor-export/'+ref.source);
function track(kind){const list=ref[kind].samples;return{description:Buffer.from(ref[kind].description,'hex'),samples:list.map((s,i)=>({data:original.subarray(s.offset,s.offset+s.size),key:s.key,duration:kind==='video'?(i===list.length-1?1000000-s.timestamp:list[i+1].timestamp-s.timestamp):Math.round(s.duration*.048)}))};}
function fake({dropVideo=false,gate=null,offlineGate=null}={}){
 const media=mediaFactory({}),events=[],frames=[],active=[],mixes=[],rendered=[];
 class Frame{constructor(_source,options){Object.assign(this,options);frames.push(this);}close(){assert.ok(!this.closed);this.closed=true;}}
 class Data{constructor(options){Object.assign(this,options);}close(){this.closed=true;}}
 function encoder(kind){return class extends EventTarget{
  static async isConfigSupported(config){return{supported:true,config};}
  constructor(options){super();this.options=options;this.state='unconfigured';this.encodeQueueSize=0;this.index=0;active.push(this);}
  configure(config){this.state='configured';this.config=config;}
  send(i,input){if(this.state==='closed'||dropVideo&&kind==='video'&&i===3)return;const spec=ref[kind].samples[i%ref[kind].samples.length],data=original.subarray(spec.offset,spec.offset+spec.size),metadata=i===0?{decoderConfig:{description:Buffer.from(ref[kind].description,'hex')}}:{};
   this.options.output({timestamp:input.timestamp,duration:kind==='video'?input.duration:spec.duration,type:spec.key?'key':'delta',byteLength:data.length,copyTo:out=>out.set(data)},metadata);}
  encode(frame){assert.equal(this.state,'configured');const i=this.index++;this.encodeQueueSize++;const input={timestamp:frame.timestamp,duration:frame.duration};Promise.resolve(gate).then(()=>{this.send(i,input);this.encodeQueueSize--;this.dispatchEvent(new Event('dequeue'));});}
  async flush(){while(this.encodeQueueSize)await new Promise(r=>this.addEventListener('dequeue',r,{once:true}));if(kind==='audio'&&this.index===47)this.send(47,{timestamp:1000000});}
  close(){this.state='closed';}
 };}
 class Offline{constructor(channels,length,sampleRate){this.numberOfChannels=channels;this.length=length;this.sampleRate=sampleRate;this.destination={};events.push('offline');}async startRendering(){await Promise.resolve(offlineGate);return{getChannelData:()=>new Float32Array(this.length)};}}
 const api=factory({VideoEncoder:encoder('video'),AudioEncoder:encoder('audio'),VideoFrame:Frame,AudioData:Data,OfflineAudioContext:Offline,workspace:owner=>media.workspace(owner),render:(_canvas,_plan,time)=>rendered.push(time),mix:(_ctx,options)=>{mixes.push(options);return{start:time=>events.push(['mix',time]),stop:()=>events.push('stop mix')};},yield:()=>Promise.resolve()});
 const p=C.upgradeProject(C.createProject());p.timing='manual';p.scenes=[{id:'native-scene',text:'',visual:'animated',imageId:null,imageName:'',camera:'static',transition:'none',durationMs:1000}];const plan=A.fromEditor(p);
 return{api,media,events,frames,active,mixes,rendered,plan,async options(){return{canvas:{},plan,resources:{images:new Map()},voiceBuffer:{duration:1},musicBuffer:{duration:1},voiceVolume:.65,musicVolume:.45,fadeIn:.3,fadeOut:.4,recordingPolicy:{maxBytes:1000000,nativeSupport:await api.support(true)}};}};
}
test('MP4 tables remux independently described AVC/AAC packets without changing a single encoded byte',async()=>{
 assert.equal(crypto.createHash('sha256').update(original).digest('hex'),ref.sha256);const api=factory({}),v=track('video'),a=track('audio'),blob=api.mux({video:v,audio:a,durationMs:1000}),bytes=new Uint8Array(await blob.arrayBuffer()),actual=I.inspectBytes(bytes);I.assertExpected(actual,{durationMs:1000,hasAudio:true});assert.equal(actual.video.count,24);assert.equal(actual.audio.count,48);assert.equal(actual.video.bytes,v.samples.reduce((n,s)=>n+s.data.length,0));assert.equal(actual.audio.bytes,a.samples.reduce((n,s)=>n+s.data.length,0));let offset=40; // ftyp is 32 bytes, then mdat's 8-byte header.
 for(const s of [...v.samples,...a.samples]){assert.deepEqual(bytes.subarray(offset,offset+s.data.length),new Uint8Array(s.data));offset+=s.data.length;}
 const silent=I.inspectBytes(new Uint8Array(await api.mux({video:v,durationMs:1000}).arrayBuffer()));assert.equal(silent.audio,null);
 assert.throws(()=>api.mux({video:{...v,description:new Uint8Array()},durationMs:1000}),{code:'MUX'});
});
test('native encoders use exact plan timestamps, the existing mixer and bounded queues, then close every frame and workspace',async()=>{
 const f=fake(),options=await f.options(),before=JSON.stringify(f.plan),result=await f.api.encode(options),info=await I.inspect(result.blob,{durationMs:1000,hasAudio:true});assert.equal(info.video.count,24);assert.equal(info.video.end,1000);assert.equal(info.audio.codec,'aac');assert.equal(JSON.stringify(f.plan),before);assert.equal(f.frames.length,24);assert.ok(f.frames.every(frame=>frame.closed));assert.ok(f.active.every(encoder=>encoder.state==='closed'));assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.events[0],'offline');assert.deepEqual(f.events[1],['mix',0]);assert.equal(f.mixes.length,1);assert.equal(f.mixes[0].voiceVolume,.65);assert.equal(f.mixes[0].musicVolume,.45);assert.equal(f.mixes[0].durationSeconds,1);assert.deepEqual(f.rendered,[...Array(24)].map((_,i)=>Math.round(i*1e6/24)/1000));
});
test('missing encoder frames fail closed and do not retain encoded bytes, PCM or encoder resources',async()=>{
 const f=fake({dropVideo:true});await assert.rejects(f.api.encode(await f.options()),{code:'INCOMPLETE'});assert.ok(f.active.every(encoder=>encoder.state==='closed'));assert.equal(f.media.statistics().residentBytes,0);
});
test('cancel while native encoding is queued cannot return a partial MP4; shared memory budget stays balanced',async()=>{
 let release;const gate=new Promise(r=>release=r),f=fake({gate}),options=await f.options(),signal=new AbortController();const pending=f.api.encode({...options,signal:signal.signal}),outcome=pending.catch(e=>e);await new Promise(r=>setImmediate(r));signal.abort();release();await outcome;assert.equal(f.media.statistics().residentBytes,0);assert.ok(f.active.every(encoder=>encoder.state==='closed'));
 const held=f.media.workspace('other owner');held.reserve(250*1048576);await assert.rejects(f.api.encode(await f.options()),{code:'ENCODING_BUDGET'});assert.equal(f.media.statistics().residentBytes,250*1048576);held.close();held.close();assert.equal(f.media.statistics().residentBytes,0);assert.throws(()=>held.reserve(1),{code:'STATE'});assert.throws(()=>JSON.stringify(held),{code:'RUNTIME'});
});
test('the absence of a native AAC encoder is an actual capability refusal, not an MP4 label',async()=>{
 assert.equal(await factory({}).support(false),null);assert.equal(await factory({VideoEncoder:{isConfigSupported:async()=>({supported:true})},VideoFrame:function(){}}).support(true),null);
});

test('exact scene and subtitle boundaries add frames without changing 24 fps timing or scene identities',async()=>{
 const f=fake(),p=C.upgradeProject(C.createProject());p.timing='manual';p.scenes=[{id:'first',text:'one',durationMs:333,visual:'animated',camera:'static',transition:'none'},{id:'second',text:'two',durationMs:667,visual:'animated',camera:'static',transition:'crossfade'}];p.selectedSceneId='first';const plan=A.fromEditor(p),before=JSON.stringify(p),options=await f.options();options.plan=plan;await f.api.encode(options);
 assert.ok(f.rendered.includes(333));assert.equal(f.frames.length,25);assert.equal(f.frames[8].timestamp,333000);assert.equal(f.frames[8].duration,333);assert.equal(f.frames.reduce((n,frame)=>n+frame.duration,0),1000000);assert.equal(JSON.stringify(p),before);assert.equal(f.media.statistics().residentBytes,0);
});
test('uncancellable offline mixing retains its reservation until settled and cancellation cannot publish output',async()=>{
 let release;const gate=new Promise(r=>release=r),f=fake({offlineGate:gate}),options=await f.options(),abort=new AbortController();let settled=false;
 const pending=f.api.encode({...options,signal:abort.signal}).finally(()=>{settled=true;});const outcome=pending.catch(e=>e);await new Promise(r=>setImmediate(r));abort.abort();await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.ok(f.media.statistics().residentBytes>0);release();assert.equal((await outcome).name,'AbortError');assert.equal(f.media.statistics().residentBytes,0);assert.ok(f.events.includes('stop mix'));assert.equal(f.frames.length,0);
});
