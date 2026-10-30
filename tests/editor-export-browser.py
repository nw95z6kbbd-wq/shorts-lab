"""Real Editor export consumer, byte inspector, independent FFmpeg and originals."""
import base64,functools,json,os,shutil,tempfile,threading,subprocess
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from backup_assets import media_payload
from editor_recording_evidence import inspect_recording
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass

from editor_export_checks import verify_file

def run():
 engine=os.environ.get('EXPORT_BROWSER','chromium');entry=os.environ.get('EXPORT_ENTRY','index.html')
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/'
 try:
  with sync_playwright() as p,tempfile.TemporaryDirectory(prefix='studio-export-') as folder:
   options={} if engine=='webkit' else {'executable_path':os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),'args':['--no-sandbox']}
   browser=getattr(p,engine).launch(**options);page=browser.new_page(viewport={'width':390,'height':844} if os.environ.get('EXPORT_MOBILE')=='1' else {'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   if entry.startswith('downloads/'):
    def offline(route):
     if route.request.url.endswith('/offline.html'):route.fulfill(body=(ROOT/entry).read_bytes(),content_type='text/html')
     elif route.request.url.startswith(('blob:','data:')) or (os.environ.get('EXPORT_FILE')=='1' and route.request.url==(ROOT/entry).as_uri()):route.continue_()
     else:route.abort()
    page.route('**/*',offline);page.goto((ROOT/entry).as_uri() if os.environ.get('EXPORT_FILE')=='1' else base+'offline.html')
   else:page.goto(base+entry)
   print('::notice title=Editor export browser checkpoint::'+json.dumps({'phase':'navigation','engine':engine,'entry':entry,'file':os.environ.get('EXPORT_FILE'),'ready':page.evaluate('({state:document.readyState,video:typeof VideoEncoder,audio:typeof AudioEncoder,avc:document.createElement("video").canPlayType("video/mp4;codecs=avc1.42001f"),aac:document.createElement("video").canPlayType("video/mp4;codecs=avc1.42001f,mp4a.40.2")})')}),flush=True)
   page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert')
   for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js','editor-export-fixture.js']:page.add_script_tag(content=(ROOT/'tests'/name).read_text())
   support=page.evaluate('ShortsVideoRecorder.capabilities(true)')
   print('::notice title=Editor export capability checkpoint::'+json.dumps(support),flush=True)
   outcomes=[]
   for mode,audio in [('auto',True),('webm',True),('auto',False)]:
    available=page.evaluate('async ([mode,audio])=>{const native=mode==="auto"?await ShortsNativeMP4.support(audio):null,caps=ShortsVideoRecorder.capabilities(audio,mode);return {native:!!native,recorder:!!(caps.capture&&caps.mediaRecorder&&(!audio||caps.audio)&&ShortsEditorExport.formats(audio,mode).length)};}',[mode,audio])
    if not (available['native'] or available['recorder']):
     result=page.evaluate('async ([mode,audio])=>{const p=ShortsCore.upgradeProject(ShortsCore.createProject(true));p.exportSettings.format=mode;if(audio)p.audio.voice.assetId="capability-probe-voice";const before=JSON.stringify(p),saved=JSON.stringify(await studioUiSnapshot()),canvas=document.createElement("canvas");canvas.width=720;canvas.height=1280;const c=ShortsEditorExport.create();try{await c.prepare({project:p,canvas});throw Error("Unsupported encoder accepted");}catch(e){if(e.code!=="FORMAT")throw e;}finally{await c.dispose();}return before===JSON.stringify(p)&&saved===JSON.stringify(await studioUiSnapshot())&&ShortsMediaSessions.statistics().residentBytes===0;}',[mode,audio])
     assert result;print('::notice title=Editor export genuine format refusal::'+json.dumps({'engine':engine,'entry':entry,'mode':mode,'audio':audio,'unchanged':result}),flush=True);continue
    prepared=page.evaluate('args=>prepareEditorExportFixture(...args)',[media_payload(),{'format':mode,'audio':audio}]);page.locator('#editorExportStart').click()
    try:result=page.evaluate('finishEditorExportFixture()')
    except Exception:
     print('::error title=Editor export result diagnostics::'+json.dumps(page.evaluate('async()=>{const b=window.exportRawBlob;return {mode:exportOriginal.exportSettings.format,audio:!!exportOriginal.audio.voice.assetId,states:exportStates,streams:b?ShortsExportInspector.inspectBytes(new Uint8Array(await b.arrayBuffer())):null};}')),flush=True)
     raise
    data=page.evaluate('async()=>{const r=new FileReader();const done=new Promise((resolve,reject)=>{r.onload=()=>resolve(r.result.slice(r.result.lastIndexOf(",")+1));r.onerror=reject;});r.readAsDataURL(editorExportBlob);return done;}');path=Path(folder)/('export.'+result['extension']);path.write_bytes(base64.b64decode(data));evidence=verify_file(path,result,audio);outcomes.append(evidence)
    if mode=='auto' and audio and not any(t.startswith('video/mp4') for t in prepared['formats']):assert result['container']=='webm' and result['fallback']
    if mode=='webm':assert result['container']=='webm'
    if audio:assert page.evaluate('exerciseEditorExportErrors()')==['missing image','overflow','resource count']
    # Cancel a real native encoder, then prepare again; no successful partial file.
    page.evaluate('async()=>{await exportJob.prepare({project:exportOriginal,canvas:exportCanvas});exportStates=[];exportProgress=[];}');page.locator('#editorExportStart').click()
    page.evaluate('async()=>{const stopped=exportPromise.catch(e=>e);await editorLiveUntil(()=>exportProgress.some(p=>p.timeMs>=200),"native encoder advanced before cancellation");await exportJob.cancel();await stopped;exportCheck(!exportJob.status().hasResult,"cancel returned a partial video");exportCheck(ShortsMediaSessions.statistics().sessions===0,"cancel leak");}')
    page.evaluate('disposeEditorExportFixture()')
   assert not errors,errors;browser.close();print(f'PASS [{engine} {entry}]: actual available Editor encoders and genuine refusals, PNG/JPG/WebP, byte codecs, full FFmpeg decode, scene pixels/frequencies, cancel/restart/errors and unchanged persisted DTO/media; '+json.dumps(outcomes),flush=True)
 finally:server.shutdown();server.server_close()
if __name__=='__main__':run()
