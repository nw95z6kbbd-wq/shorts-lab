  async function play() {
    if (playing) { pausePlayback(); return; }
    const plan = timing.plan; if (!plan?.timeline.length || !editorVisible || document.hidden || audioState === 'loading') return;
    const total = plan.durationMs, withAudio = ['voice','music'].some(role => plan.audio[role].assetId);
    if (withAudio && !audioPlayback.status().ready) { audioFailure ||= new Error('Аудио не подготовлено. Проверьте исходные файлы.'); renderAudio(); return; }
    if (elapsedMs >= total) elapsedMs = 0;
    playing = true; const epoch = ++playEpoch;
    updatePlaybackUI();
    try {
      // Activate the owned context in this trusted click, but produce no sound
      // until the selected Canvas window has actually rendered its first frame.
      if (withAudio) await audioPlayback.start(Math.floor(elapsedMs), { paused: true });
      if (!playing || epoch !== playEpoch) return;
      project = { ...project, selectedSceneId: P.frameAt(plan, elapsedMs).scene.id }; updateSelectedScene();
      const ready = await renderPreview();
      if (!playing || epoch !== playEpoch) return;
      if (!ready) { pausePlayback(); return; }
      if (withAudio) { await audioPlayback.start(Math.floor(elapsedMs)); audioFailure = null; audioState = 'ready'; renderAudio(); }
    }
    catch (error) { if (epoch === playEpoch) { pausePlayback(); audioFailure = error; audioState = 'error'; renderAudio(); } return; }
    if (!playing || epoch !== playEpoch) { audioPlayback.pause().catch(()=>{}); return; }
    playbackAnchor = performance.now() - elapsedMs;
    async function frame(now) {
      if (!playing || epoch !== playEpoch) return;
      try {
        elapsedMs = Math.min(total, Math.max(0, Math.floor(withAudio ? audioPlayback.positionMs() : now - playbackAnchor)));
        const value = P.frameAt(plan, elapsedMs);
        project = { ...project, selectedSceneId: value.scene.id }; updateSelectedScene();
        const prepared = livePreview.status().active;
        const reusable = prepared?.state === 'ready' && prepared.previewSceneId === value.scene.id && prepared.identity.contentRevision === previewRevision;
        const before = performance.now();
        // A cold image window buffers BOTH consumers at the same project offset.
        if (withAudio && !reusable) await audioPlayback.pause();
        const ready = await renderPreview();
        if (!playing || epoch !== playEpoch) return;
        if (!ready) { pausePlayback(); return; }
        if (withAudio && !reusable && elapsedMs < total) await audioPlayback.start(elapsedMs);
        else if (!withAudio && !reusable) playbackAnchor += performance.now() - before;
        if (!playing || epoch !== playEpoch) return;
        updatePlaybackUI();
        if (elapsedMs >= total) { pausePlayback(); return; }
        animationFrame = requestAnimationFrame(frame);
      } catch (error) { if (epoch === playEpoch) { pausePlayback(); audioFailure = error; audioState = 'error'; renderAudio(); } }
    }
    animationFrame = requestAnimationFrame(frame);
  }

