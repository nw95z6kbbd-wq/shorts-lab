"""Functional browser checks. No npm dependencies and no application backend."""
import functools
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Error, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
KEY = "shorts-studio.project.v1"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run():
    server = None
    with tempfile.TemporaryDirectory(prefix="shorts-test-") as temp, sync_playwright() as p:
        chromium = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
        browser = p.chromium.launch(executable_path=chromium, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        errors = []
        requests = []
        context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
        page = context.new_page()
        page.on("request", lambda request: requests.append(request.url))
        url = (ROOT / "index.html").as_uri()
        try:
            try:
                page.goto(url)
                print("PASS: direct file:// startup")
            except Error as error:
                if "ERR_BLOCKED_BY_ADMINISTRATOR" not in str(error):
                    raise
                server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
                threading.Thread(target=server.serve_forever, daemon=True).start()
                url = f"http://127.0.0.1:{server.server_port}/index.html"
                page.close()
                page = context.new_page()
                page.on("request", lambda request: requests.append(request.url))
                page.goto(url)
                print("LIMITATION: system browser policy blocks file://; running UI checks over a local static HTTP server")

            expect(page.locator(".scene-card")).to_have_count(8)
            expect(page.locator("#wordCount")).to_have_text("86")
            expect(page.locator("#previewText")).to_contain_text("настоящей звезды")
            page.locator("#nextScene").click()
            expect(page.locator("#portraitScene")).to_have_text("02 / 08")
            page.locator("#prevScene").click()
            expect(page.locator("#portraitScene")).to_have_text("01 / 08")
            print("PASS: demo, counts, preview and scene navigation")

            page.locator('[data-caption="outline"]').click()
            page.locator('[data-theme="dusk"]').click()
            page.locator("#captionSize").select_option("large")
            page.locator("#projectName").fill("Тест / экспорт")
            page.locator("#scriptText").fill("Привет, мир! Это тест.\nПоследняя сцена")
            expect(page.locator("#wordCount")).to_have_text("6")
            expect(page.locator("#scriptChanged")).to_be_visible()
            page.locator("#splitScenes").click()
            expect(page.locator("#confirmDialog")).to_be_visible()
            page.locator("#dialogConfirm").click()
            expect(page.locator(".scene-card")).to_have_count(3)
            expect(page.locator("#totalDuration")).to_have_text("0:03")
            expect(page.locator("#scriptChanged")).to_be_hidden()
            page.locator("#scene-input-0").fill("Один два три четыре пять.")
            expect(page.locator("#totalDuration")).to_have_text("0:04")
            expect(page.locator("#previewText")).to_contain_text("четыре пять")
            page.locator("#addScene").click()
            expect(page.locator(".scene-card")).to_have_count(4)
            page.locator("#scene-input-3").fill("Финал.")
            page.get_by_role("button", name="Удалить сцену 2", exact=True).click()
            page.locator('#confirmDialog button[value="cancel"]').click()
            expect(page.locator(".scene-card")).to_have_count(4)
            page.get_by_role("button", name="Удалить сцену 2", exact=True).click()
            page.locator("#dialogConfirm").click()
            expect(page.locator(".scene-card")).to_have_count(3)
            print("PASS: splitting, script-change warning, editing, adding and deleting scenes")

            page.locator("#tab-subtitles").click()
            expect(page.locator(".subtitle-cue")).to_have_count(3)
            expect(page.locator(".cue-time").nth(0)).to_have_text("00:00:00,000 → 00:00:02,000")
            expect(page.locator(".cue-time").nth(1)).to_have_text("00:00:02,000 → 00:00:02,800")
            expect(page.locator(".cue-time").nth(2)).to_have_text("00:00:02,800 → 00:00:03,200")
            with page.expect_download() as item:
                page.locator("#exportSrtPanel").click()
            download = item.value
            assert download.suggested_filename.endswith(".srt") and "/" not in download.suggested_filename
            target = Path(temp) / "captions.srt"
            download.save_as(target)
            srt = target.read_text(encoding="utf-8")
            assert "00:00:02,800 --> 00:00:03,200" in srt and "Финал." in srt
            assert len(re.findall(r"^\d+$", srt, flags=re.M)) == 3
            print("PASS: actual SRT download, UTF-8 Russian text and precise contiguous timecodes")

            with page.expect_download() as item:
                page.locator("#saveProject").click()
            backup = Path(temp) / "backup.shorts.json"
            item.value.save_as(backup)
            saved = json.loads(backup.read_text(encoding="utf-8"))
            assert len(saved["scenes"]) == 3 and saved["style"]["theme"] == "dusk"
            expect(page.locator("#saveStatus")).to_contain_text("Сохранено")
            page.reload()
            expect(page.locator("#projectName")).to_have_value("Тест / экспорт")
            expect(page.locator(".scene-card")).to_have_count(3)
            expect(page.locator("#scene-input-0")).to_have_value("Один два три четыре пять.")
            expect(page.locator("#portrait")).to_have_class(re.compile("theme-dusk caption-outline size-large"))
            page.locator("#newProject").click()
            page.locator('#confirmDialog button[value="cancel"]').click()
            expect(page.locator(".scene-card")).to_have_count(3)
            page.locator("#newProject").click()
            page.locator("#dialogConfirm").click()
            expect(page.locator(".scene-card")).to_have_count(0)
            expect(page.locator("#exportSrt")).to_be_disabled()
            page.reload()
            expect(page.locator(".scene-card")).to_have_count(0)
            expect(page.locator("#scriptText")).to_have_value("")
            page.locator("#projectFile").set_input_files(str(backup))
            expect(page.locator(".scene-card")).to_have_count(3)
            expect(page.locator("#projectName")).to_have_value("Тест / экспорт")
            page.locator("#projectFile").set_input_files({"name": "broken.json", "mimeType": "application/json", "buffer": b"{}"})
            expect(page.locator("#toast")).to_contain_text("Не удалось открыть")
            expect(page.locator(".scene-card")).to_have_count(3)
            print("PASS: JSON backup/import, invalid-file handling, reload persistence and empty-project persistence")

            # One-word scenes exercise real playback, pause, scene changes and end-of-playback state.
            page.locator("#scriptText").fill("Раз. Два.")
            page.locator("#splitScenes").click()
            page.locator("#dialogConfirm").click()
            page.locator("#playPreview").click()
            expect(page.locator("#playPreview")).to_have_attribute("aria-label", "Приостановить предпросмотр")
            page.locator("#playPreview").click()
            expect(page.locator("#playPreview")).to_have_attribute("aria-label", "Воспроизвести предпросмотр")
            page.locator("#playPreview").click()
            expect(page.locator("#portraitScene")).to_have_text("02 / 02")
            expect(page.locator("#playPreview")).to_have_attribute("aria-label", "Воспроизвести предпросмотр")
            assert page.locator("#timelineProgress").evaluate("node => node.style.width") == "100%"
            print("PASS: timed playback, pause, automatic scene switch and completion")

            page.locator("#scene-input-1").fill('<img src=x onerror="window.__xss=1"> Безопасный текст')
            expect(page.locator("#previewText")).to_contain_text("<img")
            assert page.locator("#previewText img").count() == 0
            assert page.evaluate("window.__xss === undefined")
            page.locator("#tab-script").focus()
            page.keyboard.press("ArrowRight")
            expect(page.locator("#tab-scenes")).to_have_attribute("aria-selected", "true")
            page.keyboard.press("End")
            expect(page.locator("#tab-subtitles")).to_have_attribute("aria-selected", "true")
            print("PASS: safe user-text rendering and keyboard tab navigation")

            page.locator("#tab-script").click()
            for width in [320, 360, 390, 600, 768, 1024, 1440]:
                page.set_viewport_size({"width": width, "height": 900})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"Overflow at {width}px"
                expect(page.locator("#portrait")).to_be_visible()
                ratio = page.locator("#portrait").evaluate("node => node.clientWidth / node.clientHeight")
                assert abs(ratio - 9 / 16) < .01
                if width <= 1050:
                    expect(page.locator("#saveProjectMobile")).to_be_visible()
                    expect(page.locator("#openProjectMobile")).to_be_visible()
            print("PASS: 7 viewport widths (320–1440px), no horizontal overflow, 9:16 and mobile file controls")

            failure_context = browser.new_context()
            failure_context.add_init_script("Object.defineProperty(Storage.prototype, 'setItem', { value() { throw new DOMException('full', 'QuotaExceededError'); } });")
            failure_page = failure_context.new_page()
            failure_page.on("pageerror", lambda error: errors.append(str(error)))
            failure_page.goto(url)
            expect(failure_page.locator("#storageWarning")).to_be_visible()
            failure_page.locator("#scriptText").fill("Проект всё ещё можно редактировать.")
            expect(failure_page.locator("#saveStatus")).to_contain_text("Не сохранено")
            with failure_page.expect_download():
                failure_page.locator("#saveProject").click()
            failure_context.close()
            print("PASS: storage quota failure is visible; editing and backup still work")

            recovery_context = browser.new_context()
            recovery_context.add_init_script(f"localStorage.setItem('{KEY}', '{{broken');")
            recovery_page = recovery_context.new_page()
            recovery_page.goto(url)
            assert recovery_page.evaluate(f"localStorage.getItem('{KEY}.recovery')") == "{broken"
            expect(recovery_page.locator("#toast")).to_contain_text("повреждён")
            recovery_context.close()
            print("PASS: corrupt local data is preserved for recovery")

            assert not errors, "Browser errors: " + repr(errors)
            assert all(request.startswith(("file:", "http://127.0.0.1:")) for request in requests), requests
            print("PASS: no browser JavaScript errors or external network dependencies")
            print("All 10 functional check groups passed.")
        finally:
            browser.close()
            if server:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    run()
