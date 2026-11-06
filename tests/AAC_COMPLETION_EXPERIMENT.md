# Isolated Linux WebKit AAC completion experiment

No production code, UI, storage contracts or release metadata are changed.
This experiment must run in real Playwright **Linux WebKit**. Chromium and
FFmpeg encoders are not substitutes for measurements of that backend.

## Exact source and independent control

`fixtures/aac-completion/input.f32le.gz` is the exact 3-second, 48 kHz stereo PCM
from the owner-provided artifact 13484110699 / run 42177523535. Decompressed SHA256:

```
545c88a3fd8f4b43dc121e48e9a3f1ed1315028f57c38d7907cf2381e7544eb0
```

`baseline.adts.aac` contains the original 140 captured AAC access units. Provenance,
input block sizes and original output timestamps are recorded in `provenance.json`.
All data is synthetic. No download from GitHub is required to run the experiment.

The original 440/880 Hz signal is periodic, so short windows may have ambiguous
correlation peaks. Each variant also encodes a deterministic nonperiodic stereo
control with separate channels, start/middle/end markers and a distinct last
640-sample region. Both sources contain exactly 144000 samples per channel.

## Nine variants, each source repeated with two fresh encoders

| Variant | Submitted samples | Finalization |
| --- | ---: | --- |
| partial | 144000; last block 640 | await flush, close |
| full | 144384; last 384 samples zero | await flush, close |
| full-zero-1 | 145408 | await flush, close |
| full-zero-2 | 146432 | await flush, close |
| full-zero-3 | 147456 | await flush, close |
| partial-task | 144000 | await flush, next task, close |
| partial-double-flush | 144000 | await flush, next task, await flush, close |
| full-zero-2-double-flush | 146432 | same double-flush sequence |
| partial-flush-then-drain | 146432 | partial source, await flush, append zero drain, await flush, close |

Only zeros are appended; original PCM, timestamps and channel layout are preserved.
The zero-frame sweep is an experiment, not an assumed encoder delay. Calling
close before flush resolves is deliberately excluded as an invalid strategy.
Every output records its phase relative to flush resolution and close, timestamp,
duration presence/value, metadata, description/ASC, bytes and relative arrival
time. Input sizes, source/padding counts and resource closure are also recorded.

## What counts as evidence

FFmpeg independently decodes unchanged access units in ADTS with manual and default
skip behavior. Original metadata timestamps stay in the capture; ADTS has no edit
list or timestamp origin. Separate PCM files and ffprobe frame/skip information
allow review of decoder-side trimming. No universal 1600-sample trim is applied.

The raw delay is measured from signal correspondence. Nonperiodic markers use the
existing confidence criteria (correlation >=0.45, peak separation >=0.05, channel
agreement <=2 samples). For the exact periodic source, prefix candidates are
retained, fixed-lag regions require correlation >=0.99, and a strategy cannot be
qualified without agreement with the nonperiodic control. These are measurement
criteria, not permissions to lose samples or shift audio in production.

A raw result must cover all 144000 original samples after measured alignment,
including the last 640. Packet count alone is insufficient. Packet loss, repeated
PTS and unexplained timestamp shifts disqualify a candidate.

Only then does the experiment use the existing production MP4 writer, unchanged,
with the measured trim and exactly 144000 presentation samples. A three-second
reference video gives 72 independently decoded frames on the zero-based movie
clock. Audio start/middle/end/last640 are compared on that clock after independent
MP4 decoding. The decoder's complete last AUs outside the declared edit interval
are retained in artifacts and explicitly distinguished from the 3s presentation.
An intentionally wrong trim must fail the signal checks.

`qualifiedStrategies` requires all four cases (both sources, two repeats) to pass,
with consistent measured delay and rejection of wrong-trim controls. Even a green
run means **measurements completed**, not that D2 or a production fix is approved.
An empty qualified list is a valid experimental outcome. Missing/inconclusive
measurements fail the job and preserve available evidence.

## Run and artifacts

The separate `aac-completion-experiment.yml` uses the same pinned Linux Playwright
image as existing WebKit CI, contents-read permission, a 20-minute job timeout and
an 8-minute matrix deadline. No app page, project DB, browser profile, arbitrary
driver logs, environment dumps, secrets or deployment jobs are used. Each browser
case has a 25-second encoder deadline. Captures are saved before analysis. Artifact
upload uses `always()`; output is bounded to 192 MiB. Previous output is never
overwritten automatically.

Locally, with the pinned WebKit bundle and Python dependencies installed:

```sh
python -m pip install -r requirements-dev.txt -r tests/requirements-safari-aac.txt
node --test tests/aac-completion-probe.test.cjs
python tests/aac-completion-test.py
python tests/aac-completion-experiment.py
```

After separate owner approval, commit the experimental files and perform a normal
push to `feat/editor-export-foundation`. The path-filtered workflow then runs for
that exact new SHA. Manual dispatch is also declared; GitHub may not expose it
until the workflow exists on the default branch. Do not merge just to expose it.

Bring `aac-completion-<SHA>` back for review: `summary.json`, original/control PCM,
every per-case capture/analysis, raw AAC, manual/default decoded PCM, candidate and
wrong-trim MP4s and their decoded PCM/timeline evidence. Only those real WebKit
measurements can justify a production completion strategy. Native Safari and a
runtime source of trustworthy encoder delay remain separate validation needs.
