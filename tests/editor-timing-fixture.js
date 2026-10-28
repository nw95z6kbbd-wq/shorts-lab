/* Shared assertions in real Chromium, WebKit and Native Safari; test-owned origins only. */
window.seedEditorTimingFixture = async function(baseline,payload,version=2,count=3){
 const seed=await seedStudioUiFixture(baseline,payload),r=ShortsProjectDB.createRepository(),record=await r.read('editor');
 let editor=version===1?structuredClone(baseline.editor):seed.editor;
 editor.scenes=editor.scenes.slice(0,3);editor.scenes.forEach((s,i)=>{s.text=['один два','три четыре пять','шесть семь восемь девять'][i];if(version===2)s.durationMs=[1234,null,2345][i];});
 if(count===5000)editor.scenes=Array.from({length:5000},(_,i)=>({...editor.scenes[i%3],id:'large-'+i,text:'сцена '+i}));
 editor.selectedSceneId=editor.scenes[1].id;if(version===2)editor.subtitles.enabled=true;
 await r.save('editor',editor,record.revision);r.close();return {editor,video:seed.video};
};
window.editorTimingAssert = function(){
 const check=(ok,msg)=>{if(!ok)throw Error('Editor UI timing: '+msg);};
 const project=ShortsEditor.backupSnapshot(),compiled=ShortsEditorTiming.compile(project),plan=ShortsRenderAdapters.fromEditor(project);
 check(JSON.stringify(compiled.plan)===JSON.stringify(plan),'adapter plan differs');
 check(document.getElementById('totalDuration').dataset.durationMs===String(plan.durationMs),'total dataset');
 check(document.getElementById('totalDuration').textContent===ShortsEditorTiming.clock(plan.durationMs),'total exact label');
 check(document.getElementById('previewDuration').dataset.durationMs===String(plan.durationMs),'DOM preview total');
 const cards=[...document.querySelectorAll('#sceneList .scene-card')];check(cards.length===project.scenes.length,'card count');
 cards.forEach((card,i)=>{const scene=project.scenes[i],row=compiled.byId.get(scene.id);check(card.dataset.sceneId===scene.id,'source order '+i);
  for(const key of ['startMs','endMs','durationMs'])check(card.dataset[key]===String(row[key]),key+' '+i);
  check(card.querySelector('.scene-timing').textContent===ShortsCore.srtTime(row.startMs)+' → '+ShortsCore.srtTime(row.endMs)+' · '+ShortsEditorTiming.seconds(row.durationMs)+' сек','exact scene label '+i);
 });
 if(!document.getElementById('pane-subtitles').hidden){
  const cues=[...document.querySelectorAll('#subtitleList .subtitle-cue')];check(cues.length===plan.cues.length,'cue count');
  cues.forEach((cue,i)=>{check(cue.dataset.startMs===String(plan.cues[i].startMs)&&cue.dataset.endMs===String(plan.cues[i].endMs),'cue bounds '+i);});
 }
 check(document.querySelectorAll('.scene-card.selected').length===(project.selectedSceneId?1:0),'selected card');
 check(!project.selectedSceneId||document.querySelector('.scene-card.selected').dataset.sceneId===project.selectedSceneId,'stable selection');
 return {project,plan,srt:ShortsRenderPlan.generateSrt(plan)};
};
window.editorTimingWaitForSave = async function(){
 const expected=ShortsEditor.backupSnapshot(),r=ShortsProjectDB.createRepository(),deadline=Date.now()+15000;
 try{while(Date.now()<deadline){const head=await r.read('editor');if(JSON.stringify(head?.state)===JSON.stringify(expected))return head;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Editor timing autosave did not commit expected full DTO');}finally{r.close();}
};
window.editorTimingErrorAssert = async function(before){
 if(document.getElementById('editorTimingError').hidden)throw Error('Timing error is hidden');
 if(!document.getElementById('exportSrt').disabled||document.getElementById('totalDuration').textContent!=='—')throw Error('Stale timing/export remains enabled');
 let blocked=false;try{ShortsEditor.backupSnapshot();}catch(e){blocked=true;}if(!blocked)throw Error('Incomplete ZIP snapshot must be rejected');
 await new Promise(r=>setTimeout(r,450));const actual=await studioUiSnapshot();
 if(JSON.stringify(actual)!==JSON.stringify(before))throw Error('Invalid draft changed saved projects or original media');return true;
};
// Native driver cannot capture downloads. Inspect the actual button handler's
// Blob independently of the calculation assertions, retaining the real download.
window.editorTimingCaptureSrt = async function(buttonId){
 const original=URL.createObjectURL,blobs=[];URL.createObjectURL=function(blob){blobs.push(blob);return original.call(this,blob);};
 try{document.getElementById(buttonId).click();if(blobs.length!==1)throw Error('SRT button did not create one Blob');const text=await blobs[0].text(),expected=editorTimingAssert().srt;if(text!==expected)throw Error('Downloaded SRT differs from RenderPlan');return text;}finally{URL.createObjectURL=original;}
};
