(function () {
  'use strict';
  const V = window.ShortsVideoCore;
  const AudioContextClass = () => window.AudioContext || window.webkitAudioContext;

  function capabilities(hasAudio = false, preference = 'auto') {
    const capture = typeof HTMLCanvasElement.prototype.captureStream === 'function';
    const mediaRecorder = typeof window.MediaRecorder === 'function' && typeof window.MediaRecorder.isTypeSupported === 'function';
    const formats = mediaRecorder ? V.supportedFormats(type => window.MediaRecorder.isTypeSupported(type), hasAudio, preference) : [];
    const Audio = AudioContextClass();
    const audio = Boolean(Audio && typeof Audio.prototype.createMediaStreamDestination === 'function');
    return { capture, mediaRecorder, formats, audio, supported: capture && mediaRecorder && formats.length > 0 };
  }

  async function resumeAudio(context) {
    let timer;
    try {
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Браузер не разрешил воспроизведение аудио. Нажмите кнопку ещё раз или уберите аудиодорожку.')), 3000); })
      ]);
      if (context.state !== 'running') throw new Error('Не удалось запустить аудиодорожку.');
    } finally { clearTimeout(timer); }
  }

  async function decodeAudio(file) {
    const Audio = AudioContextClass();
    if (!Audio) throw new Error('В этом браузере загрузка аудио не поддерживается.');
    if (!file || !file.size) throw new Error('Выберите непустой аудиофайл.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Аудиофайл слишком большой. Максимальный размер — 25 МБ.');
    const context = new Audio();
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 600) throw new Error('Длительность аудиодорожки должна быть от доли секунды до 10 минут.');
      return buffer;
    } catch (error) {
      if (error.message.startsWith('Длительность')) throw error;
      throw new Error('Не удалось прочитать аудио. Попробуйте другой файл WAV, MP3, M4A или OGG, который воспроизводится в вашем браузере.');
    } finally { await context.close().catch(() => {}); }
  }

  async function playAudio(buffer, volume, offsetSeconds) {
    if (!buffer || offsetSeconds >= buffer.duration) return { stop() {} };
    const Audio = AudioContextClass();
    if (!Audio) throw new Error('Предпросмотр аудио не поддерживается браузером.');
    const context = new Audio();
    let source;
    try {
      await resumeAudio(context);
      source = context.createBufferSource(); source.buffer = buffer;
      const gain = context.createGain(); gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain); gain.connect(context.destination);
      source.start(0, Math.max(0, offsetSeconds));
      return { stop() { try { source.stop(); } catch (_) { /* Already ended. */ } context.close().catch(() => {}); } };
    } catch (error) { await context.close().catch(() => {}); throw error; }
  }

  async function record({ canvas, plan, audioBuffer = null, volume = .7, format = 'auto', signal, onProgress = () => {}, onFormat = () => {} }) {
    const support = capabilities(Boolean(audioBuffer), format);
    if (!support.supported) throw new Error('Браузер не поддерживает запись Canvas в MP4 или WebM. Откройте сайт в актуальном Chrome, Edge, Firefox или Safari. Предпросмотр и сценарий остаются доступны.');
    if (audioBuffer && !support.audio) throw new Error('Запись аудио не поддерживается. Уберите аудиодорожку и попробуйте снова.');
    signal?.throwIfAborted();
    const render = ms => window.ShortsVideoRenderer.render(canvas, plan, ms);
    let stream, context, source, silenceSource, recorder, animationFrame, flushTimer, finalTimer;
    let abortListener, visibilityListener;
    try {
      render(0);
      stream = canvas.captureStream(V.FPS);
      if (!stream.getVideoTracks().length) throw new Error('Браузер не смог захватить изображение Canvas.');
      if (audioBuffer) {
        const Audio = AudioContextClass();
        context = new Audio();
        await resumeAudio(context);
        signal?.throwIfAborted();
        const destination = context.createMediaStreamDestination();
        const gain = context.createGain(); gain.gain.value = Math.max(0, Math.min(1, volume));
        source = context.createBufferSource(); source.buffer = audioBuffer;
        source.connect(gain); gain.connect(destination); gain.connect(context.destination);
        // Keep the audio graph producing real silent samples after a short soundtrack ends.
        silenceSource = context.createBufferSource();
        silenceSource.buffer = context.createBuffer(1, 128, context.sampleRate);
        silenceSource.loop = true; silenceSource.connect(destination);
        const tracks = destination.stream.getAudioTracks();
        if (!tracks.length) throw new Error('Браузер не смог создать аудиодорожку. Уберите аудио и попробуйте снова.');
        tracks.forEach(track => stream.addTrack(track));
      }
      signal?.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false, stopping = false;
        function fail(error) {
          if (settled) return;
          settled = true; cancelAnimationFrame(animationFrame);
          reject(error instanceof Error || error instanceof DOMException ? error : new Error('Не удалось записать видео. Попробуйте формат WebM.'));
        }
        async function finish() {
          if (settled) return;
          if (!stopping) { fail(new Error('Браузер завершил запись раньше времени. Попробуйте ещё раз или выберите WebM.')); return; }
          try {
            const mimeType = recorder.mimeType || chunks.find(chunk => chunk.type)?.type;
            const extension = V.extensionFor(mimeType);
            let blob = new Blob(chunks, { type: mimeType });
            if (!blob.size) throw new Error('Браузер создал пустой видеофайл. Попробуйте другой формат.');
            if (extension === 'webm') blob = new Blob([V.patchWebmDuration(new Uint8Array(await blob.arrayBuffer()), plan.durationMs)], { type: mimeType });
            if (settled) return;
            settled = true;
            resolve({ blob, mimeType, extension, durationMs: plan.durationMs, width: V.WIDTH, height: V.HEIGHT });
          } catch (error) { fail(error); }
        }
        // isTypeSupported is advisory: a rejected encoder falls through to the next real format.
        for (const type of support.formats) {
          let candidate;
          try {
            candidate = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2600000, audioBitsPerSecond: 128000 });
            candidate.ondataavailable = event => { if (!settled && event.data.size) chunks.push(event.data); };
            candidate.onerror = () => fail(new Error('Ошибка видеокодека браузера. Попробуйте формат WebM или уберите аудиодорожку.'));
            candidate.onstop = finish;
            recorder = candidate;
            candidate.start(250);
            break;
          } catch (_) {
            if (candidate) { candidate.ondataavailable = null; candidate.onerror = null; candidate.onstop = null; if (candidate.state !== 'inactive') candidate.stop(); }
            recorder = null; chunks.length = 0;
          }
        }
        if (!recorder) { fail(new Error('Не удалось запустить ни один видеокодек. Попробуйте другой браузер или уберите аудиодорожку.')); return; }
        abortListener = () => fail(signal.reason || new DOMException('Запись отменена.', 'AbortError'));
        visibilityListener = () => { if (document.hidden) fail(new Error('Запись прервана: вкладка была скрыта. Оставьте её открытой до завершения и попробуйте снова.')); };
        signal?.addEventListener('abort', abortListener, { once: true });
        document.addEventListener('visibilitychange', visibilityListener);
        if (signal?.aborted) { abortListener(); return; }
        try {
          onFormat(recorder.mimeType);
          silenceSource?.start(context.currentTime);
          source?.start(context.currentTime + .02);
          const start = performance.now();
          onProgress(0, 0);
          function frame(now) {
            if (settled) return;
            try {
              const elapsed = Math.min(plan.durationMs, Math.max(0, now - start));
              render(elapsed);
              onProgress(Math.min(.99, elapsed / plan.durationMs), elapsed);
              if (elapsed >= plan.durationMs) {
                stopping = true;
                // Allow the last drawn frame to reach the canvas capture track before flushing.
                flushTimer = setTimeout(() => { if (!settled && recorder.state !== 'inactive') recorder.stop(); }, Math.ceil(1000 / V.FPS));
                finalTimer = setTimeout(() => fail(new Error('Браузер не смог завершить видеофайл. Попробуйте WebM.')), 10000);
              } else animationFrame = requestAnimationFrame(frame);
            } catch (error) { fail(error); }
          }
          animationFrame = requestAnimationFrame(frame);
        } catch (error) { fail(error); }
      });
    } finally {
      cancelAnimationFrame(animationFrame); clearTimeout(flushTimer); clearTimeout(finalTimer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
      if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null; if (recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} } }
      try { source?.stop(); } catch (_) { /* Audio may already have ended. */ }
      try { silenceSource?.stop(); } catch (_) { /* The silent clock may not have started. */ }
      stream?.getTracks().forEach(track => track.stop());
      if (context) await context.close().catch(() => {});
    }
  }

  window.ShortsVideoRecorder = { capabilities, decodeAudio, playAudio, record };
})();
