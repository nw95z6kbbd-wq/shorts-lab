"""Actual Editor export with independently decoded visual/audio markers."""
import base64, functools, json, os, shutil, tempfile, threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from editor_av_markers import marker_payload, verify_markers
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def run():
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='editor-av-') as folder:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
            page=browser.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            entry=os.environ.get('EXPORT_ENTRY','index.html')
            page.goto(f'http://127.0.0.1:{server.server_port}/'+entry)
            page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert')
            for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js','editor-export-fixture.js']:
                page.add_script_tag(content=(ROOT/'tests'/name).read_text())
            for mode in ['auto','webm']:
                page.evaluate('args=>prepareEditorExportFixture(...args)',[marker_payload(),{'format':mode,'audio':True,'markers':True}])
                page.locator('#editorExportStart').click(); result=page.evaluate('finishEditorExportFixture()')
                data=page.evaluate('async()=>{const b=new Uint8Array(await editorExportBlob.arrayBuffer());let s="";for(const c of b)s+=String.fromCharCode(c);return btoa(s);}')
                path=Path(folder)/('marker.'+result['extension']);path.write_bytes(base64.b64decode(data))
                print('PASS AV markers '+mode+' '+entry+': '+json.dumps(verify_markers(path)),flush=True)
                page.evaluate('disposeEditorExportFixture()')
            assert not errors,errors
            browser.close()
    finally:
        server.shutdown();server.server_close()
if __name__=='__main__': run()
