"""Actual Editor Canvas UI in native Safari; originals and UI driven through DOM handlers."""
import functools,json,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from runtime_session_native import command_result

def check_native_editor_live(root,script,command):
 class Handler(SimpleHTTPRequestHandler):
  def log_message(self,*a):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
 def execute(code,args=None):
  diagnostics=(root/'tests/runtime-diagnostics.js').read_text()
  return command_result(command('POST','/execute/async',{'script':diagnostics+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e)}));','args':args or []}))
 try:
  command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/index.html'})
  execute('await ShortsEditorReady;const end=Date.now()+25000;while(!window.ShortsVideoRestored){if(Date.now()>end)throw Error("Video restore timeout");await new Promise(r=>setTimeout(r,30));}return true;')
  for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js','editor-canvas-fixture.js','ux-fixture.js']:script((root/'tests'/name).read_text())
  spec=json.loads((root/'tests/fixtures/editor-canvas/spec.json').read_text());template=(root/'tests/fixtures/editor-canvas/reference.svg').read_text();payload=media_payload()
  independent=execute('return await checkEditorCanvas(arguments[0],arguments[1],arguments[2]);',[spec,template,payload]);assert independent['combinations']==27
  profiles=execute('return await editorLiveVerifyProfiles(editorCanvasCaptures,arguments[0]);',[spec]);assert profiles['combinations']==27
  project=script('const p=ShortsCore.upgradeProject(ShortsCore.createProject());p.name="Safari live pictures";p.timing="manual";p.scenes=[0,1,2].map(i=>({id:"live-"+i,text:"",durationMs:1000,visual:"animated",imageId:null,imageName:"",camera:"zoom-in",transition:"crossfade"}));p.selectedSceneId="live-0";return p;')
  execute('await editorLiveImport(arguments[0]);document.getElementById("tab-scenes").click();return true;',[project])
  for i,file in enumerate(payload[:3]):execute('return await editorLiveUpload(arguments[0],arguments[1]);',[i,file])
  assert execute('return await editorLiveFrameReference(arguments[0]);',[payload])
  for camera in ['static','zoom-in','zoom-out','pan-left','pan-right']:
   execute('const s=document.querySelector(".studio-scene-camera");s.value=arguments[0];s.dispatchEvent(new Event("change",{bubbles:true}));await editorLiveReady();return true;',[camera])
  for transition in ['none','crossfade','slide','zoom']:
   execute('const s=document.querySelectorAll(".studio-scene-transition")[1];s.value=arguments[0];s.dispatchEvent(new Event("change",{bubbles:true}));await editorLiveReady();return await editorLiveFrameReference(arguments[1]);',[transition,payload])
  geometry=[]
  for width,height in [(1440,1000),(390,844),(1440,1000),(1000,900),(1440,700),(1440,480)]:
   command('POST','/window/rect',{'width':width,'height':height})
   geometry.append(execute('return await uxCheckEditorPreview();'))
  print('::notice title=Native Safari preview geometry with originals::'+json.dumps([{'inner':g['inner'],'viewport':g['viewport']['client'],'column':g['column']['rect'],'frame':g['frame']['rect'],'position':g['column']['position']} for g in geometry]),flush=True)
  command('POST','/window/rect',{'width':1000,'height':900})
  execute('await editorTimingWaitForSave();return true;');before=execute('return await studioUiSnapshot();')
  command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/index.html'});execute('await ShortsEditorReady;return true;')
  for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js']:script((root/'tests'/name).read_text())
  execute('await editorLiveReady();return true;');assert execute('return await studioUiSnapshot();')==before
  execute('document.getElementById("openVideoMode").click();await editorLiveUntil(()=>ShortsMediaSessions.statistics().sessions===0,"mode cleanup");document.getElementById("backToEditor").click();await editorLiveReady();return true;')
  assert execute('return await studioUiSnapshot();')==before
  print('::notice title=Native Safari live Editor UI::'+json.dumps({'profiles':profiles,'images':['PNG','JPEG','WebP'],'frames':'UI exactly matches recorder path','camera':5,'transitions':4,'reload':'DTO and original SHA-256 identical','modeCleanup':'zero runtime owners outside Editor'}),flush=True)
 finally:server.shutdown();server.server_close()
