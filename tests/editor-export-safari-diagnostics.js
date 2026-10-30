/* Failure-only native diagnosis; never used to rescue an export assertion. */
window.installEditorExportTrace=function(){
 // Observe public callbacks only. The compatibility test must use the actual
 // browser constructor, without Proxy/getSettings calls during native startup.
 const Original=ShortsVideoRecorder.record,trace=window.editorExportTrace={recorders:[],contexts:[],progress:[]};
 ShortsVideoRecorder.record=options=>{
  const policy=options.recordingPolicy?Object.freeze({...options.recordingPolicy,onContext:c=>{trace.contexts.push(c);options.recordingPolicy.onContext?.(c);}}):null;
  return Original({...options,recordingPolicy:policy,onFormat:type=>{trace.recorders.push({actual:type});options.onFormat?.(type);},onProgress:(fraction,ms)=>{trace.progress.push(ms);options.onProgress?.(fraction,ms);}});
 };
 return()=>{ShortsVideoRecorder.record=Original;};
};
