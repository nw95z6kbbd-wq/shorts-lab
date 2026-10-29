'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js');
const before=fs.readFileSync('tests/fixtures/editor-audio/play-before-continuity.js','utf8'),app=fs.readFileSync('js/app.js','utf8'),after=app.slice(app.indexOf('  async function play() {'),app.indexOf('  function renderAppearance()'));
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(source){
 let clock=0,prepared='s0',held,resolve,pauses=0;const callbacks=[],starts=[],renders=[];
 const p=C.upgradeProject(C.createProject());p.timing='manual';p.scenes=Array.from({length:4},(_,i)=>({id:'s'+i,text:'',durationMs:1000,visual:'animated',imageId:null,imageName:'',camera:'static',transition:'none'}));p.selectedSceneId='s0';p.audio.music.assetId='music';const plan=A.fromEditor(p);
 const env={playing:false,timing:{plan},editorVisible:true,document:{hidden:false},audioState:'ready',audioFailure:null,elapsedMs:0,playEpoch:0,previewRevision:9,project:p,P,performance:{now:()=>clock},updateSelectedScene(){},updatePlaybackUI(){},renderAudio(){},audioPlayback:{status:()=>({ready:true}),positionMs:()=>clock,start:async(ms,options)=>starts.push({ms,options}),pause:async()=>pauses++},livePreview:{status:()=>({active:{state:'ready',previewSceneId:prepared,identity:{contentRevision:9}}})},requestAnimationFrame:cb=>callbacks.push(cb),pausePlayback(){pauses++;env.playing=false;env.playEpoch++;},async renderPreview(){const id=P.frameAt(plan,env.elapsedMs).scene.id;renders.push({time:env.elapsedMs,id});if(id==='s1'&&held)await held;prepared=id;return true;}};
 vm.createContext(env);vm.runInContext(source,env);return {env,starts,renders,callbacks,pauses:()=>pauses,setTime:t=>clock=t,hold(){held=new Promise(r=>resolve=r);},release(){held=null;resolve();}};
}
test('frozen prior UI restarts music at a scene boundary; current UI keeps the exact same audio consumer',async()=>{
 assert.equal(require('node:crypto').createHash('sha256').update(before).digest('hex'),'530cb8e9b1987a2d972134f77d8148e55fdb1f2288428fa3c13a4719a7689e39');
 for(const [source,legacy] of [[before,true],[after,false]]){const f=fixture(source);await f.env.play();assert.equal(f.starts.length,2);f.setTime(1100);await f.callbacks.shift()(1100);assert.equal(f.pauses(),legacy?1:0);assert.equal(f.starts.length,legacy?3:2);assert.equal(f.renders.at(-1).id,'s1');}
});
test('slow image preparation crossing another scene catches up to the live audio clock without stop or seek',async()=>{
 const f=fixture(after);await f.env.play();f.hold();f.setTime(1100);const frame=f.callbacks.shift()(1100);await tick();assert.equal(f.pauses(),0);f.setTime(2500);f.release();await frame;assert.equal(f.pauses(),0);assert.equal(f.starts.length,2);assert.deepEqual(f.renders.at(-1),{id:'s2',time:2500});assert.equal(f.env.project.selectedSceneId,'s2');assert.equal(f.env.elapsedMs,2500);
});
test('pause/cancellation during a pending picture cannot restart sound or schedule a stale frame',async()=>{
 const f=fixture(after);await f.env.play();f.hold();f.setTime(1100);const frame=f.callbacks.shift()(1100);await tick();f.env.pausePlayback();f.setTime(2500);f.release();await frame;assert.equal(f.pauses(),1);assert.equal(f.starts.length,2);assert.equal(f.callbacks.length,0);assert.equal(f.env.playing,false);
});
test('the plan end still stops playback after cold preparation while automatic boundaries never do',async()=>{
 const f=fixture(after);await f.env.play();f.hold();f.setTime(1100);const frame=f.callbacks.shift()(1100);await tick();f.setTime(4000);f.release();await frame;assert.equal(f.starts.length,2);assert.equal(f.pauses(),1);assert.equal(f.env.elapsedMs,4000);assert.equal(f.env.playing,false);assert.equal(f.callbacks.length,0);
});
test('the local-file PCM meter preserves 128-sample RMS/zero detection within a larger callback',()=>{
 const env={window:{}};vm.createContext(env);vm.runInContext(fs.readFileSync('tests/editor-audio-continuity.js','utf8'),env);const p={blocks:0,zeroBlocks:0,minRms:null},data=new Float32Array(2048).fill(.1);data.fill(0,128,256);
 env.window.editorBoundaryAccumulate(p,data,1,44100);assert.equal(p.blocks,16);assert.equal(p.zeroBlocks,1);assert.equal(p.minRms,0);
 const silent={blocks:0,zeroBlocks:0,minRms:null};env.window.editorBoundaryAccumulate(silent,new Float32Array(2048),1,44100);assert.equal(silent.zeroBlocks,16);
 const active={blocks:0,zeroBlocks:0,minRms:null};env.window.editorBoundaryAccumulate(active,new Float32Array(2048).fill(.1),1,44100);assert.ok(active.minRms>.09);assert.equal(active.zeroBlocks,0);env.window.editorBoundaryAccumulate(active,data,10,44100);assert.equal(active.blocks,16);
});
test('audio/Canvas assertions after seek wait for a moving frame relative to the seek offset',async()=>{
 const env={};env.window=env;vm.createContext(env);vm.runInContext(fs.readFileSync('tests/editor-audio-fixture.js','utf8'),env);
 let release;const gate=new Promise(r=>release=r);env.editorAudioTaps=[{stopped:false,when:0,context:{currentTime:.2},options:{offsetSeconds:3.5}}];env.editorCanvas={dataset:{timeMs:'3500'}};
 env.editorLiveUntil=async condition=>{assert.equal(condition(),false,'the old paused seek frame must not satisfy playback progress');await gate;assert.equal(condition(),true);};env.editorAudioSignal=()=>({clock:3700,canvas:Number(env.editorCanvas.dataset.timeMs)});
 const checking=env.editorAudioPlaying(150);env.editorCanvas.dataset.timeMs='3700';release();assert.equal((await checking).canvas,3700);
 env.editorLiveUntil=async condition=>assert.equal(condition(),true);env.editorAudioSignal=()=>({clock:4000,canvas:3700});await assert.rejects(env.editorAudioPlaying(150),/Canvas\/audio offset/,'the original sync tolerance still rejects real lag');
});
