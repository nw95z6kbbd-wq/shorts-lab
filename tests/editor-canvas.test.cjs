'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../js/core.js'),P=require('../js/render-plan.js'),A=require('../js/render-adapters.js'),E=require('../js/editor-profile.js');
const ctx={font:'',measureText(text){const size=Number(/ ([\d.]+)px/.exec(this.font)?.[1]||60);const width=[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].length*size*.55;return{width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width,actualBoundingBoxAscent:size/2,actualBoundingBoxDescent:size/2};}};
function project(text='Своё видео\nПрямо сейчас'){const p=C.upgradeProject(C.createProject(false));p.scenes=[{id:'stable',text,durationMs:2000,visual:'animated',imageId:null,imageName:'',camera:'static',transition:'none'}];p.timing='manual';p.selectedSceneId='stable';return p;}
test('all 27 real Editor styles resolve independently; legacy missing settings are safe, unknown fields never default silently',()=>{
 let count=0;for(const theme of E.THEMES)for(const caption of E.CAPTIONS)for(const size of E.SIZES){const p=project();p.style={theme,caption,size};const before=JSON.stringify(p),plan=A.fromEditor(p);P.assertRenderable(plan);assert.equal(plan.appearance.resolved.renderer,'editor-canvas-v1');assert.equal(plan.theme,theme);assert.equal(plan.caption,caption);assert.equal(JSON.stringify(p),before);count++;}assert.equal(count,27);
 for(const bad of [{theme:'space'},{caption:'unknown'},{size:'giant'},{css:'color:red'}]){const p=project();Object.assign(p.style,bad);assert.throws(()=>A.fromEditor(p),{code:'STYLE_UNSUPPORTED'});}
 for(const bad of [null,1,{theme:23}]){const p=project();p.style=bad;assert.throws(()=>A.fromEditor(p),{code:'SETTINGS'});}
 const p=C.createProject(true);delete p.style;assert.doesNotThrow(()=>P.assertRenderable(A.fromEditor(p)));assert.equal(p.style,undefined);
});
test('profile rejects forged resolved/unknown significant settings and mixed namespaces',()=>{
 const p=A.fromEditor(project());for(const change of [{resolved:{...p.appearance.resolved,theme:'space'}},{resolved:{...p.appearance.resolved,blur:2}},{requested:{...p.appearance.requested,unknown:1}},{unknown:true}])assert.throws(()=>P.assertRenderable({...p,appearance:{...p.appearance,...change}}));
 assert.throws(()=>P.assertRenderable({...p,source:{mode:'alien'}}),{code:'SETTINGS'});assert.throws(()=>P.assertRenderable({...p,theme:'space'}),{code:'SETTINGS'});
});
test('known geometry and nominal sizes; explicit newlines and last two words only in accent',()=>{
 const expected={small:50,medium:62.5,large:75};
 for(const size of E.SIZES)for(const caption of E.CAPTIONS){const s={theme:'cosmos',caption,size},r=E.layout(ctx,'Своё видео\nПрямо сейчас',s);assert.equal(r.font,size==='medium'&&caption==='classic'?57.5:expected[size]);assert.equal(r.lines.length,2);assert.deepEqual(r.area,{x:42.5,y:512,width:635,height:576});assert.equal(r.lines[0].y,512+r.typography.padTop+r.font*1.3*.5);assert.ok(r.lines[1].y<1088);assert.deepEqual(r.lines.flatMap(l=>l.runs).map(x=>x.accent),caption==='accent'?[false,false,true,true]:[false,false,false,false]);}
});
test('grapheme-safe long word wrapping retains Unicode/emoji without truncation or accidental spaces',()=>{
 const s={theme:'minimal',caption:'accent',size:'large'};
 for(const text of ['Привет Latin 世界 👨‍👩‍👧‍👦 é 👍🏽','Сверхдлинноесловобезпробелов'.repeat(2),'👨‍👩‍👧‍👦'.repeat(18),'مرحبا мир hello']){
  const r=E.layout(ctx,text,s);assert.equal(r.lines.flatMap(l=>l.runs).map(x=>x.text).join(''),text.replace(/\s/gu,''));
  const allowed=new Set([...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].map(x=>x.segment));
  for(const run of r.lines.flatMap(l=>l.runs))for(const x of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(run.text))assert.ok(allowed.has(x.segment));
 }
 const r=E.layout(ctx,'',s);assert.equal(r.lines[0].text,'');
});
test('bounded font reduction and overflow fail honestly, never switch scene subtitle policy',()=>{
 const p=project('текст '.repeat(400));const before=JSON.stringify(p),plan=A.fromEditor(p);assert.equal(plan.subtitles.policy,'editor-scene');assert.throws(()=>E.layout(ctx,plan.cues[0].text,p.style),{code:'TEXT_OVERFLOW'});assert.equal(JSON.stringify(p),before);
 assert.throws(()=>E.layout(ctx,'x\n'.repeat(100),p.style),{code:'TEXT_OVERFLOW'});
 let reduced=false;for(let n=15;n<90;n++){try{const r=E.layout(ctx,'слово '.repeat(n),p.style);if(r.font<E.typography(p.style).base){assert.ok(r.font>=E.typography(p.style).min);reduced=true;break;}}catch(e){assert.equal(e.code,'TEXT_OVERFLOW');}}assert.ok(reduced);
 p.subtitles.enabled=false;assert.equal(A.fromEditor(p).cues.length,0);
});
test('5000 scenes: logarithmic frame/cue access, constant bounded progress, stable boundaries and IDs',()=>{
 const p=project();p.scenes=Array.from({length:5000},(_,i)=>({...p.scenes[0],id:'s'+i,durationMs:17+i%3,text:'сцена '+i}));p.selectedSceneId='s0';const plan=A.fromEditor(p),before=JSON.stringify(plan);let reads=0;
 const timeline=new Proxy(plan.timeline,{get(a,k){if(/^\d+$/.test(String(k)))reads++;return a[k];}}),view={...plan,timeline};
 for(const index of [0,1,23,500,2499,4999])for(const t of [plan.timeline[index].startMs,plan.timeline[index].endMs-1]){reads=0;assert.equal(P.frameAt(view,t).scene.id,'s'+index);assert.ok(reads<=15,reads);const seg=E.segments(view,t);assert.equal(seg.length,24);assert.ok(seg.every(x=>x.width>0&&x.progress>=0&&x.progress<=1));assert.ok(reads<=63);}
 assert.equal(JSON.stringify(plan),before);const small=A.fromEditor(project());assert.equal(E.segments(small,0).length,1);
});

test('complete Video RenderPlans and frames remain identical to hash-verified pre-Editor modules',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),checkpoint=require('./fixtures/runtime/before.json');
 const load=(name,dependencies)=>{const source=fs.readFileSync('tests/fixtures/editor-canvas/before/'+name,'utf8');assert.equal(crypto.createHash('sha256').update(source).digest('hex'),checkpoint.files['js/'+name]);const box={module:{exports:{}},require:n=>dependencies[n]};vm.runInNewContext(source,box);return box.module.exports;};
 const oldP=load('render-plan.js',{'./core.js':C}),oldA=load('render-adapters.js',{'./core.js':C,'./render-plan.js':oldP});
 const V=require('../js/video-core.js'),plain=x=>JSON.parse(JSON.stringify(x));
 for(let n=0;n<100;n++){
  const draft=V.demo();draft.theme=['space','mystery','sunrise','neon'][n%4];draft.caption=['accent','classic','outline'][n%3];draft.timing=n%2?'manual':'auto';draft.scenes=draft.scenes.slice(0,1+n%6);draft.scenes.forEach((s,i)=>{s.durationSeconds=.5+i*.123;s.camera=['static','zoom-out','pan-left'][i%3];s.transition=['none','crossfade','slide','zoom'][i%4];});
  const before=plain(oldA.fromVideo(draft)),after=A.fromVideo(draft);assert.deepEqual(after,before);
  for(const time of [-1,0,1,...after.timeline.flatMap(s=>[s.startMs,s.endMs-1,s.endMs]),after.durationMs+1])assert.deepEqual(P.frameAt(after,time),plain(oldP.frameAt(before,time)));
 }
});

test('Unicode ink bounds cannot escape the text area even when logical width fits',()=>{
 const tall={font:'',measureText(text){const m=ctx.measureText.call(this,text);return {...m,actualBoundingBoxAscent:text.includes('́')?2000:m.actualBoundingBoxAscent};}};
 assert.throws(()=>E.layout(tall,'á',{theme:'cosmos',caption:'accent',size:'medium'}),{code:'TEXT_OVERFLOW'});
 const noMetrics={font:'',measureText:()=>({width:10})};assert.throws(()=>E.layout(noMetrics,'text',{theme:'cosmos',caption:'accent',size:'medium'}),{code:'RESOURCES'});
});
