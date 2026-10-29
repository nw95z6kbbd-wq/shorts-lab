"""Native Safari acceptance of real Editor audio, HTTP and file:// standalone."""
import functools,json,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from editor_audio_checks import check_editor_audio,audio_helpers
from runtime_session_native import command_result
def check_native_editor_audio(root,script,command,click):
 class Handler(SimpleHTTPRequestHandler):
  def log_message(self,*args):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
 diagnostics=(root/'tests/runtime-diagnostics.js').read_text()
 def execute(code,args=None):
  return command_result(command('POST','/execute/async',{'script':diagnostics+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e)}));','args':args or []}))
 def ready():
  execute('await ShortsEditorReady;const end=Date.now()+25000;while(!window.ShortsVideoRestored){if(Date.now()>end)throw Error("Video restore timeout");await new Promise(r=>setTimeout(r,30));}return true;')
  audio_helpers(root,script)
 try:
  for entry in [f'http://127.0.0.1:{server.server_port}/index.html',(root/'downloads/Shorts-Studio.html').as_uri()]:
   command('POST','/url',{'url':entry});ready()
   evidence=check_editor_audio(execute,click,media_payload());saved=evidence.pop('saved')
   command('POST','/url',{'url':entry});ready();execute('await editorAudioReady();await editorLiveReady();return true;');assert execute('return await studioUiSnapshot();')==saved
   click('.sidebar [data-backup-export]')
   archive=execute('''await editorLiveUntil(()=>!backupDownload.hidden,'ZIP ready');const blob=await(await fetch(backupDownload.href)).blob();const bundle=await ShortsBackupFormat.importArchive(blob);audioCheck(bundle.manifest.version===2,'ZIP2');return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.slice(r.result.lastIndexOf(',')+1));r.onerror=reject;r.readAsDataURL(blob);});''')
   click('#backupCancel')
   fresh=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=fresh.serve_forever,daemon=True).start()
   try:
    command('POST','/url',{'url':f'http://127.0.0.1:{fresh.server_port}/index.html'});ready()
    execute('''const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0))],'editor.shorts.zip',{type:'application/zip'}));backupFile.files=dt.files;backupFile.dispatchEvent(new Event('change',{bubbles:true}));await editorLiveUntil(()=>!backupConfirm.hidden,'ZIP validation');return true;''',[archive])
    click('#backupConfirm');ready();execute('await editorAudioReady();await editorLiveReady();return true;')
    restored=execute('return await studioUiSnapshot();')
    assert sorted(restored['hashes'].values())==sorted(saved['hashes'].values())
    for role in ['voice','music']:
     assert {k:v for k,v in restored['editor']['audio'][role].items() if k!='assetId'}=={k:v for k,v in saved['editor']['audio'][role].items() if k!='assetId'}
    assert [s['id'] for s in restored['editor']['scenes']]==[s['id'] for s in saved['editor']['scenes']]
    execute('await editorLiveSeek(0,"audio-scene-0");editorAudioTap();return true;');click('#playPreview');actual=execute('return await editorAudioPlaying();');assert actual['rms']>.0001,actual;click('#playPreview')
    evidence['zip']='ZIP2 actual UI into isolated origin; all original SHA-256 values and audio parameters match; actual restored sound'
   finally:fresh.shutdown();fresh.server_close()
   print('::notice title=Native Safari Editor audio verified::'+json.dumps({'entry':entry,**evidence}),flush=True)
 finally:server.shutdown();server.server_close()
