# Existing Editor export: AAC failure evidence

This observer runs only in `editor-export-browser.py`, in its fresh browser
context, for the synthetic three-second native MP4/audio case. It does not load
user projects. Production JavaScript, AAC acceptance rules, constants, and
capability-refusal assertions are unchanged.

`editor-aac-trace.js` is installed before application scripts capture AudioEncoder.
While explicitly armed by the synthetic fixture, it copies input PCM and output
chunks, forwards the same frame/chunk/metadata objects to the native encoder and
application callbacks, and preserves native return values, flush promise and
exceptions. It does not close input frames. Capture faults are recorded without
replacing the export outcome. Limits: one encoder, 144000 input frames, 256 input
blocks, 512 output packets, 2 MiB AAC, 2 MiB descriptions, 8 MiB JSON transport.

The expected PCM is 144000 stereo samples at 48 kHz. The input index shows the
actual number of frames and timestamps of every AudioData, including the final
640-sample input. Full input PCM is interleaved little-endian Float32. Original
AAC bytes, raw decoder configuration/ES-cookie, extracted ASC, timestamps and
duration presence are retained; missing duration is never presented as a measured
1024-sample duration.

After the export finishes or rejects, `editor-aac-report.cjs` replays the captured
timing/configuration in the checked-out `audioSpecificConfig()` and `validateAAC()`
source in a bounded VM. Only the diagnostic copy is instrumented, immediately
before the original coverage condition; the condition and production source are
unchanged. The report includes the source hash and checks agreement with an
observed AAC coverage rejection. A changed source layout/condition requires a
diagnostic review rather than silently reporting a stale rule.

`validator.json` records:

- expected PCM length, first PTS, timestamp-derived priming and existing cookie flag;
- priming selected by the current validator (not proof of real encoder delay);
- its `decoded` duration sum in samples and the residual after priming/PCM;
- both coverage predicates and the exact rejecting branch;
- packet count, missing-duration count and reported duration sum in microseconds;
- separately labelled coded-sample model, not an independent decode result.

`editor_aac_evidence.py` saves each capture in a new directory under
`test-results/editor-canvas/editor-export-aac/`, before replay/decoding. It writes
`input.f32le`, `packets.json`, original `chunk-*.aac-payload`, descriptions and ASC.
It wraps payloads unchanged in ADTS and decodes with FFmpeg both with
`+skip_manual` and default skipping. Independent decoded sample counts, hashes,
raw PCM and ffprobe frame/skip side data are saved. ADTS has no original PTS/edit
list: compare its sample positions against the original packet index, not an
invented zero-delay presentation timeline. No guessed priming is removed. For
alignment analysis, original and decoded PCM are available sample-for-sample as
time-domain signals; lossy AAC PCM must not be compared byte-for-byte to input.

`manifest.json` records the checked-out SHA and whether tracked sources are dirty.
It never includes environment dumps, browser storage/profile, screenshots,
arbitrary error messages or credentials. The original test rejection remains a
failure even if evidence gathering or independent decoding fails. Raw capture
survives such diagnostic failures. Existing production tests/assertions remain.

The Chromium and WebKit jobs upload this specific directory with `always()`,
14-day retention, and hidden files excluded. No deploy/release job or permission
is added. Native Safari's separate workflow is unchanged.

## Local checks

```sh
node --test tests/*.test.cjs
python tests/editor-aac-evidence-test.py
EXPORT_BROWSER=webkit python tests/check-errors.py tests/editor-export-browser.py
```

The last command requires the matching real Playwright Linux WebKit bundle.
Chromium and FFmpeg checks are not substitutes for it or for native Safari.
Run browser checks in an isolated checkout if regenerating standalone HTML.

## Save and run after owner approval

Review the diff, commit only diagnostic files plus their test/workflow wiring in
the existing branch, then perform a normal push. No force push or PR is needed to
trigger `check-editor-export.yml`, which calls the existing checks with
`upload_pages: false`. Do not rerun the old SHA expecting new telemetry.

Bring the new run URL/SHA and the complete `editor-aac-webkit-<SHA>` artifact to
review. In particular inspect `capture.json`, `validator.json`, `manifest.json`,
the input index, packet index, decoder descriptions and independent decoded PCM.
Only then decide whether the observed failure is missing PCM, incorrect priming,
padding semantics, or a duration/timestamp issue. This task does not fix D1/D2.
