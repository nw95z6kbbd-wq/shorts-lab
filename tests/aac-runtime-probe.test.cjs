'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const P=require('./aac-runtime-probe.js'),helper=require('./safari-aac-probe.js'),crypto=require('node:crypto');
// Lossless PCM transport is an explicit codec simulator, not WebKit/AAC evidence.
// It exercises the oracle with actual signals rather than canned success answers.
function fixture(options={}){
 const instances=[],frames=[];let count=0;
 class Data{constructor(o){Object.assign(this,o);frames.push(this);}copyTo(out,{planeIndex}){out.set(this.data.subarray(planeIndex*this.numberOfFrames,(planeIndex+1)*this.numberOfFrames));}close(){assert.ok(!this.closed);this.closed=true;}}
 class Chunk{constructor(o){Object.assign(this,o);}}
 class Encoder{
  static async isConfigSupported(){return {supported:true};}
  constructor(o){this.o=o;this.state='unconfigured';this.parts=[];this.encodeQueueSize=0;this.id=count++;instances.push(this);}
  configure(c){assert.deepEqual(c,P.CONFIG);this.state='configured';}
  encode(f){assert.equal(f.numberOfFrames,1024);assert.equal(f.timestamp,Math.round(this.parts.length*1024e6/48000));this.parts.push(f.data.slice());}
  async flush(){
   if(options.hang)return new Promise(()=>{});if(options.flushError)throw Error('Synthetic flush failure');
   const n=(this.parts.length+(options.extraUnit?1:0))*1024,source=new Float32Array(n*2),delay=options.delay??1600;
   this.parts.forEach((p,k)=>{for(let c=0;c<2;c++)for(let i=0;i<1024;i++)source[(k*1024+i)*2+c]=p[c*1024+i];});
   const actualDelay=delay+(options.unstable&&this.id===1?1:0),coded=new Float32Array(n*2);
   for(let i=actualDelay;i<n;i++){coded[i*2]=source[(i-actualDelay)*2];coded[i*2+1]=source[(i-actualDelay)*2+1];}
   if(options.destroyHead)coded.fill(0,(delay+4096)*2,(delay+4096+640)*2);
   if(options.destroyTail){const sourceN=n-2*1024-2*4096-(options.padding??384);coded.fill(0,(delay+4096+sourceN-640)*2,(delay+4096+sourceN)*2);}
   for(let i=0;i<this.parts.length+(options.extraUnit?1:0);i++){
    if(options.drop===i)continue;
    const data=new Uint8Array(coded.slice(i*2048,(i+1)*2048).buffer);
    this.o.output({timestamp:Math.round(i*1024e6/48000)+(options.shift||0),duration:options.noDuration?null:21333,type:'key',byteLength:data.length,copyTo:b=>b.set(data)},
     i===0?{decoderConfig:{...P.CONFIG,description:Uint8Array.of(0x11,0x90)}}:{});
   }
  }
  close(){this.state='closed';}
 }
 class Decoder{
  static async isConfigSupported(){return {supported:true};}
  constructor(o){this.o=o;this.state='unconfigured';this.decodeQueueSize=0;this.pending=[];instances.push(this);}
  configure(){this.state='configured';}
  decode(chunk){
   if(options.hiddenSkip){this.pending.push(chunk);return;}this.emit(chunk);
  }
  emit(chunk){
   const pcm=new Float32Array(chunk.data.buffer,chunk.data.byteOffset,chunk.data.byteLength/4);
   const frame={numberOfFrames:options.decoderSkip?1023:1024,sampleRate:48000,numberOfChannels:2,timestamp:chunk.timestamp,
    copyTo(out,{planeIndex}){for(let i=0;i<out.length;i++)out[i]=pcm[i*2+planeIndex];},close(){assert.ok(!this.closed);this.closed=true;}};
   this.o.output(frame);assert.ok(frame.closed);
  }
  async flush(){if(options.hiddenSkip){
   const pcm=new Float32Array(this.pending.length*2048);this.pending.forEach((c,i)=>pcm.set(new Float32Array(c.data.buffer,c.data.byteOffset,c.data.byteLength/4),i*2048));
   pcm.copyWithin(0,1600*2);pcm.fill(0,pcm.length-1600*2);
   this.pending.forEach((c,i)=>this.emit({...c,data:new Uint8Array(pcm.slice(i*2048,(i+1)*2048).buffer)}));
  }}
  close(){this.state='closed';}
 }
 const wrapped=P.wrap(P.stimulus(16384)).pcm,n=wrapped.length/2+2048,raw=new Float32Array(n*2),full=new Float32Array(n*2);full.set(wrapped);raw.set(wrapped,1600*2);
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),payload=Buffer.from(raw.buffer);
 const reference={schema:1,sourceFrames:16384,config:P.CONFIG,rawContentDelay:1600,rawDecodedFrames:n,inputSHA256:hash(Buffer.from(full.buffer)),payloadSHA256:hash(payload),ascBase64:'EZA=',
  chunks:Array.from({length:n/1024},(_,i)=>({type:'key',timestamp:Math.round(i*1024e6/48000),duration:21333,dataBase64:payload.subarray(i*8192,(i+1)*8192).toString('base64')}))};
 return {io:{SafariAACProbe:helper,AudioEncoder:Encoder,AudioDecoder:Decoder,AudioData:Data,EncodedAudioChunk:Chunk,crypto:crypto.webcrypto,AACDecoderReference:reference},instances,frames};
}
function released(f){assert.ok(f.instances.every(i=>i.state==='closed'));assert.ok(f.frames.every(i=>i.closed));}
test('same-instance head and tail uniquely measure delay without a supplied value',()=>{
 const source=P.stimulus(17024),wrapped=P.wrap(source),decoded=new Float32Array(wrapped.pcm.length+2048*2);decoded.set(wrapped.pcm,1234*2);
 assert.equal(P.correlate(wrapped.pcm,decoded,wrapped.markers).delay,1234);
 const windows=P.content(source,decoded,1234+P.PREFIX);assert.ok(windows.some(w=>w.name==='last640'));assert.ok(windows.every(w=>w.correlations.every(x=>x>.999)));
});
test('periodic and silent calibration cannot produce a confident delay',()=>{
 const silent=new Float32Array(12000);assert.throws(()=>P.correlate(silent,silent,[{start:0,frames:1024}]),{code:'AMBIGUOUS_CONTENT'});
 const periodic=Float32Array.from({length:20000},(_,i)=>Math.sin(i/2%32*Math.PI/16));
 assert.throws(()=>P.correlate(periodic,periodic,[{start:0,frames:1024}]),{code:'AMBIGUOUS_CONTENT'});
});
test('full blocks plus two zero blocks preserve the 640 tail; four measurements repeat; no double trim',async()=>{
 const f=fixture(),api=P.create(f.io),evidence=[];
 const profile=await api.calibrate({onEvidence:r=>evidence.push(r)});assert.equal(profile.delay,1600);assert.equal(profile.measurements.length,4);
 const measured=await api.verify(P.stimulus(144000),profile,{onEvidence:r=>evidence.push(r)});
 assert.equal(measured.trim,1600+P.PREFIX);assert.equal(measured.presentationFrames,144000);assert.equal(measured.packetDelta,0);
 assert.equal(evidence.length,7);const r=evidence.at(-1);assert.equal(r.inputs.length,151);assert.ok(r.inputs.every(i=>i.frames===1024));
 assert.equal(r.inputs.at(-3).sourceFrames,640);assert.equal(r.inputs.at(-2).sourceFrames,0);assert.equal(r.inputs.at(-1).sourceFrames,0);
 assert.equal(r.decodes.shifted.frames[0].timestamp,1000000);assert.ok(Object.values(r.decodes).every(d=>d.frames.reduce((n,x)=>n+x.numberOfFrames,0)===r.chunks.length*1024));
 released(f);
});
test('missing chunk duration remains absent; physical AAC frame length is independently checked',async()=>{
 const f=fixture({noDuration:true}),evidence=[];await P.create(f.io).measure(P.stimulus(16384),{onEvidence:r=>evidence.push(r)});
 assert.ok(evidence[0].chunks.every(c=>c.duration===null&&!c.durationPresent));released(f);
});
test('internal packet loss and positive timestamp shift refuse, never compact the timeline',async()=>{
 for(const options of [{drop:9},{shift:500000}]){
  const f=fixture(options);await assert.rejects(P.create(f.io).measure(P.stimulus(17024)),{code:options.drop?'PACKET_TIMESTAMPS':'UNEXPLAINED_TIMESTAMP_ORIGIN'});released(f);
 }
});
test('decoder partial output/skipping cannot be mistaken for raw encoder delay',async()=>{
 const f=fixture({decoderSkip:true});await assert.rejects(P.create(f.io).measure(P.stimulus(16384)),{code:'DECODER_SKIPPING_OR_FORMAT'});released(f);
});
test('inconsistent delay across fresh encoders rejects the calibration profile',async()=>{
 const f=fixture({unstable:true});await assert.rejects(P.create(f.io).calibrate(),{code:'CALIBRATION_NOT_REPEATABLE'});released(f);
});
test('zeroed useful tail fails the signal check even though all packets and markers survive',async()=>{
 const f=fixture({destroyTail:true,padding:384});await assert.rejects(P.create(f.io).measure(P.stimulus(144000)),{code:'SOURCE_CONTENT_MISMATCH'});released(f);
});
test('the known reference delay is never assigned to a zero-delay runtime encoder',async()=>{
 const f=fixture({delay:0}),api=P.create(f.io),profile=await api.calibrate();
 assert.equal(profile.decoderProof.verifiedRawDelay,1600);assert.equal(profile.delay,0);
 assert.equal((await api.verify(P.stimulus(17024),profile)).trim,P.PREFIX);released(f);
});
test('negative AAC origin is compensated once; measured 2112 is supported without a cookie heuristic',async()=>{
 const f=fixture({shift:-33333}),m=await P.create(f.io).measure(P.stimulus(17024));assert.equal(m.delay,1600);assert.equal(m.trim,5696);released(f);
 const c=fixture({delay:2112,extraUnit:true}),profile=await P.create(c.io).calibrate();assert.equal(profile.delay,2112);assert.equal(profile.packetDelta,1);released(c);
});
test('an actual export with a changed delay or extra whole unit cannot reuse the profile',async()=>{
 for(const field of ['delay','extraUnit']){
  const options={},f=fixture(options),api=P.create(f.io),profile=await api.calibrate();
  options[field]=field==='delay'?1601:true;
  await assert.rejects(api.verify(P.stimulus(17024),profile),{code:'EXPORT_DIFFERS_FROM_CALIBRATION'});released(f);
 }
});
test('truncated physical canary tail and zeroed useful beginning refuse',async()=>{
 const short=fixture({delay:4096});await assert.rejects(P.create(short.io).measure(P.stimulus(16384)));released(short);
 const f=fixture({destroyHead:true});await assert.rejects(P.create(f.io).measure(P.stimulus(17024)),{code:'SOURCE_CONTENT_MISMATCH'});released(f);
});
test('known raw decoder reference detects hidden trim with zero replacement and unchanged full-AU counts',async()=>{
 const f=fixture({hiddenSkip:true});await assert.rejects(P.create(f.io).calibrate(),{code:'DECODER_REFERENCE_MISMATCH'});released(f);
});
test('missing or corrupted reference cannot establish an encoder profile',async()=>{
 const f=fixture();await assert.rejects(P.create({...f.io,AACDecoderReference:null}).calibrate(),{code:'DECODER_REFERENCE_UNAVAILABLE'});
 f.io.AACDecoderReference.payloadSHA256='0'.repeat(64);
 await assert.rejects(P.create(f.io).calibrate(),{code:'DECODER_REFERENCE_IDENTITY'});released(f);
});
test('unknown profiles, unavailable decoder, source over budget and abort fail closed',async()=>{
 const f=fixture(),api=P.create(f.io);await assert.rejects(api.verify(P.stimulus(16384),{delay:1600}),{code:'UNTRUSTED_PROFILE'});
 await assert.rejects(P.create({...f.io,AudioDecoder:null}).measure(P.stimulus(16384)),{code:'WEB_CODECS_UNAVAILABLE'});
 assert.throws(()=>P.wrap(new Float32Array(144001*2)),{code:'SOURCE_BUDGET'});
 const controller=new AbortController();controller.abort();await assert.rejects(api.measure(P.stimulus(16384),{signal:controller.signal}),{name:'AbortError'});released(f);
});
test('flush failure and in-flight abort release resources and preserve evidence',async()=>{
 const f=fixture({flushError:true}),evidence=[];await assert.rejects(P.create(f.io).measure(P.stimulus(16384),{onEvidence:r=>evidence.push(r)}));released(f);assert.ok(evidence[0].error);
 const h=fixture({hang:true}),controller=new AbortController();setTimeout(()=>controller.abort(),10);
 await assert.rejects(P.create(h.io).measure(P.stimulus(16384),{signal:controller.signal}),{name:'AbortError'});released(h);
});
module.exports={fixture};
