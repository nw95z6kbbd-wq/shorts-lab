'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
function create(source,{paused=true,noFrame=false,wrongFrame=false,rejectedPlay=false,heldFrame}={}){
 let next=0;const callbacks=new Map(),events=new Map();
 const element={paused,readyState:4,error:null,time:0,playCalls:0,pauseCalls:0,presented:0,
  addEventListener(e,f){events.set(e,f);},removeEventListener(e){events.delete(e);},
  requestVideoFrameCallback(f){const id=++next;callbacks.set(id,f);return id;},cancelVideoFrameCallback:id=>callbacks.delete(id),
  get currentTime(){return this.time;},set currentTime(t){this.time=t;queueMicrotask(()=>{events.get('seeked')?.();if(!this.paused)this.frame();});},
  frame(){if(noFrame)return;queueMicrotask(()=>{for(const [id,f] of [...callbacks]){callbacks.delete(id);this.presented++;f(0,{mediaTime:heldFrame??this.time+(wrongFrame?1:.04)});}});},
  play(){this.playCalls++;if(rejectedPlay)return Promise.reject(Error('autoplay denied'));this.paused=false;this.frame();return Promise.resolve();},
  pause(){this.pauseCalls++;this.paused=true;}
 };
 const window={requestAnimationFrame:f=>queueMicrotask(f)};
 vm.runInNewContext(source,{window,setTimeout,clearTimeout,Error});
 return{seek:(t,expected)=>window.seekRuntimeVideoFrame(element,t,25,expected),element,callbacks,events};
}
const before=fs.readFileSync('tests/fixtures/recorder-clock/seek-before.js','utf8'),now=fs.readFileSync('tests/runtime-session-fixture.js','utf8');
test('frozen pre-fix sampler times out on a paused seek even with readyState=4 and seeked delivered',async()=>{
 assert.equal(createHash('sha256').update(before).digest('hex'),'8c5c165b2199ce70bd825f8e6bd8e7950a122b8ffd84c81db65f1dab956d55c4');
 const f=create(before);await assert.rejects(f.seek(1.5),/presentation timeout/);assert.equal(f.element.playCalls,0);assert.equal(f.element.readyState,4);
});
test('seek presents an actual timestamp-checked frame then restores the original paused state',async()=>{
 const f=create(now),value=await f.seek(1.5);assert.ok(Math.abs(value.mediaTime-1.5)<=.1);assert.ok(f.element.presented);assert.equal(f.element.playCalls,1);assert.equal(f.element.pauseCalls,1);assert.equal(f.element.paused,true);assert.equal(f.events.size,0);assert.equal(f.callbacks.size,0);
});
test('no frame, a wrong timestamp and autoplay rejection cannot become formal successful completion',async()=>{
 for(const options of [{noFrame:true},{wrongFrame:true},{rejectedPlay:true}]){const f=create(now,options);await assert.rejects(f.seek(4.8),options.rejectedPlay?/autoplay denied/:/presentation timeout/);assert.equal(f.element.paused,true);assert.equal(f.events.size,0);assert.equal(f.callbacks.size,0);}
});
test('an already-playing consumer remains playing',async()=>{
 const f=create(now,{paused:false});await f.seek(.5);assert.equal(f.element.playCalls,0);assert.equal(f.element.pauseCalls,0);assert.equal(f.element.paused,false);
});

test('a legitimate VFR held frame is checked against its independently decoded PTS without enlarging 100ms tolerance',async()=>{
 const prior=create(now,{heldFrame:2.316});await assert.rejects(prior.seek(2.5),/presentation timeout/);
 const actual=create(now,{heldFrame:2.316});assert.equal((await actual.seek(2.5,2.316)).mediaTime,2.316);assert.equal(actual.element.currentTime,2.5);assert.equal(actual.element.paused,true);
 for(const expected of [2.2,2.71,NaN]){const f=create(now,{heldFrame:2.316});await assert.rejects(f.seek(2.5,expected));assert.equal(f.callbacks.size,0);}
});
