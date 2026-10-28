'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../js/core.js'),V=require('../js/video-core.js'),P=require('../js/render-plan.js'),A=require('../js/render-adapters.js');
const mediaFactory=require('../js/media-session.js'),renderFactory=require('../js/render-session.js');
const png=fs.readFileSync('tests/fixtures/backup-media/red.png'),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
const delay=()=>new Promise(r=>setTimeout(r,0));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture(){
 const assets=new Map(),events=[],gates={};let active=0,maxActive=0;
 for(const id of ['a','b','c'])assets.set(id,{id,kind:'image',blob:new Blob([png],{type:'image/png'})});
 for(const id of ['voice','music'])assets.set(id,{id,kind:'voice',blob:new Blob(['audio-'+id],{type:'audio/wav'})});
 const io={original:async id=>{events.push('read:'+id);await gates.read?.promise;return assets.get(id);},
  image:async blob=>{const id=[...assets.values()].find(a=>a.blob===blob)?.id;events.push('image:'+id);active++;maxActive=Math.max(active,maxActive);try{await gates.image?.promise;if(gates.imageError)throw Error('bad image');return{image:{id},width,height,dispose(){events.push('dispose:'+id);}};}finally{active--;}},
  audio:async blob=>{events.push('audio');active++;maxActive=Math.max(active,maxActive);try{await gates.audio?.promise;if(gates.audioError)throw Error('bad audio');return{length:gates.audioLength||128,numberOfChannels:2,duration:1,sampleRate:48000};}finally{active--;}}
 };
 const media=mediaFactory(io),runtime=renderFactory({adapters:A,plan:P,media,render:(canvas,plan,time,resources)=>{events.push('frame');return resources.images.get(plan.timeline[0].imageId);},record:async o=>{events.push('record');return{plan:o.plan,resources:o.resources};},context:()=>{throw Error('not expected');}});
 return{assets,events,gates,io,media,runtime,maxActive:()=>maxActive};
}
function project(slot='editor',id='a'){
 if(slot==='video'){const p=V.demo();p.scenes=p.scenes.slice(0,2).map((s,i)=>({...s,id:'scene-'+i}));Object.assign(p.scenes[0],{visual:'image',imageId:id});return p;}
 const p=C.upgradeProject(C.createProject(true));p.scenes=p.scenes.slice(0,2);Object.assign(p.scenes[0],{visual:'image',imageId:id,durationMs:1234});p.timing='manual';return p;
}
function session(f,slot='editor',p=project(slot),options={}){return f.runtime.create({slot,project:p,plan:slot==='editor'?A.fromEditor(p):A.fromVideo(p),projectId:p.id||'video-owner',contentRevision:7,savedRevision:3,...options});}
async function started(f,event){for(let i=0;i<50&&!f.events.includes(event);i++)await delay();assert.ok(f.events.includes(event),f.events);}

test('immutable DTO/plan snapshots retain independent identity fields and never upgrade persisted legacy DTO',async()=>{
 const f=fixture(),p=C.createProject(true),before=JSON.stringify(p),plan=A.fromEditor(p),s=session(f,'editor',p,{plan});
 assert.equal(s.snapshot.version,1);assert.equal(JSON.stringify(p),before);assert.deepEqual(s.plan,plan);assert.notEqual(s.plan,plan);
 p.scenes[0].text='changed';plan.timeline[0].text='changed';assert.notEqual(s.snapshot.scenes[0].text,'changed');assert.notEqual(s.plan.timeline[0].text,'changed');
 assert.throws(()=>s.snapshot.style.theme='dusk',TypeError);assert.throws(()=>JSON.stringify(s),{code:'RUNTIME'});
 assert.equal(s.identity.contentRevision,7);assert.equal(s.identity.savedRevision,3);assert.equal(s.status().generation,0);
 assert.equal(s.status().dataBytes,Buffer.byteLength(JSON.stringify(s.snapshot))+Buffer.byteLength(JSON.stringify(s.plan)));
 await s.prepare();assert.equal(s.status().generation,1);assert.equal(s.status().renderable,true);assert.doesNotThrow(()=>P.assertRenderable(s.plan));await s.dispose();
});
test('wrong slot, stale plan, future DTO and runtime values cannot create a prepared session',()=>{
 const f=fixture(),p=project(),vp=project('video');
 assert.throws(()=>session(f,'editor',p,{plan:A.fromVideo(vp)}),{code:'PLAN_MISMATCH'});
 const plan=A.fromEditor(p);p.scenes[0].text+=' edit';assert.throws(()=>session(f,'editor',p,{plan}),{code:'PLAN_MISMATCH'});
 assert.throws(()=>session(f,'editor',p,{contentRevision:-1}),{code:'IDENTITY'});
 for(const runtime of [new Blob(['x']),new Map(),()=>{},new Date()]){const x=project(),plan=A.fromEditor(x);x.runtime=runtime;assert.throws(()=>f.runtime.create({slot:'editor',project:x,plan,projectId:x.id,contentRevision:1}),{code:'DATA'});}
 assert.throws(()=>session(f,'editor',{...p,version:999}),{code:'UNSUPPORTED'});
 const conflict=project(),validPlan=A.fromEditor(conflict);conflict.audio.voice.assetId=conflict.scenes[0].imageId;assert.throws(()=>f.runtime.create({slot:'editor',project:conflict,plan:validPlan,projectId:conflict.id,contentRevision:1}),{code:'PROJECT'});
 assert.equal(f.media.statistics().sessions,0,'invalid references never allocate a media owner');
});
test('duplicate scene image IDs decode once within a session; leases pin resources until the final return',async()=>{
 const f=fixture(),p=project();Object.assign(p.scenes[1],{visual:'image',imageId:'a'});const s=session(f,'editor',p);
 await s.prepare();assert.equal(f.events.filter(e=>e==='image:a').length,1);const a=s.acquire(),b=s.acquire();assert.equal(a.resources.images.get('a'),b.resources.images.get('a'));
 let closed=false;const ending=s.dispose().then(()=>{closed=true;});await delay();assert.equal(closed,false);assert.equal(s.status().state,'disposed');assert.equal(s.status().consumers,2);
 // A close request invalidates the controller immediately, but borrowed media live on.
 assert.throws(()=>s.acquire(),{code:'STATE'});a.release();assert.ok(!f.events.includes('dispose:a'));b.release();b.release();await ending;assert.equal(f.events.filter(e=>e==='dispose:a').length,1);assert.equal(f.media.statistics().residentBytes,0);
});
test('editor/video and repeated mode sessions do not share decoded objects or resolve by scene index',async()=>{
 const f=fixture(),a=session(f,'editor',project('editor','a')),b=session(f,'video',project('video','b'));
 await Promise.all([a.prepare(),b.prepare()]);const la=a.acquire(),lb=b.acquire();assert.equal(la.resources.images.get('a').id,'a');assert.equal(lb.resources.images.get('b').id,'b');assert.equal(lb.resources.images.has('a'),false);
 la.release();await a.dispose();assert.ok(!f.events.includes('dispose:b'));lb.release();await b.dispose();
 for(let i=0;i<4;i++){const s=session(f,i%2?'editor':'video');await s.prepare();await s.cancel();await s.dispose();}
 assert.equal(f.media.statistics().sessions,0);assert.equal(f.maxActive(),1);
});
test('inactive original references and thousands of animated scenes are retained as data but not decoded',async()=>{
 const f=fixture(),p=project();p.scenes=Array.from({length:5000},(_,i)=>({...p.scenes[0],id:'s-'+i,visual:'animated',imageId:'inactive-'+i,text:i?'слово':'слово '.repeat(60)}));p.selectedSceneId=p.scenes[0].id;
 const s=session(f,'editor',p);await s.prepare();assert.equal(s.snapshot.scenes.length,5000);assert.equal(s.status().neededMedia,0);assert.equal(f.events.length,0);await s.dispose();
});
test('missing, wrong-category and corrupt image/audio errors are distinct and never leave a ready subset',async()=>{
 for(const kind of ['missing','type','image','audio']){
  const f=fixture(),p=project();p.audio.voice.assetId='voice';
  if(kind==='missing')f.assets.delete('a');if(kind==='type')f.assets.get('a').kind='voice';if(kind==='image')f.gates.imageError=true;if(kind==='audio')f.gates.audioError=true;
  const s=session(f,'editor',p);await assert.rejects(s.prepare(),{code:{missing:'MISSING_ORIGINAL',type:'MEDIA_TYPE',image:'IMAGE_DECODE',audio:'AUDIO_DECODE'}[kind]});
  assert.equal(s.status().state,'error');assert.throws(()=>s.acquire(),{code:'STATE'});await s.dispose();assert.equal(f.media.statistics().residentBytes,0);if(kind==='audio')assert.ok(f.events.includes('dispose:a'));
 }
 const f=fixture(),p=project();f.assets.get('a').blob=new Blob(['not image'],{type:'image/png'});await assert.rejects(session(f,'editor',p).prepare(),{code:'IMAGE_HEADER'});
 const audio=fixture(),withMissingAudio=project();withMissingAudio.audio.voice.assetId='absent';const s=session(audio,'editor',withMissingAudio);await assert.rejects(s.prepare(),{code:'MISSING_ORIGINAL',assetId:'absent'});await s.dispose();assert.equal(audio.media.statistics().residentBytes,0);assert.ok(audio.events.includes('dispose:a'));
});
test('cancellation during an original read returns promptly and never starts a late decoder',async()=>{
 const f=fixture();f.gates.read=deferred();const s=session(f),preparing=s.prepare();await started(f,'read:a');const ending=s.cancel();await assert.rejects(preparing,{code:'CANCELLED'});assert.equal(f.media.statistics().sessions,1,'uncancellable native reads retain their admission slot');f.gates.read.resolve();await ending;assert.equal(f.events.includes('image:a'),false);assert.equal(s.status().state,'cancelled');
});
test('late image decode after replacement is disposed once and cannot reappear in the new session',async()=>{
 const f=fixture();f.gates.image=deferred();const old=session(f),preparing=old.prepare();await started(f,'image:a');const closing=old.cancel();await assert.rejects(preparing,{code:'CANCELLED'});
 const gate=f.gates.image;delete f.gates.image;const next=session(f,'video',project('video','b')),ready=next.prepare();await delay();assert.equal(f.events.includes('image:b'),false,'global scheduler retains the real in-flight decoder');
 gate.resolve();await closing;await ready;assert.equal(old.status().state,'cancelled');assert.equal(f.events.filter(e=>e==='dispose:a').length,1);const lease=next.acquire();assert.equal(lease.resources.images.get('b').id,'b');lease.release();await next.dispose();assert.equal(f.maxActive(),1);
});
test('late audio and queued decoders are cancelled without starting more contexts or publishing buffers',async()=>{
 const f=fixture(),p=project();p.scenes[0].visual='animated';p.audio.voice.assetId='voice';f.gates.audio=deferred();
 const s=session(f,'editor',p),prep=s.prepare();await started(f,'audio');const end=s.cancel();await assert.rejects(prep,{code:'CANCELLED'});
 const next=session(f,'video',project('video','b')),queued=next.prepare();await delay();await next.cancel();await assert.rejects(queued,{code:'CANCELLED'});assert.equal(f.events.includes('image:b'),false);
 f.gates.audio.resolve();await end;await s.cancel();await s.dispose();assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().sessions,0);
});
test('working-set, header, decoded audio and global lifetime budgets fail honestly and release reservations',async()=>{
 for(const limits of [{maxImages:0},{maxImagePixels:1},{maxOriginalBytes:1},{maxDecodedBytes:1}]){const f=fixture(),s=session(f,'editor',project(),{limits});await assert.rejects(s.prepare(),e=>['IMAGE_COUNT','IMAGE_BUDGET','MEMORY_BUDGET'].includes(e.code));await s.dispose();assert.equal(f.media.statistics().residentBytes,0);}
 const f=fixture(),p=project();p.scenes[0].visual='animated';p.audio.voice.assetId='voice';f.gates.audioLength=1024;
 const s=session(f,'editor',p,{limits:{maxAudioBytes:32}});await assert.rejects(s.prepare(),{code:'DECODED_BUDGET'});await s.dispose();assert.equal(f.media.statistics().residentBytes,0);
 const pool=mediaFactory(f.io,{maxSessions:1,maxResidentBytes:16});const first=pool.create({owner:{slot:'editor',projectId:'x'}});assert.throws(()=>pool.create({owner:{slot:'video',projectId:'y'}}),{code:'SESSION_LIMIT'});await assert.rejects(first.prepare([{id:'a',kind:'image'}]),{code:'MEMORY_BUDGET'});await first.dispose();assert.equal(pool.statistics().residentBytes,0);
});
test('voice/music share one prepared original without changing gains, fades or starting sound',async()=>{
 const f=fixture(),p=project();p.audio.voice.assetId=p.audio.music.assetId='voice';p.audio.voice.volume=.91;p.audio.music.volume=.13;p.audio.music.fadeInMs=1234;
 const s=session(f,'editor',p);await s.prepare();assert.equal(f.events.filter(e=>e==='audio').length,1);const lease=s.acquire();assert.equal(lease.audio('voice'),lease.audio('voice'));assert.equal(s.plan.audio.music.fadeInSeconds,1.234);assert.equal(s.plan.audio.music.loop,false);lease.release();await s.dispose();
});
test('test consumer receives the exact video plan/resources; editor render refusal is preserved',async()=>{
 const f=fixture(),p=project('video'),expected=A.fromVideo(p),s=session(f,'video',p);await s.prepare();const frame=s.renderFrame({},0);assert.equal(frame.id,'a');const result=await s.record({canvas:{}});assert.deepEqual(result.plan,expected);await s.dispose();assert.equal(f.events.filter(e=>e==='record').length,1);
 const e=session(f);await e.prepare();assert.doesNotThrow(()=>P.assertRenderable(e.plan));assert.throws(()=>P.assertRenderable({...e.plan,appearance:{...e.plan.appearance,supported:false}}),{code:'APPEARANCE'});await e.dispose();
});
test('an active recording pins resources through actual asynchronous abort cleanup',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();let resource;
 const runtime=renderFactory({adapters:A,plan:P,media:f.media,record:async o=>{resource=o.resources.images.get('a');entered.resolve();await gate.promise;if(o.signal.aborted)throw Object.assign(Error('cancel'),{code:'CANCELLED'});}});
 const p=project('video'),s=runtime.create({slot:'video',projectId:'owner',contentRevision:1,project:p,plan:A.fromVideo(p)});await s.prepare();const recording=s.record({canvas:{}});await entered.promise;let ended=false;const ending=s.cancel().then(()=>{ended=true;});await delay();assert.equal(ended,false);assert.equal(resource.id,'a');assert.ok(!f.events.includes('dispose:a'));gate.resolve();await assert.rejects(recording,{code:'CANCELLED'});await ending;assert.equal(f.events.filter(e=>e==='dispose:a').length,1);
});
test('owned playback uses the shared mixer, never autoplay, and closes context before returning its lease',async()=>{
 const f=fixture(),closed=deferred();let contexts=0,mixes=0,stops=0,options;
 const runtime=renderFactory({adapters:A,plan:P,media:f.media,context:()=>{contexts++;return{state:'running',currentTime:0,destination:{},resume:async()=>{},async close(){await closed.promise;contexts--;this.state='closed';}};},mix:(_c,o)=>{options=o;mixes++;return{start(){},stop(){stops++;}};}});
 const p=project();p.audio.voice.assetId='voice';p.audio.music.assetId='music';const s=runtime.create({slot:'editor',projectId:p.id,contentRevision:1,project:p,plan:A.fromEditor(p)});
 await s.prepare();assert.equal(contexts,0);const playback=await s.playAudio({offsetSeconds:.2});assert.equal(contexts,1);assert.equal(mixes,1);assert.deepEqual({voiceVolume:options.voiceVolume,musicVolume:options.musicVolume,fadeIn:options.fadeIn,fadeOut:options.fadeOut,durationSeconds:options.durationSeconds},P.audioOptions(s.plan));
 await assert.rejects(s.playAudio(),{code:'BUSY'});let ended=false;const end=s.dispose().then(()=>{ended=true;});await delay();assert.equal(stops,1);assert.equal(ended,false);assert.ok(!f.events.includes('dispose:a'));closed.resolve();await end;await playback.stop();assert.equal(contexts,0);assert.ok(f.events.includes('dispose:a'));
});
test('global resident budget preserves the first session when another session cannot fit',async()=>{
 const f=fixture(),pool=mediaFactory(f.io,{maxResidentBytes:png.length+width*height*4});
 const a=pool.create({owner:{slot:'editor',projectId:'a'}}),b=pool.create({owner:{slot:'video',projectId:'b'}});
 await a.prepare([{id:'a',kind:'image'}]);const lease=a.acquire();await assert.rejects(b.prepare([{id:'b',kind:'image'}]),{code:'MEMORY_BUDGET'});assert.equal(lease.resources.images.get('a').id,'a');assert.ok(!f.events.includes('dispose:a'));await b.dispose();lease.release();await a.dispose();assert.equal(pool.statistics().residentBytes,0);
});
test('uncancellable original reads remain bounded after rapid cancellation of every session',async()=>{
 const f=fixture();f.gates.read=deferred();const sessions=Array.from({length:8},(_,i)=>f.media.create({owner:{slot:i%2?'editor':'video',projectId:'p'+i}}));
 const preparing=sessions.map(s=>s.prepare([{id:'a',kind:'image'}]));const failures=preparing.map(p=>assert.rejects(p,{code:'CANCELLED'}));await delay();const ends=sessions.map(s=>s.cancel());await Promise.all(failures);assert.equal(f.media.statistics().sessions,8);assert.throws(()=>f.media.create({owner:{slot:'video',projectId:'new'}}),{code:'SESSION_LIMIT'});f.gates.read.resolve();await Promise.all(ends);assert.equal(f.media.statistics().sessions,0);assert.equal(f.events.filter(e=>e.startsWith('image:')).length,0);
});
test('data budgets, external abort signals and temporary URL IDs cannot activate a session',async()=>{
 const f=fixture(),p=project(),plan=A.fromEditor(p);p.script='x'.repeat(16*1048576+1);assert.throws(()=>f.runtime.create({slot:'editor',projectId:p.id,contentRevision:0,project:p,plan}),{code:'DATA_BUDGET'});assert.equal(f.media.statistics().sessions,0);
 const s=f.media.create({owner:{slot:'editor',projectId:'x'}});await assert.rejects(s.prepare([{id:'blob:temporary',kind:'image'}]),{code:'REFERENCES'});await s.dispose();
 const controller=new AbortController(),next=session(f,'video',project('video'),{signal:controller.signal});await next.prepare();const lease=next.acquire();controller.abort();assert.equal(next.status().state,'cancelled');assert.equal(lease.resources.images.get('a').id,'a');assert.throws(()=>JSON.stringify(lease.resources),{code:'RUNTIME'});lease.release();await next.dispose();assert.equal(f.media.statistics().sessions,0);
});
test('failed native context closure reports an error and retains media until a successful retry',async()=>{
 const f=fixture();let fail=true;
 const runtime=renderFactory({adapters:A,plan:P,media:f.media,context:()=>({state:'running',currentTime:0,destination:{},resume:async()=>{},async close(){if(fail)throw Error('native close failed');this.state='closed';}}),mix:()=>({start(){},stop(){}})});
 const p=project();p.audio.voice.assetId='voice';const s=runtime.create({slot:'editor',projectId:p.id,contentRevision:1,project:p,plan:A.fromEditor(p)});await s.prepare();await s.playAudio();await assert.rejects(s.cancel(),{code:'AUDIO_CLOSE'});assert.equal(s.status().error.code,'AUDIO_CLOSE');assert.equal(s.status().cleanupPending,true);assert.equal(s.status().consumers,1);assert.ok(!f.events.includes('dispose:a'));fail=false;await s.dispose();assert.equal(s.status().consumers,0);assert.ok(f.events.includes('dispose:a'));assert.equal(f.media.statistics().residentBytes,0);
});
test('existing runtime/UI/storage sources and Safari guard retain the frozen main implementation',()=>{
 const {createHash}=require('node:crypto'),checkpoint=require('./fixtures/runtime/before.json'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(checkpoint.commit,'8042586d1c5c65a4a89eedd61052a37ca14b4868');
 const approved=new Set(['js/app.js','js/render-plan.js','js/render-adapters.js','js/video-renderer.js','tests/render_guard.py','tests/safari-baseline-test.py']);
 for(const [name,expected] of Object.entries(checkpoint.files))if(!approved.has(name))assert.equal(hash(fs.readFileSync(name)),expected,name);
 require('node:child_process').execFileSync('python',['tests/render_guard.py']);
 for(const name of ['render-plan.js','render-adapters.js'])assert.equal(hash(fs.readFileSync('tests/fixtures/editor-canvas/before/'+name)),checkpoint.files['js/'+name],name+' frozen before Editor Canvas');
 assert.equal(hash(fs.readFileSync('tests/fixtures/editor-canvas/before/render_guard.py')),checkpoint.files['tests/render_guard.py']);
 const oldAdapter=fs.readFileSync('tests/fixtures/editor-canvas/before/render-adapters.js','utf8'),adapter=fs.readFileSync('js/render-adapters.js','utf8');
 const videoPart=source=>source.slice(source.indexOf('  function fromVideo('),source.indexOf('  function fromEditor('));assert.equal(videoPart(adapter),videoPart(oldAdapter),'Video adapter body remains exact');
 for(const [name,{sha256,remove}] of Object.entries(checkpoint.bridges)){
  let source=fs.readFileSync(name,'utf8');if(name==='index.html')for(const bridge of require('./fixtures/editor-live/ui-bridges.json')){assert.equal(source.split(bridge.new).length,2,'exact live Canvas Editor-only bridge');source=source.replace(bridge.new,bridge.old);}if(name==='index.html')for(const bridge of require('./fixtures/editor-timing/ui-bridges.json')){assert.equal(source.split(bridge.new).length,2,'exact Editor UI bridge');source=source.replace(bridge.new,bridge.old);}if(name==='tests/safari-product.py')for(const bridge of ["            print(\"::notice title=Native preview geometry::\"+json.dumps(script(\"return uxPreviewSummary();\")),flush=True)\n",'from editor_canvas_native import check_native_editor_canvas\n','            check_native_editor_canvas(ROOT,script,command,click)\n']){assert.equal(source.split(bridge).length,2);source=source.replace(bridge,'');}if(name==='index.html')for(const file of ['editor-profile','editor-canvas'])source=source.replace('  <script src="js/'+file+'.js" defer></script>\n','');for(const text of remove){assert.equal(source.split(text).length,2,name+' exact additive bridge');source=source.replace(text,'');}assert.equal(hash(source),sha256,name);
 }
});
