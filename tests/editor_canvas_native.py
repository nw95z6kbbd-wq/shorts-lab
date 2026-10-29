"""Canonical editor profiles and actual test-owned Editor recording in Safari."""
import functools
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from editor_canvas_diagnostics import save_editor_diagnostics
from runtime_session_native import command_result
from editor_recording_evidence import save_recording_evidence, assert_complete_recording, editor_frame_expectations
from safari_file_entry import prepare_native_file_entry

def check_native_editor_canvas(root,script,command,click):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start()
    diagnostics=(root/'tests/runtime-diagnostics.js').read_text()
    def execute(code,args=None):
        return command_result(command('POST','/execute/async',{'script':diagnostics+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e)}));','args':args or []}))
    grants=[]
    args=[json.loads((root/'tests/fixtures/editor-canvas/spec.json').read_text()),(root/'tests/fixtures/editor-canvas/reference.svg').read_text(),media_payload()]
    def check_recording(attempt):
        for name in ['runtime-session-fixture.js','editor-canvas-recording.js']:script((root/'tests'/name).read_text())
        execute('await prepareEditorCanvasRecording(arguments[0],{shortAudio:arguments[1]});return true;',[media_payload(),attempt==1]);click('#editorRecordProbe')
        try:
            execute('const r=await editorRecordingPromise;if(r.skipped)throw Error("Native Editor recording unavailable");window.editorRecordedBlob=r.blob;return true;')
            # VFR capture may hold a scene image across >100 ms. Decode the
            # actual file first; compare the browser callback with that frame's
            # true PTS while retaining the same seek target, RGB and tolerance.
            decoded=save_recording_evidence(root,script,command,'safari-frame-oracle-'+str(attempt))
            assert not decoded.get('inspectionError'),decoded
            expected=editor_frame_expectations(decoded['encoded'])
            recording=execute('return await finishEditorCanvasRecording(arguments[0]);',[expected])
        except Exception:
            try:
                save_recording_evidence(root,script,command,'safari-recording-failure-'+str(attempt))
            except Exception as diagnostic_error:
                print('::warning title=Editor diagnostic transport::'+str(diagnostic_error)[:800],flush=True)
            raise
        evidence=save_recording_evidence(root,script,command,'safari-recording-'+('http' if script('return location.protocol;')=='http:' else 'file')+'-'+str(attempt))
        assert not evidence.get('inspectionError'),evidence
        assert_complete_recording(evidence['encoded'])
        assert not recording.get('skipped'),recording
        print('::notice title=Native Safari Editor recording verified::'+json.dumps(recording),flush=True)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as summary:
                summary.write('\n### Editor Canvas — actual Safari recording\n\n```json\n'+json.dumps(recording,ensure_ascii=False,indent=2)+'\n```\n')
    try:
        for entry in [f'http://127.0.0.1:{server.server_port}/index.html',(root/'index.html').as_uri(),(root/'downloads/Shorts-Studio.html').as_uri()]:
            print('::notice title=Native Safari Editor Canvas entry::'+entry,flush=True)
            if entry.startswith('file:'):
                grants.append(prepare_native_file_entry(entry,command))
            command('POST','/url',{'url':entry})
            startup=execute('''const errors=[];addEventListener('error',e=>errors.push(e.message||e.target?.src||'script error'),true);addEventListener('unhandledrejection',e=>errors.push(ShortsRuntimeDiagnostics.failure(e.reason)));
              let editorReady='absent',observed;const observe=()=>{if(window.ShortsEditorReady&&observed!==window.ShortsEditorReady){observed=window.ShortsEditorReady;editorReady='pending';Promise.resolve(observed).then(()=>editorReady='ready',e=>{editorReady='rejected';errors.push(ShortsRuntimeDiagnostics.failure(e));});}};observe();
              // Existing storage bounds are 8 s open + 15 s transaction; do not race their failure reporting.
              const started=Date.now(),end=started+25000;while(!window.ShortsEditorCanvas||!window.ShortsVideoRestored){observe();if(Date.now()>end){const inline=[...document.scripts].find(s=>s.textContent.includes('window.ShortsEditorReady =')),appScript={index:inline?[...document.scripts].indexOf(inline):null,length:inline?.textContent.length||0,parse:null};if(inline)try{new Function(inline.textContent);appScript.parse='valid';}catch(e){appScript.parse=ShortsRuntimeDiagnostics.failure(e);}throw Error('Editor Canvas startup timeout '+JSON.stringify({appScript,inert:document.body?.inert,scriptCount:document.scripts.length,expected:arguments[0],url:location.href,title:document.title,readyState:document.readyState,editorReady,modules:Object.fromEntries(['ShortsCore','ShortsEditorProfile','ShortsRenderPlan','ShortsStorage','ShortsEditorReady','ShortsEditor','ShortsEditorCanvas','ShortsVideoRenderer','ShortsVideoRestored'].map(k=>[k,typeof window[k]])),errors,body:document.body?.innerText.slice(0,500)}));}await new Promise(r=>setTimeout(r,30));}if(location.href!==arguments[0])throw Error('Editor Canvas expected actual entry '+arguments[0]+' but got '+location.href);return {elapsedMs:Date.now()-started,url:location.href,storageWarning:document.getElementById('storageWarning')?.hidden?null:document.getElementById('storageWarning')?.textContent};''',[entry])
            script((root/'tests/editor-live-fixture.js').read_text())
            execute('await editorLiveReady();return true;')
            script((root/'tests/editor-canvas-fixture.js').read_text())
            try:
                result=execute('return await checkEditorCanvas(...arguments[0]);',[args])
            except Exception:
                save_editor_diagnostics(script('return window.editorCanvasFailure;'),'safari')
                raise
            assert result['combinations']==27,result
            save_editor_diagnostics(script('return window.editorCanvasBaselineProbe;'),'safari-baseline')
            count=execute('return await rejectEditorVisualMutants(...arguments[0]);',[args]);assert count==3,count
            evidence={'entry':entry,'startup':startup,'result':result,'visualCounterexamples':count}
            print('::notice title=Native Safari Editor Canvas verified::'+json.dumps(evidence),flush=True)
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as summary:
                    summary.write('\n### Editor Canvas — actual Safari entry\n\n```json\n'+json.dumps(evidence,ensure_ascii=False,indent=2)+'\n```\n')
            if entry.startswith('http:') or entry.endswith('/downloads/Shorts-Studio.html'):
                # Repeated measurements, not retry-on-failure: every recording
                # must satisfy the unchanged browser and full-byte assertions.
                for attempt in range(10):check_recording(attempt)
    finally:
        for grant in grants:grant.unlink(missing_ok=True)
        server.shutdown();server.server_close()
