'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const D=require('./runtime-diagnostics.js');
test('Safari anonymous @ stack never replaces the actual exception message or code',()=>{
 const error=Object.assign(new Error('Браузер не разрешил звук.'),{stack:'@',code:'AUDIO_GESTURE'});
 assert.equal(error.stack||error.message,'@','reproduce the original diagnostic loss');
 const result=JSON.parse(JSON.stringify(D.failure(error)));
 assert.deepEqual(result,{name:'Error',message:'Браузер не разрешил звук.',code:'AUDIO_GESTURE',stack:'@'});
 assert.match(JSON.stringify(result),/Браузер не разрешил звук/);
});
test('all rejection shapes and nested causes survive JSON transport',()=>{
 for(const error of [null,undefined,'bad codec',new DOMException('denied','NotAllowedError'),{message:'missing samples',code:17,stack:'@'}]){
  const result=JSON.parse(JSON.stringify(D.failure(error)));assert.equal(typeof result.message,'string');assert.ok(result.message);
 }
 const cause=Object.assign(Error('close failed'),{code:'AUDIO_CLOSE'}),outer=Error('cleanup failed',{cause});assert.equal(D.failure(outer).cause.code,'AUDIO_CLOSE');
});

test('native Python result validator rejects every failure envelope including empty details',()=>{
 require('node:child_process').execFileSync('python',['tests/runtime-native-test.py'],{stdio:'pipe'});
});
