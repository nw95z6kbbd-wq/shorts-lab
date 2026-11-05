'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const P=require('./safari-aac-probe.js');
test('deterministic stereo probes cover start/middle/end including AAC boundaries',()=>{
 for(const n of P.LENGTHS){const a=P.stimulus(n),b=P.stimulus(n);assert.deepEqual(a.pcm,b.pcm);assert.equal(a.pcm.length,n*2);assert.equal(a.markers.length,3);assert.ok(a.markers[0].start>0);assert.ok(a.markers[2].start+a.markers[2].frames<n);assert.notEqual(a.pcm[20],a.pcm[21]);assert.ok(a.pcm.every(v=>Number.isFinite(v)&&Math.abs(v)<1));}
 assert.ok(P.LENGTHS.includes(1023)&&P.LENGTHS.includes(1024)&&P.LENGTHS.includes(1025));
});
test('unapproved lengths fail before allocating',()=>{for(const n of [0,1,Infinity,1e9])assert.throws(()=>P.stimulus(n));});
test('raw ASC does not manufacture encoder delay',()=>{const raw=Uint8Array.from([17,144]);assert.deepEqual(P.ascFromDescription(raw),raw);assert.deepEqual(P.metadataRecord({decoderConfig:{description:raw}}).delayFields,{});});
function cookie(buffer){const asc=Buffer.from([17,144]),d=(tag,payload)=>Buffer.concat([Buffer.from([tag,payload.length]),payload]);return d(3,Buffer.concat([Buffer.alloc(3),d(4,Buffer.concat([Buffer.from([64,20,...buffer]),Buffer.alloc(8),d(5,asc)])),d(6,Buffer.from([2]))]));}
test('ES cookie bufferSizeDB never changes extracted config or invents priming',()=>{
 for(const value of [[0,24,0],[0,0,0],[0,1,0]]){const raw=cookie(value),m=P.metadataRecord({decoderConfig:{description:raw}});assert.deepEqual(P.ascFromDescription(raw),Uint8Array.from([17,144]));assert.equal(m.decoderConfig.descriptionKind,'ES_Descriptor');assert.deepEqual(m.decoderConfig.delayFields,{});assert.equal(Buffer.from(m.decoderConfig.descriptionBase64,'base64').toString('hex'),raw.toString('hex'));}
});
test('malformed descriptor is recorded without losing raw cookie',()=>{const raw=cookie([0,24,0]).subarray(0,8);assert.throws(()=>P.ascFromDescription(raw));const m=P.metadataRecord({decoderConfig:{description:raw}});assert.equal(m.decoderConfig.ascError,'Error');assert.ok(m.decoderConfig.descriptionBase64);});
test('delay metadata is observed only when supplied; unknown string values are not exported',()=>{
 const m=P.metadataRecord({encoderDelay:73,secret:'SENTINEL_SECRET',decoderConfig:{priming:128,delaySource:'SENTINEL_SECRET'}});
 assert.equal(m.delayFields.encoderDelay,73);assert.equal(m.decoderConfig.delayFields.priming,128);assert.ok(!JSON.stringify(m).includes('SENTINEL_SECRET'));assert.equal(m.decoderConfig.descriptionBase64,undefined);
});
test('PCM transport is explicitly little endian and lossless for generated f32',()=>{const x=P.stimulus(1024).pcm,b=Buffer.from(P.pcm64(x),'base64');assert.equal(b.length,x.length*4);x.forEach((v,i)=>assert.equal(b.readFloatLE(i*4),v));});
