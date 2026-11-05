# Native Safari AAC diagnostic

This diagnostic characterizes encoder/decoder behavior. A green run means that
the measurements completed, **not** that D1/D2 or production MP4 export are fixed.
The existing VFR policy and Cocoa priming inference are preserved in the WIP
commit and are not used by this probe.

## Run

The owner must first approve and perform a normal push of
`feat/editor-export-foundation`. No force push is needed. The separate
`Diagnose native Safari AAC timing` workflow runs on pushes changing its test
files or workflow. It also supports `workflow_dispatch` once GitHub exposes that
workflow (dispatch discovery normally requires the workflow on the default
branch). Do not merge only to expose manual dispatch: the branch push trigger is
sufficient for the initial run.

The workflow uses `macos-15-intel`, `/usr/bin/safaridriver`, and Safari. It has only
`contents: read`, a 15-minute job timeout, and no Pages/deploy/release jobs.
Checkout does not persist credentials. The existing branch-check workflow can
also run on the push; its Pages artifact input remains `upload_pages: false`.

For a local Mac with Safari Remote Automation enabled:

```sh
python -m pip install -r tests/requirements-safari-aac.txt
sudo /usr/bin/safaridriver --enable
python tests/safari-aac-diagnostic.py
```

FFmpeg and ffprobe must be installed. Linux is refused, rather than substituted
with Chromium or WebKit. Output is restricted to `test-results/safari-aac/`.
Use an empty diagnostic output directory for each run; preserve prior evidence
elsewhere if needed. No application page, project, IndexedDB or media asset is
opened. The HTTP server serves only a fixed synthetic page and the probe script.

## Inputs and evidence

Every encoder instance receives deterministic 48 kHz stereo Float32 PCM, in
1024-sample input blocks with exact sample-index timestamps. Source lengths are
1023, 1024, 1025, 2048, 48000 and 144337 samples; each is repeated with a fresh
encoder. The two channels contain different, nonperiodic, band-limited signals
with three emphasized markers near the start, middle and end.

For every case, `capture.json` records the original PCM and markers, every input
AudioData timestamp/length, output chunk timestamp/duration/type, and observed
metadata keys. Decoder configuration and original description bytes are kept.
Full ES_Descriptor cookies are structurally parsed to ASC; their buffer fields
never select an encoder delay. Numeric/boolean delay-like metadata is recorded
when actually supplied; missing metadata remains missing. Unknown string values
are not exported.

Artifacts include original AAC payload files, their SHA-256/timing index, raw
description/ASC files, a diagnostic ADTS stream, FFmpeg frame/skip side data,
original and decoded f32le stereo PCM, and `analysis.json`. ADTS adds headers
without changing access-unit payloads. It deliberately has no original PTS or
edit list: original timestamps remain in the index. The app MP4 mux and any
assumed trim are bypassed.

The same bytes are decoded by:

1. FFmpeg with `+skip_manual`, which requests no automatic sample skipping and
   exposes skip information for inspection.
2. FFmpeg with its default skip behavior.
3. Safari AudioDecoder using the original description.
4. Safari AudioDecoder using extracted ASC.

An older Safari may reject a full ES cookie as a decoder configuration. That
failure is retained; the normalized-ASC path must still produce a measurement.

## Interpretation

Normalized cross-correlation searches the full decoded signal, without a search
center at 1024, 2112 or any other assumed priming. It measures each marker on each
channel. Correlation >=0.45, peak separation >=0.05, and agreement within two
samples are **measurement confidence criteria**, not a permitted AV shift. Weak
or inconsistent matches are inconclusive and make the diagnostic job fail.
These criteria are tested against independent real AAC and destructive cases.

The report distinguishes:

- raw decoded content lag;
- original packet timestamp origin;
- decoded-frame timestamp continuity and content lag on that timeline;
- output length and remaining tail after measured alignment;
- relative content removal between decoders and whether output-length differences
  support leading trimming.

Different decoder filter behavior can also affect alignment. A raw correlation
lag is not automatically encoder-only priming. `encoderDelayConclusion` therefore
remains unresolved until the original timestamps, actual delay metadata, skip
side data, raw output and decoder comparisons are reviewed together. In-band
decoder trimming must not be compensated a second time. There is no production
edit list in this experiment and no automatic choice of a trim constant.

`manifest.json` records the exact commit SHA, macOS/Safari versions, architecture,
tool version and all case outcomes. A per-case capture is saved before analysis;
artifact upload uses `always()`. The maximum capture response is 8 MiB, AAC output
2 MiB/case, decoded output 200000 frames/path, and total artifacts 64 MiB. Only
synthetic evidence is uploaded. Environment dumps, browser profiles, cookies,
screenshots, user projects, arbitrary driver capabilities/logs and raw exception
messages are not collected.

## Bring to the next review

- Run URL, exact SHA and complete `safari-aac-<SHA>` artifact.
- `manifest.json`, including inconclusive cases and repetitions.
- Every `analysis.json` plus the corresponding capture/chunk index and metadata.
- Raw ASC/cookie, AAC payloads and PCM for cases with different decoder behavior.
- FFmpeg manual-skip side data and Safari frame timestamps.

Do not replace an inconclusive measurement with 2112 or loosen thresholds to turn
the run green. Repeat on the owner's MacBook; CI on Intel does not establish
identical behavior on Apple Silicon. Native export/edit-list and end-to-end AV
checks remain separate follow-up validation after a delay policy is justified.
