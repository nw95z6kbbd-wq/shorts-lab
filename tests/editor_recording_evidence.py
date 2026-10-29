"""Inspect only the generated three-scene test clip, never user project/media."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def inspect_recording(path):
    """Report real decoded frame coverage separately from container duration."""
    assert shutil.which('ffprobe') and shutil.which('ffmpeg'), 'FFmpeg and ffprobe are required for independent Editor recording validation'
    raw = subprocess.check_output(['ffprobe', '-v', 'error', '-show_frames', '-show_streams', '-show_format', '-show_entries',
        'frame=media_type,width,height,best_effort_timestamp_time,pts_time,pkt_duration_time,duration_time,nb_samples,sample_rate:stream=index,codec_type,codec_name,width,height,sample_rate,duration:format=duration,format_name,size', '-of', 'json', str(path)], timeout=40)
    if len(raw) > 4 * 1048576:
        raise AssertionError('Unexpectedly large three-second recording inspection')
    info = json.loads(raw)
    def frames(kind):
        values=[]
        for f in info['frames']:
            if f.get('media_type') != kind:
                continue
            t=float(f.get('best_effort_timestamp_time', f.get('pts_time', 'nan')))
            duration=float(f.get('duration_time', f.get('pkt_duration_time', 0)))
            values.append((t, duration, f))
        return values
    video, audio = frames('video'), frames('audio')
    def bounds(values):
        return {'count':len(values), 'firstPts':min((v[0] for v in values),default=None),
                'lastPts':max((v[0] for v in values),default=None), 'end':max((v[0]+v[1] for v in values),default=None),
                'maxGap':max((b[0]-a[0] for a,b in zip(values,values[1:])),default=0)}
    # Decode the entire file with errors fatal, rather than accepting one frame.
    subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(path),'-f','null','-'],check=True,capture_output=True,timeout=40)
    return {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,
            'format':info['format'],'streams':info['streams'],'video':{**bounds(video),'dimensions':sorted({(f[2].get('width'),f[2].get('height')) for f in video})},'audio':bounds(audio),'fullDecode':True}


def save_recording_evidence(root, script, command, label):
    """Bounded test-owned Blob transport; keep diagnostics even when decoding fails."""
    folder=Path(root)/'test-results/editor-canvas'/label
    folder.mkdir(parents=True,exist_ok=True)
    evidence=script('return window.editorRecordingEvidence || null;')
    result={'browser':evidence}
    (folder/'browser.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    try:
        value=command('POST','/execute/async',{'script':'''const done=arguments[arguments.length-1],blob=window.editorRecordedBlob;
          if(!blob)return done({missing:true});if(blob.size>16*1048576)return done({error:'Test recording exceeds 16 MiB diagnostic transport budget'});
          const r=new FileReader();r.onerror=()=>done({error:'Diagnostic Blob read failed'});r.onload=()=>done({type:blob.type,base64:r.result.slice(r.result.lastIndexOf(',')+1)});r.readAsDataURL(blob);''','args':[]})
        if value.get('error'):
            raise RuntimeError(value['error'])
        if value.get('missing'):
            result['encoded']={'missing':True}
        else:
            extension='mp4' if value['type'].startswith('video/mp4') else 'webm'
            path=folder/('recording.'+extension)
            path.write_bytes(base64.b64decode(value['base64'],validate=True))
            result['encoded']=inspect_recording(path)
    except Exception as error:
        result['inspectionError']={'name':type(error).__name__,'message':str(error)[:800]}
    (folder/'evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    encoded=json.dumps(result,ensure_ascii=False)
    # Error diagnostics remain public even after GitHub's per-step notice limit.
    print('::warning title=Editor recording byte evidence::'+encoded.replace('%','%25').replace('\r','%0D').replace('\n','%0A'),flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as summary:
            summary.write('\n### Editor recording byte evidence\n\n```json\n'+json.dumps(result,ensure_ascii=False,indent=2)+'\n```\n')
    return result
