"""Inspect only the generated three-scene test clip, never user project/media."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def inspect_recording(path, editor_progress=True):
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
    times=sorted(f[0] for f in video)
    held={}
    for target in [.5,1.5,2.5]:
        previous=max((t for t in times if t<=target),default=None)
        following=min((t for t in times if t>target),default=None)
        held[str(target)]={'pts':previous,'until':following}
    def bounds(values):
        return {'count':len(values), 'firstPts':min((v[0] for v in values),default=None),
                'lastPts':max((v[0] for v in values),default=None), 'end':max((v[0]+v[1] for v in values),default=None),
                'maxGap':max((b[0]-a[0] for a,b in zip(values,values[1:])),default=0)}
    # Decode the entire file with errors fatal, rather than accepting one frame.
    subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(path),'-f','null','-'],check=True,capture_output=True,timeout=40)
    # Diagnostic only: locate how far the canonical scene-progress bar had
    # advanced in the first and last actual frames (leading/trailing loss).
    strip=subprocess.check_output(['ffmpeg','-v','error','-xerror','-i',str(path),'-an','-vf','format=rgb24,crop=634:1:43:107','-pix_fmt','rgb24','-f','rawvideo','-'],timeout=40) if editor_progress and video and all((f[2].get('width'),f[2].get('height'))==(720,1280) for f in video) else b''
    stride=634*3
    def filled(row):
        values=[]
        for start,end in [(0,205),(215,420),(430,634)]:
            count=0
            for x in range(start,end):
                r,g,b=row[x*3:x*3+3]
                count+=r>130 and g>100 and b>r+10 and b>g+20
            values.append(count)
        return values
    progress={'first':filled(strip[:stride]),'last':filled(strip[-stride:])} if len(strip)>=stride else None
    return {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,
            'format':info['format'],'streams':info['streams'],'video':{**bounds(video),'dimensions':sorted({(f[2].get('width'),f[2].get('height')) for f in video}),'progressPixels':progress,
            'heldSeekFrames':held,'nearestSeekFrames':{str(t):min((f[0] for f in video),key=lambda pts:abs(pts-t),default=None) for t in [.5,1.5,2.5,2.7,4.8]}},'audio':bounds(audio),'fullDecode':True}


def editor_frame_expectations(evidence):
    """PTS of the actual held frame, independently decoded from these exact bytes.

    A VFR video legitimately holds its preceding frame until the next sample.
    This does not relax the browser callback tolerance or replace its RGB checks.
    """
    assert_complete_recording(evidence)
    result=[]
    for index,target in enumerate([.5,1.5,2.5]):
        value=evidence['video']['heldSeekFrames'][str(target)]
        assert isinstance(value['pts'],(int,float)) and 0<=value['pts']<=target, ('Invalid preceding frame',target,value)
        assert isinstance(value['until'],(int,float)) and value['until']>target, ('Unproven held frame interval',target,value)
        if value['pts']>=index:result.append(value['pts'])
        else:
            # The original sampler also accepts the next presented frame up to
            # 100 ms after Seek. Keep that existing rule, never widen it.
            assert index<=value['until']<index+1 and value['until']-target<=.1, ('Missing scene frame at requested time',target,value)
            result.append(value['until'])
    return result


def assert_complete_recording(evidence):
    """A plausible container header or one decodable frame is insufficient."""
    video, audio = evidence['video'], evidence['audio']
    assert video['dimensions'] == [(720, 1280)], ('Recorded frame resolution', video)
    assert video['count'] >= 12, ('Incomplete recorded frame count', video)
    span = video['end'] - video['firstPts']
    assert 2.7 <= span <= 4, ('Incomplete recorded frame timeline', video)
    assert audio['count'] and 2.7 <= audio['end'] - audio['firstPts'] <= 4, ('Incomplete recorded audio timeline', audio)
    assert 2.7 <= float(evidence['format']['duration']) <= 4, ('Incomplete recorded container duration', evidence['format'])
    assert evidence['fullDecode'] is True


def save_recording_evidence(root, script, command, label, kind='editor'):
    """Bounded test-owned Blob transport; keep diagnostics even when decoding fails."""
    folder=Path(root)/'test-results/editor-canvas'/label
    folder.mkdir(parents=True,exist_ok=True)
    assert kind in ('editor','runtime')
    blob_name='editorRecordedBlob' if kind=='editor' else 'runtimeRecordedBlob'
    evidence=script('return window.editorRecordingEvidence || null;') if kind=='editor' else script('const d=window.runtimeSessionDiagnostics?.();return d?{trace:d.trace,pool:d.pool,contexts:d.contexts}:null;')
    result={'browser':evidence}
    if label.startswith('safari-recording-failure'):
        try:
            result['sameBytesReprobe']=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];reprobeEditorRecording().then(done,e=>done({error:e.name+": "+e.message}));','args':[]})
        except Exception as error:
            result['sameBytesReprobe']={'error':str(error)[:300]}
    (folder/'browser.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    try:
        value=command('POST','/execute/async',{'script':'''const done=arguments[arguments.length-1],blob=window[arguments[0]];
          if(!blob)return done({missing:true});if(blob.size>16*1048576)return done({error:'Test recording exceeds 16 MiB diagnostic transport budget'});
          const r=new FileReader();r.onerror=()=>done({error:'Diagnostic Blob read failed'});r.onload=()=>done({type:blob.type,base64:r.result.slice(r.result.lastIndexOf(',')+1)});r.readAsDataURL(blob);''','args':[blob_name]})
        if value.get('error'):
            raise RuntimeError(value['error'])
        if value.get('missing'):
            result['encoded']={'missing':True}
        else:
            extension='mp4' if value['type'].startswith('video/mp4') else 'webm'
            path=folder/('recording.'+extension)
            path.write_bytes(base64.b64decode(value['base64'],validate=True))
            result['encoded']=inspect_recording(path,editor_progress=kind=='editor')
    except Exception as error:
        result['inspectionError']={'name':type(error).__name__,'message':str(error)[:800]}
    (folder/'evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    if evidence and label.startswith('safari-recording-') and any(label.endswith('-'+str(i)) for i in range(3)) and not label.startswith('safari-recording-failure'):
        summary={k:evidence.get(k) for k in ['entry','video','audioAtFirstFrame','audioAtLastFrame','formatAtMs','completedWallMs']}
        summary['encodedVideo']=result.get('encoded',{}).get('video')
        summary['encodedAudio']=result.get('encoded',{}).get('audio')
        summary['render']=evidence.get('render')
        summary['recorderEvents']=[r.get('events',[])[:2]+r.get('events',[])[-2:] for r in evidence.get('recorders',[])]
        print('::warning title=Native Editor clock summary::'+json.dumps(summary,ensure_ascii=False),flush=True)
    # Split evidence below GitHub's 4 KiB per-annotation truncation boundary.
    # Never print recorded media bytes, source paths, or data URLs.
    for kind, value in result.items():
        encoded=json.dumps(value,ensure_ascii=False)
        level='error' if 'failure' in label else 'notice'
        print('::'+level+' title=Editor recording '+kind+'::'+encoded.replace('%','%25').replace('\r','%0D').replace('\n','%0A'),flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as summary:
            summary.write('\n### Editor recording byte evidence\n\n```json\n'+json.dumps(result,ensure_ascii=False,indent=2)+'\n```\n')
    return result
