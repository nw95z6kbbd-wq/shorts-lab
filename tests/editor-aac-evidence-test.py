"""Exercise artifact saving with real synthetic FFmpeg AAC, not simulated Safari."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from editor_aac_evidence import ROOT, adts_header, binary, save_capture, save_from_page


class AACEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        script = '''const P=require('./tests/safari-aac-probe.js'),s=P.stimulus(144337);
          console.log(JSON.stringify({schema:1,expected:{fixture:'editor-export-synthetic-3s',durationMs:3000,pcmFrames:144000,sampleRate:48000,numberOfChannels:2},errors:[],
            encoders:[{inputFrames:144000,inputPCMBase64:P.pcm64(s.pcm.subarray(0,144000*2)),inputs:Array.from({length:141},(_,i)=>({offset:i*1024,timestamp:Math.round(i*1024/48000*1e6),numberOfFrames:Math.min(1024,144000-i*1024),sampleRate:48000,numberOfChannels:2})),chunks:[]}]}));'''
        cls.capture = json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT, timeout=10))
        cls.pcm = base64.b64decode(cls.capture['encoders'][0]['inputPCMBase64'])
        encoded = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
                                  '-c:a', 'aac', '-b:a', '128000', '-f', 'adts', '-'],
                                 input=cls.pcm, capture_output=True, check=True, timeout=20).stdout
        at, payloads = 0, []
        while at < len(encoded):
            if encoded[at:at + 2] != b'\xff\xf1':
                raise ValueError('Unexpected FFmpeg ADTS header')
            size = (encoded[at + 3] & 3) << 11 | encoded[at + 4] << 3 | encoded[at + 5] >> 5
            payloads.append(encoded[at + 7:at + size])
            at += size
        cls.capture['encoders'][0]['chunks'] = [
            {'timestamp': round(i * 1024 / 48000 * 1e6), 'durationPresent': False, 'duration': None,
             'dataBase64': base64.b64encode(payload).decode(),
             'metadata': {'decoderConfig': {'descriptionBase64': 'EZA='}} if i == 0 else {}}
            for i, payload in enumerate(payloads)]
        cls.folder, cls.manifest = save_capture(cls.capture, 'ffmpeg-control', cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_exact_source_pcm_and_last_partial_input_are_saved(self):
        self.assertEqual((self.folder / 'input.f32le').read_bytes(), self.pcm)
        self.assertEqual(self.manifest['inputFramesCaptured'], 144000)
        self.assertEqual(self.manifest['lastInputFrames'], 640)
        self.assertEqual(len(self.capture['encoders'][0]['inputs']), 141)

    def test_actual_aac_bytes_have_independent_decode_counts(self):
        self.assertEqual(self.manifest['errors'], [])
        count = len(self.capture['encoders'][0]['chunks'])
        self.assertEqual(self.manifest['independentDecode']['manual-skip']['frames'], count * 1024)
        self.assertTrue((self.folder / 'ffprobe-manual.json').exists())
        packets = json.loads((self.folder / 'packets.json').read_text())
        for i, packet in enumerate(self.capture['encoders'][0]['chunks']):
            self.assertEqual((self.folder / f'chunk-{i:03d}.aac-payload').read_bytes(), base64.b64decode(packet['dataBase64']))
            self.assertFalse(packets[i]['durationPresent'])
            self.assertIsNone(packets[i]['duration'])

    def test_original_validator_operands_are_not_replaced_by_decode_counts(self):
        report = self.manifest['validator']
        count = len(self.capture['encoders'][0]['chunks'])
        self.assertEqual(report['packetCount'], count)
        self.assertEqual(report['missingChunkDurationCount'], count)
        self.assertEqual(report['coverage']['decoded'], count * 1024)
        self.assertEqual(report['coverage']['residualSamples'], count * 1024 - 144000)
        self.assertEqual(report['reportedChunkDurationUsSum'], 0)
        self.assertIn('no original PTS', self.manifest['meaning'])

    def test_environment_secret_is_absent_from_artifacts(self):
        sentinel = 'SYNTHETIC_ENV_SECRET_NOT_FOR_ARTIFACTS_83017'
        with patch.dict(os.environ, {'EDITOR_DIAGNOSTIC_TEST_SECRET': sentinel}):
            folder, manifest = save_capture(self.capture, 'secret-check', self.root)
        self.assertEqual(manifest['errors'], [])
        for file in folder.iterdir():
            self.assertNotIn(sentinel.encode(), file.read_bytes())

    def test_repeated_runs_preserve_previous_evidence(self):
        folder, _ = save_capture(self.capture, 'ffmpeg-control', self.root)
        self.assertNotEqual(folder, self.folder)
        self.assertTrue((self.folder / 'manifest.json').exists())

    def test_diagnostic_failure_keeps_raw_capture(self):
        broken = json.loads(json.dumps(self.capture))
        broken['encoders'][0]['chunks'][0]['metadata']['decoderConfig']['descriptionBase64'] = 'AAAA'
        folder, manifest = save_capture(broken, 'invalid-control', self.root)
        self.assertTrue((folder / 'capture.json').exists())
        self.assertTrue(manifest['errors'])
        self.assertEqual(json.loads((folder / 'capture.json').read_text())['encoders'][0]['chunks'][0], broken['encoders'][0]['chunks'][0])

    def test_foreign_capture_and_unbounded_payload_are_refused(self):
        foreign = {**self.capture, 'expected': {'fixture': 'user-project'}}
        with self.assertRaises(ValueError):
            save_capture(foreign, 'foreign', self.root)
        with self.assertRaises(ValueError):
            binary('A' * 100, 4)
        with self.assertRaises(ValueError):
            adts_header(b'x' * 9000, b'\x11\x90')

    def test_diagnostic_exception_does_not_replace_test_failure(self):
        class Page:
            def evaluate(self, *_):
                raise RuntimeError('SYNTHETIC_PRIVATE_MESSAGE')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            save_from_page(Page(), 'failed-browser')
        self.assertIn('RuntimeError', output.getvalue())
        self.assertNotIn('SYNTHETIC_PRIVATE_MESSAGE', output.getvalue())


if __name__ == '__main__':
    unittest.main(verbosity=2)
