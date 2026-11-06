"""Regressions using real, freshly encoded AAC; no prepared validator answers."""
import base64
from copy import deepcopy
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import yaml

from safari_aac_analysis import adts_header, marker_lags

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_experiment', ROOT / 'tests/aac-runtime-experiment.py')
E = importlib.util.module_from_spec(spec)
spec.loader.exec_module(E)


class IndependentOracles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        code = "const P=require('./tests/aac-runtime-probe.js'),H=require('./tests/safari-aac-probe.js'),w=P.wrap(P.stimulus(17024));process.stdout.write(JSON.stringify({pcm:H.pcm64(w.pcm),markers:w.markers}));"
        cls.source = json.loads(subprocess.check_output(['node', '-e', code], cwd=ROOT, timeout=10))
        cls.reference = np.frombuffer(base64.b64decode(cls.source['pcm']), dtype='<f4').reshape(-1, 2)
        cls.record = cls.encode(cls.reference)

    @classmethod
    def encode(cls, pcm):
        full = np.zeros((((len(pcm)+1023)//1024+2)*1024, 2), dtype='<f4')
        full[:len(pcm)] = pcm
        coded = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '128000', '-f', 'adts', 'pipe:1'],
                               input=full.tobytes(), capture_output=True, check=True, timeout=20).stdout
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-flags2', '+skip_manual', '-f', 'aac', '-i', 'pipe:0', '-f', 'f32le', 'pipe:1'],
                                 input=coded, capture_output=True, check=True, timeout=20).stdout
        raw = np.frombuffer(decoded, dtype='<f4').reshape(-1, 2)
        measured = marker_lags(cls.reference, raw, cls.source['markers'])
        assert measured['status'] == 'measured'
        delay = measured['lagSamples']
        chunks = [{'timestamp': round(i*1024e6/48000), 'duration': 21333, 'durationPresent': True, 'dataBase64': p,
                   'metadata': {'decoderConfig': {'ascBase64': 'EZA='}} if i == 0 else {}} for i, p in enumerate(E.split_adts(coded))]
        return {'label': 'fresh-ffmpeg-unit-fixture', 'inputPCMBase64': cls.source['pcm'], 'sourceFrames': 17024, 'chunks': chunks, 'markers': cls.source['markers'], 'error': None,
                'measurement': {'delay': delay, 'trim': 4096+delay, 'presentationFrames': 17024},
                'decodes': {}, 'resources': {'created': len(full)//1024, 'closed': len(full)//1024, 'decodedCreated': 0, 'decodedClosed': 0, 'encoderClosed': True, 'decoderClosed': True}}

    def analyze(self, record):
        with tempfile.TemporaryDirectory(prefix='aac-runtime-unit-') as folder:
            return E.analyze(record, Path(folder) / 'case')

    def test_real_raw_aac_matches_measured_delay(self):
        self.assertEqual(self.analyze(self.record)['status'], 'independently-confirmed-candidate')

    def test_wrong_priming_not_accepted(self):
        record = deepcopy(self.record)
        record['measurement']['delay'] += 500
        record['measurement']['trim'] += 500
        with self.assertRaisesRegex(ValueError, 'delay does not match'):
            self.analyze(record)

    def test_wrong_trim_is_not_relabelled_as_success(self):
        record = deepcopy(self.record)
        record['measurement']['trim'] *= 2
        with self.assertRaisesRegex(ValueError, 'Wrong presentation trim'):
            self.analyze(record)

    def test_lost_internal_unit_with_compacted_pts_still_fails_signal_oracle(self):
        record = deepcopy(self.record)
        del record['chunks'][14]
        for i, chunk in enumerate(record['chunks']):
            chunk['timestamp'] = round(i*1024e6/48000)
        with self.assertRaisesRegex(ValueError, 'delay does not match'):
            self.analyze(record)

    def test_zeroed_tail_with_all_packets_and_markers_still_fails(self):
        altered = self.reference.copy()
        altered[4096+17024-640:4096+17024] = 0
        record = self.encode(altered)
        with self.assertRaisesRegex(ValueError, 'useful PCM correlation failed'):
            self.analyze(record)

    def test_decoder_side_trim_disagrees_with_raw_units(self):
        record = deepcopy(self.record)
        record['decodes'] = {'trimmed': {'pcmBase64': base64.b64encode(self.reference.astype('<f4').tobytes()).decode()}}
        with self.assertRaisesRegex(ValueError, 'Browser/independent decoder disagree'):
            self.analyze(record)

    def test_silence_has_no_correlation_evidence_and_nonzero_edges_are_checked(self):
        source = self.reference[4096:4096+17024].copy()
        source[:64] = 0
        evidence = E.content_windows(source, source, 0)
        self.assertTrue(next(e for e in evidence if e['name'] == 'first64')['silentReferenceHasNoCorrelationEvidence'])
        destroyed = source.copy()
        destroyed[64:128] = 0
        with self.assertRaisesRegex(ValueError, 'firstUseful64'):
            E.content_windows(source, destroyed, 0)

    def test_corrupt_interior_outside_three_named_markers_is_not_missed(self):
        source = self.reference[4096:4096+17024].copy()
        decoded = source.copy()
        decoded[4096:5120] = 0
        with self.assertRaisesRegex(ValueError, 'block-4096'):
            E.content_windows(source, decoded, 0)

    def test_artifact_does_not_dump_environment_secrets(self):
        sentinel = 'SYNTHETIC_SECRET_MUST_NOT_BE_CAPTURED_71a983'
        with patch.dict(os.environ, {'SHORTSLAB_RUNTIME_TEST_SECRET': sentinel}):
            with tempfile.TemporaryDirectory(prefix='aac-runtime-secret-') as folder:
                E.analyze(self.record, Path(folder) / 'case')
                for file in Path(folder).rglob('*'):
                    if file.is_file():
                        self.assertNotIn(sentinel.encode(), file.read_bytes())

    def test_fixed_decoder_reference_is_verified_by_actual_raw_aac_decode(self):
        reference = json.loads((ROOT / 'tests/fixtures/aac-runtime/decoder-reference.json').read_text())
        code = "const P=require('./tests/aac-runtime-probe.js'),H=require('./tests/safari-aac-probe.js'),w=P.wrap(P.stimulus(16384));const full=new Float32Array((w.pcm.length/2048+2)*2048);full.set(w.pcm);console.log(JSON.stringify({pcm:H.pcm64(w.pcm),submitted:H.pcm64(full),markers:w.markers}));"
        source = json.loads(subprocess.check_output(['node', '-e', code], cwd=ROOT, timeout=10))
        self.assertEqual(hashlib.sha256(base64.b64decode(source['submitted'])).hexdigest(), reference['inputSHA256'])
        self.assertEqual(hashlib.sha256(b''.join(base64.b64decode(c['dataBase64']) for c in reference['chunks'])).hexdigest(), reference['payloadSHA256'])
        record = {'label': 'fixed-decoder-reference', 'inputPCMBase64': source['pcm'], 'sourceFrames': 16384,
                  'chunks': [{**c, 'durationPresent': True, 'metadata': {'decoderConfig': {'ascBase64': reference['ascBase64']}} if i == 0 else {}} for i, c in enumerate(reference['chunks'])],
                  'markers': source['markers'], 'error': None, 'decodes': {},
                  'measurement': {'delay': reference['rawContentDelay'], 'trim': 4096+reference['rawContentDelay'], 'presentationFrames': 16384},
                  'resources': {'created': 0, 'closed': 0, 'decodedCreated': 0, 'decodedClosed': 0, 'encoderClosed': True, 'decoderClosed': True}}
        result = self.analyze(record)
        self.assertEqual(result['status'], 'independently-confirmed-candidate')
        self.assertEqual(reference['rawDecodedFrames'], len(reference['chunks'])*1024)

    def test_adts_parser_rejects_corruption(self):
        raw = base64.b64decode(self.record['chunks'][0]['dataBase64'])
        valid = adts_header(len(raw), bytes.fromhex('1190')) + raw
        self.assertEqual(E.split_adts(valid), [base64.b64encode(raw).decode()])
        for bad in [valid[:6], valid[:-1], bytes([0])+valid[1:]]:
            with self.assertRaises(ValueError):
                E.split_adts(bad)


class Isolation(unittest.TestCase):
    def test_workflow_is_read_only_real_browsers_and_always_uploads(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/aac-runtime-experiment.yml').read_text())
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        for name, mode in [('webkit', 'webkit'), ('safari', 'native-safari')]:
            job = workflow['jobs'][name]
            self.assertLessEqual(job['timeout-minutes'], 20)
            self.assertEqual(job['env']['AAC_RUNTIME_MODE'], mode)
            upload = next(s for s in job['steps'] if s.get('uses', '').startswith('actions/upload-artifact@'))
            self.assertEqual(upload['if'], 'always()')
        self.assertEqual(workflow['jobs']['safari']['runs-on'], 'macos-15-intel')
        self.assertNotIn('deploy', json.dumps(workflow))
        self.assertNotIn('upload-pages', json.dumps(workflow))

    def test_native_safari_refuses_linux_without_starting_any_driver(self):
        spec = importlib.util.spec_from_file_location('runtime_safari', ROOT / 'tests/aac-runtime-safari.py')
        transport = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        with patch.object(transport.platform, 'system', return_value='Linux'):
            with self.assertRaisesRegex(RuntimeError, 'Native Safari requires macOS'):
                with transport.session('http://127.0.0.1:1/'):
                    self.fail('Native Safari was substituted')

    def test_candidate_not_loaded_by_product_and_no_fixed_priming(self):
        source = (ROOT / 'tests/aac-runtime-probe.js').read_text()
        for forbidden in ['1600', '2112', 'bufferSizeDB', 'localStorage', 'indexedDB', 'navigator.userAgent']:
            self.assertNotIn(forbidden, source)
        self.assertNotIn('aac-runtime-probe', (ROOT / 'index.html').read_text())
        self.assertNotIn('aac-runtime-probe', (ROOT / 'js/native-mp4.js').read_text())


if __name__ == '__main__':
    unittest.main()
