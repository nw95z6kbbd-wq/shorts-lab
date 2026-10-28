'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={};vm.runInNewContext(fs.readFileSync('tests/runtime-session-fixture.js','utf8'),{window,setTimeout,clearTimeout});
test('recorded video probe stays attached and visible for seeking, and stops before removal',()=>{
 const events=[],element={isConnected:false,src:'blob:recording',pause(){events.push('pause');},removeAttribute(name){assert.equal(name,'src');delete this.src;events.push('src');},load(){assert.equal(this.src,undefined);events.push('load');},remove(){assert.deepEqual(events,['pause','src','load']);this.isConnected=false;events.push('remove');}};
 const document={body:{append(node){assert.equal(node,element);node.isConnected=true;}}};
 const unmount=window.mountRuntimeRecordedVideo(element,document);
 assert.equal(element.isConnected,true);assert.match(element.style,/position:fixed/);assert.match(element.style,/width:90px;height:160px/);assert.doesNotMatch(element.style,/display:none|visibility:hidden/);
 // The probe retains its document consumer for all three frame samples.
 const seek=()=>{assert.equal(element.isConnected,true,'frame decode has a document consumer');};
 for(const second of [.5,2.7,4.8]){element.currentTime=second;seek();}
 unmount();assert.equal(element.isConnected,false);assert.deepEqual(events,['pause','src','load','remove']);
});

class MetadataFirstVideo extends EventTarget {
 constructor(){super();this.readyState=1;this.videoWidth=720;this.videoHeight=1280;this.error=null;this.time=0;this.seekEvents=0;}
 set currentTime(value){if(this.readyState<2)return;this.time=value;this.seekEvents++;this.dispatchEvent(new Event('seeked'));}
 get currentTime(){return this.time;}
 decoded(){this.readyState=4;this.dispatchEvent(new Event('loadeddata'));}
}
test('metadata-first asynchronous decode cannot swallow the initial seek anymore',async()=>{
 const old=new MetadataFirstVideo();old.currentTime=.5;old.decoded();assert.equal(old.currentTime,0);assert.equal(old.seekEvents,0,'reproduce an early seek lost before decoded data');
 const video=new MetadataFirstVideo();let ready=false;
 const waiting=window.waitRuntimeVideoFrame(video,1000).then(()=>{ready=true;video.currentTime=.5;});
 await Promise.resolve();assert.equal(ready,false);assert.equal(video.currentTime,0,'metadata and dimensions alone never permit seeking');
 video.decoded();await waiting;assert.equal(ready,true);assert.equal(video.currentTime,.5);assert.equal(video.seekEvents,1);
});
test('frame readiness rejects decoder errors and missing data instead of accepting metadata',async()=>{
 const video=new MetadataFirstVideo(),waiting=window.waitRuntimeVideoFrame(video,1000);
 video.error={code:3,message:'corrupt bitstream'};video.dispatchEvent(new Event('error'));await assert.rejects(waiting,/frame decode error: 3 corrupt bitstream/);
 await assert.rejects(window.waitRuntimeVideoFrame(new MetadataFirstVideo(),5),/frame readiness timeout/);
 const ready=new MetadataFirstVideo();ready.decoded();await window.waitRuntimeVideoFrame(ready,1000);
});
