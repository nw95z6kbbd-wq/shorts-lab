"""Regression checks for Safari's independent, pre-RenderPlan source baseline.

No browser or network is needed. --baseline additionally checks the real Actions
checkout, including its Git identity, before Safari starts. Do not derive this
anchor from the PR base, HEAD, merge parents, or the files being tested.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from render_guard import ROOT, FIXTURE, assert_render_stack, verify_guard_rejects_changes


# Independent tripwire: this is PR #11's approved tree, not PR #12's runtime.
# Changing it requires new compatibility evidence; see RENDER_PLAN.md.
APPROVED_BASELINE = 'ad1ca0a701605af6d80c8de8983ec5ebeb9e8905'
WORKFLOW = ROOT / '.github/workflows/pages.yml'
RUNTIME = list(json.loads((FIXTURE / 'unchanged-runtime.json').read_text()))
FROZEN = {
    'js/video-recorder.js': 'video-recorder-before.js',
    'js/video-renderer.js': 'video-renderer-before.js',
    'js/video-core.js': 'video-core-before.js',
}


def configured_baseline(workflow):
    """Read only the named baseline checkout; fail closed on dynamic refs."""
    step = re.search(
        r'^      - name: Check out stable baseline for Safari export comparison\n'
        r'(?P<body>(?:(?!^      - ).*\n)+)', workflow, re.MULTILINE)
    assert step, 'Safari baseline checkout missing'
    body = step['body']
    assert '        uses: actions/checkout@v4\n' in body, 'Unexpected baseline checkout action'
    refs = re.findall(r'^          ref: (.+)$', body, re.MULTILINE)
    assert len(refs) == 1 and re.fullmatch(r'[0-9a-f]{40}', refs[0]), 'Safari baseline must be a literal full commit SHA'
    assert refs[0] == APPROVED_BASELINE, 'Safari compatibility anchor changed without reviewed evidence'
    assert '          path: .safari-baseline\n' in body, 'Safari baseline path changed'
    assert '          persist-credentials: false\n' in body, 'Baseline checkout must not persist credentials'
    return refs[0]


def populate(root, historical):
    for name in RUNTIME + list(FROZEN):
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        source = FIXTURE / FROZEN[name] if historical and name in FROZEN else ROOT / name
        shutil.copyfile(source, target)


class SafariBaselineTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='safari-baseline-regression-')
        self.addCleanup(self.folder.cleanup)
        self.old = Path(self.folder.name) / 'approved'
        self.current = Path(self.folder.name) / 'current'
        populate(self.old, historical=True)
        populate(self.current, historical=False)

    def test_ref_is_independent_of_pr_push_dispatch_and_reusable_context(self):
        contexts = [
            # PR #12, the post-merge push, and a future PR based on that merge.
            ('pull_request', 'main', 'refs/pull/12/merge', '7bc03672a1c4a1aecbe47c00095a0ee2e6614c13'),
            ('push', '', 'refs/heads/main', '8b5b073857c6bfe76036a1dde46de44254da5522'),
            ('pull_request', 'main', 'refs/pull/13/merge', 'f' * 40),
            ('workflow_dispatch', '', 'refs/heads/main', '8b5b073857c6bfe76036a1dde46de44254da5522'),
            ('workflow_call', '', 'refs/heads/main', 'f' * 40),
        ]
        workflow = WORKFLOW.read_text()
        for event, base_ref, ref, sha in contexts:
            with self.subTest(event=event, ref=ref), patch.dict(os.environ, {
                'GITHUB_EVENT_NAME': event, 'GITHUB_BASE_REF': base_ref,
                'GITHUB_REF': ref, 'GITHUB_SHA': sha, 'GITHUB_RUN_ATTEMPT': '2',
            }):
                self.assertEqual(configured_baseline(workflow), APPROVED_BASELINE)
                assert_render_stack(self.current, self.old)

    def test_moving_or_current_refs_cannot_replace_independent_baseline(self):
        workflow = WORKFLOW.read_text()
        for replacement in [
            '${{ github.event.pull_request.base.sha || github.sha }}',
            '${{ github.sha }}', 'main', 'HEAD^',
            '8b5b073857c6bfe76036a1dde46de44254da5522',
        ]:
            with self.subTest(ref=replacement), self.assertRaises(AssertionError):
                configured_baseline(workflow.replace('ref: ' + APPROVED_BASELINE, 'ref: ' + replacement, 1))

    def test_original_post_merge_failure_is_reproduced_with_current_baseline(self):
        with self.assertRaisesRegex(AssertionError, 'Unexpected recorder baseline'):
            assert_render_stack(self.current, self.current)

    def test_actual_encoder_mutation_still_fails_with_approved_baseline(self):
        target = self.current / 'js/video-recorder.js'
        text = target.read_text()
        self.assertIn('videoBitsPerSecond: 2600000', text)
        target.write_text(text.replace('videoBitsPerSecond: 2600000', 'videoBitsPerSecond: 1000000', 1))
        with self.assertRaisesRegex(AssertionError, 'Encoder/capture loop changed'):
            assert_render_stack(self.current, self.old)

    def test_corrupted_historical_checkout_is_rejected(self):
        for name in FROZEN:
            target = self.old / name
            text = target.read_text()
            try:
                target.write_text(text + '\n// unexpected baseline mutation\n')
                with self.subTest(file=name), self.assertRaisesRegex(AssertionError, 'Unexpected .* baseline'):
                    assert_render_stack(self.current, self.old)
            finally:
                target.write_text(text)

    def test_all_seven_existing_and_editor_dispatch_counterexamples_still_fail(self):
        self.assertEqual(verify_guard_rejects_changes(), 8)

    def test_ci_keeps_guard_native_safari_and_preflight_mandatory(self):
        workflow = WORKFLOW.read_text()
        self.assertIn('          python tests/render_guard.py\n', workflow)
        self.assertIn('          python tests/safari-baseline-test.py\n', workflow)
        self.assertIn('        run: python tests/safari-baseline-test.py --baseline .safari-baseline\n', workflow)
        self.assertIn('          SAFARI_BASELINE_ROOT: .safari-baseline\n', workflow)
        self.assertIn('        run: python tests/safari-product.py\n', workflow)
        self.assertNotIn('continue-on-error:', workflow)
        safari = (ROOT / 'tests/safari-product.py').read_text()
        self.assertIn('assert_render_stack(ROOT,', safari)


def check_real_checkout(baseline):
    baseline = baseline.resolve()
    configured = configured_baseline(WORKFLOW.read_text())
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=baseline, text=True).strip()
    assert actual == configured, f'Unexpected Safari checkout: expected {configured}, got {actual}'
    # Also verify the checkout bytes against the independent pre-refactor files.
    # This works with checkout's default depth=1; no parent traversal is needed.
    assert_render_stack(ROOT, baseline)
    print('PASS: actual Safari baseline checkout ' + actual + '; exact source guard passed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SafariBaselineTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    if args.baseline:
        check_real_checkout(args.baseline)
