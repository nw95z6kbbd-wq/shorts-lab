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
    return playMix({ voiceBuffer: buffer, voiceVolume: volume, offsetSeconds, durationSeconds: buffer?.duration || 1 });
  }

  async function playMix(options) {
    if (!options.voiceBuffer && !options.musicBuffer) return { stop() {} };
    const Audio = AudioContextClass();
    if (!Audio) throw new Error('Предпросмотр аудио не поддерживается браузером.');
    const context = new Audio();
    let mix;
    try {
      await resumeAudio(context);
      mix = window.ShortsVideoAudio.connectMix(context, { ...options, destination: context.destination });
      mix.start(context.currentTime + .02);
      return { stop() { mix.stop(); context.close().catch(() => {}); } };
    } catch (error) { mix?.stop(); await context.close().catch(() => {}); throw error; }
  }

  async function record({ canvas, plan, resources, audioBuffer = null, volume = .7, voiceBuffer = audioBuffer, musicBuffer = null, voiceVolume = volume, musicVolume = .25, fadeIn = 1, fadeOut = 1, format = 'auto', recordingPolicy = null, signal, onProgress = () => {}, onFormat = () => {} }) {
    window.ShortsRenderPlan.assertRenderable(plan);
    const hasAudio = Boolean(voiceBuffer || musicBuffer);
    let support = capabilities(hasAudio, format);
    if (recordingPolicy !== null) {
      if (plan?.source?.mode !== 'editor' || !Object.isFrozen(recordingPolicy) || !Array.isArray(recordingPolicy.mimeTypes) || !recordingPolicy.mimeTypes.length || !Number.isSafeInteger(recordingPolicy.maxBytes) || recordingPolicy.maxBytes < 1 || recordingPolicy.mimeTypes.some(type => typeof type !== 'string' || !/^video\/(mp4|webm);codecs=/.test(type))) throw new Error('Некорректная политика записи Editor.');
      const formats = recordingPolicy.mimeTypes.filter(type => { try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; } });
      support = { ...support, formats, supported: support.capture && support.mediaRecorder && formats.length > 0 };
    }
    if (!support.supported) throw new Error('Браузер не поддерживает запись Canvas в MP4 или WebM. Откройте сайт в актуальном Chrome, Edge, Firefox или Safari. Предпросмотр и сценарий остаются доступны.');
    if (hasAudio && !support.audio) throw new Error('Запись аудио не поддерживается. Уберите аудиодорожки и попробуйте снова.');
    signal?.throwIfAborted();
    const render = ms => window.ShortsVideoRenderer.render(canvas, plan, ms, resources);
    let stream, context, mix, recorder, animationFrame, flushTimer, finalTimer;
    let abortListener, visibilityListener;
    try {
      render(0);
      stream = canvas.captureStream(V.FPS);
      if (!stream.getVideoTracks().length) throw new Error('Браузер не смог захватить изображение Canvas.');
      if (hasAudio) {
        const Audio = AudioContextClass();
        context = new Audio();
        recordingPolicy?.onContext?.(context);
        await resumeAudio(context);
        signal?.throwIfAborted();
        const destination = context.createMediaStreamDestination();
        mix = window.ShortsVideoAudio.connectMix(context, { voiceBuffer, musicBuffer, voiceVolume, musicVolume, fadeIn, fadeOut, durationSeconds: plan.durationMs / 1000, destination, monitor: true });
        const tracks = destination.stream.getAudioTracks();
        if (!tracks.length) throw new Error('Браузер не смог создать аудиодорожку. Уберите аудио и попробуйте снова.');
        tracks.forEach(track => stream.addTrack(track));
      }
      signal?.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false, stopping = false, flushRequested = false, finalFlushPending = false, drainRequired = false;
        function fail(error) {
          if (settled) return;
          settled = true; cancelAnimationFrame(animationFrame);
          reject(error instanceof Error || error instanceof DOMException ? error : new Error('Не удалось записать видео. Попробуйте формат WebM.'));
        }
        async function finish() {
          if (settled) return;
          if (!stopping || (drainRequired && (!flushRequested || finalFlushPending))) { fail(new Error('Браузер завершил запись раньше времени. Попробуйте ещё раз или выберите WebM.')); return; }
          try {
            const mimeType = recorder.mimeType || chunks.find(chunk => chunk.type)?.type;
            const extension = V.extensionFor(mimeType);
            let blob = new Blob(chunks, { type: mimeType });
            if (!blob.size) throw new Error('Браузер создал пустой видеофайл. Попробуйте другой формат.');
            if (recordingPolicy && blob.size > recordingPolicy.maxBytes) throw Object.assign(new Error('Размер видео превышает рабочий предел экспорта.'), { code: 'OUTPUT_BUDGET' });
            if (extension === 'webm') blob = new Blob([V.patchWebmDuration(new Uint8Array(await blob.arrayBuffer()), plan.durationMs)], { type: mimeType });
            if (recordingPolicy && blob.size > recordingPolicy.maxBytes) throw Object.assign(new Error('Размер завершённого видео превышает рабочий предел экспорта.'), { code: 'OUTPUT_BUDGET' });
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
            candidate.ondataavailable = event => {
              if (!settled && event.data.size) {
                if (recordingPolicy && chunks.reduce((size, chunk) => size + chunk.size, 0) + event.data.size > recordingPolicy.maxBytes) { fail(Object.assign(new Error('Размер видео превышает рабочий предел экспорта. Проект и оригиналы не изменены.'), { code: 'OUTPUT_BUDGET' })); return; }
                chunks.push(event.data);
              }
              if (!settled && finalFlushPending) {
                finalFlushPending = false;
                try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { fail(error); }
              }
            };
            candidate.onerror = () => fail(new Error('Ошибка видеокодека браузера. Попробуйте формат WebM или уберите аудиодорожку.'));
            candidate.onstop = finish;
            recorder = candidate;
            drainRequired = V.extensionFor(candidate.mimeType || type) === 'webm';
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
          mix?.start(context.currentTime + .02);
          const start = performance.now();
          // MediaRecorder timestamps the mixed stream on the Web Audio clock.
          // Safari can advance that clock more slowly during device warm-up.
          // Keep frames, audio and the stop boundary on that same media clock;
          // silent Canvas recording retains its original performance clock.
          const audioStart = context?.currentTime;
          let audioLast = audioStart, audioAdvancedAt = start;
          const elapsedTime = now => {
            if (!context) return now - start;
            const time = context.currentTime;
            if (context.state !== 'running' || !Number.isFinite(time) || time < audioLast) throw new Error('Аудиопоток прерван или его часы недоступны. Повторите запись.');
            if (time > audioLast) audioAdvancedAt = now;
            else if (now - audioAdvancedAt >= 10000) throw new Error('Аудиопоток не продвигается. Повторите запись или уберите аудиодорожки.');
            audioLast = time;
            return (time - audioStart) * 1000;
          };
          onProgress(0, 0);
          function frame(now) {
            if (settled) return;
            try {
              const elapsed = Math.min(plan.durationMs, Math.max(0, elapsedTime(now)));
              render(elapsed);
              onProgress(Math.min(.99, elapsed / plan.durationMs), elapsed);
              if (elapsed >= plan.durationMs) {
                stopping = true;
                // Allow the last drawn frame to reach the canvas capture track before flushing.
                flushTimer = setTimeout(() => {
                  if (settled || recorder.state === 'inactive') return;
                  if (!drainRequired) { try { recorder.stop(); } catch (error) { fail(error); } return; }
                  recorder.onpause = () => {
                    if (settled || flushRequested) return;
                    flushRequested = true; finalFlushPending = true;
                    try { recorder.requestData(); } catch (error) { fail(error); }
                  };
                  // Freeze input at the final frame, flush while the encoder is
                  // still alive, then stop only after dataavailable acknowledges it.
                  // Safari can otherwise drop the tail and emit an empty stop chunk.
                  try { if (recorder.state === 'paused') recorder.onpause(); else recorder.pause(); }
                  catch (error) { fail(error); }
                }, Math.ceil(1000 / V.FPS));
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
      if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null; recorder.onpause = null; if (recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} } }
      mix?.stop();
      stream?.getTracks().forEach(track => track.stop());
      if (context) await context.close().catch(() => {});
    }
  }

  window.ShortsVideoRecorder = { capabilities, decodeAudio, playAudio, playMix, record };
})();
