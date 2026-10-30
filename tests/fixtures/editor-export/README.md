# Independent synthetic encoder fixtures

Generated from solid purple video (720x1280, 24 fps, 1 second) and a 440 Hz sine
(48 kHz). No commercial/user media. They are not produced by the app renderer.

- classic.mp4: FFmpeg libx264 constrained baseline + AAC, +faststart.
- fragmented.mp4: same with +frag_keyframe+empty_moov+default_base_moof.
- silent.mp4: lossless video stream copy of classic.mp4 with -an.
- vp9-opus.webm: FFmpeg libvpx-vp9 + libopus.
- h264-opus.mp4: AVC stream from classic.mp4 with Opus stream from vp9-opus.webm;
  a real MP4 with compatible video but incompatible audio.
- wrong-codecs.mp4: stream-copy of vp9-opus.webm into MP4 (-strict -2).

Base command: `ffmpeg -f lavfi -i color=c=purple:s=720x1280:r=24:d=1 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -profile:v baseline -c:a aac -movflags +faststart -shortest classic.mp4`.
Fixtures are checked against independent FFprobe results in browser/native tests;
mutation tests reject non-AVC/AAC MP4, altered descriptors, truncation and fake
full-duration claims on short actual sample coverage.

recorder-bridges.json and session-bridges.json list only exact reviewed optional
Editor policy additions. Source guards reverse them before the original frozen
proof. Never regenerate the historical Video baseline with current code.

`native-mux-reference.json` independently records FFprobe packet offsets, sizes,
timestamps, key flags and codec extradata from native-stereo.mp4, with its SHA-256.
That synthetic fixture copies classic.mp4 video and independently re-encodes its
sine to 48 kHz stereo AAC (`-c:v copy -c:a aac -ac 2 -ar 48000 -b:a 128k`).
The muxer test copies these exact packet bytes into new tables and verifies
byte identity and AVC/AAC coverage; browser tests also perform full FFmpeg decode.
