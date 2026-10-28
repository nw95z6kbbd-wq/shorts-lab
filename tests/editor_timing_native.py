"""Native Safari Editor UI timing; new origin, real handlers, no user data."""
import functools,json,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload


def check_native_editor_timing(root,script,command):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*_args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
    def execute(code,args=None):
        result=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(result=>done({result}),error=>done({failure:{message:String(error.message||error),code:error.code||null,stack:error.stack||null}}));','args':args or []})
        assert 'failure' not in result,result
        return result.get('result')
    def helpers():
        for name in ['studio-data-fixture.js','editor-timing-fixture.js']:script((root/'tests'/name).read_text())
    def ready():
        execute('await ShortsEditorReady;const deadline=Date.now()+20000;while(!window.ShortsVideoRestored||document.body.inert){if(Date.now()>deadline)throw Error("Editor timing restore timeout");await new Promise(r=>setTimeout(r,50));}return true;');helpers()
    def event(element,value,kind='input'):
        script('const n=document.querySelector(arguments[0]);n.focus();n.value=arguments[1];n.dispatchEvent(new Event(arguments[2],{bubbles:true}));',[element,value,kind])
    def check():return script('return editorTimingAssert();')
    def save():return execute('return await editorTimingWaitForSave();')
    try:
        base=f'http://127.0.0.1:{server.server_port}/';command('POST','/url',{'url':base+'tests/fixtures/backup-seed.html'})
        for name in ['core.js','video-core.js','project-db.js']:script((root/'js'/name).read_text())
        helpers();baseline=json.loads((root/'tests/fixtures/studio-safety/projects-1.4.0.json').read_text());seed=execute('return await seedEditorTimingFixture(arguments[0],arguments[1],2);',[baseline,media_payload()])
        command('POST','/url',{'url':base+'index.html'});ready();assert check()['project']==seed['editor']
        script('document.getElementById("tab-scenes").click();');before=execute('return await studioUiSnapshot();')
        selected=seed['editor']['selectedSceneId'];scene_map={s['id']:s for s in seed['editor']['scenes']}
        script('document.querySelectorAll(".scene-card")[1].querySelectorAll(".studio-move")[1].click();')
        state=check()['project'];assert state['selectedSceneId']==selected and {s['id']:s for s in state['scenes']}==scene_map;save()
        event('.studio-scene-duration','1,234');assert check()['project']['scenes'][0]['durationMs']==1234
        event('#editorTimingMode','reading','change');assert check()['plan']['timing']['policy']=='editor-reading'
        event('#editorTimingMode','manual','change');assert check()['project']['scenes'][0]['durationMs']==1234
        event('.studio-scene-duration','');assert check()['project']['scenes'][0]['durationMs'] is None;assert save()['state']['scenes'][0]['durationMs'] is None
        before_error=execute('return await studioUiSnapshot();')
        for invalid in ['-1','NaN','Infinity','0','1.0001','9007199254740.992']:
            event('.studio-scene-duration',invalid);assert execute('return await editorTimingErrorAssert(arguments[0]);',[before_error])
        transport=script('return editorTimingLastDiff;');assert transport['changeCount']==0,transport
        print('::notice title=Native Safari snapshot equality::All DTO values and original SHA-256 match; reordered object containers: '+str(transport['keyOrderCount']),flush=True)
        event('.studio-scene-duration','1.234');check();save()
        event('#scene-input-0','один два три четыре пять шесть семь 🌌');script('document.getElementById("tab-subtitles").click();');event('#editorSubtitleMode','chunks','change');check();save();assert execute('return await editorTimingCaptureSrt("exportSrtPanel");')
        before_error=execute('return await studioUiSnapshot();');script('document.getElementById("tab-scenes").click();');event('.studio-scene-duration','0.001');assert execute('return await editorTimingErrorAssert(arguments[0]);',[before_error])
        script('document.getElementById("tab-subtitles").click();');event('#editorSubtitleMode','scene','change');assert check()['project']['scenes'][0]['durationMs']==1;save()
        script('document.getElementById("editorSubtitlesEnabled").click();');assert check()['plan']['cues']==[];assert script('return document.getElementById("exportSrtPanel").disabled;')
        script('document.getElementById("editorSubtitlesEnabled").click();');save();after=execute('return await studioUiSnapshot();');assert before['video']==after['video'] and before['hashes']==after['hashes'];check()
        command('POST','/url',{'url':base+'index.html'});ready();assert execute('return await studioUiSnapshot();')==after;check()
        script('document.getElementById("tab-scenes").click();document.querySelectorAll("[data-backup-export]")[0].click();')
        bundle=execute('const until=Date.now()+20000;while(document.getElementById("backupDownload").hidden){if(Date.now()>until)throw Error(document.getElementById("backupError").textContent||"ZIP timeout");await new Promise(r=>setTimeout(r,50));}const b=await ShortsBackupFormat.importArchive(await(await fetch(document.getElementById("backupDownload").href)).blob());return {version:b.manifest.version,editor:b.projects.editor};')
        assert bundle['version']==2 and bundle['editor']==after['editor'];script('document.getElementById("backupCancel").click();')
        print('::notice title=Native Safari Editor timings verified::Actual UI handlers: manual/reading/fallback, reorder and stable media, exact RenderPlan labels/SRT Blob, invalid drafts and chunk errors leave both heads unchanged, disabled captions, reload and ZIP v2 preserve full DTO.',flush=True)
    finally:server.shutdown();server.server_close()
