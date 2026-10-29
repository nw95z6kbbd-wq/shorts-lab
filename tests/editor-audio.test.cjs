'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../js/core.js'),A=require('../js/render-adapters.js'),P=require('../js/render-plan.js');
const audioFactory=require('../js/editor-audio.js'),mediaFactory=require('../js/media-session.js'),runtimeFactory=require('../js/render-session.js');
const tick=()=>new Promise(r=>setTimeout(r,0));
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(){
 const originals=new Map(),contexts=[],mixes=[];let decodeGate,closeFailure=false;
 const media=mediaFactory({original:async id=>originals.get(id),image:()=>{throw Error('audio-only session decoded image');},audio:async blob=>{if(decodeGate)await decodeGate.promise;if(await blob.text()==='broken')throw Error('bad audio');return {length:100,numberOfChannels:1,duration:1};}});
 const runtime=runtimeFactory({media,adapters:A,plan:P,context:()=>{const context={state:'suspended',currentTime:0,destination:{},async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){if(closeFailure)throw Error('close rejected');this.state='closed';}};contexts.push(context);return context;},mix:(ctx,options)=>{const mix={options,start:t=>mix.when=t,stop:()=>mix.stopped=true};mixes.push(mix);return mix;}});
 const p=C.upgradeProject(C.createProject(true));p.timing='manual';p.scenes=p.scenes.slice(0,3);p.scenes.forEach((s,i)=>{s.durationMs=1000;s.imageId='do-not-read-image-'+i;});p.audio.voice.assetId='voice';p.audio.music.assetId='music';
 originals.set('voice',{id:'voice',kind:'voice',blob:new Blob(['wave'],{type:'audio/wav'})});originals.set('music',{id:'music',kind:'music',blob:new Blob(['wave2'],{type:'audio/wav'})});
 return {media,runtime,p,contexts,mixes,originals,setGate:g=>decodeGate=g,setCloseFailure:v=>closeFailure=v};
}
test('audio edits use DTO2 validators, leave legacy reads alone, and preserve every scene/media field',()=>{
 const api=audioFactory({core:C}),old=C.createProject(true),before=structuredClone(old),next=api.edit(old,'music',{assetId:'original',name:'music.wav',volume:.35,fadeInMs:1234,fadeOutMs:0});
 assert.deepEqual(old,before);assert.equal(old.version,1);assert.equal(next.version,2);assert.deepEqual(next.scenes.map(s=>({id:s.id,text:s.text})),old.scenes);assert.equal(next.audio.music.fadeInMs,1234);
 for(const patch of [{volume:NaN},{volume:-1},{volume:1.1},{fadeInMs:-1},{fadeOutMs:Infinity},{extra:1}])assert.throws(()=>api.edit(next,'music',patch));
 for(const [raw,ms] of [['0',0],['1,234',1234],['.001',1],['9007199254740.991',Number.MAX_SAFE_INTEGER]])assert.equal(api.fadeMs(raw),ms);
 for(const raw of ['','-1','NaN','Infinity','1.0001','9007199254740.992'])assert.throws(()=>api.fadeMs(raw));
});
test('audio-only runtime uses both tracks without reading scene images; leases and JSON boundaries remain strict',async()=>{
 const f=fixture(),s=f.runtime.createAudio({slot:'editor',project:f.p,plan:A.fromEditor(f.p),contentRevision:7});await s.prepare();assert.equal(s.status().neededMedia,2);
 assert.throws(()=>s.renderFrame({},0),{code:'AUDIO_ONLY'});await assert.rejects(s.record({}),{code:'PREVIEW_ONLY'});
 const handle=await s.playAudio();assert.throws(()=>JSON.stringify(handle),{code:'RUNTIME'});assert.equal(f.contexts.length,1);
 const closing=s.dispose();await closing;assert.equal(f.contexts[0].state,'closed');assert.equal(f.media.statistics().sessions,0);
});
test('one media clock survives startup lag, pause/resume and absolute seek without restarting at zero',async()=>{
 const f=fixture(),s=f.runtime.createAudio({slot:'editor',project:f.p,plan:A.fromEditor(f.p),contentRevision:1});await s.prepare();const h=await s.playAudio({offsetSeconds:.5}),ctx=f.contexts[0];
 assert.equal(h.positionMs(),500);ctx.currentTime=.32;assert.ok(Math.abs(h.positionMs()-800)<.001);
 await h.pause();ctx.currentTime=2;assert.ok(Math.abs(h.positionMs()-800)<.001);await h.resume();assert.equal(f.mixes.at(-1).options.offsetSeconds,.8);
 ctx.currentTime=2.22;assert.ok(Math.abs(h.positionMs()-1000)<.001);await h.seek(2300);assert.equal(h.positionMs(),2300);assert.equal(f.mixes.at(-1).options.offsetSeconds,2.3);
 await h.pause();await h.seek(200);assert.equal(h.positionMs(),200);await h.resume();assert.equal(f.mixes.at(-1).options.offsetSeconds,.2);
 ctx.currentTime=20;assert.equal(h.positionMs(),3000);ctx.state='interrupted';assert.throws(()=>h.positionMs(),{code:'AUDIO_CLOCK'});
 await h.stop();await h.stop();await s.dispose();assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.contexts.length,1);assert.ok(f.mixes.every(m=>m.stopped));
});
test('failed context close holds the lease until confirmed retry, preventing resource reuse',async()=>{
 const f=fixture(),s=f.runtime.createAudio({slot:'editor',project:f.p,plan:A.fromEditor(f.p),contentRevision:1});await s.prepare();await s.playAudio();f.setCloseFailure(true);await assert.rejects(s.dispose(),{code:'AUDIO_CLOSE'});assert.equal(s.status().ownedConsumers,1);assert.ok(f.media.statistics().residentBytes>0);f.setCloseFailure(false);await s.dispose();assert.equal(f.media.statistics().residentBytes,0);
});
test('cancelled real async preparation cannot install a stale audio owner; mode cleanup frees originals',async()=>{
 const f=fixture(),g=gate();f.setGate(g);const api=audioFactory({core:C,runtime:f.runtime}),states=[],p=api.createPlayback({onState:s=>states.push(s)});
 const old=p.update(f.p,A.fromEditor(f.p),1);await tick();const changed=structuredClone(f.p);changed.audio.voice.assetId='music';const next=p.update(changed,A.fromEditor(changed),2);g.resolve();f.setGate(null);await old;await next;assert.equal(p.status().ready,true);assert.equal(f.media.statistics().sessions,1);
 await p.start(1200);assert.equal(f.mixes.at(-1).options.offsetSeconds,1.2);await p.pause();await p.start(400);assert.equal(f.contexts.length,1);assert.equal(f.mixes.at(-1).options.offsetSeconds,.4);
 await p.close();await p.close();assert.equal(f.media.statistics().sessions,0);assert.equal(f.media.statistics().residentBytes,0);assert.ok(f.contexts.every(c=>c.state==='closed'));
});
test('uploads retain the previous accepted DTO on bad MIME, bytes, size, stale decode and cancellation',async()=>{
 const f=fixture(),storage={stage:(id,blob,name,kind)=>f.originals.set(id,{id,blob,name,kind}),discard:id=>f.originals.delete(id),pending:id=>f.originals.has(id)},api=audioFactory({core:C,media:f.media,storage});let accepted=[],states=[];
 const uploads=api.createUploads({owner:()=>f.p.id,valid:()=>true,accept:(r,p)=>{accepted.push({r,p});return true;},onState:(r,s,e)=>states.push({r,s,e})});
 const file=(bytes,type='audio/wav')=>Object.assign(new Blob([bytes],{type}),{name:'original.wav'});
 assert.equal(await uploads.load('voice',file('valid')),true);const saved=accepted[0].p.assetId;assert.equal(await f.originals.get(saved).blob.text(),'valid');
 for(const b of [file('broken'),file('valid','image/png'),file(''),Object.assign({size:25*1048576+1},{name:'huge.wav',type:'audio/wav'}),file('RIFFxxxxWAVEdata','audio/mpeg')]){assert.equal(await uploads.load('voice',b),false);assert.equal(accepted.length,1);assert.ok(f.originals.has(saved));assert.equal(states.at(-1).s,'error');}
 const g=gate();f.setGate(g);const stale=uploads.load('voice',file('slow'));await tick();const fresh=uploads.load('voice',file('latest'));g.resolve();f.setGate(null);assert.equal(await stale,false);assert.equal(await fresh,true);assert.equal(accepted.length,2);assert.deepEqual(accepted.map(a=>a.r),['voice','voice']);
 await uploads.dispose();assert.equal(f.media.statistics().sessions,0);assert.ok(f.originals.has(saved));
});
test('different roles can be selected together without cancelling each other',async()=>{
 const f=fixture(),storage={stage:(id,blob,name,kind)=>f.originals.set(id,{id,blob,name,kind}),discard:id=>f.originals.delete(id),pending:id=>f.originals.has(id)},accepted=[];
 const uploads=audioFactory({core:C,media:f.media,storage}).createUploads({owner:()=>f.p.id,valid:()=>true,accept:(role,patch)=>{accepted.push({role,patch});return true;}});
 const file=name=>Object.assign(new Blob(['valid'],{type:'audio/wav'}),{name});assert.deepEqual(await Promise.all([uploads.load('voice',file('voice.wav')),uploads.load('music',file('music.wav'))]),[true,true]);assert.deepEqual(accepted.map(a=>a.role),['voice','music']);assert.notEqual(accepted[0].patch.assetId,accepted[1].patch.assetId);await uploads.dispose();assert.equal(f.media.statistics().sessions,0);
});
test('historical runtime proofs reverse only exact audio extensions and reject clock or scope mutations',()=>{
 const strip=require('./editor-audio-bridge.cjs'),current=fs.readFileSync('js/render-session.js','utf8');assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync('tests/fixtures/editor-audio/render-session-before.js')).digest('hex'),'7f1ab2f81b822b43b9b5ff131dbe226d1892c6177cd217db2e50b23ccd72081e');assert.equal(strip('js/render-session.js',current),fs.readFileSync('tests/fixtures/editor-audio/render-session-before.js','utf8'));
 for(const [a,b] of [['context.currentTime+.02','context.currentTime+.2'],['if(audioOnly)throw','if(!audioOnly)throw'],['mix?.stop();mix=null','mix=null']]){assert.ok(current.includes(a));assert.throws(()=>strip('js/render-session.js',current.replace(a,b)));}
});
test('oversized snapshot is an explicit preparation error, never an uncaught UI startup failure',async()=>{
 const problem=Object.assign(Error('JSON budget'),{code:'DATA_BUDGET'}),states=[],p=fixture().p;
 const controller=audioFactory({runtime:{snapshotData(){throw problem;}}}).createPlayback({onState:(s,e)=>states.push({s,e})});
 await controller.update(p,A.fromEditor(p),1);assert.equal(states.at(-1).s,'error');assert.equal(states.at(-1).e,problem);assert.equal(controller.status().ready,false);await controller.close();
});
