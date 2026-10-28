(function(){
  'use strict';
  const E=window.ShortsEditorProfile,P=window.ShortsRenderPlan,V=window.ShortsVideoCore,layers=new WeakMap(),layouts=new WeakMap();
  const ease=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
  function gradient(ctx,x,y,a,b,stops){const g=ctx.createLinearGradient(x,y,a,b);for(const [at,c] of stops)g.addColorStop(at,c);return g;}
  function background(ctx,theme){
    if(theme==='minimal'){
      const g=ctx.createRadialGradient(360,0,0,360,0,1100);g.addColorStop(0,'#35303f');g.addColorStop(.75,'#17151e');ctx.fillStyle=g;ctx.fillRect(0,0,720,1280);return;
    }
    const dusk=theme==='dusk';
    ctx.fillStyle=gradient(ctx,0,0,dusk?200:720,1280,dusk?[[0,'#352543'],[.55,'#6e4161'],[1,'#c77d65']]:[[0,'#121527'],[.5,'#1b1329'],[.85,'#352346'],[1,'#81647e']]);ctx.fillRect(0,0,720,1280);
    const glow=ctx.createRadialGradient(dusk?504:468,384,0,dusk?504:468,384,600);glow.addColorStop(0,dusk?'#efa36860':'#6e4a9e66');glow.addColorStop(1,dusk?'#efa36800':'#6e4a9e00');ctx.fillStyle=glow;ctx.fillRect(0,0,720,1280);
    const orb=ctx.createRadialGradient(454,537,0,349.2,416.4,262.8);
    for(const [at,c] of dusk?[[0,'#efb588'],[.4,'#a96e7b'],[1,'#6a4566']]:[[0,'#a98bb540'],[.45,'#342845'],[1,'#151421']])orb.addColorStop(at,c);
    ctx.fillStyle=orb;ctx.beginPath();ctx.arc(349.2,416.4,262.8,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.translate(349.2,416.4);ctx.rotate(-50*Math.PI/180);ctx.strokeStyle='#b59cc830';ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(0,0,388.9,36.96,0,0,Math.PI*2);ctx.stroke();ctx.restore();
    ctx.save();ctx.translate(403.2,1273.6);ctx.rotate(-13*Math.PI/180);ctx.fillStyle=gradient(ctx,0,-288,0,288,dusk?[[0,'#c6918c'],[.3,'#502d4c'],[.7,'#211527']]:[[0,'#c0a7b9'],[.18,'#49304f'],[.58,'#151120']]);ctx.beginPath();ctx.ellipse(0,0,748.8,288,0,0,Math.PI*2);ctx.fill();ctx.restore();
    const dots=[[.10,.14,2.5],[.77,.08,1.75],[.90,.32,2],[.23,.47,1.75],[.57,.60,1.5],[.85,.74,1.5],[.08,.71,1.25]];
    ctx.fillStyle='#ffffff61';for(let col=0;col<3;col++)for(let row=0;row<3;row++)for(const [x,y,r] of dots){ctx.beginPath();ctx.arc((col+x)*357.5,(row+y)*427.5,r,0,Math.PI*2);ctx.fill();}
  }
  function imageFor(scene,resources){
    const image=typeof resources?.images?.get==='function'?resources.images.get(scene.imageId):null;
    if(!image||!((image.width||image.naturalWidth)>0)||!((image.height||image.naturalHeight)>0))throw E.error('MISSING_MEDIA','Не подготовлено доступное изображение сцены '+scene.id,{assetId:scene.imageId});return image;
  }
  function visual(ctx,plan,scene,time,resources){
    background(ctx,plan.appearance.requested.theme);
    if(scene.visual==='image'){
      const image=imageFor(scene,resources),iw=image.width||image.naturalWidth,ih=image.height||image.naturalHeight;
      const r=V.cameraRect(iw,ih,(time-scene.startMs)/(scene.endMs-scene.startMs),scene.camera);ctx.drawImage(image,r.x,r.y,r.width,r.height);
    }
  }
  function textLayout(ctx,plan,cue){
    if(!cue)return null;
    // Only immutable session plans can cache measurements. Mutable caller plans
    // are recalculated, so edits cannot publish a stale layout.
    const immutable=Object.isFrozen(plan)&&Object.isFrozen(plan.appearance.requested)&&Object.isFrozen(cue);
    let cache=immutable?layouts.get(plan):null;
    if(!cache&&immutable){cache=new Map();layouts.set(plan,cache);}
    if(cache?.has(cue))return cache.get(cue);
    const {namespace,...style}=plan.appearance.requested;const result=E.layout(ctx,cue.text,style);
    if(cache){if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(cue,result);}return result;
  }
  function render(canvas,plan,time,resources){
    if(!P.isPlan(plan)||plan.source?.mode!=='editor')throw E.error('SETTINGS','Editor Canvas принимает только Editor RenderPlan.');
    P.assertRenderable(plan);
    if(!canvas||typeof canvas.getContext!=='function')throw E.error('CANVAS','Не передан Canvas Editor.');
    if(!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<=0||canvas.height<=0||canvas.width*16!==canvas.height*9)throw E.error('SETTINGS','Canvas Editor должен иметь пропорции 9:16.');
    if(canvas.width*canvas.height>16777216)throw E.error('RESOURCES','Canvas превышает рабочий предел 16 млн пикселей.');
    let ctx;try{ctx=canvas.getContext('2d',{alpha:false});}catch(cause){throw Object.assign(E.error('CANVAS','Не удалось подготовить Canvas Editor.'),{cause});}
    if(!ctx)throw E.error('CANVAS','Не удалось подготовить Canvas Editor.');
    const frame=P.frameAt(plan,time),previous=plan.timeline[frame.scene.index-1];
    const synthesis=canvas.style?.fontSynthesis;
    ctx.save();
    try{
      // Scope canonical font synthesis to Editor; do not pollute a reused Video target.
      if(canvas.style)canvas.style.fontSynthesis='initial';
      ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetX=ctx.shadowOffsetY=0;ctx.filter='none';ctx.setLineDash([]);
      const layout=textLayout(ctx,plan,frame.cue); // overflow fails before painting
      const duration=Math.min(440,(frame.scene.endMs-frame.scene.startMs)/3,previous?(previous.endMs-previous.startMs)/3:440),transition=frame.scene.transition==='none'?1:ease(frame.localMs/duration);
      const involved=previous&&transition<1?[previous,frame.scene]:[frame.scene];
      for(const s of involved){if(!['animated','image'].includes(s.visual)||!['static','zoom-in','zoom-out','pan-left','pan-right'].includes(s.camera)||!['none','crossfade','slide','zoom'].includes(s.transition))throw E.error('SETTINGS','Неверные визуальные параметры сцены.');if(s.visual==='image')imageFor(s,resources);}
      ctx.scale(canvas.width/720,canvas.height/1280);
      if(previous&&transition<1){
        visual(ctx,plan,previous,previous.visual==='image'?previous.endMs:frame.time,resources);
        let layer=layers.get(canvas);if(!layer){layer=document.createElement('canvas');layer.width=720;layer.height=1280;layers.set(canvas,layer);}
        const lc=layer.getContext('2d',{alpha:false});if(!lc)throw E.error('CANVAS','Не удалось создать слой перехода Editor.');visual(lc,plan,frame.scene,frame.time,resources);
        ctx.save();if(frame.scene.transition==='slide')ctx.translate(720*(1-transition),0);else{ctx.globalAlpha=transition;if(frame.scene.transition==='zoom'){const scale=1+.1*(1-transition);ctx.translate(360,640);ctx.scale(scale,scale);ctx.translate(-360,-640);}}ctx.drawImage(layer,0,0);ctx.restore();
      }else visual(ctx,plan,frame.scene,frame.time,resources);
      ctx.fillStyle=gradient(ctx,0,0,0,1280,[[0,'#0b081a44'],[.2,'#0b081a00'],[.78,'#0b081a00'],[1,'#0b081a88']]);ctx.fillRect(0,0,720,1280);
      ctx.textBaseline='top';ctx.textAlign='left';ctx.font='600 15px Arial, sans-serif';ctx.fillStyle='#d0b6eb';ctx.fillText('✦',35,36);ctx.fillStyle='#e7dff2a6';ctx.fillText('SHORTS STUDIO',75,40);ctx.textAlign='right';ctx.font='400 17.5px Arial, sans-serif';ctx.fillText(String(frame.scene.index+1).padStart(2,'0')+' / '+String(plan.timeline.length).padStart(2,'0'),685,40);
      const segments=E.segments(plan,frame.time);for(const s of segments){ctx.fillStyle='#ffffff26';ctx.fillRect(s.x,105,s.width,5);ctx.fillStyle=s.progress>=1?'#b593ec':'#e0cff9';ctx.fillRect(s.x,105,s.width*s.progress,5);}
      if(layout){
        const style=plan.appearance.requested;
        if(style.caption==='classic'){ctx.fillStyle='#080611b3';ctx.beginPath();ctx.roundRect(42.5,512,635,layout.height,15);ctx.fill();}
        ctx.font=`${layout.typography.weight} ${layout.font}px ${layout.typography.family}`;ctx.textBaseline='middle';ctx.textAlign='left';ctx.direction='ltr';ctx.shadowColor=style.caption==='outline'?'#140d20':'#08051280';ctx.shadowBlur=(style.caption==='outline'?0:35)*canvas.width/720;ctx.shadowOffsetX=(style.caption==='outline'?5:0)*canvas.width/720;ctx.shadowOffsetY=5*canvas.height/1280;
        for(const line of layout.lines){
          let x=360-ctx.measureText(line.text).width/2;
          // Whole runs preserve shaping inside words; grapheme fragments never
          // split combining sequences, emoji modifiers or ZWJ families.
          for(let i=0;i<line.runs.length;i++){
            const r=line.runs[i];if(style.caption==='outline'){ctx.strokeStyle='#100a1f';ctx.lineWidth=1.75;ctx.strokeText(r.text,x,line.y);}ctx.fillStyle=r.accent?'#c4a2ff':'#ffffff';ctx.fillText(r.text,x,line.y);x+=ctx.measureText(r.text).width+(i<line.runs.length-1?ctx.measureText(' ').width:0);
          }
        }
        ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetX=ctx.shadowOffsetY=0;
      }
      ctx.textAlign='left';ctx.textBaseline='top';ctx.font='400 15px Arial, sans-serif';ctx.fillStyle='#ddd1e39c';ctx.fillText('У каждой истории есть начало',42.5,1220);ctx.font='400 35px Arial, sans-serif';ctx.fillStyle='#dcc3ed';ctx.fillText('✦',650,1200);
      return {sceneId:frame.scene.id,layout,segments};
    }finally{ctx.restore();if(canvas.style)canvas.style.fontSynthesis=synthesis;}
  }
  window.ShortsEditorCanvas=Object.freeze({render});
})();
