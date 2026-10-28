(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./render-plan.js'), require('./editor-profile.js'));
  else root.ShortsRenderAdapters = factory(root.ShortsCore, root.ShortsRenderPlan, root.ShortsEditorProfile);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, P, E) {
  'use strict';
  const videoThemes = ['mystery', 'space', 'sunrise', 'neon'], captions = ['accent', 'classic', 'outline'];
  function ids(scenes) {
    const seen = new Set();
    for (const scene of scenes) {
      if (!scene || typeof scene.id !== 'string' || !scene.id || seen.has(scene.id)) throw new Error('Для расчёта нужны постоянные уникальные идентификаторы сцен.');
      seen.add(scene.id);
    }
  }
  function media(scenes, voice, music) {
    const used = new Map();
    const add = (id, kind) => {
      if (!id) return;
      if (used.has(id) && (used.get(id) === 'image') !== (kind === 'image')) throw new Error('Исходник нельзя использовать одновременно как изображение и аудио.');
      used.set(id, kind);
    };
    scenes.forEach(s => add(s.imageId, 'image')); add(voice.assetId, 'voice'); add(music.assetId, 'music');
    return [...used].map(([assetId, kind]) => ({ assetId, kind }));
  }
  function audio(voice, music) {
    return { policy: 'start-at-zero-clip-at-plan-end', voice: { ...voice, offsetMs: 0, loop: false },
      music: { ...music, offsetMs: 0, loop: false }, shortSource: 'silence-after-source-end', durationFromAudio: false };
  }
  function fromVideo(draft, { legacy = false } = {}) {
    if (!legacy) {
      ids(draft.scenes);
      if (draft.version !== 1 || draft.scenes.length > 12 || draft.scenes.some(s => typeof s.text !== 'string' || s.text.length > 280)) throw new Error('Не удалось прочитать сцены видеорежима.');
    }
    const manual = draft.timing === 'manual';
    if (manual && draft.scenes.some(s => !Number.isFinite(s.durationSeconds) || s.durationSeconds < .5 || s.durationSeconds > 60)) throw new Error('Укажите длительность каждой сцены от 0,5 до 60 секунд.');
    const voice = { assetId: draft.voiceAssetId || null, name: draft.voiceName || '', volume: draft.volume ?? .7 };
    const music = { assetId: draft.musicAssetId || null, name: draft.musicName || '', volume: draft.musicVolume ?? .25,
      fadeInSeconds: draft.musicFadeIn ?? 1, fadeOutSeconds: draft.musicFadeOut ?? 1 };
    return P.build({ source: { mode: 'video', dtoVersion: draft.version ?? 1 }, title: draft.title,
      scenes: draft.scenes.map(s => ({ id: s.id, text: s.text, durationMs: manual ? Math.round(s.durationSeconds * 1000) : null,
        visual: s.visual || 'animated', imageId: s.imageId || null, camera: s.camera || 'zoom-in', transition: s.transition || 'crossfade' })),
      timing: { policy: manual ? 'video-manual' : 'video-auto', durationMs: manual ? null : Math.round(Number(draft.durationSeconds) * 1000) },
      subtitles: { policy: 'video-chunks-6', enabled: true, highlight: 'estimated-word', alignment: 'scene-proportional-estimate' },
      appearance: { requested: { namespace: 'video', theme: draft.theme, caption: draft.caption, size: 'auto-fit' },
        resolved: { renderer: 'canvas-v1', theme: draft.theme, caption: draft.caption, size: 'auto-fit', layout: 'video-v1' },
        supported: videoThemes.includes(draft.theme) && captions.includes(draft.caption), limitations: [...(videoThemes.includes(draft.theme) ? [] : ['video-theme-not-supported']), ...(captions.includes(draft.caption) ? [] : ['video-caption-not-supported'])] },
      audio: audio(voice, music), media: legacy ? [] : media(draft.scenes, voice, music), exportSettings: { format: draft.format || 'auto', profile: 'shorts-720p' } });
  }
  function fromEditor(input) {
    const raw = typeof input === 'string' ? JSON.parse(input) : input;
    if (!raw || !Array.isArray(raw.scenes)) throw new Error('Не удалось прочитать сцены ручной Студии.');
    if (typeof raw.id !== 'string' || !raw.id) throw new Error('Для расчёта нужен постоянный идентификатор проекта.');
    E.style(raw.style,{partial:true});
    ids(raw.scenes); // Do not generate IDs during a deterministic calculation.
    // A legacy import may omit updatedAt. It is irrelevant to rendering; do not
    // let the DTO normalizer consult the wall clock for this temporary value.
    const inputProject = raw.version === 1 && typeof raw.updatedAt !== 'string' ? { ...raw, updatedAt: '' } : raw;
    const project = C.upgradeProject(inputProject), manual = project.timing === 'manual';
    const voice = { ...project.audio.voice }, music = { assetId: project.audio.music.assetId, name: project.audio.music.name,
      volume: project.audio.music.volume, fadeInSeconds: project.audio.music.fadeInMs / 1000, fadeOutSeconds: project.audio.music.fadeOutMs / 1000 };
    const scenes = project.scenes.map(s => ({ ...s, durationMs: manual && s.durationMs !== null ? s.durationMs : C.durationMs(s.text) }));
    return P.build({ source: { mode: 'editor', dtoVersion: raw.version, projectId: project.id }, title: project.name, scenes,
      timing: { policy: manual ? 'editor-manual-or-reading' : 'editor-reading', wordsPerMinute: C.WORDS_PER_MINUTE },
      subtitles: { policy: project.subtitles.mode === 'chunks' ? 'editor-chunks-6' : 'editor-scene', enabled: project.subtitles.enabled,
        highlight: 'none', alignment: project.subtitles.mode === 'chunks' ? 'scene-proportional-estimate' : 'scene-boundaries' },
      appearance: E.resolve(project.style),
      audio: audio(voice, music), media: media(project.scenes, voice, music), exportSettings: { ...project.exportSettings } });
  }
  return Object.freeze({ fromEditor, fromVideo });
});
