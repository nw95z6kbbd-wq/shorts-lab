"""Offline signal and MP4 checks for the isolated AAC completion experiment."""
import base64
import json
from pathlib import Path
import subprocess

import numpy as np

from safari_aac_analysis import adts_header, independent_decode, marker_lags

ROOT = Path(__file__).resolve().parents[1]
N = 144000
RATE = 48000


def prefix_lag(source, decoded, control_markers=None):
    if control_markers:
        measured = marker_lags(source, decoded, control_markers[:1])
        return {'lag': measured['lagSamples'], 'confidence': measured['status'], 'detail': measured}
    # The original fixture is periodic. Keep alternatives and require agreement
    # with the nonperiodic control before qualifying a strategy.
    width = 10000
    if len(decoded) < width:
        return {'lag': None, 'confidence': 'inconclusive'}
    template = source[:width].astype(float)
    signal = decoded.astype(float)
    n = 1 << (len(signal) + width - 2).bit_length()
    dot = sum(np.fft.irfft(np.fft.rfft(signal[:, c], n) * np.fft.rfft(template[::-1, c], n), n)[width - 1:len(signal)] for c in range(2))
    sums = np.concatenate(([0.], np.cumsum(np.sum(signal * signal, axis=1))))
    scores = dot / np.sqrt(np.maximum(sums[width:] - sums[:-width], 1e-30) * np.sum(template * template))
    indices = np.argsort(scores)[-5:][::-1]
    best = int(indices[0])
    return {'lag': best if scores[best] >= .99 else None,
            'confidence': 'periodic-needs-control' if scores[best] >= .99 else 'inconclusive',
            'alternatives': [{'lag': int(i), 'correlation': float(scores[i])} for i in indices]}


def content_at(source, decoded, lag, control_markers=None):
    windows = control_markers or [{'name': 'start', 'start': 0, 'frames': 10000},
                                  {'name': 'middle', 'start': 60000, 'frames': 16000},
                                  {'name': 'end', 'start': 128000, 'frames': 16000}]
    windows = windows + [{'name': 'last640', 'start': N - 640, 'frames': 640}]
    result = []
    for w in windows:
        a, b = w['start'], w['start'] + w['frames']
        item = {'name': w['name'], 'sourceRange': [a, b], 'covered': lag is not None and lag >= 0 and b + lag <= len(decoded)}
        if item['covered']:
            correlations = []
            for c in range(2):
                x, y = source[a:b, c].astype(float), decoded[a + lag:b + lag, c].astype(float)
                denominator = np.linalg.norm(x) * np.linalg.norm(y)
                correlations.append(float(np.dot(x, y) / denominator) if denominator else 0.)
            item['correlations'] = correlations
            item['passed'] = min(correlations) >= (.45 if control_markers else .99)
            if control_markers:
                local = marker_lags(source, decoded, [w])
                item['bestLocalLag'] = local['lagSamples']
                item['passed'] = item['passed'] and local['status'] == 'measured' and abs(local['lagSamples'] - lag) <= 2
        else:
            item['passed'] = False
        result.append(item)
    return {'passed': all(w['passed'] for w in result), 'windows': result,
            'sourceTailMissingFrames': N if lag is None else max(0, N - max(0, len(decoded) - lag))}


def packet_timing(chunks):
    origin = chunks[0]['timestamp'] if chunks else 0
    errors = [(c['timestamp'] - origin) - i * 1024 * 1e6 / RATE for i, c in enumerate(chunks)]
    durations_ok = True
    for i, c in enumerate(chunks):
        if c['durationPresent']:
            duration = c['duration']
            samples = round(duration * RATE / 1e6)
            durations_ok = durations_ok and isinstance(duration, int) and 1 <= samples <= 1024 and abs(duration - samples * 1e6 / RATE) <= 1 and (i == len(chunks) - 1 or samples == 1024)
    return {'originUs': origin, 'contiguous': bool(chunks) and all(abs(e) <= 1 for e in errors),
            'durationsPlausible': durations_ok,
            'maxGridErrorUs': max((abs(e) for e in errors), default=None),
            'missingDurationCount': sum(not c['durationPresent'] for c in chunks),
            'reportedDurationUsSum': sum(c['duration'] for c in chunks if c['durationPresent'])}


def inspect_mp4(capture_file, priming, folder, name, source, markers):
    target = folder / (name + '.mp4')
    subprocess.run(['node', str(ROOT / 'tests/aac-completion-mux.cjs'), str(capture_file), str(priming), str(target)], check=True, capture_output=True, timeout=15)
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(target)], timeout=20))
    (folder / (name + '-streams.json')).write_text(json.dumps(info, indent=2))
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
    timeline_ok = abs(float(video.get('start_time', -1))) <= .000001 and abs(float(audio.get('start_time', -1))) <= 1 / RATE and abs(float(video['duration']) - 3) <= .000001 and abs(float(audio['duration']) - 3) <= .000001 and abs(float(info['format']['duration']) - 3) <= .000001
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(target), '-map', '0:v:0', '-f', 'null', '-'], check=True, capture_output=True, timeout=30)
    frames = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries',
                                                 'frame=best_effort_timestamp_time', '-of', 'json', str(target)], timeout=20))['frames']
    video_errors = [abs(float(f['best_effort_timestamp_time']) - i / 24) for i, f in enumerate(frames)]
    timeline_ok = timeline_ok and len(frames) == 72 and max(video_errors, default=1) <= .000001
    # Preserve offsets. Never silently concatenate a late track onto movie zero.
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-xerror', '-copyts', '-i', str(target), '-map', '0:a:0',
                                   '-af', 'aresample=async=1:first_pts=0', '-acodec', 'pcm_f32le', '-f', 'f32le', '-'], timeout=30)
    if len(raw) > 200000 * 8 or len(raw) % 8:
        raise ValueError('MP4 PCM budget')
    (folder / (name + '-decoded.f32le')).write_bytes(raw)
    decoded = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
    # An audio decoder may return complete last AUs beyond an edit's end. Retain
    # them in the artifact; inspect only the declared 3s movie presentation here.
    presented = decoded[:N]
    measured = prefix_lag(source, presented, markers)
    content = content_at(source, presented, 0, markers)
    aligned = measured['lag'] is not None and abs(measured['lag']) <= 2
    return {'primingUsed': priming, 'timelineOK': timeline_ok, 'videoFrameCount': len(frames),
            'maxVideoTimestampErrorSeconds': max(video_errors, default=None), 'decoderFramesBeforePresentationClip': len(decoded),
            'declaredPresentationFrames': N, 'measuredPresentationLag': measured,
            'content': content, 'passed': timeline_ok and len(decoded) >= N and aligned and content['passed']}


def analyze_case(capture, folder, source, markers=None):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    capture_file = folder / 'capture.json'
    capture_file.write_text(json.dumps(capture, indent=2))
    chunks = capture['chunks']
    if len(chunks) > 512 or not chunks:
        raise ValueError('Missing/excessive packets')
    descriptions = [c['metadata']['decoderConfig']['ascBase64'] for c in chunks if c.get('metadata', {}).get('decoderConfig', {}).get('ascBase64')]
    if not descriptions or len(set(descriptions)) != 1:
        raise ValueError('Missing/changing ASC')
    asc = base64.b64decode(descriptions[0], validate=True)
    stream = bytearray()
    for i, c in enumerate(chunks):
        payload = base64.b64decode(c['dataBase64'], validate=True)
        if len(stream) + len(payload) > 2 * 1048576:
            raise ValueError('AAC budget')
        (folder / f'chunk-{i:03d}.aac-payload').write_bytes(payload)
        stream.extend(adts_header(len(payload), asc) + payload)
    adts = folder / 'coded.adts.aac'
    adts.write_bytes(stream)
    report = {'packetCount': len(chunks), 'timing': packet_timing(chunks), 'decoders': {},
              'error': capture['error'], 'sourceFrames': N, 'submittedFrames': sum(i['frames'] for i in capture['inputs']),
              'submittedSourceFrames': sum(i['sourceFrames'] for i in capture['inputs']), 'mp4': {}, 'analysisErrors': []}
    probe = subprocess.check_output(['ffprobe', '-v', 'error', '-flags2', '+skip_manual', '-show_frames', '-show_streams', '-of', 'json', str(adts)], timeout=30)
    if len(probe) > 4 * 1048576:
        raise ValueError('Probe budget')
    (folder / 'ffprobe.json').write_bytes(probe)
    streams = json.loads(probe)['streams']
    if len(streams) != 1 or int(streams[0]['sample_rate']) != RATE or streams[0]['channels'] != 2:
        raise ValueError('Actual decoder format differs')
    baseline = None
    for name, manual in [('manual', True), ('default', False)]:
        raw = independent_decode(adts, manual)
        (folder / (name + '.f32le')).write_bytes(raw)
        pcm = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
        lag = prefix_lag(source, pcm, markers)
        report['decoders'][name] = {'frames': len(pcm), 'lag': lag, 'content': content_at(source, pcm, lag['lag'], markers)}
        if manual:
            baseline = pcm
        (folder / 'analysis.json').write_text(json.dumps(report, indent=2))
    measured = report['decoders']['manual']
    resources = capture['resources']
    delay = measured['lag']['lag']
    origin = report['timing']['originUs']
    report['timestampAnchorConsistent'] = delay is not None and (abs(origin) <= 1 or abs(origin + delay * 1e6 / RATE) <= 1)
    eligible = not capture['error'] and report['submittedSourceFrames'] == N and report['timing']['contiguous'] and report['timing']['durationsPlausible'] and report['timestampAnchorConsistent'] and measured['content']['passed'] and resources['created'] == resources['closed'] and resources['encoderClosed'] and len(baseline) == len(chunks) * 1024
    report['eligibleForMeasuredTrim'] = eligible
    (folder / 'analysis.json').write_text(json.dumps(report, indent=2))
    if eligible:
        delay = measured['lag']['lag']
        for label, trim in [('candidate', delay), ('wrong-delay', 0 if delay > 2 else delay + 1024)]:
            try:
                report['mp4'][label] = inspect_mp4(capture_file, trim, folder, label, source, markers)
            except Exception as error:
                report['analysisErrors'].append({'stage': label, 'type': type(error).__name__})
            (folder / 'analysis.json').write_text(json.dumps(report, indent=2))
    report['candidatePassed'] = bool(eligible and not report['analysisErrors'] and report['mp4'].get('candidate', {}).get('passed') and not report['mp4'].get('wrong-delay', {}).get('passed'))
    report['meaning'] = 'Experimental measured trim; not a production delay rule. Original periodic source additionally needs paired nonperiodic control.'
    (folder / 'analysis.json').write_text(json.dumps(report, indent=2))
    return report


def qualify(cases):
    """A strategy needs both sources, two repetitions and consistent raw delay."""
    qualified = []
    for variant in sorted({c['variant'] for c in cases}):
        group = [c for c in cases if c['variant'] == variant]
        keys = {(c['source'], c['repeat']) for c in group}
        expected = {(s, r) for s in ['original', 'control'] for r in range(2)}
        if keys == expected and len(group) == 4 and all(c.get('candidatePassed') and c.get('lag') is not None for c in group):
            lags = [c['lag'] for c in group]
            if max(lags) - min(lags) <= 2:
                qualified.append(variant)
    return qualified
