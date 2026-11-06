"""Validate experiment oracles using the original artifact and real FFmpeg AAC.

These local controls are not WebKit completion measurements.
"""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import yaml

from aac_completion_analysis import ROOT, N, analyze_case, content_at, packet_timing, prefix_lag, qualify
from safari_aac_analysis import independent_decode


class Completion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        fixture = ROOT / 'tests/fixtures/aac-completion'
        cls.original = np.frombuffer(gzip.decompress((fixture / 'input.f32le.gz').read_bytes()), dtype='<f4').reshape(-1, 2)
        cls.baseline = np.frombuffer(independent_decode(fixture / 'baseline.adts.aac', True), dtype='<f4').reshape(-1, 2)
        script = "global.SafariAACProbe=require('./tests/safari-aac-probe.js');const s=require('./tests/aac-completion-probe.js').sourceControl();console.log(JSON.stringify({pcm:SafariAACProbe.pcm64(s.pcm),markers:s.markers}));"
        control = json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT, timeout=10))
        cls.control = np.frombuffer(base64.b64decode(control['pcm']), dtype='<f4').reshape(-1, 2)
        cls.markers = control['markers']
        # Independent encoder, including extra zero input to leave source coverage
        # after measuring its actual delay. No constant is used as the trim.
        pcm = np.concatenate((cls.control, np.zeros((3072, 2), dtype='<f4'))).astype('<f4').tobytes()
        encoded = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '128000', '-f', 'adts', '-'], input=pcm, capture_output=True, check=True, timeout=30).stdout
        at, payloads = 0, []
        while at < len(encoded):
            if encoded[at:at + 2] != b'\xff\xf1':
                raise ValueError('Unexpected ADTS fixture')
            size = (encoded[at + 3] & 3) << 11 | encoded[at + 4] << 3 | encoded[at + 5] >> 5
            payloads.append(encoded[at + 7:at + size])
            at += size
        cls.capture = {'error': None, 'inputs': [{'frames': N + 3072, 'sourceFrames': N}], 'resources': {'created': 1, 'closed': 1, 'encoderClosed': True},
                       'chunks': [{'timestamp': round(i * 1024 * 1e6 / 48000), 'duration': None, 'durationPresent': False, 'type': 'key', 'dataBase64': base64.b64encode(p).decode(),
                                   'metadata': {'decoderConfig': {'ascBase64': 'EZA='}} if i == 0 else {}} for i, p in enumerate(payloads)]}
        cls.report = analyze_case(cls.capture, cls.folder / 'real-ffmpeg', cls.control, cls.markers)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_exact_original_and_lossy_baseline_identity(self):
        fixture = ROOT / 'tests/fixtures/aac-completion'
        provenance = json.loads((fixture / 'provenance.json').read_text())
        self.assertEqual(hashlib.sha256(self.original.tobytes()).hexdigest(), provenance['pcmSHA256'])
        self.assertEqual(hashlib.sha256((fixture / 'baseline.adts.aac').read_bytes()).hexdigest(), provenance['baselineAACSHA256'])
        self.assertEqual(len(self.original), N)
        self.assertEqual(provenance['inputs'][-1]['numberOfFrames'], 640)

    def test_real_original_webkit_artifact_exposes_delay_and_missing_tail(self):
        lag = prefix_lag(self.original, self.baseline)
        self.assertEqual(lag['lag'], 1600)  # Recorded artifact, not a universal rule.
        content = content_at(self.original, self.baseline, lag['lag'])
        self.assertEqual(len(self.baseline), 143360)
        self.assertEqual(content['sourceTailMissingFrames'], 2240)
        self.assertFalse(content['passed'])

    def test_nonperiodic_measurement_finds_arbitrary_delays(self):
        for delay in [0, 73, 1024, 1600, 2112]:
            decoded = np.concatenate((np.zeros((delay, 2)), self.control, np.zeros((600, 2))))
            self.assertEqual(prefix_lag(self.control, decoded, self.markers)['lag'], delay)
            self.assertTrue(content_at(self.control, decoded, delay, self.markers)['passed'])

    def test_count_alone_cannot_hide_missing_or_corrupted_last640(self):
        delay = 1700
        missing = np.concatenate((np.zeros((delay, 2)), self.control[:-640]))
        self.assertGreater(len(missing), N)
        self.assertFalse(content_at(self.control, missing, delay, self.markers)['passed'])
        damaged = np.concatenate((np.zeros((delay, 2)), self.control.copy()))
        damaged[-640:] = 0
        self.assertFalse(content_at(self.control, damaged, delay, self.markers)['passed'])

    def test_internal_loss_and_wrong_delay_are_rejected_by_signal(self):
        delay = 1200
        good = np.concatenate((np.zeros((delay, 2)), self.control))
        damaged = np.concatenate((good[:30000], good[31024:], np.zeros((1024, 2))))
        self.assertEqual(len(damaged), len(good))
        self.assertFalse(content_at(self.control, damaged, delay, self.markers)['passed'])
        self.assertFalse(content_at(self.control, good, 0, self.markers)['passed'])
        self.assertFalse(content_at(self.control, good, delay + 1024, self.markers)['passed'])

    def test_real_aac_measured_trim_preserves_full_source_on_mp4_video_clock(self):
        report = self.report
        self.assertTrue(report['candidatePassed'])
        self.assertTrue(report['mp4']['candidate']['timelineOK'])
        self.assertTrue(report['mp4']['candidate']['content']['passed'])
        self.assertFalse(report['mp4']['wrong-delay']['passed'])
        self.assertEqual(report['mp4']['candidate']['declaredPresentationFrames'], N)

    def test_positive_timestamp_shift_is_not_silently_normalized(self):
        c = json.loads(json.dumps(self.capture))
        for chunk in c['chunks']:
            chunk['timestamp'] += 500000
        report = analyze_case(c, self.folder / 'shifted', self.control, self.markers)
        self.assertFalse(report['timestampAnchorConsistent'])
        self.assertFalse(report['candidatePassed'])

    def test_packet_loss_or_duplicate_pts_is_visible(self):
        chunks = self.capture['chunks']
        self.assertTrue(packet_timing(chunks)['contiguous'])
        self.assertFalse(packet_timing(chunks[:5] + chunks[6:])['contiguous'])
        copied = json.loads(json.dumps(chunks))
        copied[5]['timestamp'] = copied[4]['timestamp']
        self.assertFalse(packet_timing(copied)['contiguous'])
        # Remove an actual encoded access unit and independently decode again.
        # Appended zeros leave enough total samples: the signal oracle must still
        # detect the missing interior audio rather than accepting packet counts.
        lost = json.loads(json.dumps(self.capture))
        del lost['chunks'][25]
        report = analyze_case(lost, self.folder / 'lost-packet', self.control, self.markers)
        self.assertFalse(report['decoders']['manual']['content']['passed'])
        self.assertFalse(report['candidatePassed'])

    def test_qualification_requires_both_sources_repetitions_and_matching_delay(self):
        cases = [{'variant': 'v', 'source': s, 'repeat': r, 'lag': 777, 'candidatePassed': True} for s in ['original', 'control'] for r in range(2)]
        self.assertEqual(qualify(cases), ['v'])
        self.assertEqual(qualify(cases[:-1]), [])
        cases[-1]['lag'] += 3
        self.assertEqual(qualify(cases), [])

    def test_workflow_isolated_and_pinned_without_publish_permissions(self):
        workflow = yaml.load((ROOT / '.github/workflows/aac-completion-experiment.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertEqual(set(workflow['jobs']), {'experiment'})
        job = workflow['jobs']['experiment']
        pages = yaml.load((ROOT / '.github/workflows/pages.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(job['container']['image'], pages['jobs']['webkit']['container']['image'])
        self.assertEqual(job['steps'][-1]['if'], 'always()')
        self.assertEqual(job['steps'][-1]['with']['path'], 'test-results/aac-completion/')
        text = json.dumps(workflow)
        for forbidden in ['secrets.', 'deploy-pages', 'upload-pages-artifact', 'contents: write']:
            self.assertNotIn(forbidden, text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
