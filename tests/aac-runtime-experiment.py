"""Isolated WebKit runtime-calibration candidate; never enables production code.

AAC_RUNTIME_MODE=chromium-replay is deliberately labelled FFmpeg encoding plus
Chromium AudioDecoder. It is not a replacement for the default real WebKit run.
"""
import base64
from contextlib import contextmanager
import importlib.util
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

import numpy as np

from aac_completion_analysis import inspect_mp4, packet_timing
from safari_aac_analysis import adts_header, independent_decode, marker_lags, pcm_bytes

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 4096
SCRIPTS = ['tests/safari-aac-probe.js', 'tests/aac-runtime-probe.js', 'tests/aac-runtime-browser.js']


def identity_source():
    fixture = ROOT / 'tests/fixtures/aac-completion'
    raw = gzip.decompress((fixture / 'input.f32le.gz').read_bytes())
    provenance = json.loads((fixture / 'provenance.json').read_text())
    if len(raw) != 144000 * 8 or hashlib.sha256(raw).hexdigest() != provenance['pcmSHA256']:
        raise ValueError('Synthetic fixture identity mismatch')
    return raw


def split_adts(raw):
    packets = []
    while raw:
        if len(raw) < 7 or raw[0] != 255 or raw[1] & 246 != 240:
            raise ValueError('Invalid ADTS header')
        header = 7 if raw[1] & 1 else 9
        size = ((raw[3] & 3) << 11) | (raw[4] << 3) | (raw[5] >> 5)
        if size <= header or size > len(raw) or raw[6] & 3:
            raise ValueError('Invalid ADTS packet')
        if raw[2] >> 6 != 1 or (raw[2] >> 2) & 15 != 3 or ((raw[2] & 1) << 2 | raw[3] >> 6) != 2:
            raise ValueError('Actual encoder is not AAC-LC/48k/stereo')
        packets.append(base64.b64encode(raw[header:size]).decode())
        raw = raw[size:]
    return packets


def replay_assets():
    # Derive encoded fixtures from the exact PCM submitted by the JS candidate.
    # No hard-coded timestamps, delay or precomputed success answers are replayed.
    script = """
const fs=require('fs'),zlib=require('zlib');global.SafariAACProbe=require('./tests/safari-aac-probe.js');
global.AACRuntimeProbe=require('./tests/aac-runtime-probe.js');
const p=require('./tests/aac-runtime-browser.js');const raw=zlib.gunzipSync(fs.readFileSync('tests/fixtures/aac-completion/input.f32le.gz'));
const source=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));const plan=p.plan(source),out=[];
for(const s of [...plan.calibration,...plan.exports]){const w=AACRuntimeProbe.wrap(s.source).pcm;
 const full=new Float32Array((Math.ceil(w.length/2048)+2)*2048);full.set(w);out.push(SafariAACProbe.pcm64(full));}
process.stdout.write(JSON.stringify(out));
"""
    items = json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT, timeout=15))
    records = {}
    for item in items:
        raw = base64.b64decode(item, validate=True)
        encoded = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
                                  '-c:a', 'aac', '-b:a', '128000', '-f', 'adts', 'pipe:1'], input=raw, capture_output=True, timeout=30, check=True).stdout
        records[hashlib.sha256(raw).hexdigest()] = {'chunks': split_adts(encoded), 'asc': base64.b64encode(bytes.fromhex('1190')).decode()}
    return records


def content_windows(source, decoded, offset):
    """Independent fixed-alignment content oracle, including useful edge samples."""
    n = len(source)
    if offset < 0 or offset + n > len(decoded):
        raise ValueError('Useful PCM extends beyond decoded AAC')
    windows = [('first', 0, 1024), ('middle', n//2-512, 1024), ('end', n-1024, 1024),
               ('last640', n-640, 640), ('first64', 0, 64), ('last64', n-64, 64)]
    useful = np.flatnonzero(np.any(source != 0, axis=1))
    if len(useful):
        windows.extend([('firstUseful64', min(int(useful[0]), n-64), 64), ('lastUseful64', max(0, int(useful[-1])-63), 64)])
    windows.extend(('block-'+str(start), min(start, n-1024), 1024) for start in range(0, n, 1024))
    evidence = []
    for name, start, width in windows:
        correlations = []
        for c in range(2):
            x, y = source[start:start+width, c].astype(float), decoded[offset+start:offset+start+width, c].astype(float)
            energy = np.dot(x, x)
            value = None if energy == 0 else float(np.dot(x, y) / np.sqrt(max(energy * np.dot(y, y), 1e-30)))
            correlations.append(value)
            if value is not None and value < .45:
                raise ValueError('Independent useful PCM correlation failed: ' + name)
        evidence.append({'name': name, 'correlations': correlations, 'silentReferenceHasNoCorrelationEvidence': any(v is None for v in correlations)})
    return evidence


def analyze(record, folder):
    folder.mkdir()
    capture = folder / 'capture.json'
    capture.write_text(json.dumps(record, indent=2))  # preserve before validation
    raw, reference = pcm_bytes(record['inputPCMBase64'])
    (folder / 'input.f32le').write_bytes(raw)
    if record['error']:
        raise ValueError('Runtime candidate refused')
    chunks = record['chunks']
    n = record['sourceFrames']
    if not 1024 <= n <= 144000 or len(reference) != n+PREFIX*2:
        raise ValueError('Synthetic envelope/source size mismatch')
    descriptions = [c['metadata']['decoderConfig']['ascBase64'] for c in chunks if c.get('metadata', {}).get('decoderConfig', {}).get('ascBase64')]
    if not descriptions or len(set(descriptions)) != 1:
        raise ValueError('Missing/changing ASC')
    asc = base64.b64decode(descriptions[0], validate=True)
    (folder / 'asc.bin').write_bytes(asc)
    stream = bytearray()
    for i, c in enumerate(chunks):
        data = base64.b64decode(c['dataBase64'], validate=True)
        (folder / f'chunk-{i:03d}.aac-payload').write_bytes(data)
        stream.extend(adts_header(len(data), asc) + data)
    coded = folder / 'coded.adts.aac'
    coded.write_bytes(stream)
    result = {'status': 'incomplete', 'decoders': {}, 'runtime': record['measurement'], 'mp4': {}}
    def checkpoint():
        (folder / 'analysis.json').write_text(json.dumps(result, indent=2))

    checkpoint()
    lag = record['measurement']['delay']
    timing = packet_timing(chunks)
    if record['measurement']['trim'] != PREFIX+lag or record['measurement']['presentationFrames'] != n:
        raise ValueError('Wrong presentation trim/length')
    if not timing['contiguous'] or not timing['durationsPlausible'] or not (abs(timing['originUs']) <= 1 or abs(timing['originUs']+lag*1e6/48000) <= 1):
        raise ValueError('AAC packet timeline mismatch')
    result['timing'] = timing
    source = reference[PREFIX:PREFIX+n]
    for name, manual in [('ffmpeg-manual', True), ('ffmpeg-default', False)]:
        decoded = independent_decode(coded, manual)
        (folder / (name + '.f32le')).write_bytes(decoded)
        pcm = np.frombuffer(decoded, dtype='<f4').reshape(-1, 2)
        measured = marker_lags(reference, pcm, record['markers'])
        result['decoders'][name] = {'frames': len(pcm), 'markers': measured}
        checkpoint()
        if len(pcm) != len(chunks) * 1024 or measured['status'] != 'measured' or measured['lagSamples'] != lag:
            raise ValueError('Runtime delay does not match independent full-AU decoder')
        result['decoders'][name]['content'] = content_windows(source, pcm, PREFIX+lag)
        checkpoint()
    for name, decoded in record['decodes'].items():
        raw_pcm, pcm = pcm_bytes(decoded['pcmBase64'])
        (folder / (name + '.f32le')).write_bytes(raw_pcm)
        measured = marker_lags(reference, pcm, record['markers'])
        result['decoders'][name] = {'frames': len(pcm), 'markers': measured}
        checkpoint()
        if len(pcm) != len(chunks) * 1024 or measured['status'] != 'measured' or measured['lagSamples'] != lag:
            raise ValueError('Browser/independent decoder disagree')
        result['decoders'][name]['content'] = content_windows(source, pcm, PREFIX+lag)
        checkpoint()
    resources = record['resources']
    if resources['created'] != resources['closed'] or resources['decodedCreated'] != resources['decodedClosed'] or not resources['encoderClosed'] or not resources['decoderClosed']:
        raise ValueError('Leaked codec resource')
    n = record['sourceFrames']
    if n == 144000:
        source = reference[PREFIX:PREFIX+n]
        # The old container helper takes the presentation length (3s) separately
        # from raw packet count. Service canaries are never presented.
        markers = None if record['label'].startswith('original') else [
            {'name': 'head', 'start': 0, 'frames': 1024}, {'name': 'middle', 'start': n//2-512, 'frames': 1024},
            {'name': 'tail', 'start': n-1024, 'frames': 1024}]
        for label, trim in [('candidate', PREFIX+lag), ('untrimmed', 0), ('double-trim', 2*(PREFIX+lag))]:
            result['mp4'][label] = inspect_mp4(capture, trim, folder, label, source, markers)
            checkpoint()
        if not result['mp4']['candidate']['passed'] or any(result['mp4'][k]['passed'] for k in ['untrimmed', 'double-trim']):
            raise ValueError('MP4 content/trim negative control failed')
    result['status'] = 'independently-confirmed-candidate'
    (folder / 'analysis.json').write_text(json.dumps(result, indent=2))
    return {'label': record['label'], 'status': result['status'], 'delay': lag, 'packetCount': len(chunks), 'trim': record['measurement']['trim']}


@contextmanager
def browser_session(mode, url):
    if mode == 'native-safari':
        spec = importlib.util.spec_from_file_location('aac_runtime_safari', ROOT / 'tests/aac-runtime-safari.py')
        transport = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        with transport.session(url) as native:
            yield native
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        engine = p.webkit if mode == 'webkit' else p.chromium
        if mode == 'webkit' and not Path(engine.executable_path).is_file():
            raise RuntimeError('Real matching WebKit unavailable; no substitution')
        browser = engine.launch(**({} if mode == 'webkit' else {'executable_path': shutil.which('chromium'), 'args': ['--no-sandbox']}))
        try:
            page = browser.new_page()
            page.goto(url)
            yield browser.version, page.evaluate
        finally:
            browser.close()


def run():
    mode = os.environ.get('AAC_RUNTIME_MODE', 'webkit')
    if mode not in ['webkit', 'native-safari', 'chromium-replay']:
        raise ValueError('Unsupported engine; no automatic substitution')
    output = ROOT / 'test-results' / ('aac-runtime-' + mode)
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Preserve previous evidence before another run')
    output.mkdir(parents=True, exist_ok=True)
    summary = {'schema': 1, 'mode': mode, 'status': 'incomplete', 'cases': [], 'productionEnabled': False,
               'meaning': 'Candidate experiment; no production sync or Merge approval.', 'stage': 'source'}
    try:
        _run_experiment(mode, output, summary)
    except Exception as error:
        # Do not retain exception messages/stderr, which may contain credentials
        # or process context. Stage and exit code identify preparation failures.
        summary['status'] = 'incomplete'
        summary['errorType'] = type(error).__name__
        if isinstance(error, subprocess.CalledProcessError):
            summary['exitCode'] = error.returncode
    finally:
        (output / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({'status': summary['status'], 'mode': mode, 'profile': summary.get('runtime', {}).get('profile'), 'cases': summary['cases']}), flush=True)
    if summary['status'] != 'candidate-confirmed-in-this-engine':
        raise RuntimeError('Runtime calibration inconclusive/refused; inspect synthetic evidence')


def _run_experiment(mode, output, summary):
    source = identity_source()
    summary['stage'] = 'assets'
    replay = replay_assets() if mode == 'chromium-replay' else None
    assets = {'/': (b'<!doctype html><title>Synthetic runtime AAC calibration</title><script src="/probe.js"></script>', 'text/html'),
              '/probe.js': (b'\n'.join((ROOT / s).read_bytes() for s in SCRIPTS), 'text/javascript'),
              '/source.f32le': (source, 'application/octet-stream'),
              '/replay.json': (json.dumps(replay).encode(), 'application/json'),
              '/reference.json': ((ROOT / 'tests/fixtures/aac-runtime/decoder-reference.json').read_bytes(), 'application/json')}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in assets:
                self.send_error(404)
                return
            body, kind = assets[self.path]
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    summary['stage'] = 'source-hashes'
    summary['sourceHashes'] = {s: hashlib.sha256((ROOT / s).read_bytes()).hexdigest() for s in SCRIPTS + ['tests/aac-runtime-experiment.py', 'tests/aac-runtime-safari.py', 'tests/aac-completion-mux.cjs', 'tests/aac_completion_analysis.py', 'tests/safari_aac_analysis.py', 'js/native-mp4.js', 'tests/fixtures/aac-runtime/decoder-reference.json']}
    summary['stage'] = 'git-revision'
    summary['commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    summary['stage'] = 'git-status'
    summary['workingTreeDirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT))
    summary['stage'] = 'server'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server_started = False
    try:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        server_started = True
        summary['stage'] = 'browser'
        with browser_session(mode, f'http://127.0.0.1:{server.server_port}/') as (browser_version, evaluate):
            summary['browserVersion'] = browser_version
            result = evaluate('''async replay=>{
const raw=await (await fetch('/source.f32le')).arrayBuffer();
return AACRuntimeBrowser.run(new Float32Array(raw),replay?await (await fetch('/replay.json')).json():null,await (await fetch('/reference.json')).json());
}''', bool(replay))
            summary['runtime'] = result
            count = evaluate('()=>AACRuntimeEvidence.length')
            for i in range(count):
                record = evaluate('(i)=>AACRuntimeEvidence[i]', i)
                folder = output / f'{i:02d}-{record["label"]}'
                try:
                    summary['cases'].append(analyze(record, folder))
                except Exception as error:
                    summary['cases'].append({'label': record['label'], 'status': 'refused', 'errorType': type(error).__name__})
                    # Internal validator errors contain only synthetic file names.
                    # Do not save process stderr, WebDriver or browser exceptions.
                    (folder / 'error.json').write_text(json.dumps({'type': type(error).__name__, 'reason': str(error) if type(error) is ValueError else None}, indent=2))
                if sum(f.stat().st_size for f in output.rglob('*') if f.is_file()) > 96 * 1048576:
                    raise ValueError('Synthetic artifact budget')
            summary['status'] = 'candidate-confirmed-in-this-engine' if result['status'] == 'candidate-measured' and count == 11 and all(c['status'] == 'independently-confirmed-candidate' for c in summary['cases']) else 'inconclusive'

    finally:
        if server_started:
            server.shutdown()
        server.server_close()


if __name__ == '__main__':
    run()
