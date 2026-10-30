# Editor export foundation (no production UI)

Product remains 1.4.0 Unreleased. No DTO, IndexedDB or ZIP changes.

`ShortsEditorExport.create()` is a non-serializable, reusable controller. It does
not start when the module is loaded and adds no buttons or panels.

```js
const controller = ShortsEditorExport.create({onState, onProgress});
await controller.prepare({project, canvas, contentRevision, savedRevision: null});
// state=ready. Call start directly in a subsequent trusted user click:
const file = await controller.start({signal});
// Caller owns file.blob / its download URL. Revoke URLs when retiring results.
await controller.dispose();
```

Canvas is caller-owned, exclusively borrowed by this job, exactly 720x1280.
Preparation snapshots DTO + fromEditor RenderPlan before its first await,
checks all subtitle layouts with editor-profile, preserves ID/order/timing and
prepares full active media through render-session. Media ID resolution, image
validation, audio decoding/windowing, mixing and recording remain the existing
implementations. Decoder contexts may be created/closed during prepare; no
playback resume, mixer or recording is started by prepare. Start synchronously
enters session.record before awaiting so Safari retains the trusted gesture.

States: idle -> preparing -> ready -> recording -> finalizing -> validating ->
complete, with error/cancelled/disposed. Progress reaches 1 only after validation.
Job generation, project ID/contentRevision and savedRevision are separate.
Latest prepare wins; stale progress/results cannot attach. Cancel/dispose are
repeatable and await real cleanup, including uncancellable decode. Keep a failed
cleanup owner for retry. An extra media lease pins decoded buffers while the
recorder owns an AudioContext. Only confirmed context closure releases that pin;
a rejected close reports AUDIO_CLOSE and keeps the owner available for an explicit
cleanup retry. No success or replacement preparation bypasses failed cleanup.
UI observer exceptions are reported in status rather
than owning the media lifecycle. No runtime object is added to project data.

## Formats and validation

Auto tries explicit AVC + AAC-LC (AVC only for silent projects), then explicit
VP9/Opus and VP8/Opus WebM. Explicit project format webm stays WebM. Generic
video/mp4 is excluded: it can encode VP9/Opus. isTypeSupported is advisory;
actual constructor/start fallback is still native. Runtime encoding errors fail
instead of silently retrying a partially recorded file.

`export-inspector.js` is a bounded inspector, not an encoder/muxer/importer:
- ISO BMFF: ftyp/moov/mdat, avc1/avc3 + AVC configuration/SPS/PPS, mp4a/esds AAC-LC,
  classic sample tables and fragmented tfhd/tfdt/trun, actual byte ranges/counts
  and timestamps. Unsupported layouts/codecs fail closed.
- WebM: EBML/DocType, tracks VP8/VP9 and optional Opus, clusters/blocks/lacing,
  packet extents and Opus durations. No MIME-based reclassification.
- Expected dimensions/audio presence and real packet time spans must match the
  plan. Timing tolerance is min(250ms, max(two target frames, 5% of duration)).
  Minimum video packet density follows existing tests (four/sec, at least two).
- A temporary muted HTMLVideoElement additionally checks decoded dimensions,
  finite duration and loaded frame readiness. It is never automatically played.
  It is removed and its Blob URL revoked on success/error/abort.

Result reports actual detected container/codecs, browser-measured geometry and
duration, plannedDurationMs separately, packet counts/spans, fallback flag and
identity. `validation.fullDecode` is false: browser validation does not claim to
decode every frame. Tests independently decode the entire file with FFmpeg,
check codecs, three image colors and both source frequencies/music fades.

## Resource boundary

Existing media limits remain: 16 unique active images, 16M total image pixels,
64MiB source bytes, 96MiB decoded/reserved/session, 64MiB/track and global managed
256MiB. Full-session preparation is required; lazy preview windows cannot record.
There is no streaming/LRU export or automatic original resizing. 5000 editor
scenes do not imply 5000-image export support. Zero-reading scenes remain omitted
by the canonical plan. Plans shorter than one target frame are rejected without
changing their DTO. Positive scene/cue intervals shorter than one target frame are also refused
with a scene diagnosis; DTO timings are preserved and never stretched.

New output budget: 64MiB maximum, lowerable by trusted caller. Preparation checks
the conservative estimate at the existing requested 2.6Mbps + 128kbps. Recorder
also caps actual delivered bytes, then checks final size (including WebM patch).
This bound avoids unbounded chunks and leaves room for finalization/inspection
copies. It is an export limit, not a project/ZIP limit or a guarantee of tab RSS.
Media are disposed before byte inspection. Native codec/GPU allocations remain
browser-owned. No WASM, servers, registration or runtime dependency is added.

## Legacy proof and tests

Only explicit Editor recordingPolicy (MIME candidates/maxBytes) is forwarded.
Default Video behavior, clocks, container-specific finalization and mixer stay
unchanged. Exact reversible additions precede the old clock/source proofs; no
baseline hash/ref is moved and all eight original counterexamples remain.

Node tests use independent FFmpeg-generated classic/fragmented/silent AVC/AAC
and VP9/Opus fixtures, corrupt inputs, frozen snapshots, real async cancellation,
resource failures and result validation. Browser tests use actual stored originals
and compare before/after DTOs and SHA-256 hashes. Chromium checks real WebM fallback
and silent AVC MP4. Native Safari requires actual AVC/AAC MP4, plus WebM, both HTTP
and standalone file://, with FFprobe/full decode/color/spectral checks. WebKit
without a capture codec must reject with FORMAT, never simulate success.
The existing complete IndexedDB/ZIP/Editor/Video suites remain mandatory.

Next UI stage must pause and close old preview/audio owners, wait for pending
uploads or disable export while they run, pass a stable snapshot, call start in
a trusted gesture, coordinate mode/project/ZIP changes and own download URLs.
