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
        raise AssertionError('Safari condition timed out: ' + code)
    def element(selector):
        result=command('POST','/element',{'using':'css selector','value':selector})
        return result['element-6066-11e4-a52e-4f735466cecf']
    def click(selector): command('POST','/element/'+element(selector)+'/click',{})

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
            command('POST','/window/rect',{'width':1280,'height':900})
            command('POST','/url',{'url':f'http://127.0.0.1:{server.server_port}/index.html'})
            wait_for('window.ShortsProduct && window.ShortsEditor && window.ShortsVideoRecorder')
            version=script('return ShortsProduct.version;'); assert version==product['version']
            assert script('return Array.from(document.querySelectorAll("[data-product-version]")).every(e=>e.textContent=== "v"+ShortsProduct.version);')
            before=script('return [localStorage.getItem("shorts-studio.project.v1"),localStorage.getItem("shorts-studio.video.v1")];')
            click('.product-toolbar [data-product-open="updates"]')
            assert script('return document.getElementById("productDialog").open;')
            assert script('return document.querySelectorAll(".release-item").length;')==len(product['releases'])
            assert script('return Array.from(document.querySelectorAll(".release-heading time")).map(e=>e.dateTime);')==[release['date'] for release in product['releases']]
            click('#productClose');command('POST','/refresh',{})
            wait_for('window.ShortsProduct && window.ShortsEditor')
            assert script('return document.getElementById("productUpdateNotice").hidden;')
            click('.product-toolbar [data-product-open="about"]')
            assert script('return document.getElementById("productRepository").href;')==product['repository']
            assert script('return document.getElementById("productOwner").value;')==product['rights']['owner']
            script('document.getElementById("productOwner").value="Проверка Safari";')
            click('#productProfileForm button[type="submit"]')
            assert 'Сохранено только' in script('return document.getElementById("productProfileStatus").textContent;')
            click('#productClose');command('POST','/refresh',{})
            wait_for('window.ShortsProduct && window.ShortsEditor')
            click('.product-toolbar [data-product-open="about"]')
            assert script('return document.getElementById("productOwner").value;')=='Проверка Safari'
            click('#productResetProfile');click('#productClose')
            assert before==script('return [localStorage.getItem("shorts-studio.project.v1"),localStorage.getItem("shorts-studio.video.v1")];')
            print('PASS [native Safari]: version, dated release history, notice dismissal and local profile; project data unchanged',flush=True)
            command('POST','/window/rect',{'width':390,'height':844})
            assert script('return document.documentElement.scrollWidth <= innerWidth;')
            click('.product-toolbar [data-product-open="about"]')
            assert script('const d=document.getElementById("productDialog");return d.scrollWidth<=d.clientWidth;')
            click('#productClose')
            print('PASS [native Safari]: narrow desktop window layout; actual viewport width:',script('return innerWidth;'),flush=True)
            command('POST','/window/rect',{'width':1280,'height':900})
            click('#createVideoMode')
            support=script('return ShortsVideoRecorder.capabilities();')
            if support['supported']:
                result=command('POST','/execute/async',{'script':'''const done=arguments[arguments.length-1];
                  const draft=ShortsVideoCore.demo(); draft.durationSeconds=1;draft.scenes=draft.scenes.slice(0,2);
                  ShortsVideoRecorder.record({canvas:document.getElementById('videoCanvas'),plan:ShortsVideoCore.makePlan(draft)}).then(result=>{
                    const url=URL.createObjectURL(result.blob);const video=document.createElement('video');video.muted=true;video.preload='auto';
                    const timer=setTimeout(()=>{URL.revokeObjectURL(url);done({error:'Safari could not load recorded metadata'});},10000);
                    video.onloadedmetadata=()=>{clearTimeout(timer);const value={type:result.mimeType,size:result.blob.size,width:video.videoWidth,height:video.videoHeight,duration:video.duration};URL.revokeObjectURL(url);done(value);};
                    video.onerror=()=>{clearTimeout(timer);URL.revokeObjectURL(url);done({error:'Safari could not decode the recorded video'});};video.src=url;video.load();
                  }).catch(error=>done({error:error.message}));''','args':[]})
                assert not result.get('error'),result
                assert result['size']>0 and (result['width'],result['height'])==(720,1280),result
                assert isinstance(result['duration'],(int,float)) and .5<result['duration']<2.5,result
                print('PASS [native Safari]: real Canvas recording decoded by Safari:',json.dumps(result),flush=True)
            else:
                assert script('return document.getElementById("recordVideo").disabled && !document.getElementById("videoSupport").hidden;')
                print('LIMITATION [native Safari]: recording APIs unavailable; explanatory message verified:',json.dumps(support),flush=True)
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
        message=str(error).replace('%','%25').replace('\r','%0D').replace('\n','%0A')
        print('::error title=Native Safari smoke check::'+message,flush=True)
        raise
