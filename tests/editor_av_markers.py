"""Independent audio/visual onset checks for the actual export consumer."""
import array, base64, io, json, math, struct, subprocess, wave
from backup_assets import media_payload

MARKERS = (.25, 1.5, 2.75)

def marker_payload():
    payload = media_payload()
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(48000)
        samples = []
        for i in range(3 * 48000):
            t = i / 48000
            active = any(start <= t < start + .06 for start in MARKERS)
            samples.append(struct.pack('<h', int(12000 * math.sin(2 * math.pi * 2000 * t)) if active else 0))
        out.writeframes(b''.join(samples))
    payload[3]['base64'] = base64.b64encode(stream.getvalue()).decode()
    return payload

def verify_markers(path):
    # Preserve the container's audio offset on the video's zero-based clock.
    # Raw PCM alone would otherwise discard an initially delayed audio track.
    raw = subprocess.check_output(['ffmpeg','-v','error','-copyts','-i',str(path),'-vn','-af','aresample=8000:async=1:first_pts=0','-ac','1','-f','f32le','-'])
    samples = array.array('f', raw)
    # Five-millisecond RMS blocks; a relative threshold avoids codec gain and
    # pre-echo being mistaken for the onset of an audible marker.
    energy = [math.sqrt(sum(x*x for x in samples[i:i+40])/40) for i in range(0,len(samples)-39,40)]
    assert energy and max(energy) > .01, 'No decoded marker signal'
    threshold = max(energy) * .35
    pts = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
    pixels = subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-an','-vf','crop=100:100:300:400,scale=1:1','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','-'])
    assert len(pixels) == len(pts)*3, 'Decoded frame/PTS count differs'
    evidence = []
    tolerance = 2/24  # Existing two-frame timing tolerance; no wider allowance.
    for index, target in enumerate(MARKERS):
        audio = next((i*.005 for i,e in enumerate(energy) if abs(i*.005-target)<.2 and e>threshold), None)
        visual = None
        for i,frame in enumerate(pts):
            t = float(frame['best_effort_timestamp_time']); r,g,b = pixels[i*3:i*3+3]
            matched = g>r*1.5 and g>b*1.5 if index==1 else b>r*1.5 and b>g*1.5
            if abs(t-target)<.2 and matched:
                visual=t; break
        assert audio is not None and visual is not None, ('Missing marker', index, audio, visual)
        assert abs(audio-target)<=tolerance and abs(visual-target)<=tolerance and abs(audio-visual)<=tolerance, ('AV marker out of sync', index,target,audio,visual)
        evidence.append({'target':target,'audio':audio,'video':visual,'differenceMs':round((audio-visual)*1000,3)})
    return evidence
