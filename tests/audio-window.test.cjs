'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const factory=require('../js/audio-window.js'),mediaFactory=require('../js/media-session.js');
const bytes=fs.readFileSync('tests/fixtures/editor-audio/long/tone-215s-stereo.mp3'),blob=new Blob([bytes],{type:'audio/mpeg'}),hash=async b=>crypto.createHash('sha256').update(new Uint8Array(b)).digest('hex');
function fixture(){let calls=0,gate;const originals=new Map([['music',{id:'music',kind:'music',blob}]]);
 const audioWindow=factory({hash,context:rate=>({async decodeAudioData(){calls++;if(gate)await gate.promise;return {length:9468000,numberOfChannels:2,sampleRate:rate,duration:9468000/rate,getChannelData:c=>({subarray:(a,b)=>new Float32Array(b-a).fill(c?.25:.5)})};},createBuffer:(channels,length,sampleRate)=>{const data=Array.from({length:channels},()=>new Float32Array(length));return {length,numberOfChannels:channels,sampleRate,duration:length/sampleRate,copyToChannel:(a,c)=>data[c].set(a),getChannelData:c=>data[c]};}})});
 const media=mediaFactory({original:async id=>originals.get(id),audioWindow,audio:async()=>({length:9468000,numberOfChannels:2,duration:214.69,sampleRate:44100})});
 const create=(extra={})=>media.create({owner:{slot:'editor',projectId:'p'},audioDurationMs:30000,...extra});
 return {media,create,originals,audioWindow,calls:()=>calls,setGate:g=>gate=g};
}
test('real 215s MP3 headers reproduce the old 64MiB PCM rejection; short plan retains 30s without raising limits',async()=>{
 const f=fixture(),info=await f.audioWindow.probe(blob);assert.equal(info.sampleRate,44100);assert.equal(info.channels,2);assert.ok(info.samples/info.sampleRate>214.6&&info.samples/info.sampleRate<214.9);assert.ok(info.fullPcmBytes>64*1048576);
 const old=f.create({audioDurationMs:null});await assert.rejects(old.prepare([{id:'music',kind:'audio'}]),{code:'DECODED_BUDGET'});await old.dispose();
 const s=f.create();await s.prepare([{id:'music',kind:'audio'}]);assert.equal(f.media.DEFAULTS.maxAudioBytes,64*1048576);assert.equal(f.media.DEFAULTS.maxDecodedBytes,96*1048576);const l=s.acquire(),b=l.audio('music');assert.equal(b.duration,30);assert.equal(b.length,1323000);assert.equal(b.getChannelData(0)[100],.5);assert.equal(b.getChannelData(1)[100],.25);assert.equal(s.status().audioInfo[0].retainedPcmBytes,10584000);assert.equal(f.media.statistics().scratchBytes,0);assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);l.release();await s.dispose();assert.equal(f.media.statistics().residentBytes,0);
});
test('overlapping validation/playback share one decode, SHA and tenant/window identity remain strict',async()=>{
 const f=fixture(),a=f.create(),b=f.create();await a.prepare([{id:'music',kind:'audio'}]);await b.prepare([{id:'music',kind:'audio'}]);assert.equal(f.calls(),1);const x=a.acquire(),y=b.acquire();assert.equal(x.audio('music'),y.audio('music'));x.release();await a.dispose();assert.equal(y.audio('music').duration,30);
 const other=f.create({owner:{slot:'video',projectId:'p'}});await other.prepare([{id:'music',kind:'audio'}]);assert.equal(f.calls(),2);await other.dispose();
 const window=f.create({audioDurationMs:15000});await window.prepare([{id:'music',kind:'audio'}]);assert.equal(f.calls(),3);await window.dispose();
 // ID collision with different original bytes must not use the prior buffer.
 f.originals.set('music',{id:'music',kind:'music',blob:new Blob([bytes,Buffer.alloc(1)],{type:'audio/mpeg'})});const changed=f.create();await changed.prepare([{id:'music',kind:'audio'}]);assert.equal(f.calls(),4);await changed.dispose();y.release();await b.dispose();assert.equal(f.media.statistics().pooledAudio,0);assert.equal(f.media.statistics().residentBytes,0);
});
test('real memory limits reject BEFORE native decoding and preserve a live previous lease',async()=>{
 const f=fixture(),good=f.create();await good.prepare([{id:'music',kind:'audio'}]);const lease=good.acquire();
 for(const options of [{limits:{maxDecodedBytes:8*1048576},audioDurationMs:10000},{limits:{maxAudioBytes:1024},audioDurationMs:20000}]){const bad=f.create(options);await assert.rejects(bad.prepare([{id:'music',kind:'audio'}]),e=>['AUDIO_DECODE_BUDGET','DECODED_BUDGET','MEMORY_BUDGET'].includes(e.code));await bad.dispose();assert.equal(f.calls(),1);assert.equal(lease.audio('music').duration,30);}
 lease.release();await good.dispose();assert.equal(f.media.statistics().residentBytes,0);
});
test('cancelling an in-flight full decode never publishes its cropped PCM or leaks reservations',async()=>{
 const f=fixture();let resolve;const promise=new Promise(r=>resolve=r);f.setGate({promise});const s=f.create(),prep=s.prepare([{id:'music',kind:'audio'}]);while(!f.calls())await new Promise(r=>setTimeout(r,0));const end=s.cancel();await assert.rejects(prep,{code:'CANCELLED'});assert.ok(f.media.statistics().scratchBytes>70*1048576);resolve();await end;assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().pooledAudio,0);assert.equal(f.media.statistics().sessions,0);
});
test('invalid headers, unsupported Layer II/free format and missing frames are rejected explicitly',()=>{
 const api=factory({});for(const b of [Buffer.from('bad'),Buffer.from([73,68,51]),Buffer.from([255,253,0,0]),bytes.subarray(0,bytes.length-100)])assert.throws(()=>api.inspect(b),e=>['AUDIO_HEADER','AUDIO_CODEC'].includes(e.code));
});
test('a real 400s stereo MP3 exceeds unchanged default workspace before allocation; AAC uses legacy decoding',async()=>{
 const f=fixture(),big=fs.readFileSync('tests/fixtures/editor-audio/long/tone-400s-stereo.mp3');f.originals.set('huge',{id:'huge',kind:'music',blob:new Blob([big],{type:'audio/mpeg'})});const s=f.create();await assert.rejects(s.prepare([{id:'huge',kind:'audio'}]),e=>e.code==='AUDIO_DECODE_BUDGET'&&e.message.includes('96'));assert.equal(f.calls(),0);await s.dispose();assert.equal(f.media.statistics().residentBytes,0);
 assert.equal(await f.audioWindow.probe(new Blob([Uint8Array.from([255,241,80,128,0])],{type:'audio/aac'})),null,'ADTS must not be mistaken for MP3');
});
