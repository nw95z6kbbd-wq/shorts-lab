# Synthetic MP3 regression inputs

Generated sine waves (523.25 Hz for 214.7 s; 783.99 Hz for 2 s), not third-party music.
The short and representative long files are 44,100 Hz, stereo, encoded by FFmpeg/libmp3lame at 48 kbit/s, without source metadata.

```sh
ffmpeg -f lavfi -i 'sine=frequency=523.25:sample_rate=44100:duration=214.7' -ac 2 -codec:a libmp3lame -b:a 48k -map_metadata -1 tone-215s-stereo.mp3
ffmpeg -f lavfi -i 'sine=frequency=783.99:sample_rate=44100:duration=2' -ac 2 -codec:a libmp3lame -b:a 48k -map_metadata -1 tone-2s-stereo.mp3
ffmpeg -f lavfi -i 'sine=frequency=659.25:sample_rate=44100:duration=400' -ac 2 -codec:a libmp3lame -b:a 48k -map_metadata -1 tone-400s-stereo.mp3
```

The 400 s stereo file exceeds the default 96 MiB full-decode workspace and must fail before native allocation, preserving the previous project.

The long input reproduces the old 64 MiB decoded-audio failure at 44.1/48 kHz.
Tests verify the actual browser-decoded samples, byte hashes, 30 s retained prefix,
shared validation/playback decode, real signals/fades/seek and ZIP/restart restoration.
The user's `Missing Persons - Jeremy Blake.mp3` was not supplied to Codex.
