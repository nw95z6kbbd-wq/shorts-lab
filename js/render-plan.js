(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.ShortsRenderPlan = factory(root.ShortsCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const KIND = 'shorts-render-plan', VERSION = 1;
  const error = (code, text) => Object.assign(new Error(text), { code });
  function chunks(text, size = 6) {
    const words = String(text).trim().split(/\s+/u).filter(Boolean), result = [];
    for (let i = 0; i < words.length; i += size) result.push(words.slice(i, i + size));
    return result;
  }
  function build(spec) {
    const video = spec.timing.policy.startsWith('video-'), manual = spec.timing.policy === 'video-manual';
    if (!['video-auto', 'video-manual', 'editor-reading', 'editor-manual-or-reading'].includes(spec.timing.policy)) throw error('POLICY', 'Неизвестная политика длительности.');
    if (!['video-chunks-6', 'editor-scene', 'editor-chunks-6'].includes(spec.subtitles.policy)) throw error('POLICY', 'Неизвестная политика субтитров.');
    const omittedScenes = [];
    const scenes = spec.scenes.filter(scene => {
      const include = video ? manual || C.countWords(scene.text) > 0 || scene.visual === 'image' : scene.durationMs > 0;
      if (!include) omittedScenes.push({ id: scene.id, reason: video ? 'empty-auto-scene' : 'zero-reading-duration' });
      return include;
    });
    if (video && !scenes.length) throw new Error('Добавьте текст хотя бы в одну сцену.');
    if (video && scenes.length > 12) throw new Error('В прототипе поддерживается не больше 12 сцен.');
    let durationMs = video && !manual ? spec.timing.durationMs : scenes.reduce((sum, s) => sum + s.durationMs, 0);
    if (video && (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 60000)) throw new Error('Общая длительность ролика должна быть от 0,5 до 60 секунд.');
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw error('TIMING', 'Общая длительность не помещается в целые миллисекунды.');
    const weights = scenes.map(scene => Math.max(4, C.countWords(scene.text))), sum = weights.reduce((a, b) => a + b, 0);
    let weight = 0, end = 0;
    const cues = [];
    const timeline = scenes.map((scene, index) => {
      const weighted = spec.timing.policy === 'video-auto';
      const startMs = weighted ? Math.round(durationMs * weight / sum) : end;
      weight += weights[index];
      const endMs = weighted ? Math.round(durationMs * weight / sum) : startMs + scene.durationMs;
      end = endMs;
      const groups = spec.subtitles.enabled === false ? [] : spec.subtitles.policy === 'editor-scene'
        ? (C.countWords(scene.text) ? [String(scene.text).trim().split(/\s+/u).filter(Boolean)] : []) : chunks(scene.text);
      const wordSum = groups.reduce((total, group) => total + group.length, 0);
      let offset = 0;
      const sceneCues = groups.map(words => {
        const start = startMs + Math.round((endMs - startMs) * offset / wordSum);
        offset += words.length;
        const cue = { startMs: start, endMs: startMs + Math.round((endMs - startMs) * offset / wordSum), text: spec.subtitles.policy === 'editor-scene' ? scene.text.trim() : words.join(' '), words };
        cues.push(cue); return cue;
      });
      if (spec.subtitles.policy === 'editor-chunks-6' && sceneCues.some(cue => cue.endMs <= cue.startMs)) throw error('SUBTITLES', 'Для коротких групп субтитров недостаточно миллисекунд. Увеличьте длительность сцены или явно выберите субтитры по сценам.');
      return { id: scene.id, text: scene.text, index, startMs, endMs, cues: sceneCues,
        visual: scene.visual || 'animated', imageId: scene.imageId || null,
        camera: scene.camera || 'zoom-in', transition: scene.transition || 'crossfade' };
    });
    return { kind: KIND, version: VERSION, source: spec.source, output: { width: 720, height: 1280, fps: 24 },
      title: spec.title, theme: spec.appearance.resolved.theme, caption: spec.appearance.resolved.caption,
      durationMs, timeline, cues, omittedScenes, timing: spec.timing, subtitles: spec.subtitles,
      appearance: spec.appearance, audio: spec.audio, media: spec.media, exportSettings: spec.exportSettings };
  }
  // The legacy public API retains its original shape, including raw theme values.
  function legacyView(plan, draft) {
    if (plan.source.mode !== 'video') throw error('POLICY', 'Совместимый видеоплан нельзя использовать для подмены оформления Студии.');
    return { title: plan.title, theme: draft.theme, caption: draft.caption, durationMs: plan.durationMs, timeline: plan.timeline, cues: plan.cues };
  }
  function isPlan(plan) { return plan?.kind === KIND; }
  function frameAt(plan, elapsedMs) {
    if (isPlan(plan) && plan.version !== VERSION) throw error('UNSUPPORTED', 'Неизвестная версия RenderPlan.');
    if (!plan?.timeline?.length || plan.durationMs <= 0) throw error('EMPTY', 'В расчётном плане нет сцен с положительной длительностью.');
    const time = Math.max(0, Math.min(plan.durationMs - 1, Number(elapsedMs) || 0));
    const scene = plan.timeline.find(scene => time < scene.endMs) || plan.timeline[plan.timeline.length - 1];
    const cue = scene.cues.find(cue => time < cue.endMs) || scene.cues[scene.cues.length - 1] || null;
    const highlight = !isPlan(plan) || plan.subtitles.highlight === 'estimated-word';
    const activeWord = cue && highlight ? Math.min(cue.words.length - 1, Math.floor((time - cue.startMs) / (cue.endMs - cue.startMs) * cue.words.length)) : -1;
    return { time, scene, cue, activeWord, localMs: time - scene.startMs };
  }
  function generateSrt(plan) {
    return plan.cues.map((cue, index) => `${index + 1}\n${C.srtTime(cue.startMs)} --> ${C.srtTime(cue.endMs)}\n${C.wrapSubtitle(cue.text)}\n`).join('\n');
  }
  function assertRenderable(plan) {
    if (!isPlan(plan)) return; // Existing public renderer/recorder callers remain valid.
    if (plan.version !== VERSION) throw error('UNSUPPORTED', 'Неизвестная версия RenderPlan.');
    if (!plan.timeline.length || plan.durationMs <= 0) throw error('EMPTY', 'Добавьте сцены с положительной длительностью.');
    if (!plan.appearance.supported) throw error('APPEARANCE', 'Canvas-renderer пока не воспроизводит запрошенное оформление точно. Подмена темы отключена.');
    if (plan.output.width !== 720 || plan.output.height !== 1280 || plan.output.fps !== 24) throw error('OUTPUT', 'Параметры RenderPlan не поддерживаются текущим renderer.');
  }
  function audioOptions(plan) {
    return { voiceVolume: plan.audio.voice.volume, musicVolume: plan.audio.music.volume,
      fadeIn: plan.audio.music.fadeInSeconds, fadeOut: plan.audio.music.fadeOutSeconds,
      durationSeconds: plan.durationMs / 1000 };
  }
  return Object.freeze({ KIND, VERSION, build, chunks, legacyView, isPlan, frameAt, generateSrt, assertRenderable, audioOptions });
});
