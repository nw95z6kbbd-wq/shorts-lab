# Safari: media clock and complete Editor recording

This is a technical correction within 1.4.0 Unreleased. It adds no Editor
record/export UI and changes no DTO, IndexedDB, ZIP, release or publication data.

## Reproduced failure and independent evidence

The successful PR #18 tree (`8317c6c`) and its main merge (`9bc4c30`) have
identical files. Both native runs passed the pinned historical source guard.
The original failure message omitted dimensions/duration; its exact missing
numeric values cannot be recovered from that log.

A fresh native Safari 26.6 run reproduced the same `Incomplete Editor recording`
assertion with complete evidence:
https://github.com/nw95z6kbbd-wq/shorts-lab/actions/runs/40834259340

| Measurement | Failed recording |
| --- | --- |
| Canvas and decoded video | 720 × 1280 |
| Blob | 179705 bytes, WebM VP9 + Opus |
| RenderPlan and final rendered time | 3000 ms |
| Renderer wall interval including setup | 3069 ms |
| AudioContext at first / last rendered frame | 0 / 2.45260770975 s, running, 44100 Hz |
| Native `start` / format callback | 45 / 44 ms after click |
| Browser duration after decoded data ready | 2.4975 s |
| Container declared duration | 3.000000 s |
| Independently decoded video | 46 frames; first PTS 0, end 2.462 s |
| Independently decoded audio | 1002 frames; first PTS 0, end 2.498 s |
| First / last frame progress segments | [0,0,0] / [205,204,202] filled pixels |

FFmpeg decoded the entire file. A separate muted playback of the **same bytes**
ended at 2.4975 s. The start event was prompt, resolution was correct, and both
the beginning and end of the rendered plan were present. This was not a stale
`readyState`, a transient metadata read, or simply a missing final image. The
performance clock advanced ahead of the audio/media clock during Safari warm-up;
the recorder compressed the complete render plan into the shorter media interval.
Updating WebM's Duration field alone did not restore missing media time.

## Correction

When an audio context exists, frame selection, progress and the stop boundary
now use `(context.currentTime - audioStart) * 1000`, the same clock as the mixed
audio stream. Silent Canvas recording retains the exact old `now - start` path.

The plan remains 3000 ms; it is not stretched to match source audio length.
A slow device can take longer wall time to prepare/record those media seconds.
Codec selection, bitrates, audio graph, fades, renderer and final flush are unchanged.
An interrupted, invalid/backwards, or non-advancing audio clock fails explicitly.
A clock that stops advancing for 10 s fails instead of leaving an endless capture.
Cancellation and visibility handling retain the existing cleanup path.

## Strict validation and source protection

- The browser still requires exactly 720 × 1280 and duration 2.7–4 s.
- Native tests make ten successive recordings per HTTP/standalone entry; a single
  failure fails the job. These are measurements, not retry-until-success.
- FFmpeg decodes every frame, checks real video/audio timestamp spans and dimensions.
  A well-formed 3 s header on a real 0.8 s payload is a negative fixture.
- Failed generated Blobs, MIME, renderer timings, audio clocks, native recorder
  events and an optional second playback are retained under
  `test-results/editor-canvas`. The second playback cannot rescue a failed assertion.
- `recorder_clock_guard.py` removes only the exact reviewed clock extension.
  The original recorder/source hashes and pinned `ad1ca0a701605af6d80c8de8983ec5ebeb9e8905`
  remain unchanged. The original eight mutation checks remain mandatory; three
  additional clock mutations are rejected. No moving baseline is used.
- Controlled clock tests execute the actual old/new recorder source. They reproduce
  the old short recording under 600 ms audio startup lag and cover slower/faster,
  stalled/interrupted/invalid/backwards audio clocks, cancellation, and exact
  silent-recording compatibility. Real browser recordings remain separate tests.

FFmpeg is a test-only tool, already used by Chromium checks. The native workflow
now ensures it is installed too. The branch-scoped `Diagnose Editor recording`
workflow calls all existing checks with read-only permissions and
`upload_pages: false` while PR creation through GitHub API is blocked. It does not
provide a Pages publication route. Main's original push/PR rules remain unchanged.
