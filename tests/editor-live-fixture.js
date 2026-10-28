/* Actual Editor UI consumer, shared by Chromium/WebKit/Native Safari. */
window.editorLiveUntil=async function(condition,label){const end=Date.now()+25000;while(!condition()){if(Date.now()>end)throw Error('Editor live timeout: '+label+' '+document.getElementById('editorPreviewMessage').textContent);await new Promise(r=>setTimeout(r,20));}};
window.editorLiveImport=async function(project){
 const input=document.getElementById('projectFile'),dt=new DataTransfer();dt.items.add(new File([JSON.stringify(project)],'studio.shorts.json',{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 await editorLiveUntil(()=>document.getElementById('confirmDialog').open||document.getElementById('projectName').value===project.name,'JSON confirmation');
 if(document.getElementById('confirmDialog').open)document.getElementById('dialogConfirm').click();
 await editorLiveUntil(()=>{try{return ShortsEditor.backupSnapshot().id===project.id;}catch(_){return false;}},'JSON restored project');
};
window.editorLiveReady=async function(id,time){await editorLiveUntil(()=>document.getElementById('portrait').dataset.previewState==='ready'&&(!id||document.getElementById('editorCanvas').dataset.sceneId===id)&&(time===undefined||Number(document.getElementById('editorCanvas').dataset.timeMs)===time),'Canvas ready '+id+' '+time);return true;};
window.editorLiveHash=async function(canvas=document.getElementById('editorCanvas')){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',canvas.getContext('2d').getImageData(0,0,720,1280).data)),x=>x.toString(16).padStart(2,'0')).join('');};
window.editorLiveSeek=async function(time,id){const seek=document.getElementById('editorSeek');seek.value=String(time);seek.dispatchEvent(new Event('input',{bubbles:true}));await editorLiveReady(id,Math.min(time,ShortsRenderAdapters.fromEditor(ShortsEditor.backupSnapshot()).durationMs-1));};
window.editorLiveUpload=async function(index,file){
 const input=document.querySelectorAll('.studio-image-controls input')[index],dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],file.name,{type:file.type}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 await editorLiveUntil(()=>document.querySelectorAll('.studio-image-state')[index].dataset.state!=='loading','upload finished');
 const status=document.querySelectorAll('.studio-image-state')[index];if(status.dataset.state!=='ready')throw Error('Editor image not accepted: '+status.textContent);
 const scene=ShortsEditor.backupSnapshot().scenes[index];await editorLiveReady(scene.id);return scene.imageId;
};
window.editorLiveVerifyProfiles=async function(captures,spec){
 const C=ShortsCore,p=C.upgradeProject(C.createProject());p.name='Canvas independent acceptance';p.timing='manual';p.script='Original text is different';p.scenes=[{id:'edited-scene',text:spec.text,durationMs:2000,visual:'animated',imageId:null,imageName:'',camera:'static',transition:'none'}];p.selectedSceneId='edited-scene';await editorLiveImport(p);
 let count=0;
 for(const theme of spec.themes)for(const caption of spec.captions)for(const size of spec.sizes){
  document.querySelector('[data-theme='+theme+']').click();document.querySelector('[data-caption='+caption+']').click();const select=document.getElementById('captionSize');select.value=size;select.dispatchEvent(new Event('change',{bubbles:true}));await editorLiveReady('edited-scene',0);
  const entry=captures.find(c=>c.name===[theme,caption,size].join('-'));if(!entry)throw Error('Missing independently accepted profile');
  const image=new Image();image.src=entry.png;await image.decode();const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;canvas.getContext('2d').drawImage(image,0,0);
  if(await editorLiveHash()!==await editorLiveHash(canvas)){
    const a=document.getElementById('editorCanvas').getContext('2d').getImageData(0,0,720,1280).data,b=canvas.getContext('2d').getImageData(0,0,720,1280).data;let count=0,max=0,first=[];
    for(let i=0;i<a.length;i++)if(a[i]!==b[i]){count++;max=Math.max(max,Math.abs(a[i]-b[i]));if(first.length<10)first.push([i,a[i],b[i]]);}
    window.editorLiveFailure={actual:document.getElementById('editorCanvas').toDataURL(),reference:entry.png,details:{count,max,first,style:ShortsEditor.backupSnapshot().style,text:ShortsEditor.backupSnapshot().scenes[0].text,time:document.getElementById('editorCanvas').dataset.timeMs}};
    throw Error('Actual UI pixels differ from independently accepted '+entry.name+' '+JSON.stringify(editorLiveFailure.details));
   }count++;
 }
 const attached=document.createElement('canvas');attached.width=720;attached.height=1280;attached.style.fontSynthesis='none';document.body.append(attached);
 try{const video=ShortsRenderAdapters.fromVideo(ShortsVideoCore.demo());ShortsVideoRenderer.render(attached,video,0);const before=await editorLiveHash(attached);ShortsVideoRenderer.render(attached,ShortsRenderAdapters.fromEditor(ShortsEditor.backupSnapshot()),0);if(attached.style.fontSynthesis!=='none'||await editorLiveHash(attached)!==await editorLiveHash())throw Error('Recorder Canvas inherited noncanonical font synthesis');ShortsVideoRenderer.render(attached,video,0);if(await editorLiveHash(attached)!==before)throw Error('Editor polluted the reused Video Canvas');}finally{attached.remove();}
 return {combinations:count,comparison:'actual UI RGBA exactly matches independently SVG-validated profiles'};
};
window.editorLiveFrameReference=async function(payload){
 const p=ShortsEditor.backupSnapshot(),plan=ShortsRenderAdapters.fromEditor(p),images=new Map(),cleanup=[];
 try{
  for(const f of payload.filter(f=>f.type.startsWith('image/'))){const blob=new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type}),decoded=await ShortsVideoMedia.decodeImage(blob);cleanup.push(decoded);for(const scene of p.scenes)if(scene.imageName===f.name)images.set(scene.imageId,decoded.image);}
  const ref=document.createElement('canvas');ref.width=720;ref.height=1280;
  for(const row of plan.timeline)for(const t of [row.startMs,Math.min(row.endMs-1,row.startMs+100),row.endMs-1]){
   await editorLiveSeek(t,row.id);ShortsVideoRenderer.render(ref,plan,t,{images});if(await editorLiveHash()!==await editorLiveHash(ref))throw Error('UI/recorder frame mismatch at '+t);
   const data=document.getElementById('editorCanvas').getContext('2d').getImageData(0,0,720,1280).data;let light=0;for(let i=0;i<data.length;i+=400)light+=data[i]+data[i+1]+data[i+2];if(light<20000)throw Error('Black UI frame at '+t);
  }return true;
 }finally{for(const image of cleanup)image.dispose();}
};
