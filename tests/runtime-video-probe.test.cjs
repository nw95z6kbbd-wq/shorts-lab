'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={};vm.runInNewContext(fs.readFileSync('tests/runtime-session-fixture.js','utf8'),{window});
test('recorded video probe stays attached and visible for seeking, and stops before removal',()=>{
 const events=[],element={isConnected:false,src:'blob:recording',pause(){events.push('pause');},removeAttribute(name){assert.equal(name,'src');delete this.src;events.push('src');},load(){assert.equal(this.src,undefined);events.push('load');},remove(){assert.deepEqual(events,['pause','src','load']);this.isConnected=false;events.push('remove');}};
 const document={body:{append(node){assert.equal(node,element);node.isConnected=true;}}};
 const unmount=window.mountRuntimeRecordedVideo(element,document);
 assert.equal(element.isConnected,true);assert.match(element.style,/position:fixed/);assert.match(element.style,/width:90px;height:160px/);assert.doesNotMatch(element.style,/display:none|visibility:hidden/);
 // Model the failing Safari condition: metadata alone can exist while a
 // detached video never dispatches seeked. Every probe seek must be connected.
 const seek=()=>{assert.equal(element.isConnected,true,'frame decode has a document consumer');};
 for(const second of [.5,2.7,4.8]){element.currentTime=second;seek();}
 unmount();assert.equal(element.isConnected,false);assert.deepEqual(events,['pause','src','load','remove']);
});
