"""The same runtime integration consumer, real Safari and real trusted clicks."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload

def command_result(result):
    assert isinstance(result,dict) and result.get('ok') is True,json.dumps(result,ensure_ascii=False)
    return result.get('value')


def check_native_runtime(root,script,command,click):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*_args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/'
    diagnostics=(root/'tests/runtime-diagnostics.js').read_text()
    def execute(code,args=None):
        result=command('POST','/execute/async',{'script':diagnostics+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e),runtime:window.runtimeSessionDiagnostics?.()}));','args':args or []})
        return command_result(result)
    try:
        command('POST','/url',{'url':base+'tests/fixtures/backup-seed.html'})
        for name in ('core.js','video-core.js','project-db.js','storage.js'):script((root/'js'/name).read_text())
        script((root/'tests/backup-fixture.js').read_text());execute('await seedBackupFixture(arguments[0],2);return true;',[media_payload()])
        command('POST','/url',{'url':base+'index.html'})
        execute('await ShortsEditorReady;while(!window.ShortsVideoRestored)await new Promise(r=>setTimeout(r,20));return true;')
        for name in ('backup-fixture.js','runtime-session-fixture.js'):script((root/'tests'/name).read_text())
        execute('return await prepareRuntimeSessionChecks();');click('#runtimeAudioStart');assert execute('return await runtimeAudioPromise;')
        click('#runtimeRecordStart');result=execute('return await finishRuntimeSessionChecks();');assert not result['recording'].get('skipped'),result
        print('::notice title=Native Safari runtime verified::'+json.dumps(result),flush=True)
    finally:server.shutdown();server.server_close()
