"""UX checks: delayed real transactions, save toasts, sticky previews, navigation and result layout.

Result-layout fixtures only set existing output DOM. Real media/export regressions
remain in video-browser.py, media-browser.py and project-browser.py.
"""
import functools
import json
import re
import os
from pathlib import Path
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

ROOT=Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/shorts-lab/'):
            self.path=self.path[len('/shorts-lab'):]
        super().do_GET()
    def log_message(self,*_args):pass


def run():
    engine=os.environ.get('UX_BROWSER','chromium')
    metadata=json.loads(subprocess.check_output(['node','-e','process.stdout.write(JSON.stringify(require("./js/product.js")))'],cwd=ROOT))
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/shorts-lab/'
    url=base+os.environ.get('UX_ENTRY','')
    try:
        with sync_playwright() as p:
            browser=p.webkit.launch() if engine=='webkit' else p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
            try:
                context=browser.new_context(viewport={'width':1440,'height':900})
                page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(url);page.wait_for_function('window.ShortsVideoRestored && document.getElementById("saveStatus").dataset.state==="saved"')
                expect(page.locator('#saveStatus')).to_be_visible()
                assert page.locator('#saveStatus').count()==1
                expect(page.locator('#editorSaveState')).to_be_hidden();expect(page.locator('#videoDraftStatus')).to_be_hidden()
                assert page.locator('.product-toolbar').count()==0
                for tab in ('updates','about'):
                    assert page.locator(f'.product-nav [data-product-open="{tab}"]').count()==1
                assert page.evaluate('Array.from(document.querySelectorAll("[data-product-version]")).every(e=>e.textContent==="v"+ShortsProduct.version)')
                assert metadata['releases'][0]['version']==page.evaluate('ShortsProduct.version')
                page.locator('#studioViewport').focus();page.keyboard.press('PageDown')
                page.wait_for_function('document.getElementById("studioViewport").scrollTop>0')
                before=page.evaluate('async()=>{const db=ShortsProjectDB.createRepository();const value=await db.read("editor");db.close();return value.revision;}')
                page.evaluate((ROOT/'tests/ux-fixture.js').read_text())
                page.evaluate('holdUXTransaction()')
                page.locator('#projectName').fill('Транзакция должна завершиться')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','pending')
                page.wait_for_timeout(650)
                expect(page.locator('#saveStatusText')).to_have_text('Сохранение…')
                page.wait_for_timeout(2850)
                page.locator('#createVideoMode').click()
                expect(page.locator('#saveStatus')).to_have_attribute('data-mode','video')
                expect(page.locator('#saveStatus')).to_be_hidden()  # no stale editor pending/success
                page.locator('#backToEditor').click()
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','pending')
                expect(page.locator('#saveStatus')).to_be_visible()
                page.locator('#scene-input-7').scroll_into_view_if_needed()
                rect=page.locator('#saveStatus').bounding_box();assert rect and rect['y']>=0 and rect['y']+rect['height']<=page.viewport_size['height']
                assert page.locator('#studioViewport').evaluate('e=>e.scrollTop>300')
                page.evaluate('window.uxHold=false')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                saved=page.evaluate('async()=>{const db=ShortsProjectDB.createRepository(),r=await db.read("editor");db.close();return r;}')
                assert saved['revision']>before and saved['state']['name']=='Транзакция должна завершиться'
                page.evaluate('quotaUXFailure()')
                page.locator('#projectName').fill('Проверка ошибки сохранения')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','error')
                expect(page.locator('#saveStatusText')).to_have_text('Ошибка сохранения')
                assert page.evaluate('async()=>{const db=ShortsProjectDB.createRepository(),r=await db.read("editor");db.close();return r.revision;}')==saved['revision']
                page.wait_for_timeout(2900)
                expect(page.locator('#saveStatus')).to_be_visible()
                expect(page.locator('#saveStatus')).to_have_attribute('aria-live','assertive')
                page.locator('#createVideoMode').click()
                expect(page.locator('#saveStatus')).to_have_attribute('data-mode','video')
                expect(page.locator('#saveStatus')).to_be_hidden()
                page.locator('#backToEditor').click()
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','error')
                expect(page.locator('#saveStatus')).to_be_visible()
                page.evaluate('restoreUXQuota()')
                page.locator('#projectName').fill('Сохранение восстановлено')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                expect(page.locator('#saveStatusText')).to_have_text('Сохранено на устройстве')
                page.wait_for_timeout(1600)
                page.locator('#projectName').fill('Повторное сохранение')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                page.wait_for_timeout(1400)
                expect(page.locator('#saveStatus')).to_be_visible()  # previous timer must not hide this success
                expect(page.locator('#saveStatus')).to_have_attribute('aria-atomic','true')
                expect(page.locator('#saveStatus')).to_be_hidden(timeout=3500)
                assert page.locator('#studioViewport').evaluate('e=>e.clientHeight===innerHeight')
                print(f'PASS [{engine} UX]: genuine delayed commit, persistent quota error, retry, single auto-dismiss toast, timer reset and mode isolation',flush=True)

                page.locator('#createVideoMode').click()
                expect(page.locator('#saveStatus')).to_be_hidden()
                page.locator('#videoTitle').fill('Видео с уведомлением')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                expect(page.locator('#saveStatus')).to_have_attribute('aria-label','Видеопроект. Сохранено на устройстве')
                page.locator('#video-scene-5').scroll_into_view_if_needed()
                # Original PNG/WAV files go through the existing upload handlers;
                # hold the write lock to cover media decoding and persistence.
                import random, struct, zlib, io, wave
                def chunk(kind,data):
                    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
                raw=random.Random(6).randbytes(800*1200*3)
                png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',800,1200,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+raw[y*2400:(y+1)*2400] for y in range(1200))))+chunk(b'IEND',b'')
                audio=io.BytesIO()
                with wave.open(audio,'wb') as wav:
                    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0\0'*16000)
                for selector,name,mime,content in [('#video-scene-image-0','large.png','image/png',png),('#videoAudio','voice.wav','audio/wav',audio.getvalue())]:
                    page.evaluate('holdUXTransaction()')
                    page.locator(selector).set_input_files({'name':name,'mimeType':mime,'buffer':content})
                    expect(page.locator('#saveStatus')).to_have_attribute('data-state','pending')
                    page.wait_for_timeout(2900)
                    expect(page.locator('#saveStatusText')).to_have_text('Сохранение…')
                    expect(page.locator('#saveStatus')).to_be_visible()
                    page.evaluate('window.uxHold=false')
                    expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                print(f'PASS [{engine} UX]: 2.8 MB PNG and original WAV uploads never report success before their real transaction commits',flush=True)
                # Both previews stay on screen for long scenes if all controls fit.
                for mode,column,last in [('editor','.preview-column','#scene-input-7'),('video','.video-preview-column','#video-scene-5')]:
                    page.locator('#backToEditor' if mode=='editor' else '#createVideoMode').click()
                    for height in (1000,900,700,480):
                        page.set_viewport_size({'width':1440,'height':height})
                        page.locator(last).scroll_into_view_if_needed()
                        page.wait_for_timeout(70)
                        box=page.locator(column).bounding_box()
                        if height>=900:
                            assert 'preview-sticky' in page.locator(column).get_attribute('class')
                            assert box['y']>=-1 and box['y']+box['height']<=page.locator('#studioViewport').bounding_box()['height']+1,(mode,height,box)
                        else:
                            # A taller panel remains fully reachable with ordinary page scroll.
                            assert page.locator(column).evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                print(f'PASS [{engine} UX]: editor and video previews on long scene lists at four heights, with safe oversized-panel fallback',flush=True)
                # Presentation fixture represents a finished file in the animation tab.
                info='MP4 · 720 × 1280 · 0:18 · 12,6 МБ · голос + музыка'
                def result_fixture():
                    page.evaluate('''text=>{const info=document.getElementById('videoFileInfo'),link=document.getElementById('downloadVideo');info.textContent=text;info.hidden=false;link.hidden=false;link.href='#ux-layout-fixture';document.getElementById('videoOutputTabs').hidden=false;}''',info)
                result_fixture()
                expect(page.locator('.video-preview-panel')).to_have_class(re.compile('has-video-result'))
                assert page.evaluate('Boolean(document.getElementById("videoFileInfo").compareDocumentPosition(document.getElementById("downloadVideo")) & Node.DOCUMENT_POSITION_FOLLOWING)')
                for width,height in ((1440,900),(1440,480),(1024,600),(768,480),(390,844),(320,568),(667,375),(844,390)):
                    page.set_viewport_size({'width':width,'height':height})
                    page.locator('#videoTitle').fill(f'Размер {width} × {height}')
                    expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                    result_fixture()
                    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,height)
                    button=page.locator('.product-nav [data-product-open="about"]')
                    button.focus();page.keyboard.press('Enter');expect(page.locator('#productDialog')).to_be_visible()
                    page.keyboard.press('Escape');expect(button).to_be_focused()
                    page.locator('.video-download-panel').scroll_into_view_if_needed()
                    box=page.locator('.video-download-panel').bounding_box();view=page.locator('#studioViewport').bounding_box()
                    assert box['y']>=-1 and box['y']+box['height']<=view['height']+1,(width,height,box,view)
                    expect(page.locator('#videoFileInfo')).to_have_text(info)
                    assert page.locator('#videoFileInfo').evaluate('e=>e.scrollHeight<=e.clientHeight+1 && e.scrollWidth<=e.clientWidth+1')
                    assert page.locator('.video-preview-panel').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                    expect(page.locator('#downloadVideo')).to_be_visible()
                    # Notice space is physically outside the workspace and cannot cover buttons.
                    page.locator('#downloadVideo').scroll_into_view_if_needed()
                    assert page.locator('#saveStatus').bounding_box()['y']>=page.locator('#studioViewport').bounding_box()['height']
                    link=page.locator('#downloadVideo');link.focus();expect(link).to_be_focused()
                    rect=link.bounding_box();assert rect['y']>=0 and rect['y']+rect['height']<=page.locator('#studioViewport').bounding_box()['height']+1
                    # Same output DOM geometry in both display states; actual file
                    # playback/tab switching remains in the real export suites.
                    page.evaluate('videoCanvas.hidden=true;generatedVideo.hidden=false')
                    page.locator('#downloadVideo').scroll_into_view_if_needed()
                    rect=link.bounding_box();assert rect['y']>=0 and rect['y']+rect['height']<=page.locator('#studioViewport').bounding_box()['height']+1
                    page.evaluate('generatedVideo.hidden=true;videoCanvas.hidden=false')
                    if width==390:page.screenshot(path='/tmp/shorts-ux-mobile.png')
                    if width==1440 and height==900:page.screenshot(path='/tmp/shorts-ux-desktop.png')
                print(f'PASS [{engine} UX]: 8 viewport/height combinations, unique sidebar links, keyboard focus return and complete file information above Download without nested scrolling',flush=True)
                page.emulate_media(reduced_motion='reduce')
                assert page.locator('#saveStatus').evaluate('e=>getComputedStyle(e).transitionDuration')=='0s'
                page.locator('#videoTitle').fill('Reduced motion')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                expect(page.locator('#saveStatus')).to_be_hidden(timeout=4000)
                page.set_viewport_size({'width':1440,'height':1000})
                page.locator('#backToEditor').click()
                page.locator('#newProject').click()
                expect(page.locator('#confirmDialog')).to_be_visible()
                page.locator('#dialogConfirm').click()
                expect(page.locator('.scene-card')).to_have_count(0)
                page.locator('.preview-column').scroll_into_view_if_needed()
                assert page.locator('.preview-column').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                expect(page.locator('#playPreview')).to_be_visible()
                assert page.locator('.editor-column').bounding_box()['x']+page.locator('.editor-column').bounding_box()['width']<page.locator('.preview-column').bounding_box()['x']
                print(f'PASS [{engine} UX]: reduced motion and a fresh short project with modal confirmation and no overlapping columns',flush=True)
                if engine=='webkit':
                    phone=browser.new_context(**p.devices['iPhone 13']);mobile=phone.new_page()
                    mobile.on('pageerror',lambda e:errors.append(str(e)));mobile.goto(url)
                    mobile.locator('.product-nav [data-product-open="updates"]').tap()
                    expect(mobile.locator('#productDialog')).to_be_visible();mobile.locator('#productClose').tap()
                    mobile.locator('.product-nav [data-product-open="about"]').tap()
                    expect(mobile.locator('#productPane-about')).to_be_visible();mobile.locator('#productClose').tap()
                    assert mobile.evaluate('document.documentElement.scrollWidth<=innerWidth');phone.close()
                    print('PASS [WebKit UX]: mobile touch navigation in the existing sidebar',flush=True)
                assert not errors,errors
            finally:browser.close()
    finally:server.shutdown();server.server_close()


if __name__=='__main__':run()
