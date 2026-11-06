# Runtime AAC calibration candidate — not enabled in production

This is a bounded executable experiment for `feat/editor-export-foundation`.
It does not load the app, change its AAC validator, enable MP4 audio exports,
change contracts/version, or establish production readiness.

## What is measured

`aac-runtime-probe.js` uses the actual AudioEncoder type and the native MP4
configuration: AAC-LC, 48 kHz stereo, 128 kbit/s. Four fresh encoders cover
16384/17024 source samples, two different nonperiodic signals/repeats. A profile
exists only when integer content delay, actual ASC and output/input packet-count
difference agree exactly in all four runs. Nothing infers delay from a UA,
Cocoa cookie bufferSizeDB, codec name, or a preset priming value.

A separate encoder instance is not sufficient evidence for the export instance.
Each measured stream therefore carries two different nonperiodic stereo canaries:

    head marker 2048 | silence 2048 | source PCM | silence 2048 | tail marker 2048

The silence guards and markers are experiment parameters, not encoder delay.
Full 1024-sample input blocks plus two extra zero blocks implement the completion
strategy qualified by the earlier Linux WebKit experiment. Original samples are
copied unchanged; this does not pad over missing sound. If the whole tail marker
cannot be decoded, calibration refuses; no guessed additional delay is accepted.

Decode the same AAC bytes three times: full as-reported description + original
PTS, normalized ASC + original PTS, and normalized ASC + PTS shifted to +1 second.
Require full 1024-sample AUs, contiguous output timestamps, exactly packetCount *
1024 decoded samples and equal waveforms between all passes. This detects visible
skipping/description/PTS-dependent trimming. It is **not by itself proof** that a
decoder never silently trims and replaces samples while retaining total length.
The runtime candidate therefore first verifies a fixed synthetic AAC decoder
reference, and repeats that verification after the four encoder probes. The
reference's raw content delay and frame count were independently measured by
FFmpeg manual/default decoding; its full submitted PCM and AAC payload hashes
are checked at runtime. This rejects hidden trimming/zero replacement even when
packet counts and all three decoder modes agree. The reference delay belongs
only to that specific committed bitstream; it is never assigned to the runtime
encoder. Regressions independently decode the fixture instead of trusting its
provenance JSON. Independent FFmpeg checks of the runtime AAC remain mandatory
in CI. Production activation remains blocked until those checks succeed with
actual WebKit and actual Safari. A trusted reference qualification is a bounded
compatibility check, not a universal guarantee about every future decoder.

Head/tail NCC searches every integer delay from 0 through 4096, with no initial
guess. Every stereo marker must choose exactly the same sample. Thresholds are
borrowed unchanged from the existing diagnostic: correlation >= .45, peak
separation >= .05 outside +/-8 samples. 4096 is an explicit supported search
limit; an encoder outside this domain is refused, not assigned the boundary.
Source content is checked at this alignment in every 1024-sample window and at
start/middle/end, last640, and first/last useful 64 samples. An exactly silent
reference channel is labelled as having no correlation evidence. Canaries still
measure alignment and physical coverage; silence never establishes delay.

The proof profile belongs to one factory (WeakSet, no persistent cache). A real
export measurement must independently match its profile in delay, ASC and packet
count difference. Missing AudioDecoder, ambiguous peaks, non-repeatability,
changed configuration, packet loss/reordering, non-full decoder output, missing
tail or abort produce explicit refusal. The experiment never recasts failure as
successful capability refusal and never edits the AAC timeline to compact gaps.

## Experimental MP4

Existing `aac-completion-mux.cjs`/`native-mp4.js` muxer is exercised offline with:

- `elst.media_time = measured raw content delay + 4096 service prefix samples`;
- presentation length = original source length, not submitted or decoded length;
- unchanged AAC access units and full coded sample durations in `stts`/`mdhd`;
- separately recorded service suffix, completion zeros and coded padding.

FFmpeg independently decodes the raw AAC and the resulting MP4, checks PCM
alignment/content and video PTS (72 H.264 frames / three seconds). Negative
controls use no trim and double trim; both must fail the signal oracle even when
their files parse and their track metadata looks valid. No claim of bit-exact
lossy audio reconstruction is made.

For the historical Linux WebKit behavior (measured delay 1600, output delta 0),
the protected 144000-sample case would submit 154624 samples / 151 full blocks,
trim 5696 samples, retain all 144000 presented samples and have 832 coded samples
after the complete envelope. These are comparisons with the earlier experiment,
**not acceptance constants**. The new CI must independently measure its values.

## Running

```
node --test tests/aac-runtime-probe.test.cjs
python tests/aac-runtime-test.py
AAC_RUNTIME_MODE=webkit python tests/aac-runtime-experiment.py
AAC_RUNTIME_MODE=native-safari python tests/aac-runtime-experiment.py
```

WebKit requires the matching Playwright bundle. Native Safari requires macOS,
Safari WebDriver enabled, numpy and FFmpeg; Linux WebKit is not native Safari.
Workflow `.github/workflows/aac-runtime-experiment.yml` has separate Linux WebKit
and macOS Safari jobs, read-only repository permissions, 15-minute limits, no
Pages/deploy and always-upload synthetic evidence. Push/manual trigger only
prepares a future run; nothing is dispatched from this change.

A local control can explicitly use:

```
AAC_RUNTIME_MODE=chromium-replay python tests/aac-runtime-experiment.py
```

This freshly encodes the exact submitted PCM with FFmpeg, matches every replay
input by SHA-256, and uses real Chromium AudioDecoder. It tests the correlation,
decoder and mux oracles with actual lossy AAC; **it does not test Chromium's AAC
AudioEncoder or replace WebKit**. Simulator unit tests are likewise not codec
measurements.

## Artifacts / next decision

`test-results/aac-runtime-<mode>/` retains summary/source hashes/dirty flag,
per-case capture JSON, exact envelope PCM, AAC payloads/ADTS/ASC, all browser and
FFmpeg decoded PCM, numerical correlations/timestamps/resource counts, and
candidate/wrong-trim MP4s plus independent analysis. Synthetic inputs only; no
application imports, environment dump, storage, driver logs or browser profiles.
Existing output directories are never overwritten. Budget: at most three seconds
of original PCM, 4096-sample delay search, 192 AAC units / 2 MiB encoded output,
200000 decoded frames per pass, 20 seconds per measurement, 96 MiB artifacts.

Return both `aac-runtime-webkit-<SHA>` and `aac-runtime-safari-<SHA>` artifacts for
review. Success must include all eleven cases: two decoder-reference qualifications,
four repeatable calibrations, five same-instance verifications, agreement with independent raw decoders, and both
three-second MP4 candidate successes with wrong-trim failures. A refusal is a
blocking measurement, not evidence that an export is safe.

Before production integration, review decoder skipping evidence, guard effects,
AAC count rules and memory/cancellation budgets for full product-length clips.
The candidate is deliberately limited to synthetic <=3-second inputs. Existing
production Cocoa priming inference has NOT been replaced by this experiment;
D2 must remain open until the candidate is qualified and explicitly integrated.
