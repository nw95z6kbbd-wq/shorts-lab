"""Check the exact GitHub Pages artifact under /shorts-lab/, including downloads."""
import functools
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run():
    site = ROOT / "_site"
    assert (site / "index.html").is_file(), "Run python scripts/prepare-site.py first."
    assert not (site / ".git").exists()
    assert not (site / "tests").exists()
    assert not (site / "requirements-dev.txt").exists()
    with tempfile.TemporaryDirectory(prefix="shorts-pages-") as temp:
        base_dir = Path(temp)
        shutil.copytree(site, base_dir / "shorts-lab")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=temp))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/shorts-lab/"
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or shutil.which("chromium"), args=["--no-sandbox"])
                try:
                    context = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})
                    page = context.new_page()
                    errors, requests = [], []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: requests.append(request.url))
                    page.on("requestfailed", lambda request: errors.append(f"{request.url}: {request.failure}"))
                    page.on("response", lambda response: errors.append(f"HTTP {response.status}: {response.url}") if response.status >= 400 else None)
                    page.goto(base)
                    expect(page.locator(".scene-card")).to_have_count(8)
                    assert page.locator("body").evaluate("node => getComputedStyle(node).backgroundColor") == "rgb(13, 13, 16)"
                    page.locator("#nextScene").click()
                    expect(page.locator("#portraitScene")).to_have_text("02 / 08")
                    with page.expect_download() as item:
                        page.locator("#exportSrt").click()
                    item.value.save_as(base_dir / "captions.srt")
                    assert "00:00:00,000 --> 00:00:02,800" in (base_dir / "captions.srt").read_text(encoding="utf-8")
                    print("PASS: staged Pages app, styles, scenes and SRT at /shorts-lab/")

                    for relative in ("assets/favicon.svg", "downloads/Shorts-Studio.html", "downloads/Shorts-Studio.zip"):
                        response = context.request.get(base + relative)
                        assert response.status == 200, relative
                        if relative.endswith(".zip"):
                            (base_dir / "download.zip").write_bytes(response.body())
                    with ZipFile(base_dir / "download.zip") as archive:
                        assert archive.testzip() is None
                        assert archive.namelist() == ["Shorts-Studio.html"]
                        assert archive.read("Shorts-Studio.html") == (site / "downloads/Shorts-Studio.html").read_bytes()
                    print("PASS: packaged standalone HTML and ZIP are downloadable and consistent")

                    # A fresh origin path opens the standalone download with the same app features.
                    page.goto(base + "downloads/Shorts-Studio.html")
                    expect(page.locator(".scene-card")).to_have_count(8)
                    page.locator("#scene-input-0").fill("Автономная версия работает.")
                    expect(page.locator("#previewText")).to_contain_text("Автономная версия работает.")
                    with page.expect_download() as item:
                        page.locator("#saveProject").click()
                    item.value.save_as(base_dir / "project.json")
                    assert json.loads((base_dir / "project.json").read_text(encoding="utf-8"))["scenes"][0]["text"] == "Автономная версия работает."
                    page.set_viewport_size({"width": 390, "height": 844})
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                    assert not errors, errors
                    assert all(url.startswith((base, "data:", "blob:")) for url in requests), requests
                    print("PASS: standalone editor, JSON download and mobile layout; no missing assets or external requests")
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    run()
