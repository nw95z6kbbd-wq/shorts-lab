# Independent synthetic encoder fixtures

Generated from solid purple video (720x1280, 24 fps, 1 second) and a 440 Hz sine
(48 kHz). No commercial/user media. They are not produced by the app renderer.

- classic.mp4: FFmpeg libx264 constrained baseline + AAC, +faststart.
- fragmented.mp4: same with +frag_keyframe+empty_moov+default_base_moof.
- silent.mp4: lossless video stream copy of classic.mp4 with -an.
- vp9-opus.webm: FFmpeg libvpx-vp9 + libopus.
- wrong-codecs.mp4: stream-copy of vp9-opus.webm into MP4 (-strict -2).

Base command: `ffmpeg -f lavfi -i color=c=purple:s=720x1280:r=24:d=1 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -profile:v baseline -c:a aac -movflags +faststart -shortest classic.mp4`.
Fixtures are checked against independent FFprobe results in browser/native tests;
mutation tests reject non-AVC/AAC MP4, altered descriptors, truncation and fake
full-duration claims on short actual sample coverage.

recorder-bridges.json and session-bridges.json list only exact reviewed optional
Editor policy additions. Source guards reverse them before the original frozen
proof. Never regenerate the historical Video baseline with current code.
