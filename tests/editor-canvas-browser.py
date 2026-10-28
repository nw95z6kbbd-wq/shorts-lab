"""27 independent SVG/Canvas profiles, bounded large plans and offline packaging."""
import base64
import tempfile
import importlib.util
import functools
import json
import os
from pathlib import Path
import shutil
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from backup_assets import media_payload
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass

def run():
    engine=os.environ.get('EDITOR_BROWSER','chromium');entry=os.environ.get('EDITOR_ENTRY','index.html');mobile=os.environ.get('EDITOR_MOBILE')=='1'
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            options={} if engine=='webkit' else {'executable_path':os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),'args':['--no-sandbox']}
            browser=getattr(p,engine).launch(**options);context=browser.new_context(**({'viewport':{'width':390,'height':844},'is_mobile':True,'has_touch':True} if mobile else {}));page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            if entry.startswith('downloads/'):
                def offline(route):
                    if route.request.url.endswith('/offline.html'):route.fulfill(body=(ROOT/entry).read_bytes(),content_type='text/html')
                    elif route.request.url.startswith(('blob:','data:')):route.continue_()
                    else:route.abort()
                page.route('**/*',offline);url=f'http://127.0.0.1:{server.server_port}/offline.html'
            elif entry=='file':url=(ROOT/'index.html').as_uri()
            else:url=f'http://127.0.0.1:{server.server_port}/{entry}'
            page.goto(url);page.wait_for_function('window.ShortsEditorCanvas && window.ShortsVideoRestored')
            page.add_script_tag(content=(ROOT/'tests/editor-canvas-fixture.js').read_text())
            result=page.evaluate('args=>checkEditorCanvas(...args)',[json.loads((ROOT/'tests/fixtures/editor-canvas/spec.json').read_text()),(ROOT/'tests/fixtures/editor-canvas/reference.svg').read_text(),media_payload()]);assert result['combinations']==27 and not errors,(result,errors)
            counterexamples=page.evaluate('args=>rejectEditorVisualMutants(...args)',[json.loads((ROOT/'tests/fixtures/editor-canvas/spec.json').read_text()),(ROOT/'tests/fixtures/editor-canvas/reference.svg').read_text(),media_payload()]);assert counterexamples==3;result['visualCounterexamples']=counterexamples
            if os.environ.get('EDITOR_CAPTURES'):
                folder=Path(os.environ['EDITOR_CAPTURES']);folder.mkdir(parents=True,exist_ok=True)
                for item in page.evaluate('editorCanvasCaptures'):(folder/(item['name']+'.png')).write_bytes(base64.b64decode(item['png'].split(',',1)[1]))
            for name in ('runtime-session-fixture.js','editor-canvas-recording.js'):page.add_script_tag(content=(ROOT/'tests'/name).read_text())
            page.evaluate('payload=>prepareEditorCanvasRecording(payload)',media_payload());page.locator('#editorRecordProbe').click();recording=page.evaluate('finishEditorCanvasRecording()');result['recording']=recording
            if not recording.get('skipped'):
                data=page.evaluate('async()=>{const r=new FileReader();const ready=new Promise((resolve,reject)=>{r.onload=()=>resolve(r.result.slice(r.result.lastIndexOf(",")+1));r.onerror=reject;});r.readAsDataURL(editorRecordedBlob);return ready;}')
                spec_module=importlib.util.spec_from_file_location('editor_media',ROOT/'tests/media-browser.py');media=importlib.util.module_from_spec(spec_module);spec_module.loader.exec_module(media)
                with tempfile.TemporaryDirectory(prefix='editor-canvas-recording-') as folder:
                    video=Path(folder)/'editor.webm';video.write_bytes(base64.b64decode(data));media.checks.verify_video(video,3,audio=True);voice,music=media.spectrum(video,1);assert voice>.015 and music>.01,(voice,music);media.no_black_frames(video)
            assert not errors,errors
            print(f'::notice title=Editor Canvas verified::PASS [{engine} {entry} mobile={mobile}]: '+json.dumps(result),flush=True);context.close();browser.close()
    finally:server.shutdown();server.server_close()
if __name__=='__main__':run()
