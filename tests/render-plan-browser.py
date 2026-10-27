"""Pixel-identical renderer against pre-refactor code; canonical and legacy API."""
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
    def log_message(self,*_args):pass


def selected_cases():
    data=json.loads((ROOT/'tests/fixtures/render-plan/legacy-plans.json').read_text())
    names=['mystery-accent','space-classic','sunrise-outline','neon-accent','fractional-manual','automatic-filtered']
    return [{'name':f['name'],'draft':f['draft']} for f in data['cases'] if f['name'] in names]


def run():
    engine=os.environ.get('RENDER_BROWSER','chromium');entry=os.environ.get('RENDER_ENTRY','index.html')
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            options={} if engine=='webkit' else {'executable_path':os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),'args':['--no-sandbox']}
            browser=getattr(p,engine).launch(**options);context=browser.new_context();page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            if entry.startswith('downloads/'):
                # Only this HTML is served. Runtime network dependencies are errors.
                path=(ROOT/entry).resolve();page.route('**/*',lambda route:route.fulfill(body=path.read_bytes(),content_type='text/html') if route.request.url.endswith('/offline.html') else route.abort());url='http://127.0.0.1/offline.html'
            else:url=f'http://127.0.0.1:{server.server_port}/{entry}'
            page.goto(url);page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored')
            page.evaluate('window.CurrentVideoCore=ShortsVideoCore;window.CurrentVideoRenderer=ShortsVideoRenderer;')
            page.add_script_tag(content=(ROOT/'tests/fixtures/render-plan/video-core-before.js').read_text());page.add_script_tag(content=(ROOT/'tests/fixtures/render-plan/video-renderer-before.js').read_text());page.evaluate('window.LegacyVideoCore=ShortsVideoCore;window.LegacyVideoRenderer=ShortsVideoRenderer;window.ShortsVideoCore=CurrentVideoCore;window.ShortsVideoRenderer=CurrentVideoRenderer;')
            page.add_script_tag(content=(ROOT/'tests/render-plan-fixture.js').read_text());result=page.evaluate('([cases,payload])=>testRenderPlanPixels(cases,payload)',[selected_cases(),media_payload()]);assert result['frames']>=40,result
            assert not errors,errors;context.close();browser.close();print(f'PASS [{engine} RenderPlan {entry}]: '+json.dumps(result),flush=True)
    finally:server.shutdown();server.server_close()


if __name__=='__main__':run()
