"""Native Safari data safety assertions; fresh origin and test-owned databases."""
import base64
import hashlib
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from editor_timing_native import check_native_editor_timing
from editor_live_native import check_native_editor_live


def check_native_studio_data(root,script,command):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*_args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    def async_script(code,args=None):
        result=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(result=>done({result}),e=>done({failure:e.message}));','args':args or []})
        assert not result.get('failure'),result
        return result.get('result')
    try:
        command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/tests/fixtures/backup-seed.html'})
        for path in ['js/core.js','js/video-core.js','tests/fixtures/studio-safety/project-db-1.4.0.js']:script((root/path).read_text())
        script('window.LegacyProjectDB=ShortsProjectDB;')
        for path in ['js/project-db.js','tests/studio-data-fixture.js']:script((root/path).read_text())
        baseline=json.loads((root/'tests/fixtures/studio-safety/projects-1.4.0.json').read_text())
        result=async_script('return await testStudioDataSafety(arguments[0],arguments[1]);',[baseline,media_payload()]);assert result['databases']==4,result
        async_script('await seedStudioAdapterFixture(arguments[0]);return true;',[baseline]);script((root/'js/storage.js').read_text());assert async_script('return await testStudioAdapterSafety();')
        print('::notice title=Native Safari Studio data verified::'+json.dumps(result)+'; adapter rejects future head and incomplete ZIP.',flush=True)
        # A different origin avoids the deliberately unsupported adapter fixture.
        base=f'http://localhost:{server.server_port}/'
        command('POST','/url',{'url':base+'tests/fixtures/backup-seed.html'})
        for path in ['js/core.js','js/video-core.js','js/project-db.js','tests/studio-data-fixture.js']:script((root/path).read_text())
        seed=async_script('return await seedStudioUiFixture(arguments[0],arguments[1]);',[baseline,media_payload()])
        command('POST','/url',{'url':base+'index.html'})
        async_script('const until=Date.now()+10000;while(!window.ShortsVideoRestored||!window.ShortsEditor){if(Date.now()>until)throw Error("Studio UI restore timeout");await new Promise(r=>setTimeout(r,50));}return true;')
        script((root/'tests/studio-data-fixture.js').read_text())
        assert script('return ShortsEditor.backupSnapshot();')==seed['editor']
        text=seed['editor']['script']+'\nРедактирование DTO 2 в Safari.'
        script('scriptText.value=arguments[0];scriptText.dispatchEvent(new Event("input",{bubbles:true}));',[text])
        assert async_script('return await waitForStudioUiSave(arguments[0]);',[{'script':text,'sceneText':seed['editor']['scenes'][0]['text']}])
        before=async_script('return await studioUiSnapshot();');expected=seed['editor'];expected['script']=text;expected['updatedAt']=before['editor']['updatedAt'];assert before['editor']==expected and before['video']==seed['video']
        for f in media_payload():assert before['hashes']['ui-'+f['name']]==hashlib.sha256(base64.b64decode(f['base64'])).hexdigest()
        command('POST','/url',{'url':base+'index.html'})
        async_script('await ShortsEditorReady;const until=Date.now()+10000;while(!window.ShortsVideoRestored){if(Date.now()>until)throw Error("Studio reload timeout");await new Promise(r=>setTimeout(r,50));}return true;')
        script((root/'tests/studio-data-fixture.js').read_text());assert async_script('return await studioUiSnapshot();')==before
        print('::notice title=Native Safari Studio DTO reload verified::DTO 2 original settings and both independent drafts survive real UI autosave/reload; PNG/JPG/WebP/voice/music SHA-256 match original bytes.',flush=True)
        recovery=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
        threading.Thread(target=recovery.serve_forever,daemon=True).start()
        try:
            command('POST','/url',{'url':f'http://127.0.0.1:{recovery.server_port}/tests/fixtures/backup-seed.html'})
            for path in ['js/core.js','js/video-core.js','js/project-db.js','tests/studio-data-fixture.js']:script((root/path).read_text())
            async_script('await seedStudioRecoveryFixture(arguments[0],arguments[1]);return true;',[baseline,media_payload()]);script((root/'js/storage.js').read_text())
            assert async_script('return await testStudioRecoverySafety(arguments[0]);',[baseline])
            print('::notice title=Native Safari recovery verified::Missing version in a corrupt head still recovers both known previous states, commits edits and retains the original image; explicitly future DTO versions remain blocked.',flush=True)
        finally:recovery.shutdown();recovery.server_close()
        check_native_editor_timing(root,script,command)
        check_native_editor_live(root,script,command)


    finally:server.shutdown();server.server_close()
