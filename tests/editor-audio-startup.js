// Native WebDriver navigation can return before application globals exist.
// Inspect the actual document and await the actual restore Promise; never
// treat a missing global, previous page or failed restore as a ready app.
async function editorAudioStartup(expected, {timeoutMs=25000,poll=()=>new Promise(r=>setTimeout(r,30))}={}) {
 const end=Date.now()+timeoutMs;
 while(!window.ShortsEditorReady||!window.ShortsEditor||!window.ShortsVideoRestored||document.body?.inert){
  if(Date.now()>end)throw Error('Editor audio startup timeout '+JSON.stringify({expected,url:location.href,readyState:document.readyState,title:document.title,inert:document.body?.inert,scripts:document.scripts.length,modules:Object.fromEntries(['ShortsCore','ShortsStorage','ShortsEditorReady','ShortsEditor','ShortsVideoRestored','ShortsEditorAudio'].map(k=>[k,typeof window[k]]))}));
  await poll();
 }
 if(location.href!==expected)throw Error('Editor audio expected '+expected+' but opened '+location.href);
 await window.ShortsEditorReady;
 return true;
}
