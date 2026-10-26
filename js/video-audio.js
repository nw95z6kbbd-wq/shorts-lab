(function () {
  'use strict';
  const V = window.ShortsVideoCore;
  // Preview and export share this exact graph and automation schedule.
  function connectMix(context, { voiceBuffer, musicBuffer, voiceVolume = .7, musicVolume = .25, fadeIn = 1, fadeOut = 1, durationSeconds, offsetSeconds = 0, destination, monitor = false }) {
    const sources = [];
    const bus = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 6; limiter.ratio.value = 20;
    limiter.attack.value = .003; limiter.release.value = .1;
    bus.connect(limiter); limiter.connect(destination);
    if (monitor && destination !== context.destination) limiter.connect(context.destination);
    const silence = context.createBufferSource(); silence.buffer = context.createBuffer(1, 128, context.sampleRate);
    silence.loop = true; silence.connect(bus); sources.push(silence);
    const tracks = [
      { buffer: voiceBuffer, volume: voiceVolume, music: false },
      { buffer: musicBuffer, volume: musicVolume, music: true }
    ];
    const scheduled = [];
    for (const track of tracks) {
      if (!track.buffer || offsetSeconds >= Math.min(track.buffer.duration, durationSeconds)) continue;
      const source = context.createBufferSource(); source.buffer = track.buffer;
      const gain = context.createGain(); source.connect(gain); gain.connect(bus);
      scheduled.push({ source, gain, ...track }); sources.push(source);
    }
    return {
      start(when) {
        silence.start(when);
        for (const track of scheduled) {
          const volume = Math.max(0, Math.min(1, track.volume));
          const end = Math.min(durationSeconds, track.buffer.duration);
          if (!track.music) track.gain.gain.setValueAtTime(volume, when);
          else {
            const points = [offsetSeconds, end, Math.min(fadeIn, end), Math.max(0, end - fadeOut)];
            if (fadeIn + fadeOut > end && fadeIn > 0 && fadeOut > 0) points.push(end * fadeIn / (fadeIn + fadeOut));
            const times = [...new Set(points)].filter(time => time >= offsetSeconds && time <= end).sort((a, b) => a - b);
            times.forEach((time, i) => {
              // At the endpoint of a hard cut (no fade-out), keep the previous level.
              const level = volume * V.musicEnvelope(time === end && !fadeOut ? end - .000001 : time, end, fadeIn, fadeOut);
              const at = when + time - offsetSeconds;
              if (!i) track.gain.gain.setValueAtTime(level, at); else track.gain.gain.linearRampToValueAtTime(level, at);
            });
          }
          track.source.start(when, offsetSeconds, end - offsetSeconds);
        }
      },
      stop() { for (const source of sources) { try { source.stop(); } catch (_) {} } bus.disconnect(); limiter.disconnect(); }
    };
  }
  window.ShortsVideoAudio = { connectMix };
})();
