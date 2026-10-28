"""Native macOS Safari smoke checks via safaridriver and the W3C WebDriver API.

Uses only Python's standard library; it does not substitute Chromium or a user-agent.
"""
import functools
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from backup_native import check_native_backup, wait_native_video
from studio_data_native import check_native_studio_data
from render_plan_native import check_native_render_plan
from render_guard import assert_render_stack
from runtime_session_native import check_native_runtime
from editor_canvas_native import check_native_editor_canvas

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run():
    if platform.system() != 'Darwin':
        raise RuntimeError('Настоящий Safari доступен только на macOS. Запустите задание Native Safari в GitHub Actions.')
    product = json.loads(subprocess.check_output(['node', '-e', 'process.stdout.write(JSON.stringify(require("./js/product.js")))'], cwd=ROOT))
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as port_socket:
        port_socket.bind(('127.0.0.1', 0)); port = port_socket.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    driver = None; session = None

    def request(method, endpoint, data=None):
        payload = None if data is None else json.dumps(data).encode('utf-8')
        req = urllib.request.Request(base + endpoint, data=payload, method=method, headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=45) as response: result = json.load(response)
        except urllib.error.HTTPError as error:
            text = error.read().decode('utf-8', errors='replace')
            raise RuntimeError('Safari WebDriver: ' + text[:1800]) from error
        value = result.get('value')
        if isinstance(value, dict) and value.get('error'): raise RuntimeError(str(value))
        return value

    def command(method, path, data=None): return request(method, '/session/' + session + path, data)
    def script(code, args=None): return command('POST', '/execute/sync', {'script':code, 'args':args or []})
    def wait_for(code, seconds=15):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if script('return Boolean(' + code + ');'): return
            time.sleep(.15)
        details=script('return {inert:document.body.inert,focus:document.hasFocus(),active:document.activeElement?.id,dialog:document.getElementById("productDialog")?.open};')
        raise AssertionError('Safari condition timed out: ' + code + '; ' + str(details))
    def element(selector):
        result=command('POST','/element',{'using':'css selector','value':selector})
        return result['element-6066-11e4-a52e-4f735466cecf']
    def click(selector):
        # Safari's element-click command does not reliably scroll nested dialogs.
        script('document.querySelector(arguments[0]).scrollIntoView({block:"nearest",inline:"nearest"});',[selector])
        command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];requestAnimationFrame(()=>done(true));','args':[]})
        try:
            command('POST','/element/'+element(selector)+'/click',{})
        except RuntimeError as error:
            details=script('const e=document.querySelector(arguments[0]),r=e.getBoundingClientRect(),d=document.getElementById("productDialog"),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);const parents=[];for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){const b=p.getBoundingClientRect();parents.push({tag:p.tagName,id:p.id,height:p.clientHeight,top:b.top,bottom:b.bottom,scroll:p.scrollTop,overflow:getComputedStyle(p).overflowY});}return {parents,selector:arguments[0],rect:{x:r.x,y:r.y,width:r.width,height:r.height},x,y,clickable:!e.matches(":disabled")&&r.width>0&&r.height>0&&(hit===e||e.contains(hit)),hit:hit?.tagName+"#"+hit?.id,display:getComputedStyle(e).display,dialog:d.open,aboutHidden:document.getElementById("productPane-about").hidden,active:document.activeElement?.id,scroll:document.querySelector(".product-dialog-scroll").scrollTop};',[selector])
            if 'element not interactable' in str(error) and details['clickable']:
                # A real trusted pointer click bypasses safaridriver's broken
                # nested-scroll element-click path; obscured controls still fail.
                command('POST','/actions',{'actions':[{'type':'pointer','id':'safari-pointer','parameters':{'pointerType':'mouse'},'actions':[{'type':'pointerMove','duration':0,'origin':'viewport','x':details['x'],'y':details['y']},{'type':'pointerDown','button':0},{'type':'pointerUp','button':0}]}]})
                return
            raise RuntimeError(str(details)+'; '+str(error)) from error

    try:
        with tempfile.TemporaryFile(mode='w+b') as log:
            driver = subprocess.Popen(['/usr/bin/safaridriver','-p',str(port)], stdout=log, stderr=subprocess.STDOUT)
            deadline=time.monotonic()+20
            while True:
                try: request('GET','/status'); break
                except Exception:
                    if time.monotonic()>deadline or driver.poll() is not None:
                        log.seek(0); raise RuntimeError('safaridriver did not start: '+log.read().decode('utf-8', errors='replace')[-2000:])
                    time.sleep(.2)
            result=request('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'safari'}}})
            session=result['sessionId']; capabilities=result['capabilities']
            assert capabilities['browserName'].lower()=='safari'
            print('Native Safari version:',capabilities.get('browserVersion'),flush=True)
            assert_render_stack(ROOT,(ROOT/os.environ['SAFARI_BASELINE_ROOT']).resolve() if os.environ.get('SAFARI_BASELINE_ROOT') else None)
            command('POST','/timeouts',{'script':30000,'pageLoad':30000,'implicit':0})
            command('POST','/window/rect',{'width':1000,'height':900})
            command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/index.html'})
            wait_for('window.ShortsProduct && window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert && document.getElementById("saveStatus").dataset.state',seconds=30)
            version=script('return ShortsProduct.version;'); assert version==product['version']
            assert script('return Array.from(document.querySelectorAll("[data-product-version]")).every(e=>e.textContent=== "v"+ShortsProduct.version);')
            before=script('return [localStorage.getItem("shorts-studio.project.v1"),localStorage.getItem("shorts-studio.video.v1")];')
            click('.product-nav [data-product-open="updates"]')
            wait_for('document.getElementById("productDialog").open')
            assert script('return document.querySelectorAll(".release-item").length;')==len(product['releases'])
            assert script('return Array.from(document.querySelectorAll(".release-heading time")).map(e=>e.dateTime);')==[release['date'] for release in product['releases'] if release['status']=='published']
            if product['releases'][0]['status']=='published':
                assert script('return document.querySelector(".release-item").dataset.status;')=='published'
                assert script('return document.querySelector(".release-item .release-badge").textContent;')=='ТЕКУЩАЯ'
                assert script('return !document.querySelector(".release-item .release-pending");')
            click('#productClose');command('POST','/refresh',{})
            wait_for('window.ShortsProduct && window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert && document.getElementById("saveStatus").dataset.state',seconds=30)
            assert script('return document.getElementById("productUpdateNotice").hidden;')
            click('.product-nav [data-product-open="about"]')
            assert script('return document.getElementById("productRepository").href;')==product['repository']
            assert script('return document.querySelector(".product-about-version [data-product-version]").textContent;')=='v'+product['version']
            if product['releases'][0]['status']=='published':
                assert script('return !document.getElementById("productPane-about").textContent.includes("Ещё не опубликовано");')
            assert script('return document.getElementById("productOwner").value;')==product['rights']['owner']
            script('document.getElementById("productOwner").value="Проверка Safari";')
            click('#productProfileForm button[type="submit"]')
            wait_for('document.getElementById("productProfileStatus").textContent.includes("Сохранено только")')
            assert 'Сохранено только' in script('return document.getElementById("productProfileStatus").textContent;')
            click('#productClose');command('POST','/refresh',{})
            wait_for('window.ShortsProduct && window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert && document.getElementById("saveStatus").dataset.state',seconds=30)
            click('.product-nav [data-product-open="about"]')
            assert script('return document.getElementById("productOwner").value;')=='Проверка Safari'
            click('#productResetProfile');click('#productClose')
            assert before==script('return [localStorage.getItem("shorts-studio.project.v1"),localStorage.getItem("shorts-studio.video.v1")];')
            print('PASS [native Safari]: version, dated release history, notice dismissal and local profile; project data unchanged',flush=True)
            assert script('return document.querySelectorAll(".studio-navigation .nav-group").length;')==2
            assert script('return document.querySelectorAll(".manual-nav [data-view]").length;')==3
            assert script('return document.querySelectorAll(".ai-nav button").length;')==1
            click('.manual-nav [data-view="script"]')
            script('const e=document.getElementById("projectName");e.value="Ручной Safari";e.dispatchEvent(new Event("input",{bubbles:true}));')
            click('#openVideoMode')
            assert script('return document.querySelectorAll(".manual-nav [aria-current]").length;')==0
            for text in ['Привет', 'Привет 🌌', 'Ёж e\u0301 👨‍👩‍👧‍👦']:
                script('const e=document.getElementById("videoIdea");e.value=arguments[0];e.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertFromPaste",data:arguments[0]}));',[text])
                expected=str(len(text.encode('utf-16-le'))//2)+' / '+str(script('return ShortsVideoCore.IDEA_LIMIT;'))+' символов'
                assert script('return document.getElementById("videoIdeaCounter").textContent;')==expected
            wait_for('document.getElementById("videoDraftStatus").textContent==="Сохранено на устройстве"')
            limit=script('return ShortsVideoCore.IDEA_LIMIT;')
            old_scenes=script('return document.getElementById("videoScenes").textContent;')
            script('const e=document.getElementById("videoIdea");e.value="я".repeat(ShortsVideoCore.IDEA_LIMIT+1);e.dispatchEvent(new Event("input",{bubbles:true}));')
            assert script('return document.getElementById("videoIdea").value.length;')==limit+1
            assert script('return document.getElementById("videoIdea").getAttribute("aria-invalid");')=='true'
            click('#generateIdea')
            assert script('return document.getElementById("videoScenes").textContent;')==old_scenes
            click('.manual-nav [data-view="scenes"]')
            assert script('return document.getElementById("projectName").value;')=='Ручной Safari'
            click('#openVideoMode')
            assert script('return document.getElementById("videoIdea").value.length;')==limit+1
            script('const e=document.getElementById("videoIdea");e.value="Исправленная идея Safari 🌌";e.dispatchEvent(new Event("input",{bubbles:true}));')
            wait_for('document.getElementById("videoDraftStatus").textContent==="Сохранено на устройстве"')
            click('.product-nav [data-product-open="updates"]')
            assert script('return Array.from(document.querySelectorAll(".release-item")).some(e=>e.dataset.importance==="highlight") && document.querySelectorAll(".release-standard").length>0 && document.querySelectorAll(".release-patch").length>0;')
            if product['releases'][0]['status']=='unreleased':
                assert script('return document.querySelector(".release-item .release-pending").textContent;')=='Ещё не опубликовано'
            else:
                assert script('return document.querySelector(".release-item time").dateTime;')==product['releases'][0]['date']
            click('#productClose');click('#backToEditor')
            print('PASS [native Safari patch UX]: grouped navigation, Unicode counter, untrimmed overflow, preserved manual/video inputs and three release significance levels and metadata-driven publication status',flush=True)

            command('POST','/window/rect',{'width':390,'height':844})
            assert script('return document.documentElement.scrollWidth <= innerWidth;')
            click('.product-nav [data-product-open="about"]')
            assert script('const d=document.getElementById("productDialog");return d.scrollWidth<=d.clientWidth;')
            click('#productClose')
            print('PASS [native Safari]: narrow desktop window layout; actual viewport width:',script('return innerWidth;'),flush=True)
            command('POST','/window/rect',{'width':1440,'height':1000})
            script((ROOT/'tests/ux-fixture.js').read_text())
            wait_for('document.getElementById("saveStatus").hidden',seconds=6)
            layout=script('return uxLayoutSnapshot();')
            command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];holdUXTransaction().then(()=>done(true),e=>done({error:e.message}));','args':[]})
            script('const e=document.getElementById("projectName");e.value="Safari toast";e.dispatchEvent(new Event("input",{bubbles:true}));')
            wait_for('document.getElementById("saveStatus").dataset.state==="pending"')
            time.sleep(.7)
            assert script('return uxLayoutSnapshot();')==layout
            assert script('return document.getElementById("saveStatusText").textContent;')=='Сохранение…'
            script('const v=document.getElementById("studioViewport");v.scrollTop=v.scrollHeight;')
            command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));','args':[]})
            print("::notice title=Native preview geometry::"+json.dumps(script("return uxPreviewSummary();")),flush=True)
            assert script('const r=document.querySelector(".preview-column").getBoundingClientRect();return r.top>=-1 && r.bottom<=document.getElementById("studioViewport").clientHeight+1;')
            assert not script('return uxToastOverlapsControls();')
            layout=script('return uxLayoutSnapshot();')
            script('window.uxHold=false;')
            wait_for('document.getElementById("saveStatus").dataset.state==="saved"')
            assert script('return uxLayoutSnapshot();')==layout
            wait_for('document.getElementById("saveStatus").hidden',seconds=6)
            assert script('return uxLayoutSnapshot();')==layout
            assert script('return !document.getElementById("noticeDock") && !getComputedStyle(document.documentElement).getPropertyValue("--notice-space");')
            script('quotaUXFailure();const e=document.getElementById("projectName");e.value="Safari quota";e.dispatchEvent(new Event("input",{bubbles:true}));')
            wait_for('document.getElementById("saveStatus").dataset.state==="error"')
            time.sleep(2.9)
            assert script('return !document.getElementById("saveStatus").hidden;')
            click('#createVideoMode')
            assert script('return document.getElementById("saveStatus").dataset.mode;')=='video'
            assert script('return document.getElementById("saveStatus").hidden;')
            click('#backToEditor')
            assert script('return document.getElementById("saveStatus").dataset.state;')=='error'
            script('restoreUXQuota();const e=document.getElementById("projectName");e.value="Safari retry";e.dispatchEvent(new Event("input",{bubbles:true}));')
            wait_for('document.getElementById("saveStatus").dataset.state==="saved"')
            print('PASS [native Safari]: delayed real transaction, auto-dismiss toast, persistent quota error, isolated mode status, retry, sticky editor and floating toast with unchanged document geometry/scroll and no bottom panel',flush=True)
            command('POST','/window/rect',{'width':1000,'height':900})
            def prepare_canvas():
                click('#createVideoMode')
                if script('return !document.getElementById("videoOutputTabs").hidden;'):
                    click('#showVideoCanvas')
                # Mirror the user's visible preview, rather than an offscreen Canvas.
                script('document.getElementById("videoCanvas").scrollIntoView({block:"center"});')
                command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));','args':[]})

            # Save actual source media, reload and exercise the existing UI recorder.
            wait_for('window.ShortsVideoRestored')
            fixture=(ROOT/'tests/persistence-fixture.js').read_text()
            script(fixture)
            saved=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];savePersistenceFixture().then(done,e=>done({error:e.message}));','args':[]})
            assert not saved.get('error'),saved
            command('POST','/refresh',{})
            wait_for('window.ShortsVideoRestored',seconds=30)
            script(fixture)
            restored=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];persistenceFixtureSnapshot().then(done,e=>done({error:e.message}));','args':[]})
            assert restored==saved, {'saved':saved,'restored':restored}
            prepare_canvas()
            assert script('return document.querySelectorAll(".scene-image-thumb").length;')==2
            assert 'voice.wav' in script('return document.getElementById("videoAudioInfo").textContent;')
            assert 'music.wav' in script('return document.getElementById("videoMusicInfo").textContent;')
            if script('return ShortsVideoRecorder.capabilities(true).supported;'):
                # Regression for the observer/driver boundary: a recorder error
                # must remain a value so the real WebM fallback can run.
                observer_state=script('return [videoRenderStatus.textContent,videoError.textContent];')
                script('videoRenderStatus.textContent="Запись не завершена.";videoError.textContent="Native waiter error fixture";')
                assert wait_native_video(command)=={'error':'Native waiter error fixture'}
                script('videoRenderStatus.textContent=arguments[0][0];videoError.textContent=arguments[0][1];',[observer_state])
                def record_restored_ui():
                    # Exercise the restored preview/audio through a trusted user
                    # action before recording, as in the portable ZIP scenario.
                    click('#playGeneratedPreview')
                    wait_for('document.getElementById("videoPreviewTime").textContent.startsWith("0:01")')
                    click('#playGeneratedPreview')
                    click('#recordVideo')
                    return wait_native_video(command)
                def full_restored_video(result):
                    return result.get('width')==720 and result.get('height')==1280 and isinstance(result.get('duration'),(int,float)) and 5<result['duration']<7.5
                metadata=record_restored_ui()
                if not full_restored_video(metadata):
                    # Never count a short MP4 as a successful export. Verify the
                    # original encoder stack, then test the existing WebM choice
                    # with the same full-duration/dimension/audio assertions.
                    assert metadata.get('error') or metadata.get('info','').startswith('MP4'),metadata
                    baseline_name=os.environ.get('SAFARI_BASELINE_ROOT')
                    if baseline_name:
                        baseline=(ROOT/baseline_name).resolve()
                        assert_render_stack(ROOT,baseline)
                    formats=script('return ShortsVideoRecorder.capabilities(true,"webm");')
                    assert formats['supported'],{'first':metadata,'webm':formats}
                    print('::warning title=Safari MP4 audio codec limitation::Empty, timed-out or truncated MP4 is NOT accepted as success: '+json.dumps(metadata)+'. Encoder/mixer/drawing implementations are unchanged outside the strictly checked resource bridge; reload the saved project to release the failed encoder, then require a full-duration WebM.',flush=True)
                    command('POST','/refresh',{})
                    wait_for('window.ShortsVideoRestored',seconds=30)
                    script(fixture)
                    fallback=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];persistenceFixtureSnapshot().then(done,e=>done({error:e.message}));','args':[]})
                    assert fallback==saved,{'saved':saved,'fallback':fallback}
                    prepare_canvas()
                    script('const select=document.getElementById("videoFormat");select.value="webm";select.dispatchEvent(new Event("change",{bubbles:true}));')
                    metadata=record_restored_ui()
                assert full_restored_video(metadata),metadata
                assert 'голос + музыка' in metadata['info'],metadata
                group=script('const p=document.querySelector(".video-download-panel"),i=document.getElementById("videoFileInfo"),d=document.getElementById("downloadVideo");return {infoBeforeDownload:Boolean(i.compareDocumentPosition(d)&Node.DOCUMENT_POSITION_FOLLOWING),noScroll:p.scrollHeight<=p.clientHeight+1};')
                assert group['infoBeforeDownload'] and group['noScroll'],group
                print('::notice title=Native Safari project restoration verified::Original PNG and two WAV hashes match after reload; actual post-restore UI export: '+json.dumps(metadata),flush=True)
            else:
                assert script('return document.getElementById("recordVideo").disabled;')
                print('::warning title=Native Safari persistence only::Original media and settings restored; audio recording API unavailable; export not verified.',flush=True)
            click('#backToEditor')
            prepare_canvas()
            support=script('return ShortsVideoRecorder.capabilities();')
            if support['supported']:
                def record_probe():
                    return command('POST','/execute/async',{'script':'''const done=arguments[arguments.length-1];
                  const draft=ShortsVideoCore.demo(); draft.durationSeconds=3;draft.scenes=draft.scenes.slice(0,2);
                  ShortsVideoRecorder.record({canvas:document.getElementById('videoCanvas'),plan:ShortsVideoCore.makePlan(draft)}).then(result=>{
                    const url=URL.createObjectURL(result.blob);const video=document.createElement('video');video.muted=true;video.preload='auto';
                    const timer=setTimeout(()=>{URL.revokeObjectURL(url);done({error:'Safari could not load recorded metadata'});},10000);
                    video.onloadedmetadata=()=>{clearTimeout(timer);const value={type:result.mimeType,size:result.blob.size,width:video.videoWidth,height:video.videoHeight,duration:video.duration};URL.revokeObjectURL(url);done(value);};
                    video.onerror=()=>{clearTimeout(timer);URL.revokeObjectURL(url);done({error:'Safari could not decode the recorded video'});};video.src=url;video.load();
                  }).catch(error=>done({error:error.message}));''','args':[]})
                result=record_probe()
                if result.get('error'):
                    baseline_name=os.environ.get('SAFARI_BASELINE_ROOT')
                    assert baseline_name, result
                    baseline=(ROOT / baseline_name).resolve()
                    relative=baseline.relative_to(ROOT).as_posix()
                    # An encoder limitation is accepted only with reproducible evidence:
                    # the stable site has the identical failure and all existing runtime
                    # code matches outside the exact approved planning/resource bridge.
                    assert_render_stack(ROOT,baseline)
                    command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/{relative}/index.html'})
                    wait_for('window.ShortsEditor && window.ShortsVideoRecorder')
                    prepare_canvas()
                    stable_result=record_probe()
                    assert stable_result.get('error')==result['error'], {'current':result,'baseline':stable_result}
                    message='Native Safari '+str(capabilities.get('browserVersion'))+': экспорт не прошёл ни в PR, ни в стабильной версии; '+result['error']+' Исходный генератор не изменён. Проверки новых окон прошли; успешный экспорт Safari НЕ подтверждён.'
                    print('::warning title=Existing Safari export limitation::'+message,flush=True)
                    if os.environ.get('GITHUB_STEP_SUMMARY'):
                        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as summary:
                            summary.write('### Safari: известное ограничение экспорта\n\n'+message+'\n\nСравнение со стабильным коммитом: `'+subprocess.check_output(['git','rev-parse','HEAD'],cwd=baseline,text=True).strip()+'`.\n')
                else:
                    assert result['size']>0 and (result['width'],result['height'])==(720,1280),result
                    assert isinstance(result['duration'],(int,float)) and 2<result['duration']<4.5,result
                    print('::notice title=Native Safari export verified::Safari '+str(capabilities.get('browserVersion'))+'; real Canvas recording decoded: '+json.dumps(result),flush=True)
            else:
                assert script('return document.getElementById("recordVideo").disabled && !document.getElementById("videoSupport").hidden;')
                print('::warning title=Native Safari recording unavailable::Safari '+str(capabilities.get('browserVersion'))+'; explanatory message verified; export NOT verified: '+json.dumps(support),flush=True)
            click('#backToEditor')
            assert script('return !document.getElementById("scriptStudio").hidden;')
            check_native_backup(ROOT,f'http://127.0.0.1:{server.server_port}/',script,command,click,wait_for)
            check_native_backup(ROOT,f'http://127.0.0.1:{server.server_port}/',script,command,click,wait_for,editor_version=2)
            check_native_studio_data(ROOT,script,command)
            check_native_render_plan(ROOT,script,command)
            check_native_runtime(ROOT,script,command,click)
            check_native_editor_canvas(ROOT,script,command,click)
    finally:
        if session:
            try: request('DELETE','/session/'+session)
            except Exception: pass
        if driver:
            driver.terminate()
            try: driver.wait(timeout=10)
            except subprocess.TimeoutExpired: driver.kill();driver.wait()
        server.shutdown();server.server_close()


if __name__=='__main__':
    try: run()
    except Exception as error:
        message=(type(error).__name__+': '+str(error)+'\n'+traceback.format_exc(limit=4)).replace('%','%25').replace('\r','%0D').replace('\n','%0A')
        print('::error title=Native Safari smoke check::'+message,flush=True)
        raise
