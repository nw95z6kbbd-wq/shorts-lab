(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.ShortsEditorPreview=factory({runtime:root.ShortsRenderSessions,plan:root.ShortsRenderPlan});
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
 'use strict';
 // One controller, one media owner at a time, latest request wins. A native
 // decoder may finish after cancellation; its owner must actually close first.
 function create({canvas,onState=()=>{}}){
  let active=null,desired=null,data=null,serial=0,closed=false,pumping=false,waiters=[];
  const notify=(state,error=null,info={})=>onState({state,error,...info});
  function settle(token,value){const rest=[];for(const w of waiters){if(w.token===token)w.resolve(value);else rest.push(w);}waiters=rest;}
  function stop(){serial++;desired=null;for(const w of waiters)w.resolve(false);waiters=[];active?.session.cancel().catch(()=>{});}
  async function pump(){
   if(pumping)return;pumping=true;
   try{while(desired&&!closed){
    const request=desired;
    if(active&&active.key===request.key&&active.session.status().state==='ready'){
     try{active.session.renderFrame(canvas,request.time);notify('ready',null,{timeMs:request.time,sceneId:io.plan.frameAt(request.plan,request.time).scene.id});settle(request.token,true);desired=null;}
     catch(error){notify('error',error);settle(request.token,false);desired=null;await active.session.dispose();active=null;}
     continue;
    }
    if(active){await active.session.dispose();active=null;}
    if(!desired||request.token!==desired.token)continue;
    let session;
    try{
     session=io.runtime.createPreview({slot:'editor',projectId:request.project.id,project:request.project,plan:request.plan,contentRevision:request.revision,savedRevision:null,timeMs:request.time});
     active={session,key:request.key};await session.prepare();
     if(!desired||request.token!==desired.token||closed){await session.dispose();if(active?.session===session)active=null;continue;}
     // Re-enter with the latest time of this same revision/window.
    }catch(error){
     if(desired?.token===request.token&&!closed){notify('error',error);settle(request.token,false);desired=null;}
     if(session)await session.dispose();if(active?.session===session)active=null;
    }
   }}finally{pumping=false;}
  }
  function draw({project,plan,time,revision}){
   if(closed)return Promise.resolve(false);
   let frame;try{frame=io.plan.frameAt(plan,time);}catch(error){stop();notify('error',error);return Promise.resolve(false);}
   const key=JSON.stringify([project.id,revision,frame.scene.id]);
   if(active?.key===key&&active.session.status().state==='ready'&&!pumping){
    try{active.session.renderFrame(canvas,time);notify('ready',null,{timeMs:time,sceneId:frame.scene.id});return Promise.resolve(true);}catch(error){stop();notify('error',error);return Promise.resolve(false);}
   }
   if(desired?.key===key){desired.time=time;return new Promise(resolve=>waiters.push({token:desired.token,resolve}));}
   stop();notify('loading');const token=serial;
   // Detached data belongs to this request. UI edits cannot mutate preparation.
   try{if(!data||data.id!==project.id||data.revision!==revision||data.source!==plan)data={id:project.id,revision,source:plan,snapshot:io.runtime.snapshotData(project,plan)};desired={key,token,time,revision,...data.snapshot};}catch(error){notify('error',error);return Promise.resolve(false);}
   const result=new Promise(resolve=>waiters.push({token,resolve}));pump().catch(error=>{notify('error',error);stop();});return result;
  }
  return Object.freeze({draw,suspend(){stop();data=null;const closing=active?.session.dispose()||Promise.resolve();closing.finally(()=>{if(!desired)active=null;});return closing;},async dispose(){closed=true;stop();data=null;await active?.session.dispose();active=null;},status:()=>({requestGeneration:serial,active:active?.session.status()||null,preparing:pumping,waiting:waiters.length})});
 }
 return Object.freeze({create});
});
