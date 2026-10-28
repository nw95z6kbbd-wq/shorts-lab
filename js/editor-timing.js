(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./core.js'),require('./render-adapters.js'));
  else root.ShortsEditorTiming=factory(root.ShortsCore,root.ShortsRenderAdapters);
})(typeof globalThis!=='undefined'?globalThis:this,function(C,A){
  'use strict';
  const failure=message=>Object.assign(new Error(message),{code:'EDITOR_INPUT'});
  function parseSeconds(raw){
    const value=String(raw).trim();if(!value)return null;
    if(!/^(?:\d+(?:[.,]\d{1,3})?|[.,]\d{1,3})$/.test(value))throw failure('Введите положительную длительность в секундах, не более трёх знаков после запятой. Пустое поле — расчёт по тексту.');
    const [whole,fraction='']=value.replace(',','.').split('.'),ms=BigInt(whole||'0')*1000n+BigInt(fraction.padEnd(3,'0'));
    if(ms<1n||ms>BigInt(Number.MAX_SAFE_INTEGER))throw failure('Длительность должна быть от 1 до '+Number.MAX_SAFE_INTEGER+' целых миллисекунд.');
    return Number(ms);
  }
  function seconds(ms){return ms==null?'':String(Math.floor(ms/1000))+(ms%1000?','+String(ms%1000).padStart(3,'0').replace(/0+$/,''):'');}
  function clock(ms){return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+(ms%1000?','+String(ms%1000).padStart(3,'0'):'');}
  function compile(project){
    const plan=A.fromEditor(project),rows=new Map(plan.timeline.map(row=>[row.id,row])),byId=new Map();let cursor=0;
    project.scenes.forEach((scene,index)=>{
      const row=rows.get(scene.id);if(row)cursor=row.endMs;
      byId.set(scene.id,{id:scene.id,index,startMs:row?row.startMs:cursor,endMs:row?row.endMs:cursor,durationMs:row?row.endMs-row.startMs:0,scene:row||null});
    });
    return {plan,byId};
  }
  function edit(project,command){
    const {type,id,value}=command;
    if(type==='timing'){
      if(!['reading','manual'].includes(value))throw failure('Неизвестный режим длительности.');
      return (project.timing||'reading')===value?project:{...C.upgradeProject(project),timing:value};
    }
    if(type==='subtitle-mode'||type==='subtitle-enabled'){
      const key=type==='subtitle-mode'?'mode':'enabled',current=project.subtitles?.[key]??(key==='mode'?'scene':true);
      if(key==='mode'?!['scene','chunks'].includes(value):typeof value!=='boolean')throw failure('Неверная настройка субтитров.');
      if(current===value)return project;const next=C.upgradeProject(project);return {...next,subtitles:{...next.subtitles,[key]:value}};
    }
    if(type==='add'){
      if(project.scenes.length>=5000)throw failure('В проекте уже 5 000 сцен.');
      const sceneId=C.id(),basic={id:sceneId,text:''};
      const scene=project.version===2?C.upgradeProject({...project,version:1,scenes:[basic],selectedSceneId:sceneId}).scenes[0]:basic;
      return {...project,scenes:[...project.scenes,scene],selectedSceneId:sceneId};
    }
    if(['image','visual','camera','transition'].includes(type)){
      const next=C.upgradeProject(project),index=next.scenes.findIndex(s=>s.id===id);if(index<0)throw failure('Сцена больше не существует.');
      if(type==='image'){
        if(value!==null&&(!value||typeof value.id!=='string'||typeof value.name!=='string'))throw failure('Неверная ссылка на изображение.');
        Object.assign(next.scenes[index],{imageId:value?.id||null,imageName:value?.name||'',visual:value?'image':'animated'});
      }else next.scenes[index][type]=value;
      return C.parseProject(next); // strict existing DTO validation, no new schema
    }
    const index=project.scenes.findIndex(scene=>scene.id===id);if(index<0)throw failure('Сцена больше не существует.');
    const scenes=project.scenes.slice();
    if(type==='move'){
      if(![-1,1].includes(value))throw failure('Неверное направление перемещения.');
      const target=index+value;if(target<0||target>=scenes.length)return project;
      [scenes[index],scenes[target]]=[scenes[target],scenes[index]];
    }else if(type==='remove'){
      scenes.splice(index,1);
      return {...project,scenes,selectedSceneId:project.selectedSceneId===id?(scenes[Math.min(index,scenes.length-1)]?.id||null):project.selectedSceneId};
    }else if(type==='text'){
      if(typeof value!=='string')throw failure('Текст сцены должен быть строкой.');scenes[index]={...scenes[index],text:value};
    }else if(type==='duration'){
      if(project.timing!=='manual')throw failure('Сначала включите ручные длительности.');
      scenes[index]={...scenes[index],durationMs:parseSeconds(value)};
    }else throw failure('Неизвестное действие Студии.');
    return {...project,scenes};
  }
  return Object.freeze({compile,edit,parseSeconds,seconds,clock});
});
