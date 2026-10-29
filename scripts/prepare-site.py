"""Package the existing static app and its self-contained downloadable version."""
import argparse
from pathlib import Path
import re
import shutil
from urllib.parse import quote
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]


def prepare(output):
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for stylesheet in ("styles.css", "video.css", "product.css", "ux.css", "backup.css", "editor-timing.css"):
        css = (ROOT / stylesheet).read_text(encoding="utf-8")
        html = html.replace(f'<link rel="stylesheet" href="{stylesheet}">', '<style>\n' + css + '\n</style>')
    favicon = quote((ROOT / "assets/favicon.svg").read_text(encoding="utf-8"), safe="")
    html = html.replace('href="assets/favicon.svg"', 'href="data:image/svg+xml,' + favicon + '"')
    scripts = re.findall(r'<script src="([^"]+)" defer></script>', html)
    if scripts != ["js/core.js", "js/product.js", "js/editor-profile.js", "js/render-plan.js", "js/render-adapters.js", "js/video-core.js", "js/project-db.js", "js/storage.js", "js/zip-store.js", "js/backup-format.js", "js/integrations.js", "js/editor-timing.js", "js/editor-canvas.js", "js/video-renderer.js", "js/video-audio.js", "js/video-recorder.js", "js/video-media.js", "js/audio-window.js", "js/media-session.js", "js/render-session.js", "js/editor-preview.js", "js/editor-images.js", "js/editor-audio.js", "js/app.js", "js/video-ui.js", "js/product-ui.js", "js/ux.js", "js/backup-ui.js"]:
        raise ValueError("Script order changed: update the single-file packaging before publication.")
    html = re.sub(r'\s*<script src="[^"]+" defer></script>', "", html)
    # Inline classic scripts ignore defer. Keep the source page's after-parser
    # initialization boundary, including in Safari file-origin storage.
    inline = "\n".join('<script>\ndocument.addEventListener("DOMContentLoaded", () => {\n' + (ROOT / src).read_text(encoding="utf-8").replace("</script", "<\\/script") + '\n}, { once: true });\n</script>' for src in scripts)
    html = html.replace("</body>", inline + "\n</body>")
    if re.search(r'<script[^>]+src=|<link[^>]+href="(?:assets/|styles.css|video.css|product.css|ux.css|backup.css|editor-timing.css)', html):
        raise ValueError("The standalone HTML still references external application files.")

    downloads = ROOT / "downloads"
    downloads.mkdir(exist_ok=True)
    (downloads / "Shorts-Studio.html").write_text(html, encoding="utf-8")
    # Fixed metadata makes rebuilding the ZIP repeatable across machines.
    info = ZipInfo("Shorts-Studio.html", date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    with ZipFile(downloads / "Shorts-Studio.zip", "w") as archive:
        archive.writestr(info, html.encode("utf-8"))

    files = [ROOT / "index.html", ROOT / "styles.css", ROOT / "video.css", ROOT / "product.css", ROOT / "ux.css", ROOT / "backup.css", ROOT / "editor-timing.css", ROOT / ".nojekyll"]
    files += sorted((ROOT / "js").glob("*.js"))
    files += sorted(file for file in (ROOT / "assets").rglob("*") if file.is_file())
    files += [downloads / "Shorts-Studio.html", downloads / "Shorts-Studio.zip"]
    for file in files:
        target = output / file.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
    print(f"Prepared {len(files)} static files in {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "_site")
    args = parser.parse_args()
    prepare(args.output.resolve())
