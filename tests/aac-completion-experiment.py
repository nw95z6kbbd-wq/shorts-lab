"""Real Linux Playwright WebKit only, isolated from the app and project data."""
import gzip
import hashlib
from importlib.metadata import version
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
import time

import numpy as np
from playwright.sync_api import sync_playwright

from aac_completion_analysis import N, analyze_case, qualify

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/aac-completion'
OUTPUT = ROOT / 'test-results/aac-completion'


def original_pcm():
    raw = gzip.decompress((FIXTURE / 'input.f32le.gz').read_bytes())
    provenance = json.loads((FIXTURE / 'provenance.json').read_text())
    if len(raw) != N * 8 or hashlib.sha256(raw).hexdigest() != provenance['pcmSHA256']:
        raise ValueError('Original PCM identity mismatch')
    return raw


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            body, kind = b'<!doctype html><title>Isolated AAC completion</title><script src="/probe.js"></script>', 'text/html'
        elif self.path == '/probe.js':
            body = (ROOT / 'tests/safari-aac-probe.js').read_bytes() + b'\n' + (ROOT / 'tests/aac-completion-probe.js').read_bytes()
            kind = 'text/javascript'
        elif self.path == '/input.f32le':
            body, kind = original_pcm(), 'application/octet-stream'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def run():
    if OUTPUT.exists() and any(OUTPUT.iterdir()):
        raise RuntimeError('Preserve the existing experiment output before another run')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    raw = original_pcm()
    (OUTPUT / 'original.f32le').write_bytes(raw)
    source_arrays = {'original': np.frombuffer(raw, dtype='<f4').reshape(-1, 2)}
    # Generate the exact same deterministic control as the browser, without
    # storing source audio redundantly in every capture.
    script = "global.SafariAACProbe=require('./tests/safari-aac-probe.js');const s=require('./tests/aac-completion-probe.js').sourceControl();require('fs').writeFileSync(process.argv[1],Buffer.from(SafariAACProbe.pcm64(s.pcm),'base64'));require('fs').writeFileSync(process.argv[2],JSON.stringify(s.markers));"
    subprocess.run(['node', '-e', script, str(OUTPUT / 'control.f32le'), str(OUTPUT / 'control-markers.json')], cwd=ROOT, check=True, capture_output=True, timeout=10)
    source_arrays['control'] = np.fromfile(OUTPUT / 'control.f32le', dtype='<f4').reshape(-1, 2)
    markers = json.loads((OUTPUT / 'control-markers.json').read_text())
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
    dirty = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, capture_output=True)
    summary = {'schema': 1, 'engine': 'real Playwright Linux WebKit', 'commit': revision.stdout.strip() if revision.returncode == 0 else None,
               'workingTreeDirty': bool(dirty.stdout) if dirty.returncode == 0 else None,
               'playwrightVersion': version('playwright'),
               'sourceHashes': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                                ['tests/aac-completion-probe.js', 'tests/aac_completion_analysis.py', 'tests/aac-completion-mux.cjs', 'js/native-mp4.js']},
               'sourceSHA256': {s: hashlib.sha256(a.astype('<f4').tobytes()).hexdigest() for s, a in source_arrays.items()},
               'cases': [], 'qualifiedStrategies': [], 'status': 'incomplete',
               'meaning': 'Measurement experiment, not a production fix or Merge approval.'}
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    try:
        with sync_playwright() as p:
            if not Path(p.webkit.executable_path).is_file():
                raise RuntimeError('Matching Linux WebKit bundle unavailable; no browser substitution')
            browser = p.webkit.launch()
            try:
                summary['browserVersion'] = browser.version
                page = browser.new_page()
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                page.evaluate('async()=>AACCompletionExperiment.initialize(await (await fetch("/input.f32le")).arrayBuffer())')
                variants = page.evaluate('AACCompletionExperiment.VARIANTS.map(v=>v.id)')
                deadline = time.monotonic() + 8 * 60
                for variant in variants:
                    for source in ['original', 'control']:
                        for repeat in range(2):
                            item = {'variant': variant, 'source': source, 'repeat': repeat, 'status': 'incomplete'}
                            summary['cases'].append(item)
                            (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2))
                            if time.monotonic() >= deadline:
                                raise TimeoutError('Experiment deadline')
                            folder = OUTPUT / f'{variant}-{source}-{repeat}'
                            folder.mkdir()
                            try:
                                capture = page.evaluate('([s,v])=>AACCompletionExperiment.run(s,v)', [source, variant])
                                encoded = json.dumps(capture, indent=2).encode()
                                if len(encoded) > 8 * 1048576:
                                    raise ValueError('Capture transport budget')
                                (folder / 'capture.json').write_bytes(encoded)
                                report = analyze_case(capture, folder, source_arrays[source], markers if source == 'control' else None)
                                item.update(status='encoder-error' if capture['error'] else 'analysis-error' if report['analysisErrors'] else 'measured',
                                            candidatePassed=report['candidatePassed'], lag=report['decoders']['manual']['lag']['lag'],
                                            packetCount=report['packetCount'], missingTail=report['decoders']['manual']['content']['sourceTailMissingFrames'])
                            except Exception as error:
                                item['errorType'] = type(error).__name__
                                (folder / 'error.json').write_text(json.dumps({'type': type(error).__name__, 'stage': 'capture-or-analysis'}, indent=2))
                            print(json.dumps(item), flush=True)
                            (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2))
                            if sum(f.stat().st_size for f in OUTPUT.rglob('*') if f.is_file()) > 192 * 1048576:
                                raise ValueError('Artifact budget')
                summary['qualifiedStrategies'] = qualify(summary['cases'])
                summary['status'] = 'measurements-complete' if len(summary['cases']) == len(variants) * 4 and all(c['status'] == 'measured' and c.get('lag') is not None for c in summary['cases']) else 'inconclusive'
            finally:
                browser.close()
    except Exception as error:
        summary['errorType'] = type(error).__name__
    finally:
        server.shutdown()
        server.server_close()
        (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    if summary['status'] != 'measurements-complete':
        raise RuntimeError('Experiment incomplete/inconclusive; inspect artifacts')
    print(json.dumps({'status': summary['status'], 'qualifiedStrategies': summary['qualifiedStrategies'], 'productionChanged': False}), flush=True)


if __name__ == '__main__':
    run()
