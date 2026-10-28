/* Independent SVG acceptance reference + real Canvas data/geometry checks. */
window.checkEditorCanvas = async function(spec,template,payload){
 window.editorCanvasFailure=null;
 const C=ShortsCore,A=ShortsRenderAdapters,R=ShortsVideoRenderer,P=ShortsRenderPlan;
 const check=(v,m)=>{if(!v)throw Error('Editor Canvas: '+m);};
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;const ctx=canvas.getContext('2d',{alpha:false});
 const project=text=>{const p=C.upgradeProject(C.createProject(false));p.scenes=[{id:'edited-scene',text,durationMs:2000,visual:'animated',imageId:null,imageName:'',camera:'static',transition:'none'}];p.timing='manual';p.selectedSceneId='edited-scene';p.script='Never regenerate this original script';return p;};
 const pixels=()=>ctx.getImageData(0,0,720,1280).data;
 const imageFromBlob=async blob=>{const url=URL.createObjectURL(blob),image=new Image();try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});return image;}finally{URL.revokeObjectURL(url);}};
 const glyphMask=(data,x0=45,y0=515,w=630,h=430)=>{const bits=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((y+y0)*720+x+x0)*4,r=data[i],g=data[i+1],b=data[i+2];bits[y*w+x]=(r>235&&g>235&&b>235)||(r>175&&r<220&&g>140&&g<200&&b>235)?1:0;}return bits;};
 const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 for(const [selector,attribute,expected] of [['[data-theme]','theme',spec.themes],['[data-caption]','caption',spec.captions],['#captionSize option','value',spec.sizes]]){const actual=[...document.querySelectorAll(selector)].map(e=>attribute==='value'?e.value:e.dataset[attribute]).sort();check(JSON.stringify(actual)===JSON.stringify([...expected].sort()),'real UI values match all 27 canonical combinations');}
 await document.fonts.ready;const captures=[],summaries=[];
 for(const theme of spec.themes)for(const caption of spec.captions)for(const size of spec.sizes){
  if(spec.onlyCase&&[theme,caption,size].join('-')!==spec.onlyCase)continue;
  const p=project(spec.text);p.style={theme,caption,size};const before=JSON.stringify(p),plan=A.fromEditor(p),calls=[],arcs=[],ellipses=[],plates=[];
  const arc=ctx.arc,ellipse=ctx.ellipse,round=ctx.roundRect;ctx.arc=function(...args){arcs.push(args);return arc.apply(this,args);};ctx.ellipse=function(...args){ellipses.push(args);return ellipse.apply(this,args);};ctx.roundRect=function(...args){plates.push(args);return round.apply(this,args);};
  const fill=ctx.fillText;ctx.fillText=function(text,x,y,...args){if(this.textBaseline==='middle')calls.push({text,x,y,font:this.font,color:this.fillStyle});return fill.call(this,text,x,y,...args);};
  let result;try{result=R.render(canvas,plan,0);}finally{ctx.fillText=fill;ctx.arc=arc;ctx.ellipse=ellipse;ctx.roundRect=round;}
  check(before===JSON.stringify(p),'no DTO mutation');const font=size==='medium'&&caption==='classic'?spec.classicMedium:spec.fonts[size],y1=spec.textArea.y+spec.paddingTop[caption]+font*spec.lineHeight*.5,y2=y1+font*spec.lineHeight;
  check(result.layout.font===font,'nominal font '+[theme,caption,size]);check(result.layout.lines.length===2,'two explicit lines');
  check(calls.every(c=>c.font.startsWith(spec.weights[caption]+' ')&&c.font.includes(' '+font+'px ')),'native draw uses independently specified font');
  check(theme==='minimal'?arcs.length===0:arcs.some(a=>a.slice(0,3).every((v,i)=>Math.abs(v-spec.orb[i])<.001)),'orb geometry/theme isolation');
  if(theme!=='minimal')check(ellipses.some(a=>a[2]===spec.ring[0]&&a[3]===spec.ring[1])&&ellipses.some(a=>a[2]===spec.horizon[0]&&a[3]===spec.horizon[1]),'ring and horizon geometry');
  if(caption==='classic')check(plates.some(a=>a[0]===42.5&&a[1]===512&&a[2]===635&&Math.abs(a[3]-(2*font*1.3+55))<.001),'classic plate geometry');else check(!plates.length,'no accidental classic plate');
  check(calls.length===4&&calls.every((c,i)=>Math.abs(c.y-(i<2?y1:y2))<spec.geometryTolerancePx),'independent exact baseline geometry');
  check(calls.map(c=>c.text).join(' ')==='Своё видео Прямо сейчас','all text drawn, edited scenes used');
  check(calls.every((c,i)=>c.color===(caption==='accent'&&i>=2?'#c4a2ff':'#ffffff')),'caption palette');
  const actual=pixels(),vars={theme,font,textOpacity:1,decorOpacity:theme==='minimal'?0:1,weight:spec.weights[caption],y1,y2,color2:caption==='accent'?'#c4a2ff':'#ffffff',glowX:theme==='dusk'?504:468,glowColor:theme==='dusk'?'#efa368':'#6e4a9e',glowOpacity:theme==='minimal'?0:theme==='dusk'?96/255:102/255};
  const svg=template.replace(/\{\{(\w+)\}\}/g,(_,key)=>String(vars[key]));const ref=await imageFromBlob(new Blob([svg],{type:'image/svg+xml'})),rc=document.createElement('canvas');rc.width=720;rc.height=1280;const rx=rc.getContext('2d');rx.drawImage(ref,0,0);const expected=rx.getImageData(0,0,720,1280).data;
  const a=glyphMask(actual),b=glyphMask(expected);let best=0;
  // SVG/Canvas baseline rasterization can differ slightly; geometric draw
  // coordinates above have zero tolerance apart from floating point rounding.
  for(let dy=-3;dy<=3;dy++)for(let dx=-2;dx<=2;dx++){let union=0,intersection=0;for(let y=3;y<427;y++)for(let x=2;x<628;x++){const av=a[y*630+x],bv=b[(y+dy)*630+x+dx];union+=av|bv;intersection+=av&bv;}best=Math.max(best,intersection/union);}
  if(best<spec.glyphMaskMinimumIoU){
   const bounds=mask=>{let x0=630,y0=430,x1=-1,y1=-1,count=0;for(let y=0;y<430;y++)for(let x=0;x<630;x++)if(mask[y*630+x]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);count++;}return {x0:x0+45,y0:y0+515,x1:x1+45,y1:y1+515,count};};
   const maskPNG=(mask,other)=>{const c=document.createElement('canvas');c.width=630;c.height=430;const x=c.getContext('2d'),d=x.createImageData(630,430);for(let i=0;i<mask.length;i++){const j=i*4;if(other){d.data[j]=mask[i]?255:0;d.data[j+1]=other[i]?255:0;}else d.data[j]=d.data[j+1]=d.data[j+2]=mask[i]?255:0;d.data[j+3]=255;}x.putImageData(d,0,0);return c.toDataURL('image/png');};
   const referencePNG=rc.toDataURL('image/png'),variants={};for(const baseline of ['middle','central','alphabetic']){const textSVG=svg.replace(/<text /g,'<text dominant-baseline="'+baseline+'" '),im=await imageFromBlob(new Blob([textSVG],{type:'image/svg+xml'}));rx.clearRect(0,0,720,1280);rx.drawImage(im,0,0);const mask=glyphMask(rx.getImageData(0,0,720,1280).data);variants[baseline]=bounds(mask);}
   ctx.font=spec.weights[caption]+' '+font+'px Arial, sans-serif';ctx.textBaseline='middle';const m=ctx.measureText('Своё видео');
   window.editorCanvasFailure={case:[theme,caption,size],iou:best,userAgent:navigator.userAgent,dpr:devicePixelRatio,canvas:{width:canvas.width,height:canvas.height,cssWidth:canvas.getBoundingClientRect().width,font:ctx.font,baseline:ctx.textBaseline,metrics:Object.fromEntries(['width','actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent','fontBoundingBoxAscent','fontBoundingBoxDescent','emHeightAscent','emHeightDescent'].map(k=>[k,m[k]??null])),bounds:bounds(a)},svg:{bounds:bounds(b),perTextBaseline:variants},fontStatus:document.fonts.status,fontAvailable:document.fonts.check(font+'px Arial'),images:{canvas:canvas.toDataURL('image/png'),reference:referencePNG,canvasMask:maskPNG(a),svgMask:maskPNG(b),difference:maskPNG(a,b)}};
  }
  check(best>=spec.glyphMaskMinimumIoU,'independent SVG glyph mask '+[theme,caption,size]+' IoU='+best);
  for(const [x,y] of spec.backgroundProbes){const i=(y*720+x)*4;for(let c=0;c<3;c++)check(Math.abs(actual[i+c]-expected[i+c])<=8,'independent SVG background '+theme+' at '+x+','+y+': '+[...actual.slice(i,i+3)]+' vs '+[...expected.slice(i,i+3)]);}
  captures.push({name:[theme,caption,size].join('-'),png:canvas.toDataURL('image/png')});summaries.push({theme,caption,size,font,svgIoU:best});
 }
 // Focal colors are checked without caption shadows, independently of layout.
 for(const theme of spec.themes){
  const p=project('');p.style.theme=theme;R.render(canvas,A.fromEditor(p),0);const actual=pixels();
  const values={theme,font:62.5,weight:750,y1:567.625,y2:648.875,color2:'#c4a2ff',textOpacity:0,decorOpacity:theme==='minimal'?0:1,glowX:theme==='dusk'?504:468,glowColor:theme==='dusk'?'#efa368':'#6e4a9e',glowOpacity:theme==='minimal'?0:theme==='dusk'?96/255:102/255};
  const svg=template.replace(/\{\{(\w+)\}\}/g,(_,key)=>String(values[key])),image=await imageFromBlob(new Blob([svg],{type:'image/svg+xml'})),reference=document.createElement('canvas');reference.width=720;reference.height=1280;const rx=reference.getContext('2d');rx.drawImage(image,0,0);const expected=rx.getImageData(0,0,720,1280).data;
  const i=(537*720+454)*4;for(let channel=0;channel<3;channel++)check(Math.abs(actual[i+channel]-expected[i+channel])<=8,'independent SVG orb focal color '+theme);
 }
 // Empty/disabled subtitles must have no placeholder or hidden text panel.
 const videoPlan=A.fromVideo(ShortsVideoCore.demo());R.render(canvas,videoPlan,100);const videoPixels=pixels();R.render(canvas,A.fromEditor(project('Editor')),0);R.render(canvas,videoPlan,100);check(same(videoPixels,pixels()),'Editor cannot pollute Video context/profile');
 let wrongProfile;try{ShortsEditorCanvas.render(canvas,videoPlan,0);}catch(e){wrongProfile=e.code;}check(wrongProfile==='SETTINGS','direct Editor renderer rejects Video');
 for(const [target,code] of [[{},'CANVAS'],[{width:3600,height:6400,getContext(){throw Error('must reject before allocation');}},'RESOURCES'],[{width:720,height:1280,getContext(){return null;}},'CANVAS']]){let caught;try{R.render(target,A.fromEditor(project('Ошибка')),0);}catch(e){caught=e.code;}check(caught===code,'distinct '+code+' error');}
 const empty=project('');const blank=R.render(canvas,A.fromEditor(empty),0);check(blank.layout===null,'empty scene has no caption');const base=pixels();
 const disabled=project('Very long text '.repeat(3000));disabled.subtitles.enabled=false;const quiet=R.render(canvas,A.fromEditor(disabled),0);check(quiet.layout===null&&same(base,pixels()),'disabled subtitles do not overflow or paint text');
 const overflow=project('Очень длинные субтитры '.repeat(500));const old=pixels();let failed;try{R.render(canvas,A.fromEditor(overflow),0);}catch(e){failed=e.code;}check(failed==='TEXT_OVERFLOW'&&same(old,pixels()),'overflow refuses without painting or truncating');
 for(const text of ['👨‍👩‍👧‍👦','👨‍👩‍👧‍👦 é 👍🏽 — Привет 世界','Сверхдлинноесловобезпробелов'.repeat(2),'مرحبا мир hello']){const r=R.render(canvas,A.fromEditor(project(text)),0);check(r.layout.lines.flatMap(l=>l.runs).map(x=>x.text).join('')===text.replace(/\s/gu,''),'graphemes retained');}
 const p=project('Первая сцена');p.scenes=Array.from({length:5000},(_,i)=>({...p.scenes[0],id:'stable-'+i,text:'Сцена '+i,durationMs:17+i%3}));p.selectedSceneId='stable-0';const big=A.fromEditor(p),start=performance.now();
 for(let i=0;i<100;i++){const index=(i*47)%5000,t=big.timeline[index].startMs,r=R.render(canvas,big,t);check(r.sceneId==='stable-'+index&&r.segments.length===24&&r.segments.every(s=>s.width>0),'bounded large-plan render');ctx.getImageData(0,0,1,1);}
 const largeFramesMs=performance.now()-start;
 const shallow=A.fromEditor(project('Коротко'));Object.freeze(shallow);R.render(canvas,shallow,0);shallow.timeline[0].cues[0].text='Изменённый текст';const edited=R.render(canvas,shallow,0);check(edited.layout.lines.map(l=>l.text).join(' ')==='Изменённый текст','shallow freeze never publishes stale layout');
 const scaled=document.createElement('canvas');scaled.width=360;scaled.height=640;const sx=scaled.getContext('2d'),sf=sx.fillText,shadows=[];sx.fillText=function(...args){if(this.textBaseline==='middle')shadows.push([this.shadowBlur,this.shadowOffsetX,this.shadowOffsetY]);return sf.apply(this,args);};check(!!R.render(scaled,A.fromEditor(project('Масштаб')),0),'9:16 scaled output');check(shadows.length>0&&shadows.every(s=>s[0]===17.5&&s[1]===0&&s[2]===2.5),'shadow device pixels scale with canonical frame');sx.fillText=sf;
 // Image/camera/transition path uses original media and deterministic boundaries.
 const images=new Map();for(const f of payload.filter(f=>f.type.startsWith('image/'))){const bytes=Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0));images.set(f.name.split('.')[0],await imageFromBlob(new Blob([bytes],{type:f.type})));}
 const gallery=project('');gallery.scenes=['red','blue','green'].map((id,i)=>({...gallery.scenes[0],id:'photo-'+i,text:'',visual:'image',imageId:id,durationMs:1000,camera:['zoom-in','pan-left','zoom-out'][i]}));gallery.selectedSceneId='photo-0';
 for(const transition of ['none','crossfade','slide','zoom']){gallery.scenes.forEach(s=>s.transition=transition);const gp=A.fromEditor(gallery);for(const t of [0,999,1000,1100,1999,2000,2999]){const r=R.render(canvas,gp,t,{images}),data=pixels();check(r.sceneId===gp.timeline[Math.min(2,Math.floor(t/1000))].id,'transition scene IDs');let bright=0;for(let i=0;i<data.length;i+=400)bright+=data[i]+data[i+1]+data[i+2];check(bright>20000,'no black transition frame');}}
 let missing;try{R.render(canvas,A.fromEditor(gallery),0,{images:new Map()});}catch(e){missing=e.code;}check(missing==='MISSING_MEDIA','missing media remains explicit');
 window.editorCanvasCaptures=captures;
 return {combinations:summaries.length,minSvgIoU:Math.min(...summaries.map(s=>s.svgIoU)),largeFrames:100,largeScenes:5000,largeFramesMs,geometry:'720x1280',overflow:'explicit',unicode:true};
};

window.rejectEditorVisualMutants = async function(spec,template,payload){
 const prototype=CanvasRenderingContext2D.prototype,fill=prototype.fillText,gradient=prototype.createLinearGradient;
 const minimal={...spec,onlyCase:'cosmos-accent-medium'};let rejected=0;
 for(const kind of ['shift','palette','background']){
  prototype.fillText=function(text,x,y,...args){if(kind==='shift'&&this.textBaseline==='middle')y+=30;if(kind==='palette'&&this.fillStyle==='#c4a2ff')this.fillStyle='#ff3333';return fill.call(this,text,x,y,...args);};
  prototype.createLinearGradient=function(...args){const g=gradient.apply(this,args),add=g.addColorStop;g.addColorStop=function(at,color){return add.call(this,at,kind==='background'&&color==='#121527'?'#ff0000':color);};return g;};
  let error;try{await checkEditorCanvas(minimal,template,payload);}catch(e){error=e;}finally{prototype.fillText=fill;prototype.createLinearGradient=gradient;}
  if(!error||!String(error.message).includes('independent SVG'))throw Error('Visual counterexample was not detected: '+kind+' '+error?.message);rejected++;
 }
 return rejected;
};
