"""Bounded, synthetic export evidence. Never changes an export verdict."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def binary(value, limit):
    if not isinstance(value, str) or len(value) > (limit + 2) // 3 * 4:
        raise ValueError('Diagnostic payload budget')
    result = base64.b64decode(value, validate=True)
    if len(result) > limit:
        raise ValueError('Diagnostic payload budget')
    return result


def adts_header(payload, asc):
    # Headers only: AAC access-unit bytes are not rewritten or trimmed.
    if len(asc) < 2 or asc[0] >> 3 != 2 or ((asc[0] & 7) << 1 | asc[1] >> 7) != 3 or (asc[1] >> 3) & 15 != 2 or asc[1] & 4:
        raise ValueError('Independent decode requires actual AAC-LC 48k stereo ASC')
    size = len(payload) + 7
    if not 7 < size < 8192:
        raise ValueError('ADTS packet budget')
    return bytes((255, 241, 76, 128 | (size >> 11), (size >> 3) & 255,
                  ((size & 7) << 5) | 31, 252))


def save_capture(capture, label, output_root=ROOT):
    expected = {'fixture': 'editor-export-synthetic-3s', 'durationMs': 3000,
                'pcmFrames': 144000, 'sampleRate': 48000, 'numberOfChannels': 2}
    if capture.get('expected') != expected or not re.fullmatch('[a-z0-9-]{1,80}', label):
        raise ValueError('Only labelled synthetic export evidence is permitted')
    data = json.dumps(capture, indent=2).encode()
    if len(data) > 8 * 1048576 or len(capture.get('encoders', [])) > 1:
        raise ValueError('Capture budget')
    base = Path(output_root) / 'test-results/editor-canvas/editor-export-aac'
    base.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix=label + '-', dir=base))
    file = folder / 'capture.json'
    file.write_bytes(data)  # Retain evidence even if replay/decoding fails.
    manifest = {'schema': 1, 'source': 'synthetic-only', 'status': 'incomplete',
                'expected': expected, 'label': label, 'errors': []}
    try:
        revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
        manifest['commit'] = revision.stdout.strip() if revision.returncode == 0 else None
        dirty = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT, capture_output=True)
        manifest['trackedSourcesDirty'] = bool(dirty.stdout) if dirty.returncode == 0 else None
        replay = subprocess.run(['node', str(ROOT / 'tests/editor-aac-report.cjs'), str(file)],
                                capture_output=True, check=True, timeout=10)
        report = json.loads(replay.stdout)
        (folder / 'validator.json').write_text(json.dumps(report, indent=2))
        manifest['validator'] = report
        record = capture['encoders'][0]
        if len(record['chunks']) > 512 or len(record['inputs']) > 256:
            raise ValueError('Packet/input budget')
        pcm = binary(record['inputPCMBase64'], 144000 * 8)
        if len(pcm) % 8:
            raise ValueError('Stereo PCM alignment')
        (folder / 'input.f32le').write_bytes(pcm)
        manifest['inputFramesCaptured'] = len(pcm) // 8
        manifest['inputSHA256'] = hashlib.sha256(pcm).hexdigest()
        manifest['lastInputFrames'] = record['inputs'][-1]['numberOfFrames'] if record['inputs'] else None
        index, payloads = [], []
        total = 0
        for i, chunk in enumerate(record['chunks']):
            payload = binary(chunk['dataBase64'], 65536)
            total += len(payload)
            if total > 2 * 1048576:
                raise ValueError('Encoded budget')
            payloads.append(payload)
            (folder / f'chunk-{i:03d}.aac-payload').write_bytes(payload)
            config = chunk.get('metadata', {}).get('decoderConfig', {})
            if 'descriptionBase64' in config:
                (folder / f'description-{i:03d}.bin').write_bytes(binary(config['descriptionBase64'], 65536))
            index.append({'index': i, 'timestamp': chunk['timestamp'], 'durationPresent': chunk['durationPresent'],
                          'duration': chunk['duration'], 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
        (folder / 'packets.json').write_text(json.dumps(index, indent=2))
        asc = binary(report['actualASCBase64'], 64)
        (folder / 'asc.bin').write_bytes(asc)
        adts = folder / 'coded.adts.aac'
        adts.write_bytes(b''.join(adts_header(payload, asc) + payload for payload in payloads))
        manifest['independentDecode'] = {}
        try:
            probe = subprocess.run(['ffprobe', '-v', 'error', '-flags2', '+skip_manual', '-show_streams',
                                    '-show_frames', '-of', 'json', str(adts)],
                                   capture_output=True, check=True, timeout=30)
            if len(probe.stdout) > 4 * 1048576:
                raise ValueError('ffprobe budget')
            (folder / 'ffprobe-manual.json').write_bytes(probe.stdout)
            streams = json.loads(probe.stdout)['streams']
            if len(streams) != 1 or int(streams[0]['sample_rate']) != 48000 or streams[0]['channels'] != 2:
                raise ValueError('Independent decoder format differs')
            for name, options in [('manual-skip', ['-flags2', '+skip_manual']), ('default', [])]:
                decoded = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', *options, '-i', str(adts),
                                          '-map', '0:a:0', '-acodec', 'pcm_f32le', '-f', 'f32le', '-'],
                                         capture_output=True, check=True, timeout=30).stdout
                if len(decoded) > 200000 * 8 or len(decoded) % 8:
                    raise ValueError('Independent PCM budget')
                (folder / f'decoded-{name}.f32le').write_bytes(decoded)
                manifest['independentDecode'][name] = {'frames': len(decoded) // 8,
                    'sha256': hashlib.sha256(decoded).hexdigest()}
        except Exception as error:
            manifest['errors'].append({'stage': 'independent-decode', 'type': type(error).__name__})
        manifest['status'] = 'saved'
    except Exception as error:
        manifest['errors'].append({'stage': 'evidence', 'type': type(error).__name__})
    finally:
        manifest['meaning'] = 'ADTS has no original PTS/edit list. Raw PCM is unaligned; no assumed priming was removed.'
        (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    return folder, manifest


def save_from_page(page, label):
    """Best-effort diagnostics must not replace the original test exception."""
    try:
        capture = page.evaluate('''async () => {
          let exportOutcome={accepted:true};
          if(window.exportPromise)await exportPromise.catch(e=>{
            exportOutcome={accepted:false,code:e.code||null,
              aacCoverageFailure:e.message==='AAC не покрывает исходный PCM либо содержит лишние пакеты.'};
          });
          return {...EditorAACTrace.snapshot(),exportOutcome};
        }''')
        folder, manifest = save_capture(capture, label)
        print('::notice title=Editor AAC evidence::' + json.dumps({
            'folder': folder.relative_to(ROOT).as_posix(), 'status': manifest['status'],
            'coverage': manifest.get('validator', {}).get('coverage'), 'errors': manifest['errors']}), flush=True)
    except Exception as error:
        print('::warning title=Editor AAC evidence unavailable::' + type(error).__name__, flush=True)
    finally:
        try:
            page.evaluate('EditorAACTrace.stop()')
        except Exception:
            pass
