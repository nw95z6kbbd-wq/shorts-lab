"""New runtime APIs with real originals/decoders, gated races and real export."""
import base64
import functools
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from backup_assets import media_payload

ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*_args):pass

def run():
    engine=os.environ.get('RUNTIME_BROWSER','chromium');entry=os.environ.get('RUNTIME_ENTRY','index.html')
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/'
    try:
        with sync_playwright() as p:
            launch={} if engine=='webkit' else {'executable_path':os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),'args':['--no-sandbox']}
            mobile=os.environ.get('RUNTIME_MOBILE')=='1'
            context_options={'viewport':{'width':390,'height':844},'is_mobile':True,'has_touch':True,'device_scale_factor':2} if mobile else {}
            browser=getattr(p,engine).launch(**launch);context=browser.new_context(**context_options);page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(base+'tests/fixtures/backup-seed.html')
            for name in ('core.js','video-core.js','project-db.js','storage.js'):page.add_script_tag(content=(ROOT/'js'/name).read_text())
            page.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text());page.evaluate('files=>seedBackupFixture(files,2)',media_payload())
            if entry.startswith('downloads/'):
                def offline(route):
                    url=route.request.url
                    if url==base+'offline.html':route.fulfill(body=(ROOT/entry).read_bytes(),content_type='text/html')
                    elif url.startswith(('blob:','data:')):route.continue_()
                    else:route.abort()
                page.route('**/*',offline);url=base+'offline.html'
            else:url=base+entry
            page.goto(url);page.wait_for_function('window.ShortsVideoRestored && window.ShortsRenderSessions')
            for file in ('backup-fixture.js','runtime-diagnostics.js','runtime-session-fixture.js'):page.add_script_tag(content=(ROOT/'tests'/file).read_text())
            page.evaluate('prepareRuntimeSessionChecks()');page.locator('#runtimeAudioStart').click();assert page.evaluate('runtimeAudioPromise')
            page.locator('#runtimeRecordStart').click();result=page.evaluate('finishRuntimeSessionChecks()')
            if not result['recording'].get('skipped'):
                data=page.evaluate('async()=>{const r=new FileReader();const done=new Promise((resolve,reject)=>{r.onload=()=>resolve(r.result.slice(r.result.lastIndexOf(",")+1));r.onerror=reject;});r.readAsDataURL(runtimeRecordedBlob);return done;}')
                spec=importlib.util.spec_from_file_location('runtime_media',ROOT/'tests/media-browser.py');media=importlib.util.module_from_spec(spec);spec.loader.exec_module(media)
                with tempfile.TemporaryDirectory(prefix='runtime-export-') as folder:
                    file=Path(folder)/'runtime.webm';file.write_bytes(base64.b64decode(data));media.checks.verify_video(file,6,audio=True);voice,music=media.spectrum(file,1);assert voice>.015 and music>.01,(voice,music);media.no_black_frames(file)
            assert not errors,errors;context.close();browser.close();print(f'::notice title=Runtime sessions verified::PASS [{engine} {entry} mobile={mobile}]: '+json.dumps(result),flush=True)
    finally:server.shutdown();server.server_close()

if __name__=='__main__':run()
