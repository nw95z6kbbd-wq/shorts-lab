"""Canonical editor profiles and actual test-owned Editor recording in Safari."""
import functools
import json
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from editor_canvas_diagnostics import save_editor_diagnostics
from runtime_session_native import command_result

def check_native_editor_canvas(root,script,command,click):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
    diagnostics=(root/'tests/runtime-diagnostics.js').read_text()
    def execute(code,args=None):
        return command_result(command('POST','/execute/async',{'script':diagnostics+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e)}));','args':args or []}))
    args=[json.loads((root/'tests/fixtures/editor-canvas/spec.json').read_text()),(root/'tests/fixtures/editor-canvas/reference.svg').read_text(),media_payload()]
    try:
        for entry in [f'http://127.0.0.1:{server.server_port}/index.html',(root/'index.html').as_uri(),(root/'downloads/Shorts-Studio.html').as_uri()]:
            print('::notice title=Native Safari Editor Canvas entry::'+entry,flush=True)
            if entry.startswith('file:'):
                # LaunchServices performs the normal user document-open handoff,
                # granting Safari access to this specific local test document.
                # WebDriver alone cannot mint that macOS sandbox extension.
                from urllib.parse import unquote, urlparse
                subprocess.run(['/usr/bin/open','-g','-a','Safari',unquote(urlparse(entry).path)],check=True)
            command('POST','/url',{'url':entry})
            execute('''const errors=[];addEventListener('error',e=>errors.push(e.message||e.target?.src||'script error'),true);addEventListener('unhandledrejection',e=>errors.push(ShortsRuntimeDiagnostics.failure(e.reason)));
              let editorReady='absent';if(window.ShortsEditorReady)Promise.resolve(ShortsEditorReady).then(()=>editorReady='ready',e=>{editorReady='rejected';errors.push(ShortsRuntimeDiagnostics.failure(e));});
              const end=Date.now()+15000;while(!window.ShortsEditorCanvas||!window.ShortsVideoRestored){if(Date.now()>end)throw Error('Editor Canvas startup timeout '+JSON.stringify({expected:arguments[0],url:location.href,title:document.title,readyState:document.readyState,editorReady,modules:Object.fromEntries(['ShortsCore','ShortsEditorProfile','ShortsRenderPlan','ShortsStorage','ShortsEditor','ShortsEditorCanvas','ShortsVideoRenderer','ShortsVideoRestored'].map(k=>[k,typeof window[k]])),errors,body:document.body?.innerText.slice(0,500)}));await new Promise(r=>setTimeout(r,30));}if(location.href!==arguments[0])throw Error('Editor Canvas expected actual entry '+arguments[0]+' but got '+location.href);return true;''',[entry])
            script((root/'tests/editor-canvas-fixture.js').read_text())
            try:
                result=execute('return await checkEditorCanvas(...arguments[0]);',[args])
            except Exception:
                save_editor_diagnostics(script('return window.editorCanvasFailure;'),'safari')
                raise
            assert result['combinations']==27,result
            save_editor_diagnostics(script('return window.editorCanvasBaselineProbe;'),'safari-baseline')
            count=execute('return await rejectEditorVisualMutants(...arguments[0]);',[args]);assert count==3,count
            print('::notice title=Native Safari Editor Canvas verified::'+json.dumps({'entry':entry,'result':result,'visualCounterexamples':count}),flush=True)
        for name in ['runtime-session-fixture.js','editor-canvas-recording.js']:script((root/'tests'/name).read_text())
        execute('await prepareEditorCanvasRecording(arguments[0]);return true;',[media_payload()]);click('#editorRecordProbe');recording=execute('return await finishEditorCanvasRecording();');assert not recording.get('skipped'),recording
        print('::notice title=Native Safari Editor recording verified::'+json.dumps(recording),flush=True)
    finally:server.shutdown();server.server_close()
