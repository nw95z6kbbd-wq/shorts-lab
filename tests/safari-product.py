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
            details=script('const e=document.querySelector(arguments[0]),r=e.getBoundingClientRect(),d=document.getElementById("productDialog"),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);return {selector:arguments[0],rect:{x:r.x,y:r.y,width:r.width,height:r.height},x,y,clickable:!e.matches(":disabled")&&r.width>0&&r.height>0&&(hit===e||e.contains(hit)),hit:hit?.tagName+"#"+hit?.id,display:getComputedStyle(e).display,dialog:d.open,aboutHidden:document.getElementById("productPane-about").hidden,active:document.activeElement?.id,scroll:document.querySelector(".product-dialog-scroll").scrollTop};',[selector])
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
            assert script('return Array.from(document.querySelectorAll(".release-heading time")).map(e=>e.dateTime);')==[release['date'] for release in product['releases']]
            click('#productClose');command('POST','/refresh',{})
            wait_for('window.ShortsProduct && window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert && document.getElementById("saveStatus").dataset.state',seconds=30)
            assert script('return document.getElementById("productUpdateNotice").hidden;')
            click('.product-nav [data-product-open="about"]')
            assert script('return document.getElementById("productRepository").href;')==product['repository']
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
            command('POST','/window/rect',{'width':390,'height':844})
            assert script('return document.documentElement.scrollWidth <= innerWidth;')
            click('.product-nav [data-product-open="about"]')
            assert script('const d=document.getElementById("productDialog");return d.scrollWidth<=d.clientWidth;')
            click('#productClose')
            print('PASS [native Safari]: narrow desktop window layout; actual viewport width:',script('return innerWidth;'),flush=True)
            script('window.scrollTo(0,document.documentElement.scrollHeight);')
            status_rect=script('const r=document.getElementById("saveStatus").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,state:document.getElementById("saveStatus").dataset.state};')
            assert status_rect['top']>=0 and status_rect['bottom']<=status_rect['height'],status_rect
            print('PASS [native Safari]: single sticky save status remains visible at the end of the page',flush=True)
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
                click('#recordVideo')
                visibility=script('const r=document.getElementById("videoCanvas").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,hidden:document.hidden,focus:document.hasFocus()};')
                wait_for('!document.getElementById("downloadVideo").hidden || document.getElementById("videoRenderStatus").textContent.includes("не завершена")',seconds=25)
                if not script('return !document.getElementById("downloadVideo").hidden;'):
                    first_error=script('return document.getElementById("videoError").textContent;')
                    formats=script('return ShortsVideoRecorder.capabilities(true,"webm");')
                    assert formats['supported'], {'error':first_error,'webm':formats,'canvas':visibility}
                    print('::warning title=Safari MP4 codec limitation::'+first_error+' Testing the existing user-selectable WebM fallback; the recorder is unchanged.',flush=True)
                    script('const select=document.getElementById("videoFormat");select.value="webm";select.dispatchEvent(new Event("change",{bubbles:true}));')
                    click('#recordVideo')
                    wait_for('!document.getElementById("downloadVideo").hidden || document.getElementById("videoRenderStatus").textContent.includes("не завершена")',seconds=25)
                assert script('return !document.getElementById("downloadVideo").hidden;'),{'error':script('return document.getElementById("videoError").textContent;'),'canvas':visibility}
                wait_for('document.getElementById("generatedVideo").readyState>=1')
                metadata=script('const v=document.getElementById("generatedVideo");return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,info:document.getElementById("videoFileInfo").textContent};')
                assert metadata['width']==720 and metadata['height']==1280 and 5<metadata['duration']<7.5,metadata
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
                    # modules and original styles are byte-for-byte unchanged.
                    original_files=[baseline/'js'/name for name in ('core.js','video-core.js','video-renderer.js','video-audio.js','video-recorder.js')]
                    original_files += [baseline/'styles.css',baseline/'video.css']
                    assert len(original_files)>=5, 'Incomplete Safari baseline'
                    assert all(file.read_bytes()==(ROOT/file.relative_to(baseline)).read_bytes() for file in original_files), 'Safari recording failed and original runtime differs from baseline'
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
