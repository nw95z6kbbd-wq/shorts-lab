"""Independent validation of synthetic outputs; usable without Playwright on macOS."""
import array,json,math,subprocess
from editor_recording_evidence import inspect_recording

def component(path,hz,time):
 raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(time),'-i',str(path),'-t','0.08','-ac','1','-ar','8000','-f','f32le','-'])
 values=array.array('f',raw);assert len(values)>400,'Missing decoded audio samples'
 return 2*math.hypot(sum(x*math.cos(2*math.pi*hz*i/8000) for i,x in enumerate(values)),sum(x*math.sin(2*math.pi*hz*i/8000) for i,x in enumerate(values)))/len(values)

def verify_file(path,result,audio):
 actual=inspect_recording(path)
 video=next(s for s in actual['streams'] if s['codec_type']=='video');sound=[s for s in actual['streams'] if s['codec_type']=='audio']
 assert video['codec_name']==result['videoCodec'];assert bool(sound)==audio
 if result['container']=='mp4':assert video['codec_name']=='h264' and (not audio or sound[0]['codec_name']=='aac'),actual
 assert video['width']==720 and video['height']==1280 and 2.85<actual['video']['end']-actual['video']['firstPts']<3.15,actual
 if audio:assert 2.85<actual['audio']['end']-actual['audio']['firstPts']<3.15,actual
 samples=[]
 # A VFR image is held until the next frame. Input -ss selects the next decoded
 # frame and could miss a genuinely absent scene. Sample the held frame instead.
 pts=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
 for t in [.5,1.5,2.5]:
  indices=[i for i,f in enumerate(pts) if float(f['best_effort_timestamp_time'])<=t];index=indices[-1] if indices else 0
  raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-an','-vf',f"select='eq(n,{index})',crop=100:100:300:400,scale=1:1",'-frames:v','1','-threads:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);samples.append(list(raw[:3]))
 r,b,g=samples;assert r[0]>r[2]*1.5 and b[2]>b[0]*1.5 and g[1]>g[0]*1.5,samples
 signal=None
 if audio:
  voice,music=component(path,440,1),component(path,880,1);assert voice>.001 and music>.001,(voice,music)
  early,end=component(path,880,.03),component(path,880,2.9);assert early<music*.65 and end<music*.65,(early,music,end)
  signal={'voice':voice,'music':music,'musicFade':[early,music,end]}
 return {'video':video['codec_name'],'audio':sound[0]['codec_name'] if sound else None,'container':actual['format']['format_name'],'coverage':actual['video'],'colors':samples,'signal':signal,'fullDecode':actual['fullDecode']}
