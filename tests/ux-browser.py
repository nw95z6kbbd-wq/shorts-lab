"""UX checks: delayed real transactions, sticky status, navigation and result layout.

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
                before=page.evaluate('async()=>{const db=ShortsProjectDB.createRepository();const value=await db.read("editor");db.close();return value.revision;}')
                # Hold a genuine write lock. The application's transaction stays queued
                # beyond its debounce, rather than replacing its storage implementation.
                page.evaluate('''async()=>await new Promise((resolve,reject)=>{
                  const q=indexedDB.open('shorts-studio.projects',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{
                    const db=q.result,t=db.transaction(['projects','assets'],'readwrite');window.uxHold=true;
                    let first=true;function pump(){const r=t.objectStore('projects').count();r.onsuccess=()=>{if(first){first=false;resolve();}if(window.uxHold)pump();};}
                    t.oncomplete=()=>db.close();t.onabort=()=>{db.close();reject(t.error);};pump();
                  };
                })''')
                page.locator('#projectName').fill('Транзакция должна завершиться')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','pending')
                page.wait_for_timeout(650)
                expect(page.locator('#saveStatusText')).to_have_text('Сохранение…')
                page.locator('#createVideoMode').click()
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','pending')
                page.locator('#backToEditor').click()
                page.locator('#scene-input-7').scroll_into_view_if_needed()
                rect=page.locator('#saveStatus').bounding_box();assert rect and rect['y']>=0 and rect['y']+rect['height']<=page.viewport_size['height']
                assert page.evaluate('scrollY>300')
                page.evaluate('window.uxHold=false')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                saved=page.evaluate('async()=>{const db=ShortsProjectDB.createRepository(),r=await db.read("editor");db.close();return r;}')
                assert saved['revision']>before and saved['state']['name']=='Транзакция должна завершиться'
                page.evaluate('''()=>{window.uxPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='projects')throw new DOMException('full','QuotaExceededError');return uxPut.call(this,value);};}''')
                page.locator('#projectName').fill('Проверка ошибки сохранения')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','error')
                expect(page.locator('#saveStatusText')).to_have_text('Ошибка сохранения')
                assert page.evaluate('async()=>{const db=ShortsProjectDB.createRepository(),r=await db.read("editor");db.close();return r.revision;}')==saved['revision']
                page.evaluate('()=>{IDBObjectStore.prototype.put=window.uxPut;}')
                page.locator('#projectName').fill('Сохранение восстановлено')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                print(f'PASS [{engine} UX]: real pending transaction never displays Saved; success/error/retry and status after long scroll',flush=True)

                page.locator('#createVideoMode').click()
                expect(page.locator('#saveStatus')).to_be_visible()
                expect(page.locator('#saveStatus')).to_have_attribute('aria-label','Видеопроект. Сохранено на устройстве')
                page.locator('#videoTitle').fill('Видео с постоянным индикатором')
                expect(page.locator('#saveStatus')).to_have_attribute('data-state','saved')
                page.locator('#video-scene-5').scroll_into_view_if_needed()
                rect=page.locator('#saveStatus').bounding_box();assert rect['y']>=0 and rect['y']+rect['height']<page.viewport_size['height']
                # Presentation fixture represents a finished file in the animation tab.
                info='MP4 · 720 × 1280 · 0:18 · 12,6 МБ · голос + музыка'
                page.evaluate('''text=>{const info=document.getElementById('videoFileInfo'),link=document.getElementById('downloadVideo');info.textContent=text;info.hidden=false;link.hidden=false;link.href='#ux-layout-fixture';document.getElementById('videoOutputTabs').hidden=false;}''',info)
                expect(page.locator('.video-preview-panel')).to_have_class(re.compile('has-video-result'))
                assert page.evaluate('Boolean(document.getElementById("videoFileInfo").compareDocumentPosition(document.getElementById("downloadVideo")) & Node.DOCUMENT_POSITION_FOLLOWING)')
                for width,height in ((1440,900),(1440,480),(1024,600),(768,480),(390,844),(320,568),(667,375),(844,390)):
                    page.set_viewport_size({'width':width,'height':height})
                    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,height)
                    button=page.locator('.product-nav [data-product-open="about"]')
                    button.focus();page.keyboard.press('Enter');expect(page.locator('#productDialog')).to_be_visible()
                    page.keyboard.press('Escape');expect(button).to_be_focused()
                    page.locator('.video-download-panel').scroll_into_view_if_needed()
                    box=page.locator('.video-download-panel').bounding_box();head=page.locator('.topbar').bounding_box()
                    assert box['y']>=head['y']+head['height']-1 and box['y']+box['height']<=height+1,(width,height,box,head)
                    expect(page.locator('#videoFileInfo')).to_have_text(info)
                    assert page.locator('#videoFileInfo').evaluate('e=>e.scrollHeight<=e.clientHeight+1 && e.scrollWidth<=e.clientWidth+1')
                    assert page.locator('.video-preview-panel').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                    expect(page.locator('#downloadVideo')).to_be_visible();expect(page.locator('#saveStatus')).to_be_visible()
                    if width==390:page.screenshot(path='/tmp/shorts-ux-mobile.png')
                    if width==1440 and height==900:page.screenshot(path='/tmp/shorts-ux-desktop.png')
                print(f'PASS [{engine} UX]: 8 viewport/height combinations, unique sidebar links, keyboard focus return and complete file information above Download without nested scrolling',flush=True)
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
