"""Existing native Safari folder-access protocol, shared by cold file tests."""
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse


def prepare_native_file_entry(entry, command):
    parsed = urlparse(entry)
    if parsed.scheme != 'file' or parsed.netloc:
        raise ValueError('A local file URI is required')
    previous = command('GET', '/window')
    fresh = command('POST', '/window/new', {'type': 'window'})['handle']
    command('POST', '/window', {'handle': previous})
    command('DELETE', '/window')
    command('POST', '/window', {'handle': fresh})
    # Native Safari grants file access per window/folder. Navigation from an
    # unrelated HTTP page alone may open safari-resource:/ErrorPage.html.
    # Open a script-free sibling through Safari, then let WebDriver load and
    # verify the actual unmodified app. No security preferences are changed.
    folder = Path(unquote(parsed.path)).parent
    with tempfile.NamedTemporaryFile(dir=folder, prefix='.shorts-ci-file-grant-', suffix='.html', delete=False) as file:
        grant = Path(file.name)
        file.write(b'<!doctype html><meta charset="utf-8"><title>Shorts Studio local test access</title><p>Native file access for the adjacent Shorts Studio test document.</p>')
    try:
        subprocess.run(['/usr/bin/open', '-g', '-a', 'Safari', str(grant)], check=True)
    except BaseException:
        grant.unlink(missing_ok=True)
        raise
    return grant
