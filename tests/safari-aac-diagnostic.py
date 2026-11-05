"""Real Safari only. Dedicated synthetic page; no application or project access."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import re
import socket
import subprocess
import threading
import time
import urllib.request

from safari_aac_analysis import LENGTHS, analyze_capture

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-results/safari-aac'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            data, kind = b'<!doctype html><meta charset="utf-8"><title>Synthetic AAC diagnostic</title><script src="/probe.js"></script>', 'text/html'
        elif self.path == '/probe.js':
            data, kind = (ROOT / 'tests/safari-aac-probe.js').read_bytes(), 'text/javascript'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def run():
    # Refuse to substitute another browser/platform, even in local tests.
    if platform.system() != 'Darwin':
        raise RuntimeError('Native Safari requires macOS; no browser substitution is permitted')
    if OUTPUT.exists() and any(OUTPUT.iterdir()):
        raise RuntimeError('Existing diagnostic artifacts must be preserved in a separate directory before a new run')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    import os
    sha = os.environ.get('DIAGNOSTIC_COMMIT_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Exact commit SHA required')
    if sha != subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip():
        raise ValueError('Diagnostic SHA differs from checked-out HEAD')
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT):
        raise RuntimeError('Tracked sources must match the recorded commit')
    manifest = {'schema': 1, 'commit': sha, 'osVersion': platform.mac_ver()[0], 'architecture': platform.machine(),
                'source': 'synthetic only', 'cases': [], 'status': 'incomplete'}
    # Never collect process environment, user profile, project storage, screenshots,
    # cookies, arbitrary WebDriver capabilities, driver logs or exception messages.
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback only
    driver, session = None, None

    def request(method, endpoint, data=None):
        req = urllib.request.Request(base + endpoint, data=None if data is None else json.dumps(data).encode(),
                                     method=method, headers={'Content-Type': 'application/json'})
        with opener.open(req, timeout=60) as response:
            raw = response.read(8 * 1048576 + 1)
        if len(raw) > 8 * 1048576:
            raise ValueError('WebDriver response budget')
        result = json.loads(raw)['value']
        if isinstance(result, dict) and result.get('error'):
            raise RuntimeError('WebDriver command failed')
        return result

    def command(method, endpoint, data=None):
        return request(method, '/session/' + session + endpoint, data)

    try:
        manifest['ffmpegVersion'] = subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]
        driver = subprocess.Popen(['/usr/bin/safaridriver', '-p', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while True:
            try:
                request('GET', '/status')
                break
            except Exception:
                if driver.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Safari WebDriver unavailable') from None
                time.sleep(.2)
        result = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})
        session = result['sessionId']
        capabilities = result['capabilities']
        if capabilities.get('browserName', '').lower() != 'safari':
            raise RuntimeError('Native Safari required')
        manifest['browser'] = {'name': 'safari', 'version': capabilities.get('browserVersion')}
        command('POST', '/timeouts', {'script': 45000, 'pageLoad': 15000, 'implicit': 0})
        command('POST', '/url', {'url': f'http://127.0.0.1:{server.server_port}/'})
        for count in LENGTHS:
            for repeat in range(2):
                folder = OUTPUT / f'n{count}-r{repeat}'
                folder.mkdir(exist_ok=True)
                item = {'frames': count, 'repeat': repeat, 'status': 'incomplete'}
                manifest['cases'].append(item)
                try:
                    capture = command('POST', '/execute/async', {'script': '''const done=arguments[arguments.length-1];
                      SafariAACProbe.capture(arguments[0],arguments[1]).then(done,()=>done({fatal:true}));''', 'args': [count, repeat]})
                    # Persist original evidence before analysis can fail.
                    (folder / 'capture.json').write_text(json.dumps(capture, indent=2))
                    report = analyze_capture(capture, folder)
                    item['status'] = report['status']
                    item['rawDecodedLagSamples'] = report['decoders']['ffmpegManualSkip']['lagSamples']
                    item['safariDecodedLagSamples'] = report['decoders'].get('normalizedASC', {}).get('lagSamples')
                except Exception as error:
                    item['errorType'] = type(error).__name__
                print(json.dumps(item), flush=True)
                if sum(p.stat().st_size for p in OUTPUT.rglob('*') if p.is_file()) > 64 * 1048576:
                    raise ValueError('Total synthetic artifact budget')
        manifest['status'] = 'measured' if all(c['status'] == 'measured' for c in manifest['cases']) else 'inconclusive'
    except Exception as error:
        manifest['errorType'] = type(error).__name__
    finally:
        (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        if session:
            try:
                command('DELETE', '', {})
            except Exception:
                pass
        if driver:
            driver.terminate()
            try:
                driver.wait(timeout=5)
            except subprocess.TimeoutExpired:
                driver.kill()
                driver.wait(timeout=5)
        server.shutdown()
        server.server_close()
    if manifest['status'] != 'measured':
        raise RuntimeError('Diagnostic incomplete/inconclusive; inspect synthetic artifacts')
    print('All synthetic cases measured; this is not a production AAC correctness verdict.', flush=True)


if __name__ == '__main__':
    run()
