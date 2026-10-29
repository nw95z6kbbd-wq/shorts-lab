"""Independent full-byte coverage regressions; isolated, generated fixture media."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from editor_recording_evidence import inspect_recording, assert_complete_recording

ROOT=Path(__file__).resolve().parents[1]


class RecordingEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory=tempfile.TemporaryDirectory(prefix='editor-recording-evidence-')
        cls.root=Path(cls.directory.name)
        for name,seconds,size in [('full',3,'720x1280'),('partial',.8,'720x1280'),('wrong-size',3,'360x640')]:
            path=cls.root/(name+'.webm')
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'testsrc2=size={size}:rate=10:duration={seconds}',
                '-f','lavfi','-i',f'sine=frequency=440:sample_rate=48000:duration={seconds}',
                '-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-b:v','250k','-c:a','libopus','-y',str(path)],check=True,capture_output=True,timeout=40)
        # Use the actual unchanged application patcher. This makes a misleading
        # but well-formed 3s header over a genuinely 0.8s video/audio payload.
        subprocess.run(['node','-e',"const fs=require('fs'),V=require('./js/video-core.js'),p=process.argv[1];fs.writeFileSync(p,V.patchWebmDuration(new Uint8Array(fs.readFileSync(p)),3000));",str(cls.root/'partial.webm')],cwd=ROOT,check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_complete_original_frames_and_audio_pass(self):
        value=inspect_recording(self.root/'full.webm')
        assert_complete_recording(value)
        self.assertEqual(value['video']['count'],30)
        self.assertEqual(len(value['sha256']),64)

    def test_forged_duration_and_decodable_first_frame_do_not_hide_incomplete_recording(self):
        value=inspect_recording(self.root/'partial.webm')
        self.assertEqual(float(value['format']['duration']),3)
        self.assertTrue(value['fullDecode'])
        self.assertGreater(value['video']['count'],0)
        with self.assertRaisesRegex(AssertionError,'Incomplete recorded frame'):
            assert_complete_recording(value)

    def test_wrong_resolution_still_fails(self):
        with self.assertRaisesRegex(AssertionError,'resolution'):
            assert_complete_recording(inspect_recording(self.root/'wrong-size.webm'))

    def test_complete_frames_cannot_hide_wrong_container_duration(self):
        value=inspect_recording(self.root/'full.webm');value['format']['duration']='4.1'
        with self.assertRaisesRegex(AssertionError,'container duration'):
            assert_complete_recording(value)

    def test_truncated_bytes_cannot_pass_as_complete(self):
        original=(self.root/'full.webm').read_bytes();path=self.root/'truncated.webm';path.write_bytes(original[:len(original)//3])
        with self.assertRaises((AssertionError,subprocess.CalledProcessError)):
            assert_complete_recording(inspect_recording(path))


if __name__=='__main__':
    unittest.main(verbosity=2)
