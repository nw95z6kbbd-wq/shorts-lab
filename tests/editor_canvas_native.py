"""Canonical editor profiles and actual test-owned Editor recording in Safari."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
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
            command('POST','/url',{'url':entry});execute('const end=Date.now()+15000;while(!window.ShortsEditorCanvas||!window.ShortsVideoRestored){if(Date.now()>end)throw Error("Editor Canvas startup timeout");await new Promise(r=>setTimeout(r,30));}return true;')
            script((root/'tests/editor-canvas-fixture.js').read_text());result=execute('return await checkEditorCanvas(...arguments[0]);',[args]);assert result['combinations']==27,result
            count=execute('return await rejectEditorVisualMutants(...arguments[0]);',[args]);assert count==3,count
            print('::notice title=Native Safari Editor Canvas verified::'+json.dumps({'entry':entry,'result':result,'visualCounterexamples':count}),flush=True)
        for name in ['runtime-session-fixture.js','editor-canvas-recording.js']:script((root/'tests'/name).read_text())
        execute('await prepareEditorCanvasRecording(arguments[0]);return true;',[media_payload()]);click('#editorRecordProbe');recording=execute('return await finishEditorCanvasRecording();');assert not recording.get('skipped'),recording
        print('::notice title=Native Safari Editor recording verified::'+json.dumps(recording),flush=True)
    finally:server.shutdown();server.server_close()
