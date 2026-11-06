'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const install=require('./editor-aac-trace.js'),helpers=require('./safari-aac-probe.js'),report=require('./editor-aac-report.cjs');
const expected={fixture:'editor-export-synthetic-3s',durationMs:3000,pcmFrames:144000,sampleRate:48000,numberOfChannels:2};
function encoderRoot(){
 class Encoder {
  static async isConfigSupported(config){return{supported:true,config};}
  constructor(options){this.options=options;this.frames=[];this.configured=null;this.closeCount=0;this.flushPromise=Promise.resolve();}
  configure(config){this.configured=config;return 17;}
  encode(frame){this.frames.push(frame);const data=Uint8Array.from([1,2,3]),chunk={timestamp:frame.timestamp,type:'key',byteLength:data.length,copyTo:out=>out.set(data)};
   const metadata={decoderConfig:{codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,description:Uint8Array.from([17,144])}};
   this.lastChunk=chunk;this.lastMetadata=metadata;return this.options.output(chunk,metadata);}
  flush(){return this.flushPromise;}
  close(){this.closeCount++;return 19;}
 }
 return{AudioEncoder:Encoder};
}
function frame(offset,n){return{timestamp:Math.round(offset*1e6/48000),duration:Math.round(n*1e6/48000),numberOfFrames:n,sampleRate:48000,numberOfChannels:2,
 copyTo(out,{planeIndex}){for(let i=0;i<n;i++)out[i]=(planeIndex?-1:1)*(offset+i)/144000;},close(){throw Error('Observer must not close caller frame');}};}
test('observer captures 144000 stereo samples including final 640 without changing native calls',async()=>{
 const root=encoderRoot(),trace=install(root,helpers);trace.arm(expected);const outputs=[];
 const encoder=new root.AudioEncoder({output:(c,m)=>outputs.push([c,m]),error:()=>{}}),config={codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,bitrate:128000};
 assert.equal(encoder.configure(config),17);assert.equal(encoder.configured,config);
 for(let offset=0;offset<144000;offset+=1024){const f=frame(offset,Math.min(1024,144000-offset));encoder.encode(f);assert.equal(encoder.frames.at(-1),f);assert.equal(outputs.at(-1)[0],encoder.lastChunk);assert.equal(outputs.at(-1)[1],encoder.lastMetadata);}
 assert.equal(encoder.flush(),encoder.flushPromise);await encoder.flushPromise;assert.equal(encoder.close(),19);assert.equal(encoder.closeCount,1);
 const capture=trace.snapshot(),r=capture.encoders[0];assert.deepEqual(capture.errors,[]);assert.equal(r.inputs.length,141);assert.equal(r.inputs.at(-1).numberOfFrames,640);assert.equal(r.inputFrames,144000);assert.equal(r.chunks.length,141);assert.ok(r.flushComplete&&r.closed);
 assert.ok(r.chunks.every(c=>!c.durationPresent&&c.duration===null));const pcm=Buffer.from(r.inputPCMBase64,'base64');assert.equal(pcm.length,144000*8);assert.equal(pcm.readFloatLE(8*143999),Math.fround(143999/144000));assert.equal(pcm.readFloatLE(8*143999+4),Math.fround(-143999/144000));trace.stop();assert.equal(trace.snapshot(),null);
});
test('observer is inert until synthetic fixture is armed and refuses other projects',()=>{
 const root=encoderRoot();let copies=0;const trace=install(root,{...helpers,metadataRecord(){copies++;throw Error('Should not observe');}});
 const e=new root.AudioEncoder({output:()=>42,error:()=>{}});assert.equal(e.encode(frame(0,1024)),42);assert.equal(copies,0);
 assert.throws(()=>trace.arm({...expected,fixture:'user-project'}));assert.throws(()=>trace.arm({...expected,pcmFrames:48000}));
});
test('diagnostic faults never suppress callbacks or replace native exceptions',()=>{
 const root=encoderRoot(),trace=install(root,{...helpers,metadataRecord(){throw Error('SENTINEL_SECRET');}});trace.arm(expected);
 const original=new Error('original callback');const e=new root.AudioEncoder({output(){throw original;},error(){}});
 assert.throws(()=>e.encode(frame(0,1024)),x=>x===original);assert.deepEqual(trace.snapshot().errors,['output-capture']);assert.ok(!JSON.stringify(trace.snapshot()).includes('SENTINEL_SECRET'));
});
test('native error callbacks and flush rejection remain observable by the caller',async()=>{
 const root=encoderRoot(),trace=install(root,helpers);trace.arm(expected);const cause=new Error('native error');let received;
 const e=new root.AudioEncoder({output(){},error(value){received=value;}});e.options.error(cause);assert.equal(received,cause);
 e.flushPromise=Promise.reject(cause);assert.equal(e.flush(),e.flushPromise);await assert.rejects(e.flushPromise,x=>x===cause);
 const r=trace.snapshot().encoders[0];assert.ok(r.encoderError&&r.flushError);
});
test('observer does not make invalid native constructor arguments acceptable',()=>{
 const original=new TypeError('native constructor validation'),root={AudioEncoder:class {
  constructor(options){if(typeof options?.output!=='function'||typeof options?.error!=='function')throw original;}
 }};
 const trace=install(root,helpers);trace.arm(expected);
 assert.throws(()=>new root.AudioEncoder({output(){}}),x=>x===original);
 assert.throws(()=>new root.AudioEncoder(),x=>x===original);
 assert.deepEqual(trace.snapshot().encoders,[]);
});
function capture(count=142,offset=0,durations=false){return{schema:1,expected,errors:[],exportOutcome:{aacCoverageFailure:true},encoders:[{
 chunks:Array.from({length:count},(_,i)=>({timestamp:Math.round((i*1024-offset)*1e6/48000),durationPresent:durations,duration:durations?21333:null,
 metadata:i===0?{decoderConfig:{descriptionBase64:'EZA='}}:{}}))}]};}
test('real source replay distinguishes underflow, excess, timestamps and acceptance',()=>{
 const excess=report(capture());assert.equal(excess.coverage.branch,'residual-at-least-one-AAC-unit');assert.equal(excess.coverage.residualSamples,1408);assert.equal(excess.coverage.priming,-0);assert.equal(excess.validatorOutcome,'INCOMPLETE');assert.ok(excess.matchesObservedCoverageFailure);
 const under=report(capture(140));assert.equal(under.coverage.branch,'decoded-minus-priming-below-pcm');assert.equal(under.coverage.residualSamples,-640);
 const good=report(capture(142,1024));assert.equal(good.validatorOutcome,'accepted');assert.equal(good.coverage.priming,1024);assert.equal(good.coverage.residualSamples,384);
 const shifted=capture();shifted.encoders[0].chunks.forEach(c=>c.timestamp+=500000);assert.equal(report(shifted).validatorOutcome,'ENCODER_TIMESTAMPS');assert.equal(report(shifted).coverage,undefined);
});
test('missing duration, reported microseconds and modelled coded samples stay separate',()=>{
 const absent=report(capture()),present=report(capture(142,0,true));assert.equal(absent.missingChunkDurationCount,142);assert.equal(absent.reportedChunkDurationUsSum,0);assert.equal(absent.coverage.decoded,145408);assert.equal(absent.codedSamplesIfEveryAccessUnitDecodesTo1024,145408);
 assert.equal(present.missingChunkDurationCount,0);assert.equal(present.reportedChunkDurationUsSum,142*21333);assert.equal(present.coverage.decoded,145408);
});
test('cookie/ASC analysis faithfully reports the existing 2112 selection without endorsing it',()=>{
 const d=(tag,p)=>Buffer.concat([Buffer.from([tag,p.length]),p]),cookie=d(3,Buffer.concat([Buffer.alloc(3),d(4,Buffer.concat([Buffer.from([64,20,0,24,0]),Buffer.alloc(8),d(5,Buffer.from([17,144]))])),d(6,Buffer.from([2]))]));
 const c=capture(143);c.encoders[0].chunks[0].metadata.decoderConfig.descriptionBase64=cookie.toString('base64');const r=report(c);assert.equal(r.coverage.priming,2112);assert.ok(r.coverage.cocoaCookie);assert.equal(r.coverage.residualSamples,320);assert.equal(r.actualASCBase64,'EZA=');
});
test('observed replay preserves outcomes of the uninstrumented production validator',()=>{
 const source=fs.readFileSync('js/native-mp4.js','utf8'),a=source.indexOf('  function validateAAC('),b=source.indexOf('  function mux(',a),raw=vm.runInNewContext('('+source.slice(a,b)+')',{error:(code,message)=>Object.assign(new Error(message),{code})});
 for(const c of [capture(),capture(140),capture(142,1024),capture(142,0,true)]){
  const audio={samples:c.encoders[0].chunks.map(s=>({timestamp:s.timestamp,duration:s.durationPresent?s.duration:undefined}))};let result='accepted';try{raw(audio,144000);}catch(e){result=e.code;}assert.equal(report(c).validatorOutcome,result);
 }
});
test('changed source conditions require diagnostic review rather than a guessed branch',()=>{
 const source=fs.readFileSync('js/native-mp4.js','utf8').replace('decoded-priming-pcmFrames>=1024','decoded-priming-pcmFrames>=2048');assert.throws(()=>report(capture(),source),/Coverage source changed/);
 assert.equal(report({encoders:[]}).status,'not-observed');const truncated=capture();truncated.errors=['budget'];assert.equal(report(truncated).status,'incomplete-capture');
 const empty=capture();empty.encoders[0].chunks[0].metadata.decoderConfig.descriptionBase64='';assert.equal(report(empty).validatorOutcome,'CODEC');
});
