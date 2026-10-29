"""Full legacy migration -> UI media -> browser process restart -> real export."""
import base64
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('media_checks', ROOT/'tests/media-browser.py')
media = importlib.util.module_from_spec(spec); spec.loader.exec_module(media)


def run():
    engine = os.environ.get('PERSISTENCE_BROWSER', 'chromium')
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(media.checks.Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/shorts-lab/'
    url = base + os.environ.get('PERSISTENCE_ENTRY', '')
    errors = []
    try:
        with tempfile.TemporaryDirectory(prefix='shorts-persistence-') as folder, sync_playwright() as p:
            folder = Path(folder); profile = folder/'browser-profile'
            def launch():
                options = dict(accept_downloads=True, viewport={'width':1440,'height':1000})
                if engine == 'webkit':
                    return p.webkit.launch_persistent_context(str(profile), **options)
                return p.chromium.launch_persistent_context(str(profile), executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'], **options)
            def page_for(context):
                page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e))); return page
            context = launch(); page = page_for(context); stage = 'legacy migration'
            try:
                page.route(base+'seed.html', lambda r:r.fulfill(body='<html></html>',content_type='text/html'))
                page.goto(base+'seed.html')
                for name in ('core.js','video-core.js'):page.add_script_tag(content=(ROOT/'js'/name).read_text())
                legacy = page.evaluate('''async seed => {
                  const e=seed.editor;e.name='Отдельный текстовый проект';e.script='Сохранённый сценарий редактора.';e.scenes=ShortsCore.createScenes(e.script);
                  const v=seed.video;v.title='Восстановленный ролик';v.scenes=v.scenes.slice(0,2);v.timing='manual';
                  v.scenes[0].durationSeconds=2;v.scenes[1].durationSeconds=3;
                  const c=document.createElement('canvas');c.width=800;c.height=1200;c.getContext('2d').fillStyle='#ed563e';c.getContext('2d').fillRect(0,0,800,1200);
                  const image=await new Promise(r=>c.toBlob(r,'image/png'));
                  v.scenes[0].visual='image';v.scenes[0].imageId='legacy-red';v.scenes[0].imageName='legacy-red.png';
                  const eraw=JSON.stringify(e),vraw=JSON.stringify(v);
                  localStorage.setItem('shorts-studio.project.v1',eraw);localStorage.setItem('shorts-studio.video.v1',vraw);
                  await new Promise((resolve,reject)=>{const q=indexedDB.open('shorts-studio.media.v1',1);q.onupgradeneeded=()=>q.result.createObjectStore('images',{keyPath:'id'});q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('images','readwrite');tx.objectStore('images').put({id:'legacy-red',file:image,name:'legacy-red.png'});tx.oncomplete=()=>{db.close();resolve();};};});
                  return {editor:eraw,video:vraw};
                }''',json.loads((ROOT/'tests/fixtures/stable-projects.json').read_text()))
                page.goto(url); page.wait_for_function('window.ShortsVideoRestored')
                expect(page.locator('#projectName')).to_have_value('Отдельный текстовый проект')
                expect(page.locator('#scriptText')).to_have_value('Сохранённый сценарий редактора.')
                page.locator('#createVideoMode').click()
                expect(page.locator('#videoTitle')).to_have_value('Восстановленный ролик')
                expect(page.locator('#videoScenes .scene-image-thumb')).to_have_count(1)
                assert page.evaluate('localStorage.getItem("shorts-studio.project.v1")')==legacy['editor']
                assert page.evaluate('localStorage.getItem("shorts-studio.video.v1")')==legacy['video']
                blue=page.evaluate('''async()=>{const c=document.createElement('canvas');c.width=800;c.height=1200;const x=c.getContext('2d');x.fillStyle='#286cdd';x.fillRect(0,0,800,1200);return c.toDataURL('image/png').split(',')[1];}''')
                page.locator('#video-scene-image-1').set_input_files({'name':'blue.png','mimeType':'image/png','buffer':base64.b64decode(blue)})
                expect(page.locator('#videoScenes .scene-image-thumb')).to_have_count(2)
                expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                assert all('только в этой вкладке' not in label for label in page.locator('.scene-image-name').all_text_contents())
                for role,frequency,input_id in [('voice',440,'videoAudio'),('music',880,'videoMusic')]:
                    stage = 'upload ' + role
                    path=folder/(role+'.wav');media.tone(path,frequency)
                    expect(page.locator('#'+input_id)).to_be_enabled()
                    page.locator('#'+input_id).set_input_files(str(path))
                    expect(page.locator('#'+('videoAudioInfo' if role=='voice' else 'videoMusicInfo'))).to_contain_text(path.name)
                    expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                media.set_range(page,'videoVolume',65);media.set_range(page,'videoMusicVolume',45)
                page.locator('#video-scene-camera-1').select_option('pan-left')
                page.locator('#video-scene-transition-1').select_option('slide')
                page.locator('#videoMusicFadeIn').fill('0.4');page.locator('#videoMusicFadeIn').dispatch_event('change')
                page.locator('#videoMusicFadeOut').fill('0.7');page.locator('#videoMusicFadeOut').dispatch_event('change')
                page.locator('#videoCaption').select_option('outline')
                page.locator('#videoFormat').select_option('webm' if engine=='chromium' else 'auto')
                expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                saved=page.evaluate('async()=>await ShortsProjectDB.createRepository().read("video")')
                original_hashes=page.evaluate('''async()=>{const db=ShortsProjectDB.createRepository(),r=await db.read('video');const out={};for(const id of ShortsProjectDB.references('video',r.state)){const a=await db.asset(id);const bytes=new Uint8Array(await a.blob.arrayBuffer());let value='';for(const b of bytes)value+=String.fromCharCode(b);out[id]=btoa(value);}db.close();return out;}''')
                stage = 'full browser restart'
                context.close()  # Terminates the actual browser process, not just a page.
                context=launch();page=page_for(context);page.goto(url);page.wait_for_function('window.ShortsVideoRestored')
                expect(page.locator('#projectName')).to_have_value('Отдельный текстовый проект')
                page.locator('#createVideoMode').click()
                expect(page.locator('#videoScenes .scene-image-thumb')).to_have_count(2)
                expect(page.locator('#videoAudioInfo')).to_contain_text('voice.wav')
                expect(page.locator('#videoMusicInfo')).to_contain_text('music.wav')
                restored=page.evaluate('async()=>await ShortsProjectDB.createRepository().read("video")')
                assert restored['state']==saved['state'] and restored['revision']==saved['revision']
                for id,encoded in original_hashes.items():
                    actual=page.evaluate('''async id=>{const a=await ShortsProjectDB.createRepository().asset(id);const bytes=new Uint8Array(await a.blob.arrayBuffer());let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}''',id)
                    assert hashlib.sha256(base64.b64decode(actual)).digest()==hashlib.sha256(base64.b64decode(encoded)).digest()
                assert hashlib.sha256(base64.b64decode(original_hashes[restored['state']['voiceAssetId']])).digest()==hashlib.sha256((folder/'voice.wav').read_bytes()).digest()
                assert page.evaluate('localStorage.getItem("shorts-studio.video.v1")')==legacy['video']
                print(f'PASS [{engine}]: legacy copies retained, independent modes, two images and original voice/music bytes, all settings survive full browser process restart',flush=True)
                with page.expect_download() as item:page.locator('#videoSrt').click()
                item.value.save_as(folder/'restored.srt')
                srt=(folder/'restored.srt').read_text();assert '00:00:02,000' in srt and '00:00:05,000' in srt
                if page.evaluate('ShortsVideoRecorder.capabilities(true,document.getElementById("videoFormat").value).supported'):
                    recording=media.record(page,folder,'restored',5)
                    voice,music=media.spectrum(recording,1)
                    assert voice>.015 and music>.01,(voice,music)
                    red=media.average_rgb(recording,.5);blue=media.average_rgb(recording,3.5)
                    assert red[0]>red[2]*1.5 and blue[2]>blue[0]*1.5,(red,blue)
                    print(f'PASS [{engine}]: actual post-restart video decoded by FFmpeg, 720x1280, 5s, both audio frequencies, correct image order, SRT and no black frames',flush=True)
                else:
                    expect(page.locator('#recordVideo')).to_be_disabled()
                    print(f'LIMITATION [{engine}]: Canvas recording codec unavailable; full persistence passed, real export is checked in Chromium and native Safari',flush=True)
                # A stale tab must never silently replace the new revision.
                other=page_for(context);other.goto(url);other.wait_for_function('window.ShortsVideoRestored');other.locator('#createVideoMode').click()
                page.locator('#videoTitle').fill('Правка первой вкладки');expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                other.locator('#videoTitle').fill('Конфликтующая правка');expect(other.locator('#videoDraftStatus')).to_contain_text('Ошибка сохранения')
                assert page.evaluate('async()=>(await ShortsProjectDB.createRepository().read("video")).state.title')=='Правка первой вкладки'
                other.close()
                # Real transaction abort after asset writes preserves the previous head.
                before=page.evaluate('async()=>await ShortsProjectDB.createRepository().read("video")')
                page.evaluate('''()=>{window.__originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='projects')throw new DOMException('full','QuotaExceededError');return __originalPut.call(this,value);};}''')
                page.locator('#videoTitle').fill('Несохранённая правка');expect(page.locator('#videoDraftStatus')).to_contain_text('Ошибка сохранения')
                assert page.evaluate('async()=>await ShortsProjectDB.createRepository().read("video")')==before
                page.evaluate('()=>{IDBObjectStore.prototype.put=window.__originalPut;}')
                page.reload();page.wait_for_function('window.ShortsVideoRestored');page.locator('#createVideoMode').click()
                expect(page.locator('#videoTitle')).to_have_value('Правка первой вкладки')
                print(f'PASS [{engine}]: cross-tab conflict, quota error and recovery of previous correct state',flush=True)
                # Losing saved audio must block export rather than silently produce silence.
                page.evaluate('''async()=>{const r=await ShortsProjectDB.createRepository().read('video');await new Promise((resolve,reject)=>{const q=indexedDB.open('shorts-studio.projects',ShortsProjectDB.DATABASE_VERSION);q.onsuccess=()=>{const db=q.result,t=db.transaction('assets','readwrite');t.objectStore('assets').delete(r.state.voiceAssetId);t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});}''')
                page.reload();page.wait_for_function('window.ShortsVideoRestored');page.locator('#createVideoMode').click()
                expect(page.locator('#recordVideo')).to_be_disabled();expect(page.locator('#videoPlanError')).to_contain_text('Голос')
                assert not errors,errors
                print(f'PASS [{engine}]: missing restored audio explicitly blocks export; no JavaScript errors',flush=True)
            except Exception as error:
                try:
                    details=page.evaluate('''async()=>({error:document.getElementById('videoError')?.textContent,status:document.getElementById('videoDraftStatus')?.textContent,state:(await ShortsProjectDB.createRepository().read('video'))?.state})''')
                except Exception:details={}
                raise AssertionError(f'{stage}; browser state: {details}; {error}') from error
            finally:context.close()
    finally:server.shutdown();server.server_close()


if __name__=='__main__':run()
