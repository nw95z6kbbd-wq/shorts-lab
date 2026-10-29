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
Codec selection, bitrates, audio graph, fades and renderer are unchanged.
WebM finalization explicitly pauses input, requests/drains pending data, then stops.
MP4 keeps its original single-stop finalization.
An interrupted, invalid/backwards, or non-advancing audio clock fails explicitly.
A clock that stops advancing for 10 s fails instead of leaving an endless capture.
Cancellation and visibility handling retain the existing cleanup path.

## Separate final-chunk loss

The clock correction alone was deliberately not accepted as complete. A subsequent
native run isolated an independent writer/drain failure:
https://github.com/nw95z6kbbd-wq/shorts-lab/actions/runs/40838020719

Here AudioContext reached 3.009887 s and the renderer reached 3000 ms, but the
`stop` dataavailable event contained **zero bytes**. The last previously delivered
chunk covered only 2.244 s; FFmpeg decoded 53 video frames and 901 audio frames.
The browser duration was 2.26 s, and the last-frame progress was [205,204,44],
confirming loss of the end of the third scene (not just inaccurate metadata).

For WebM, at the existing final-frame capture boundary the recorder pauses gathering
new samples, waits for `pause`, calls `requestData()`, waits for `dataavailable`,
and only then calls `stop()`. This is an event barrier, not an added fixed delay.
Pausing input prevents a slow flush from padding/extending voice or video. The
existing 10 s completion watchdog remains; missing pause/data acknowledgements,
errors or unsolicited stops reject instead of returning a partial successful file.
A controlled writer model reproduces stop dropping a 750 ms pending tail; both
immediate and delayed flush acknowledgement preserve the complete media interval.

### Container-specific boundary

The explicit drain is restricted by the actual/requested MIME to WebM. Applying
pause/requestData to Safari's MP4 writer made the existing 3 s no-audio probe
report 6.103333 s, which the unchanged native test rejected. MP4 therefore retains
the original single-stop path. A dedicated model test rejects accidental MP4
routing through the WebM drain. Both real formats remain tested; no MIME is hidden
or reclassified, and no duration tolerance is enlarged.

## Strict validation and source protection

- The browser still requires exactly 720 × 1280 and duration 2.7–4 s.
- Native tests make ten successive recordings per HTTP/standalone entry; a single
  failure fails the job. These are measurements, not retry-until-success.
- FFmpeg decodes every frame, checks real video/audio timestamp spans and dimensions.
  A well-formed 3 s header on a real 1.8 s payload is a negative fixture.
- Failed generated Blobs, MIME, renderer timings, audio clocks, native recorder
  events and an optional second playback are retained under
  `test-results/editor-canvas`. The second playback cannot rescue a failed assertion.
- `recorder_clock_guard.py` removes only the exact reviewed clock extension.
  The original recorder/source hashes and pinned `ad1ca0a701605af6d80c8de8983ec5ebeb9e8905`
  remain unchanged. The original eight mutation checks remain mandatory; three
  additional clock mutations and five finalization mutations are rejected. No moving baseline is used.
- Controlled clock tests execute the actual old/new recorder source. They reproduce
  the old short recording under 600 ms audio startup lag and cover slower/faster,
  stalled/interrupted/invalid/backwards audio clocks, cancellation, and exact
  silent-recording compatibility. Real browser recordings remain separate tests.

FFmpeg is a test-only tool, already used by Chromium checks. The native workflow
now ensures it is installed too. The branch-scoped `Diagnose Editor recording`
workflow calls all existing checks with read-only permissions and
`upload_pages: false` while PR creation through GitHub API is blocked. It does not
provide a Pages publication route. Main's original push/PR rules remain unchanged.

## Paused seek sampling

A separate native run also exposed a pre-existing test-player stall after seeking
while paused (including on the complete 6 s runtime clip). The sampler now briefly
plays the muted generated file until a real compositor frame is observed, then
restores the original paused state. The 100 ms timestamp requirement, 4 s timeout,
ready-state checks and actual RGB scene-order assertions remain unchanged. No
frame, a wrong timestamp or denied playback still fails. A frozen 9bc4c30 sampler
reproduces the old timeout with a gated compositor. Native runtime recordings are
also fully decoded by FFmpeg; container metadata alone cannot rescue a partial clip.

One native measurement per entry uses 0.25 s voice/music buffers with the 3 s plan,
so audio input ending early must neither shorten the video nor hang the media clock.
