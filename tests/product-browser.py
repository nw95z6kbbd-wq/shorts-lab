"""Product UI checks in Chromium or WebKit, including mobile emulation."""
import functools
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SEEN = 'shorts-studio.updates.dismissed.v1'
PROFILE = 'shorts-studio.product.profile.v1'


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/shorts-lab/'):
            self.path = self.path[len('/shorts-lab'):]
        super().do_GET()

    def log_message(self, *_args):
        pass


def run():
    metadata = json.loads(subprocess.check_output(['node', '-e', 'process.stdout.write(JSON.stringify(require("./js/product.js")))'], cwd=ROOT))
    engine = os.environ.get('PRODUCT_BROWSER', 'chromium')
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/shorts-lab/'
    url = base + os.environ.get('PRODUCT_ENTRY', '')
    errors, requests = [], []
    try:
        with sync_playwright() as p:
            if engine == 'webkit': browser = p.webkit.launch()
            else: browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'])
            try:
                context = browser.new_context(viewport={'width':1440,'height':1000}, accept_downloads=True)
                page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('request', lambda request: requests.append(request.url))
                page.goto(url)
                original = page.evaluate('({editor:localStorage.getItem("shorts-studio.project.v1"), video:localStorage.getItem("shorts-studio.video.v1")})')
                count = page.locator('[data-product-version]').count()
                expect(page.locator('[data-product-version]')).to_have_text(['v' + metadata['version']] * count)
                expect(page.locator('#productUpdateNotice')).to_be_visible()
                page.locator('#productUpdateNotice [data-product-open="updates"]').click()
                expect(page.locator('#productDialog')).to_be_visible()
                expect(page.locator('.release-item')).to_have_count(len(metadata['releases']))
                for i, release in enumerate(metadata['releases']):
                    expect(page.locator('.release-heading h3').nth(i)).to_have_text('Версия ' + release['version'])
                    expect(page.locator('.release-heading time').nth(i)).to_have_attribute('datetime', release['date'])
                    expect(page.locator('.release-item').nth(i).locator('li')).to_have_count(len(release['changes']))
                page.locator('#productClose').click()
                assert page.evaluate(f'localStorage.getItem({json.dumps(SEEN)})') == metadata['version']
                page.reload(); expect(page.locator('#productUpdateNotice')).to_be_hidden()
                page.locator('.product-toolbar [data-product-open="updates"]').click()
                page.keyboard.press('Escape'); expect(page.locator('#productDialog')).not_to_be_visible()
                print(f'PASS [{engine}]: one version source, complete dated release history and persistent notice dismissal', flush=True)

                page.evaluate('(data)=>localStorage.setItem(data.key,data.value)', {'key':SEEN, 'value':metadata['releases'][1]['version']})
                page.reload(); expect(page.locator('#productUpdateNotice')).to_be_visible()
                page.locator('#productDismissNotice').click()
                page.reload(); expect(page.locator('#productUpdateNotice')).to_be_hidden()
                page.locator('.product-toolbar [data-product-open="updates"]').click()
                page.keyboard.press('End'); expect(page.locator('#productTab-about')).to_have_attribute('aria-selected','true')
                expect(page.locator('#productOwner')).to_have_value(metadata['rights']['owner'])
                expect(page.locator('#productContact')).to_have_value(metadata['rights']['contact'])
                expect(page.locator('#productRepository')).to_have_attribute('href',metadata['repository'])
                expect(page.locator('#productLicenseNote')).to_have_text(metadata['licenseNote'])
                page.locator('#productOwner').fill('Тестовый правообладатель')
                payload='<img src=x onerror="window.productXss=1">'
                page.locator('#productContact').fill(payload)
                page.locator('#productProfileForm button[type="submit"]').click()
                expect(page.locator('#productProfileStatus')).to_contain_text('Сохранено только')
                page.locator('#productClose').click(); page.reload()
                page.locator('.product-toolbar [data-product-open="about"]').click()
                expect(page.locator('#productOwner')).to_have_value('Тестовый правообладатель')
                expect(page.locator('#productContact')).to_have_value(payload)
                assert page.evaluate('window.productXss === undefined')
                assert page.locator('#productPane-about img').count() == 0
                page.locator('#productResetProfile').click()
                expect(page.locator('#productOwner')).to_have_value(metadata['rights']['owner'])
                page.locator('#productClose').click()
                after = page.evaluate('({editor:localStorage.getItem("shorts-studio.project.v1"), video:localStorage.getItem("shorts-studio.video.v1")})')
                assert after == original
                print(f'PASS [{engine}]: new-version notice, keyboard tabs, editable local profile, safe text and unchanged projects', flush=True)

                for width in (320,390,768,1440):
                    page.set_viewport_size({'width':width,'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                    page.locator('.product-toolbar [data-product-open="about"]').click()
                    assert page.locator('#productDialog').evaluate('e=>e.scrollWidth <= e.clientWidth'), width
                    page.locator('#productProfileForm button[type="submit"]').scroll_into_view_if_needed()
                    expect(page.locator('#productProfileForm button[type="submit"]')).to_be_visible()
                    page.locator('#productClose').click()
                page.locator('#createVideoMode').click()
                expect(page.locator('#videoStudio')).to_be_visible()
                page.locator('.product-toolbar [data-product-open="updates"]').click(); page.locator('#productClose').click()
                expect(page.locator('#videoStudio')).to_be_visible()
                page.locator('#backToEditor').click(); expect(page.locator('#scriptStudio')).to_be_visible()
                print(f'PASS [{engine}]: 4 viewport sizes, modal scrolling and product UI in both editor modes', flush=True)

                blocked = browser.new_context()
                blocked.add_init_script('Object.defineProperty(Storage.prototype,"setItem",{value(){throw new DOMException("full","QuotaExceededError")}});')
                other=blocked.new_page(); other.on('pageerror',lambda e:errors.append(str(e)))
                other.goto(url);expect(other.locator('#productUpdateNotice')).to_be_hidden()
                other.locator('.product-toolbar [data-product-open="about"]').click()
                other.locator('#productOwner').fill('Только эта вкладка')
                other.locator('#productProfileForm button[type="submit"]').click()
                expect(other.locator('#productProfileStatus')).to_contain_text('запретил сохранение')
                blocked.close()
                if engine == 'webkit':
                    phone = browser.new_context(**p.devices['iPhone 13'])
                    mobile = phone.new_page(); mobile.on('pageerror',lambda e:errors.append(str(e)))
                    mobile.goto(url);mobile.locator('.product-toolbar [data-product-open="updates"]').tap()
                    expect(mobile.locator('#productDialog')).to_be_visible()
                    mobile.locator('#productTab-about').tap(); mobile.locator('#productOwner').fill('Мобильная проверка')
                    mobile.locator('#productProfileForm button[type="submit"]').tap()
                    expect(mobile.locator('#productProfileStatus')).to_contain_text('Сохранено только')
                    assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    mobile.locator('#productClose').tap();phone.close()
                    print('PASS [WebKit iPhone emulation]: touch navigation, forms and mobile modal',flush=True)
                assert not errors, errors
                assert all(request.startswith((base,'blob:','data:')) for request in requests),requests
                print(f'PASS [{engine}]: unavailable storage handled; no JavaScript errors or external requests', flush=True)
            finally: browser.close()
    finally: server.shutdown();server.server_close()


if __name__ == '__main__': run()
