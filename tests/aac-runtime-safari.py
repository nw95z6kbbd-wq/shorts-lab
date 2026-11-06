"""Minimal native Safari transport for the isolated runtime AAC page only."""
from contextlib import contextmanager
import json
import platform
import socket
import subprocess
import time
import urllib.request


@contextmanager
def session(url):
    if platform.system() != 'Darwin':
        raise RuntimeError('Native Safari requires macOS; no substitution')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback only
    driver = subprocess.Popen(['/usr/bin/safaridriver', '-p', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    session_id = None

    def request(method, endpoint, data=None):
        req = urllib.request.Request(base + endpoint, data=None if data is None else json.dumps(data).encode(),
                                     method=method, headers={'Content-Type': 'application/json'})
        with opener.open(req, timeout=260) as response:
            raw = response.read(12 * 1048576 + 1)
        if len(raw) > 12 * 1048576:
            raise ValueError('WebDriver response budget')
        value = json.loads(raw)['value']
        if isinstance(value, dict) and value.get('error'):
            raise RuntimeError('Native Safari WebDriver command failed')
        return value

    def command(method, endpoint, data=None):
        return request(method, '/session/' + session_id + endpoint, data)

    def evaluate(script, argument=None):
        # Only repository-authored expressions are passed here, never file data.
        value = command('POST', '/execute/async', {'script': 'const done=arguments[arguments.length-1]; Promise.resolve((' + script + ')(arguments[0])).then(done,()=>done({transportFailure:true}));', 'args': [argument]})
        if isinstance(value, dict) and value.get('transportFailure'):
            raise RuntimeError('Native Safari isolated script failed')
        return value

    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                request('GET', '/status')
                break
            except Exception:
                if driver.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Native Safari driver unavailable') from None
                time.sleep(.2)
        result = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})
        session_id = result['sessionId']
        if result['capabilities'].get('browserName', '').lower() != 'safari':
            raise RuntimeError('Native Safari required')
        command('POST', '/timeouts', {'script': 250000, 'pageLoad': 15000, 'implicit': 0})
        command('POST', '/url', {'url': url})
        yield result['capabilities'].get('browserVersion'), evaluate
    finally:
        if session_id:
            try:
                command('DELETE', '', {})
            except Exception:
                pass
        driver.terminate()
        try:
            driver.wait(timeout=5)
        except subprocess.TimeoutExpired:
            driver.kill()
            driver.wait(timeout=5)
