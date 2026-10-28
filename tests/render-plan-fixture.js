/* Browser/native Safari verification against the frozen independent renderer. */
window.testRenderPlanPixels = async function (cases, payload) {
  const P=ShortsRenderPlan,A=ShortsRenderAdapters,V=ShortsVideoCore,R=ShortsVideoRenderer;
  const assert=(v,label)=>{if(!v)throw Error('RenderPlan: '+label);};
  const images=new Map(),urls=[],decoded=[];
  try {
    await document.fonts.ready;
    for(const f of payload.filter(f=>f.type.startsWith('image/'))){
      const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type}));urls.push(url);
      const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Test image decode '+f.name+' '+url));image.src=url;});decoded.push(image);
      images.set(f.name.split('.')[0],image);if(f.name==='red.png')images.set('baseline-original-image',image);
    }
    const canvas=()=>{const c=document.createElement('canvas');c.width=720;c.height=1280;return c;};
    const target=canvas(),layer=canvas(),resources={images};let frames=0;
    // Differential rendering must use the same real destination and scratch
    // surface. Separate accelerated surfaces can quantize a blended pixel by
    // one channel value in WebKit, even with identical draw operations.
    const draw=(renderer,plan,time,runtime)=>{
      for(const c of [target,layer]){const ctx=c.getContext('2d',{alpha:false});if(typeof ctx.reset==='function')ctx.reset();else{c.width=720;c.height=1280;}}
      const own=Object.getOwnPropertyDescriptor(document,'createElement'),create=document.createElement;
      document.createElement=function(tag,...args){return String(tag).toLowerCase()==='canvas'?layer:create.call(this,tag,...args);};
      try{renderer.render(target,plan,time,runtime);}finally{if(own)Object.defineProperty(document,'createElement',own);else delete document.createElement;}
    };
    const pixels=c=>new Uint32Array(c.getContext('2d').getImageData(0,0,720,1280).data.buffer);
    const same=(a,b,label)=>{assert(a.length===b.length,label+' length');for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error(label+' differs at pixel '+i);};
    const run=(name,draft)=>{
      const expected=LegacyVideoCore.makePlan(draft),plan=A.fromVideo(draft),legacy=V.makePlan(draft);expected.images=images;legacy.images=images;
      assert(!Object.hasOwn(plan,'images'),'decoded images stay outside RenderPlan');
      assert(JSON.stringify(JSON.parse(JSON.stringify(plan)))===JSON.stringify(plan),'plan is plain transferable data');
      // Prime lazy glyph caches before an exact differential comparison.
      draw(LegacyVideoRenderer,expected,0);draw(R,plan,0,resources);
      draw(LegacyVideoRenderer,expected,0);draw(R,legacy,0);
      const boundary=plan.timeline[1]?.startMs||0;
      for(const time of new Set([0,1,Math.max(0,boundary-1),boundary,boundary+100,plan.durationMs-1])){
        assert(JSON.stringify(LegacyVideoCore.frameAt(expected,time))===JSON.stringify(V.frameAt(plan,time)),name+' frame values at '+time);
        // Equal call counts matter: JSC may optimize one identical renderer
        // earlier if it is called twice for the two API paths being tested.
        draw(LegacyVideoRenderer,expected,time);const original=pixels(target);draw(R,plan,time,resources);const actual=pixels(target);
        draw(LegacyVideoRenderer,expected,time);const originalCompat=pixels(target);draw(R,legacy,time);const actualCompat=pixels(target);
        const different=(a,b)=>{let count=0,max=0,first=null;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){count++;first??={pixel:i,a:a[i].toString(16),b:b[i].toString(16)};for(let n=0;n<4;n++)max=Math.max(max,Math.abs((a[i]>>>(8*n)&255)-(b[i]>>>(8*n)&255)));}return{count,max,first};};
        const delta=different(original,actual),compatDelta=different(originalCompat,actualCompat);
        if(delta.count||compatDelta.count)throw Error(JSON.stringify({name,time,shared:delta,legacy:compatDelta,oldSelf:different(original,originalCompat),newSelf:different(actual,actualCompat)}));
        same(original,actual,name+' shared at '+time);same(originalCompat,actualCompat,name+' legacy API at '+time);frames++;
      }
    };
    for(const f of cases)run(f.name,f.draft);
    const base=cases[0].draft;
    for(const transition of ['none','crossfade','slide','zoom'])run('gallery-'+transition,{...base,timing:'manual',scenes:['red','blue','green'].map((id,i)=>({id:'photo-'+i,text:i?'Сцена '+i:'',visual:'image',imageId:id,camera:['zoom-in','zoom-out','pan-left'][i],transition,durationSeconds:[1.2,1.7,2.1][i]}))});
    const editor=ShortsCore.upgradeProject(ShortsCore.createProject(true)),supported=A.fromEditor(editor),ep={...supported,appearance:{...supported.appearance,supported:false}},original=pixels(target);
    let refused=false;try{R.render(target,ep,0,resources);}catch(e){refused=e.code==='APPEARANCE';}assert(refused,'unsupported manual appearance must not be approximated');same(original,pixels(target),'refused manual frame');
    let recordingRefused=false;try{await ShortsVideoRecorder.record({canvas:target,plan:ep});}catch(e){recordingRefused=e.code==='APPEARANCE';}assert(recordingRefused,'recorder refuses unsupported appearance before capture');
    return {frames,comparison:'all RGBA pixels identical',legacyApi:true,manualAppearance:'implemented editor profile; unsupported flag still refused'};
  }finally{for(const image of decoded)image.src='';for(const url of urls)URL.revokeObjectURL(url);}
};
window.installRenderPlanProbe = function () {
  const R=ShortsVideoRenderer,rec=ShortsVideoRecorder,P=ShortsRenderPlan,original={render:R.render,playMix:rec.playMix,record:rec.record};
  const probe={previewFrames:0,recordFrames:0,mixCalls:0,records:0};let lastPlan,lastResources,recordPlan,recordResources,recording=false;
  const assert=(v,label)=>{if(!v)throw Error('Plan integration: '+label);};
  const audio=options=>({voiceVolume:options.voiceVolume,musicVolume:options.musicVolume,fadeIn:options.fadeIn,fadeOut:options.fadeOut,durationSeconds:options.durationSeconds});
  R.render=function(canvas,plan,time,resources){
    if(canvas.id==='videoCanvas'){
      assert(P.isPlan(plan)&&plan.source.mode==='video','preview and record must receive canonical video plan');
      assert(!Object.hasOwn(plan,'images'),'no runtime resources in plan');
      if(recording){assert(plan===recordPlan&&resources===recordResources,'record uses exactly the same plan/resources');probe.recordFrames++;}
      else{lastPlan=plan;lastResources=resources;probe.previewFrames++;}
    }return original.render(canvas,plan,time,resources);
  };
  rec.playMix=function(options){assert(JSON.stringify(audio(options))===JSON.stringify(P.audioOptions(lastPlan)),'preview mix settings match plan');probe.mixCalls++;return original.playMix(options);};
  rec.record=async function(options){
    assert(options.plan===lastPlan&&options.resources===lastResources,'preview/record snapshot identity');
    assert(JSON.stringify(audio(options))===JSON.stringify(P.audioOptions(options.plan)),'record mix settings match plan');
    assert(options.format===options.plan.exportSettings.format,'export preference matches plan');
    recordPlan=options.plan;recordResources=options.resources;recording=true;probe.records++;
    try{return await original.record(options);}finally{recording=false;}
  };
  window.verifyRenderPlanProbe=()=>{
    R.render=original.render;rec.playMix=original.playMix;rec.record=original.record;
    assert(probe.previewFrames>0&&probe.recordFrames>0&&probe.mixCalls>0&&probe.records>0,'real preview/mix/record exercised');
    return {...probe,durationMs:recordPlan.durationMs,source:recordPlan.source.mode};
  };
  document.getElementById('videoSeek').dispatchEvent(new Event('input',{bubbles:true}));
};
