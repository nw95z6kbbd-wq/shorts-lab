"""Prove the AV oracle rejects a shifted track, using independent FFmpeg files."""
import base64, subprocess, tempfile, unittest
from pathlib import Path
from editor_av_markers import marker_payload, verify_markers

class AVMarkers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        voice=cls.root/'markers.wav';voice.write_bytes(base64.b64decode(marker_payload()[3]['base64']))
        filters="drawbox=color=blue:t=fill:enable='between(t,0.25,0.34)+between(t,2.75,2.84)',drawbox=color=green:t=fill:enable='between(t,1.5,1.59)'"
        for label,delay in [('aligned',0),('shifted',150)]:
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=red:s=720x1280:r=24:d=3','-i',str(voice),'-vf',filters,'-af',f'adelay={delay}:all=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',str(cls.root/(label+'.mp4'))],check=True,capture_output=True,timeout=45)
        aligned=str(cls.root/'aligned.mp4')
        subprocess.run(['ffmpeg','-v','error','-i',aligned,'-itsoffset','0.15','-i',aligned,'-map','0:v:0','-map','1:a:0','-c','copy','-y',str(cls.root/'timestamp-shifted.mp4')],check=True,capture_output=True,timeout=20)
    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()
    def test_aligned_markers_at_start_middle_end(self):
        self.assertEqual(len(verify_markers(self.root/'aligned.mp4')),3)
    def test_audible_track_shift_is_rejected(self):
        with self.assertRaises(AssertionError):verify_markers(self.root/'shifted.mp4')
    def test_container_timestamp_shift_is_rejected(self):
        with self.assertRaises(AssertionError):verify_markers(self.root/'timestamp-shifted.mp4')
    def test_native_mp4_edit_list_preserves_reference_pcm(self):
        root=Path(__file__).resolve().parents[1];target=self.root/'priming.mp4'
        script="""const fs=require('fs'),r=require('./tests/fixtures/editor-export/native-mux-reference.json'),source=fs.readFileSync('tests/fixtures/editor-export/'+r.source);
        const track=kind=>({description:Buffer.from(r[kind].description,'hex'),samples:r[kind].samples.map((s,i,list)=>({data:source.subarray(s.offset,s.offset+s.size),key:s.key,duration:kind==='video'?(i===list.length-1?1000000-s.timestamp:list[i+1].timestamp-s.timestamp):Math.round(s.duration*.048)}))});
        (async()=>{const blob=require('./js/native-mp4.js')({}).mux({video:track('video'),audio:{...track('audio'),mediaTime:1024,presentationFrames:48000},durationMs:1000});fs.writeFileSync(process.argv[1],new Uint8Array(await blob.arrayBuffer()));})().catch(e=>{console.error(e);process.exitCode=1;});"""
        subprocess.run(['node','-e',script,str(target)],cwd=root,check=True,capture_output=True,timeout=20)
        reference=root/'tests/fixtures/editor-export/native-stereo.mp4'
        def decode(path):return subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-t','1','-ac','1','-ar','48000','-f','f32le','-'])
        actual=decode(target);self.assertEqual(len(actual),48000*4);self.assertEqual(actual,decode(reference))

if __name__=='__main__':unittest.main(verbosity=2)
