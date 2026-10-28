/* Test-only: transport plain diagnostics, never a native Error/Event object. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ShortsRuntimeDiagnostics=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function failure(error,depth=0){
    const read=key=>{try{const value=error?.[key];return value==null?null:String(value);}catch(_){return '[unreadable '+key+']';}};
    let fallback;try{fallback=String(error);}catch(_){fallback='[unprintable rejection]';}
    const result={name:read('name')||typeof error,message:read('message')||fallback,code:read('code'),stack:read('stack')};
    try{if(depth<2&&error?.cause!=null&&error.cause!==error)result.cause=failure(error.cause,depth+1);}catch(_){}
    return result;
  }
  return {failure};
});
