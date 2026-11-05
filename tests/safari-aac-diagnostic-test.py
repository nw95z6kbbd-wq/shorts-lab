"""Test the measurement oracle locally. FFmpeg fixtures are not Safari results."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import yaml

from safari_aac_analysis import (LENGTHS, adts_header, analyze_capture, compare_decoders,
                                 frame_timeline, marker_lags, unbase64)

ROOT = Path(__file__).resolve().parents[1]


def synthetic(count=48000):
    script = "const P=require('./tests/safari-aac-probe.js'),n=+process.argv[1],s=P.stimulus(n);console.log(JSON.stringify({schema:1,frames:n,repeat:0,inputPCMBase64:P.pcm64(s.pcm),markers:s.markers,inputs:Array.from({length:Math.ceil(n/1024)},(_,i)=>({offset:i*1024,numberOfFrames:Math.min(1024,n-i*1024),timestamp:Math.round(i*1024/48000*1e6)})),chunks:[],decodes:{},error:null}));"
    return json.loads(subprocess.check_output(['node', '-e', script, str(count)], cwd=ROOT, timeout=10))


class SignalAnalysis(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.capture = synthetic()
        cls.pcm = np.frombuffer(base64.b64decode(cls.capture['inputPCMBase64']), dtype='<f4').reshape(-1, 2)

    def test_offsets_are_measured_without_a_known_priming_constant(self):
        for delay in (0, 73, 1024, 2112, 3571):
            decoded = np.concatenate((np.zeros((delay, 2)), self.pcm, np.zeros((500, 2))))
            result = marker_lags(self.pcm, decoded, self.capture['markers'])
            self.assertEqual(result['status'], 'measured')
            self.assertEqual(result['lagSamples'], delay)

    def test_lossy_amplitude_noise_and_polarity_of_stereo_remain_distinguishable(self):
        noise = np.random.default_rng(17).normal(0, .003, self.pcm.shape)
        decoded = np.concatenate((np.zeros((123, 2)), self.pcm * .8 + noise))
        self.assertEqual(marker_lags(self.pcm, decoded, self.capture['markers'])['lagSamples'], 123)
        swapped = marker_lags(self.pcm, decoded[:, ::-1], self.capture['markers'])
        self.assertEqual(swapped['status'], 'inconclusive')

    def test_internal_packet_loss_is_not_hidden_by_concatenating_pcm(self):
        decoded = np.delete(self.pcm, np.s_[12000:13024], axis=0)
        result = marker_lags(self.pcm, decoded, self.capture['markers'])
        self.assertEqual(result['status'], 'inconclusive')
        self.assertGreater(result['lagSpreadSamples'], 1000)

    def test_missing_final_marker_and_silence_are_inconclusive(self):
        for pcm in (np.zeros_like(self.pcm), self.pcm[:35000]):
            self.assertEqual(marker_lags(self.pcm, pcm, self.capture['markers'])['status'], 'inconclusive')

    def test_decoder_trim_is_separate_from_raw_content_lag(self):
        a = {'status': 'measured', 'lagSamples': 1500}
        b = {'status': 'measured', 'lagSamples': 100}
        result = compare_decoders(a, 50000, b, 48600)
        self.assertTrue(result['consistentWithLeadingTrim'])
        self.assertEqual(result['contentSamplesRemovedRelativeToManualFFmpeg'], 1400)
        self.assertFalse(compare_decoders(a, 50000, b, 50000)['consistentWithLeadingTrim'])

    def test_decoder_timestamp_gap_is_not_silently_compressed(self):
        frames = [{'timestamp': 0, 'numberOfFrames': 1024, 'sampleRate': 48000, 'numberOfChannels': 2},
                  {'timestamp': 21333, 'numberOfFrames': 1024, 'sampleRate': 48000, 'numberOfChannels': 2}]
        self.assertEqual(frame_timeline(frames)['status'], 'contiguous')
        frames[1]['timestamp'] += 500000
        self.assertEqual(frame_timeline(frames)['status'], 'discontinuous')

    def test_boundary_lengths_have_three_measurable_markers(self):
        for n in LENGTHS:
            capture = synthetic(n)
            pcm = np.frombuffer(base64.b64decode(capture['inputPCMBase64']), dtype='<f4').reshape(-1, 2)
            self.assertEqual(marker_lags(pcm, pcm, capture['markers'])['lagSamples'], 0)

    def test_payload_bounds_and_config_do_not_fabricate_asc(self):
        with self.assertRaises(ValueError):
            unbase64('x' * 100, 4)
        with self.assertRaises(ValueError):
            adts_header(100, b'\x12\x10')  # 44.1k is not relabelled as 48k
        with self.assertRaises(ValueError):
            adts_header(9000, b'\x11\x90')

    def test_independent_real_aac_roundtrip_and_wrong_trim(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            source = folder / 'source.f32le'
            source.write_bytes(self.pcm.astype('<f4').tobytes())
            target = folder / 'ffmpeg-fixture.aac'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', str(source),
                            '-c:a', 'aac', '-b:a', '128000', '-f', 'adts', str(target)], check=True, capture_output=True, timeout=20)
            data, at, payloads = target.read_bytes(), 0, []
            while at < len(data):
                self.assertEqual(data[at:at + 2], b'\xff\xf1')
                size = (data[at + 3] & 3) << 11 | data[at + 4] << 3 | data[at + 5] >> 5
                payloads.append(data[at + 7:at + size])
                at += size
            capture = json.loads(json.dumps(self.capture))
            capture['chunks'] = [{'timestamp': round(i * 1024 / 48000 * 1e6), 'duration': None,
                                  'dataBase64': base64.b64encode(p).decode(),
                                  'metadata': {'decoderConfig': {'ascBase64': 'EZA=', 'descriptionBase64': 'EZA='}} if i == 0 else {}}
                                 for i, p in enumerate(payloads)]
            from unittest.mock import patch
            sentinel = 'SYNTHETIC_SECRET_MUST_NOT_BE_IN_ARTIFACTS_72901'
            with patch.dict(os.environ, {'DIAGNOSTIC_TEST_SECRET': sentinel}):
                report = analyze_capture(capture, folder / 'analysis')
            for artifact in (folder / 'analysis').rglob('*'):
                if artifact.is_file():
                    self.assertNotIn(sentinel.encode(), artifact.read_bytes())
            baseline = report['decoders']['ffmpegManualSkip']
            self.assertEqual(baseline['status'], 'measured')
            self.assertTrue(report['manualOutputMatchesCodedFrameCount'])
            decoded = np.frombuffer((folder / 'analysis/ffmpegManualSkip.f32le').read_bytes(), dtype='<f4').reshape(-1, 2)
            wrong = marker_lags(self.pcm, decoded[2112:], self.capture['markers'])
            self.assertNotEqual(wrong['lagSamples'], 0)
            self.assertEqual(report['status'], 'inconclusive')  # no native Safari decoder was run
            self.assertIn('UNRESOLVED', report['encoderDelayConclusion'])
            # Delete real encoded bytes, not a mocked verdict or precomputed PCM.
            del capture['chunks'][20]
            damaged = analyze_capture(capture, folder / 'missing-packet')
            self.assertEqual(damaged['decoders']['ffmpegManualSkip']['status'], 'inconclusive')


class Isolation(unittest.TestCase):
    def test_workflow_has_no_release_permissions_or_deploy_path(self):
        workflow = yaml.load((ROOT / '.github/workflows/safari-aac-diagnostic.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertEqual(set(workflow['on']), {'push', 'workflow_dispatch'})
        job = workflow['jobs']['diagnose']
        self.assertEqual(job['runs-on'], 'macos-15-intel')
        self.assertLessEqual(int(job['timeout-minutes']), 15)
        self.assertEqual(set(workflow['jobs']), {'diagnose'})
        upload = job['steps'][-1]
        self.assertEqual(upload['if'], '${{ always() }}')
        self.assertEqual(upload['with']['path'], 'test-results/safari-aac/')
        for step in job['steps']:
            self.assertNotIn('secrets.', json.dumps(step))
            self.assertNotIn('deploy', step.get('uses', ''))

    def test_diagnostic_sources_have_no_app_storage_or_environment_dump(self):
        browser = (ROOT / 'tests/safari-aac-probe.js').read_text()
        for forbidden in ('localStorage', 'indexedDB', 'document.cookie', 'fetch(', 'ShortsNativeMP4', '2112', 'bufferSizeDB'):
            self.assertNotIn(forbidden, browser)
        runner = (ROOT / 'tests/safari-aac-diagnostic.py').read_text()
        self.assertNotIn('dict(os.environ)', runner)
        self.assertNotIn('os.environ.items', runner)
        self.assertIn("elif self.path == '/probe.js'", runner)

    def test_native_runner_refuses_linux_instead_of_substituting_a_browser(self):
        spec = importlib.util.spec_from_file_location('aac_runner', ROOT / 'tests/safari-aac-diagnostic.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        from unittest.mock import patch
        with patch.object(module.platform, 'system', return_value='Linux'), self.assertRaisesRegex(RuntimeError, 'Native Safari'):
            module.run()


if __name__ == '__main__':
    unittest.main(verbosity=2)
