"""Exact old/new Canvas pixels and explicit manual-style refusal in native Safari."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload


def check_native_render_plan(root,script,command):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*_args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
    def run_async(code,args=None):
        result=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(result=>done({result}),e=>done({failure:e.message}));','args':args or []})
        assert not result.get('failure'),result
        return result.get('result')
    try:
        command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/index.html'})
        run_async('const until=Date.now()+10000;while(!window.ShortsEditor||!window.ShortsVideoRestored){if(Date.now()>until)throw Error("RenderPlan startup timeout");await new Promise(r=>setTimeout(r,50));}return true;')
        script('window.CurrentVideoCore=ShortsVideoCore;window.CurrentVideoRenderer=ShortsVideoRenderer;')
        for file in ['video-core-before.js','video-renderer-before.js']:script((root/'tests/fixtures/render-plan'/file).read_text())
        script('window.LegacyVideoCore=ShortsVideoCore;window.LegacyVideoRenderer=ShortsVideoRenderer;window.ShortsVideoCore=CurrentVideoCore;window.ShortsVideoRenderer=CurrentVideoRenderer;')
        script((root/'tests/render-plan-fixture.js').read_text())
        names=['mystery-accent','space-classic','sunrise-outline','neon-accent','fractional-manual','automatic-filtered']
        golden=json.loads((root/'tests/fixtures/render-plan/legacy-plans.json').read_text());cases=[{'name':f['name'],'draft':f['draft']} for f in golden['cases'] if f['name'] in names]
        result=run_async('return await testRenderPlanPixels(arguments[0],arguments[1]);',[cases,media_payload()]);assert result['frames']>=40,result
        print('::notice title=Native Safari RenderPlan verified::'+json.dumps(result),flush=True)
    finally:server.shutdown();server.server_close()
