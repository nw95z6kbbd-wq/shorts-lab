"""Synthetic AAC evidence only; never imports the app mux or assumes encoder delay."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np

RATE = 48000
LENGTHS = (1023, 1024, 1025, 2048, 48000, 144337)


def unbase64(value, limit):
    if not isinstance(value, str) or len(value) > (limit + 2) // 3 * 4:
        raise ValueError('Synthetic payload budget')
    result = base64.b64decode(value, validate=True)
    if len(result) > limit:
        raise ValueError('Synthetic payload budget')
    return result


def pcm_bytes(value):
    raw = unbase64(value, 200000 * 2 * 4)
    if not raw or len(raw) % 8:
        raise ValueError('Stereo f32 PCM required')
    pcm = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
    if not np.isfinite(pcm).all():
        raise ValueError('Non-finite PCM')
    return raw, pcm


def marker_lags(reference, decoded, markers):
    """Normalized correlation, searching the whole output without a priming guess.

    Two samples is measurement agreement, not an allowed AV delay. Weak or
    inconsistent peaks produce INCONCLUSIVE instead of selecting a known delay.
    """
    evidence = []
    for marker in markers:
        start, width = marker['start'], marker['frames']
        if not 0 <= start < start + width <= len(reference) or width < 64:
            raise ValueError('Marker bounds')
        channels = []
        for channel in range(2):
            template = reference[start:start + width, channel].astype(np.float64)
            template -= template.mean()
            signal = decoded[:, channel].astype(np.float64)
            if len(signal) < width:
                raise ValueError('Output shorter than marker')
            n = 1 << (len(signal) + width - 2).bit_length()
            dot = np.fft.irfft(np.fft.rfft(signal, n) * np.fft.rfft(template[::-1], n), n)[width - 1:len(signal)]
            sums = np.concatenate(([0.], np.cumsum(signal)))
            squares = np.concatenate(([0.], np.cumsum(signal * signal)))
            energy = squares[width:] - squares[:-width] - (sums[width:] - sums[:-width]) ** 2 / width
            denominator = np.sqrt(np.maximum(energy, 0) * np.dot(template, template))
            scores = np.divide(dot, denominator, out=np.zeros_like(dot), where=denominator > 1e-12)
            peak = int(np.argmax(scores))
            other = scores.copy()
            other[max(0, peak - 8):peak + 9] = -1
            channels.append({'lagSamples': peak - start, 'correlation': float(scores[peak]),
                             'peakSeparation': float(scores[peak] - np.max(other, initial=-1))})
        evidence.append({'name': marker['name'], 'sourceSample': start, 'channels': channels})
    lags = [c['lagSamples'] for m in evidence for c in m['channels']]
    strong = all(c['correlation'] >= .45 and c['peakSeparation'] >= .05 for m in evidence for c in m['channels'])
    consistent = bool(lags) and max(lags) - min(lags) <= 2
    return {'status': 'measured' if strong and consistent else 'inconclusive', 'markers': evidence,
            'lagSamples': int(np.median(lags)) if strong and consistent else None,
            'lagSpreadSamples': max(lags) - min(lags) if lags else None,
            'meaning': 'Decoded content lag, not by itself proof of encoder-only priming.'}


def adts_header(length, asc):
    # ADTS preserves access-unit bytes but has no container timestamps/edit list.
    if len(asc) < 2 or asc[0] >> 3 != 2 or ((asc[0] & 7) << 1 | asc[1] >> 7) != 3 or (asc[1] >> 3) & 15 != 2 or asc[1] & 4:
        raise ValueError('Diagnostic requires actual AAC-LC 48k stereo / 1024 config')
    size = length + 7
    if not 7 < size < 8192:
        raise ValueError('ADTS frame budget')
    return bytes((0xff, 0xf1, (1 << 6) | (3 << 2), (2 << 6) | (size >> 11),
                  (size >> 3) & 255, ((size & 7) << 5) | 31, 0xfc))


def independent_decode(path, manual):
    options = ['-flags2', '+skip_manual'] if manual else []
    command = ['ffmpeg', '-v', 'error', '-xerror', *options, '-i', str(path), '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-']
    result = subprocess.run(command, capture_output=True, timeout=30, check=True)
    if not result.stdout or len(result.stdout) > 200000 * 8 or len(result.stdout) % 8:
        raise ValueError('Independent decode budget/format')
    return result.stdout


def compare_decoders(raw_analysis, raw_frames, analysis, frames):
    if raw_analysis['status'] != 'measured' or analysis['status'] != 'measured':
        return {'status': 'inconclusive'}
    removed = raw_analysis['lagSamples'] - analysis['lagSamples']
    return {'contentSamplesRemovedRelativeToManualFFmpeg': removed,
            'outputFrameCountDifference': raw_frames - frames,
            'consistentWithLeadingTrim': removed > 2 and abs((raw_frames - frames) - removed) <= 2,
            'caveat': 'Different decoder/filter behavior can also affect alignment; inspect frame PTS and skip side data. This is not encoder-delay metadata.'}


def frame_timeline(frames):
    if not frames:
        return {'status': 'unavailable'}
    origin, total, errors = frames[0]['timestamp'], 0, []
    for frame in frames:
        if frame['sampleRate'] != RATE or frame['numberOfChannels'] != 2:
            raise ValueError('Unexpected decoder format')
        errors.append((frame['timestamp'] - origin) * RATE / 1e6 - total)
        total += frame['numberOfFrames']
    return {'status': 'contiguous' if max(abs(e) for e in errors) <= .1 else 'discontinuous',
            'originSamples': origin * RATE / 1e6, 'decodedFrames': total,
            'maxTimestampErrorSamples': max(abs(e) for e in errors)}


def analyze_capture(capture, folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    count = capture['frames']
    if count not in LENGTHS or capture.get('schema') != 1 or len(capture['chunks']) > 512:
        raise ValueError('Capture schema/budget')
    raw, reference = pcm_bytes(capture['inputPCMBase64'])
    if len(reference) != count or len(capture['markers']) != 3:
        raise ValueError('Input/markers mismatch')
    (folder / 'input.f32le').write_bytes(raw)
    chunks, asc = capture['chunks'], None
    for chunk in chunks:
        dc = chunk.get('metadata', {}).get('decoderConfig', {})
        if 'ascBase64' in dc:
            candidate = unbase64(dc['ascBase64'], 64)
            if asc is not None and asc != candidate:
                raise ValueError('Changed decoder config')
            asc = candidate
    if asc is None or not chunks:
        raise ValueError('Missing actual ASC/chunks')
    (folder / 'asc.bin').write_bytes(asc)
    stream, index = bytearray(), []
    for i, chunk in enumerate(chunks):
        data = unbase64(chunk['dataBase64'], 8191)
        if len(stream) + len(data) > 2 * 1048576:
            raise ValueError('Encoded budget')
        # Separate chunks retain original payload; index retains original timing.
        (folder / f'chunk-{i:03d}.aac-payload').write_bytes(data)
        dc = chunk.get('metadata', {}).get('decoderConfig', {})
        if 'descriptionBase64' in dc:
            (folder / f'description-{i:03d}.bin').write_bytes(unbase64(dc['descriptionBase64'], 65536))
        index.append({'index': i, 'timestamp': chunk['timestamp'], 'duration': chunk['duration'],
                      'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        stream.extend(adts_header(len(data), asc) + data)
    (folder / 'chunks.json').write_text(json.dumps(index, indent=2))
    path = folder / 'untrimmed.adts.aac'
    path.write_bytes(stream)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-flags2', '+skip_manual', '-show_frames', '-show_streams', '-of', 'json', str(path)], capture_output=True, timeout=30, check=True)
    if len(probe.stdout) > 4 * 1048576:
        raise ValueError('Probe budget')
    (folder / 'ffprobe-manual.json').write_bytes(probe.stdout)
    report = {'sourceFrames': count, 'packetCount': len(chunks), 'codedFramesIf1024PerAU': len(chunks) * 1024,
              'timestampOriginSamples': chunks[0]['timestamp'] * RATE / 1e6,
              'packetTimestampDeltasSamples': [(b['timestamp'] - a['timestamp']) * RATE / 1e6 for a, b in zip(chunks, chunks[1:])],
              'inputs': capture['inputs'], 'packetTiming': index, 'decoders': {},
              'encoderDelayConclusion': 'UNRESOLVED: no delay is inferred from ES-cookie/bufferSizeDB or packet count.'}
    for label, manual in [('ffmpegManualSkip', True), ('ffmpegDefault', False)]:
        decoded = independent_decode(path, manual)
        (folder / (label + '.f32le')).write_bytes(decoded)
        pcm = np.frombuffer(decoded, dtype='<f4').reshape(-1, 2)
        report['decoders'][label] = {'frames': len(pcm), **marker_lags(reference, pcm, capture['markers'])}
    baseline = report['decoders']['ffmpegManualSkip']
    report['manualOutputMatchesCodedFrameCount'] = baseline['frames'] == len(chunks) * 1024
    if baseline['status'] == 'measured':
        report['rawAlignment'] = {
            'leadingContentLagSamples': baseline['lagSamples'],
            'contentTimelineLagUsingOriginalPacketOrigin': baseline['lagSamples'] + report['timestampOriginSamples'],
            'tailSamplesAfterAlignedSource': baseline['frames'] - baseline['lagSamples'] - count,
            'caveat': 'Measured system response includes decoder behavior; do not equate this automatically to encoder priming.'}
    for label, value in capture.get('decodes', {}).items():
        if label not in ('asReported', 'normalizedASC'):
            raise ValueError('Unexpected decoder')
        if value.get('error') or not value.get('pcmBase64'):
            report['decoders'][label] = {'status': 'unavailable', 'errorType': value.get('error')}
            continue
        decoded, pcm = pcm_bytes(value['pcmBase64'])
        (folder / (label + '.f32le')).write_bytes(decoded)
        timeline = frame_timeline(value['frames'])
        item = {'frames': len(pcm), 'frameMetadata': value['frames'], 'timeline': timeline, **marker_lags(reference, pcm, capture['markers'])}
        if timeline['status'] != 'contiguous' or timeline['decodedFrames'] != len(pcm):
            item['status'] = 'inconclusive'
        item['contentTimelineLagSamples'] = item['lagSamples'] + timeline['originSamples'] if item['status'] == 'measured' else None
        item['relativeToManualFFmpeg'] = compare_decoders(baseline, baseline['frames'], item, len(pcm))
        report['decoders'][label] = item
    default = report['decoders']['ffmpegDefault']
    default['relativeToManualFFmpeg'] = compare_decoders(baseline, baseline['frames'], default, default['frames'])
    # Missing metadata is an observation, not permission to manufacture delay.
    report['reportedDelayFields'] = [c['metadata'] for c in chunks if c.get('metadata', {}).get('delayFields') or c.get('metadata', {}).get('decoderConfig', {}).get('delayFields')]
    report['status'] = 'measured' if not capture.get('error') and report['manualOutputMatchesCodedFrameCount'] and baseline['status'] == 'measured' and report['decoders'].get('normalizedASC', {}).get('status') == 'measured' else 'inconclusive'
    (folder / 'analysis.json').write_text(json.dumps(report, indent=2))
    return report
