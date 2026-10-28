(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ShortsEditorProfile=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ID='editor-canvas-v1',LAYOUT='editor-v1';
  const THEMES=Object.freeze(['cosmos','dusk','minimal']),CAPTIONS=Object.freeze(['accent','classic','outline']),SIZES=Object.freeze(['small','medium','large']);
  const GEOMETRY=Object.freeze({width:720,height:1280,textX:42.5,textY:512,textWidth:635,textHeight:576,segmentsY:105,segmentsHeight:5,segmentsGap:10,maxSegments:24});
  const error=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
  function style(value,{partial=false}={}){
    if(value===undefined&&partial)return;
    if(!value||typeof value!=='object'||Array.isArray(value))throw error('SETTINGS','Оформление Editor должно быть объектом.');
    if(Object.keys(value).some(k=>!['theme','caption','size'].includes(k)))throw error('STYLE_UNSUPPORTED','Неизвестный значимый параметр оформления Editor.');
    for(const [key,choices] of [['theme',THEMES],['caption',CAPTIONS],['size',SIZES]]){
      if(partial&&value[key]===undefined)continue;
      if(typeof value[key]!=='string')throw error('SETTINGS','Неверное значение '+key+' в оформлении Editor.');
      if(!choices.includes(value[key]))throw error('STYLE_UNSUPPORTED','Editor Canvas не поддерживает '+key+': '+value[key]);
    }
  }
  function resolve(value){style(value);return {requested:{namespace:'editor',...value},resolved:{renderer:ID,layout:LAYOUT,...value},supported:true,limitations:[]};}
  function assertAppearance(a){
    if(!a||a.requested?.namespace!=='editor')throw error('SETTINGS','Не указан профиль Editor.');
    if(Object.keys(a).some(k=>!['requested','resolved','supported','limitations'].includes(k)))throw error('STYLE_UNSUPPORTED','Неизвестные поля Canvas-оформления.');
    const {namespace,...requested}=a.requested;style(requested);
    if(typeof a.supported!=='boolean')throw error('SETTINGS','supported должен быть логическим значением.');
    if(!a.supported)throw error('APPEARANCE','Запрошенное оформление Editor не реализовано.');
    const expected={renderer:ID,layout:LAYOUT,...requested},r=a.resolved;
    if(!r||Object.keys(r).length!==Object.keys(expected).length||Object.keys(expected).some(k=>r[k]!==expected[k])||!Array.isArray(a.limitations)||a.limitations.length)throw error('SETTINGS','Разрешённое оформление не соответствует каноническому Editor Canvas.');
  }
  function typography(s){
    style(s);const base={small:50,medium:s.caption==='classic'?57.5:62.5,large:75}[s.size];
    return {base,min:{small:40,medium:45,large:52.5}[s.size],step:2.5,lineHeight:1.3,weight:{accent:750,classic:600,outline:800}[s.caption],family:'Arial, sans-serif',padX:s.caption==='classic'?25:5,padTop:s.caption==='classic'?27.5:15,padBottom:s.caption==='classic'?27.5:22.5};
  }
  function layout(ctx,text,s){
    const t=typography(s),g=GEOMETRY;
    if(typeof text!=='string')throw error('SETTINGS','Субтитры должны быть текстом.');
    if(typeof Intl.Segmenter!=='function')throw error('RESOURCES','Для безопасного переноса Unicode требуется Intl.Segmenter.');
    const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'}),width=g.textWidth-2*t.padX;
    const tokens=text.replace(/\r\n?/g,'\n').match(/\S+|[^\S\n]+|\n/gu)||[];
    const words=tokens.filter(x=>!/^\s+$/u.test(x)).length;
    // Whitespace is collapsed, explicit newlines retained. Long words are split
    // only at grapheme boundaries, never by UTF-16 code units or silent slicing.
    for(let font=t.base;font>=t.min;font-=t.step){
      ctx.font=`${t.weight} ${font}px ${t.family}`;
      const lines=[[]];let word=0,failed=false;
      const maxLines=Math.floor((g.textHeight-t.padTop-t.padBottom)/(font*t.lineHeight));
      for(const token of tokens){
        if(token==='\n'){lines.push([]);if(lines.length>maxLines){failed=true;break;}continue;}
        if(/^\s+$/u.test(token))continue;
        let part='';const pieces=[];
        for(const {segment} of segmenter.segment(token)){
          if(ctx.measureText(segment).width>width){failed=true;break;}
          if(part&&ctx.measureText(part+segment).width>width){pieces.push(part);part='';}
          part+=segment;
          if(pieces.length>maxLines){failed=true;break;}
        }
        if(failed)break;if(part)pieces.push(part);
        for(const piece of pieces){
          let line=lines[lines.length-1];
          if(line.length&&ctx.measureText(line.map(r=>r.text).join(' ')+' '+piece).width>width){line=[];lines.push(line);}
          line.push({text:piece,word,accent:s.caption==='accent'&&words>2&&word>=words-2});
          if(lines.length>maxLines){failed=true;break;}
        }
        if(failed)break;word++;
      }
      if(failed)continue;
      const lineHeight=font*t.lineHeight,height=lines.length*lineHeight+t.padTop+t.padBottom;
      if(height>g.textHeight)continue;
      return {font,lineHeight,height,area:{x:g.textX,y:g.textY,width:g.textWidth,height:g.textHeight},lines:lines.map((runs,i)=>({runs,text:runs.map(r=>r.text).join(' '),x:360,y:g.textY+t.padTop+lineHeight*(i+.5)})),typography:t};
    }
    throw error('TEXT_OVERFLOW','Субтитры не помещаются в область Editor Canvas даже при минимальном размере. Сократите сцену или явно измените её субтитры.',{sceneTextLength:text.length});
  }
  function segments(plan,time){
    const n=plan.timeline.length,count=Math.min(n,GEOMETRY.maxSegments),gap=GEOMETRY.segmentsGap,width=(GEOMETRY.textWidth-gap*(count-1))/count;
    return Array.from({length:count},(_,i)=>{
      const first=Math.floor(i*n/count),last=Math.floor((i+1)*n/count)-1,a=plan.timeline[first],b=plan.timeline[last];
      return {first,last,x:GEOMETRY.textX+i*(width+gap),width,progress:Math.max(0,Math.min(1,(time-a.startMs)/(b.endMs-a.startMs)))};
    });
  }
  return Object.freeze({ID,LAYOUT,THEMES,CAPTIONS,SIZES,GEOMETRY,error,style,resolve,assertAppearance,typography,layout,segments});
});
