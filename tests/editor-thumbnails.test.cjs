'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const imagesFactory=require('../js/editor-images.js'),mediaFactory=require('../js/media-session.js');
const pngBytes=fs.readFileSync('tests/fixtures/backup-media/red.png'),width=pngBytes.readUInt32BE(16),height=pngBytes.readUInt32BE(20);
const png=new Blob([pngBytes],{type:'image/png'});
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('thumbnail condition timed out');}
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function setup(){
 const originals=new Map([['one',{blob:png,kind:'image'}],['two',{blob:png,kind:'image'}]]),reads=[],disposed=[],urls=new Map(),revoked=[],draws=[];let observe,decodeGate,blobGate;
 const media=mediaFactory({original:async id=>{reads.push(id);return originals.get(id);},image:async blob=>{if(decodeGate)await decodeGate.promise;return{width,height,image:{width,height},dispose(){disposed.push(blob);}};}});
 const controller=imagesFactory({media,observer:fn=>{observe=fn;return{observe(){},unobserve(){},disconnect(){}};},canvas:()=>({width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args)}),toBlob:async cb=>{if(blobGate)await blobGate.promise;cb(new Blob(['small thumbnail'],{type:'image/png'}));}}),urls:{createObjectURL:blob=>{const url='blob:'+urls.size;urls.set(url,blob);return url;},revokeObjectURL:url=>revoked.push(url)}}).createThumbnails();
 function card(projectId='project',assetId='one',index=0){const target={},image={hidden:true,removeAttribute(){delete this.src;}},message={textContent:''},data={projectId,assetId,name:assetId+'.png',index};controller.track(target,image,message,data);return{target,image,message,data};}
 const visible=(card,value=true)=>observe([{target:card.target,isIntersecting:value}]);
 return{controller,media,originals,reads,disposed,urls,revoked,draws,card,visible,decode:g=>decodeGate=g,blob:g=>blobGate=g};
}
test('thumbnails resolve only visible originals through the bounded media owner; release full decode and keep originals untouched',async()=>{
 const f=setup(),card=f.card();await tick();assert.deepEqual(f.reads,[]);f.visible(card);
 await until(()=>f.controller.status().ready===1&&!f.controller.status().preparing);card.image.onload();assert.equal(card.image.hidden,false);assert.equal(card.image.alt,'Изображение сцены 1 — one.png');assert.equal(f.disposed.length,1);assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.media.statistics().sessions,0);assert.ok(f.draws[0][3]>=116);assert.ok(f.draws[0][4]>=144);
 assert.equal(f.urls.get(card.image.src).type,'image/png');assert.equal(await f.originals.get('one').blob.text(),await png.text());f.controller.remove(card.target);assert.equal(card.image.hidden,true);assert.equal(card.image.src,undefined);assert.equal(f.revoked.length,1);
});
test('replacement, removal, reordered labels and same scene/source IDs in another project cannot apply a stale result',async()=>{
 const f=setup(),g=gate(),card=f.card();f.decode(g);f.visible(card);await until(()=>f.reads.length===1);
 card.data={...card.data,projectId:'different-project',assetId:'two',index:3};f.controller.track(card.target,card.image,card.message,card.data);g.resolve();await until(()=>f.controller.status().ready===1&&!f.controller.status().preparing);card.image.onload();assert.deepEqual(f.reads,['one','two']);assert.equal(card.image.alt,'Изображение сцены 4 — one.png');assert.equal(f.urls.size,1);assert.equal(f.disposed.length,2);
 f.controller.track(card.target,card.image,card.message,{...card.data,assetId:null});assert.equal(card.image.src,undefined);assert.equal(f.controller.status().tracked,0);assert.equal(f.media.statistics().sessions,0);
});
test('an offscreen or cancelled toBlob result never attaches; repeated cleanup is safe',async()=>{
 const f=setup(),card=f.card(),g=gate();f.blob(g);f.visible(card);await until(()=>f.draws.length===1);f.visible(card,false);f.controller.suspend();g.resolve();await until(()=>!f.controller.status().preparing);assert.equal(f.urls.size,0);assert.equal(card.image.src,undefined);assert.equal(f.media.statistics().residentBytes,0);f.controller.dispose();f.controller.dispose();assert.equal(f.media.statistics().sessions,0);
});
test('missing originals and invalid image content have visible diagnostics without staging or removing anything',async()=>{
 for(const assetId of ['missing','bad']){
  const f=setup();f.originals.set('bad',{blob:new Blob(['not an image'],{type:'image/png'}),kind:'image'});const card=f.card('project',assetId);f.visible(card);await until(()=>!f.controller.status().preparing&&card.message.textContent);assert.match(card.message.textContent,/Миниатюра недоступна/);assert.equal(card.image.src,undefined);assert.equal(f.media.statistics().residentBytes,0);assert.equal(f.originals.size,3);f.controller.dispose();
 }
});
test('5000 cards do not eagerly read originals; at most eight small thumbnails and one temporary decode, mode exit releases all',async()=>{
 const f=setup(),cards=Array.from({length:5000},(_,i)=>f.card('large','one',i));await tick();assert.equal(f.reads.length,0);
 for(const card of cards.slice(0,20))f.visible(card);await until(()=>f.controller.status().ready===8&&!f.controller.status().preparing);assert.equal(f.reads.length,8);assert.equal(f.media.statistics().sessions,0);
 f.visible(cards[0],false);await until(()=>f.reads.length===9&&!f.controller.status().preparing);assert.equal(f.controller.status().ready,8);f.controller.suspend();assert.equal(f.controller.status().ready,0);assert.equal(f.revoked.length,9);assert.equal(f.media.statistics().residentBytes,0);
 f.controller.resume();await until(()=>f.controller.status().ready===8&&!f.controller.status().preparing);f.controller.dispose();assert.equal(f.media.statistics().sessions,0);assert.equal(f.revoked.length,17);
});

test('display errors revoke the small URL and keep the original for editing and ZIP',async()=>{
 const f=setup(),card=f.card();f.visible(card);await until(()=>f.controller.status().ready===1&&!f.controller.status().preparing);card.image.onerror();assert.equal(card.image.hidden,true);assert.equal(card.image.src,undefined);assert.equal(f.revoked.length,1);assert.equal(f.controller.status().ready,0);assert.match(card.message.textContent,/Оригинал не изменён/);assert.ok(f.originals.has('one'));f.controller.dispose();assert.equal(f.media.statistics().residentBytes,0);
});
