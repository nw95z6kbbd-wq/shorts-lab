(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShortsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WORDS_PER_MINUTE = 150;
  const DEMO_SCRIPT = `В тебе есть кое-что от настоящей звезды.
Многие химические элементы, из которых состоит твоё тело, родились в звёздах.
Углерод, кислород и железо появились в недрах звёзд задолго до рождения Земли.
Когда массивные звёзды взрывались, эти элементы разлетались по Вселенной.
Спустя миллиарды лет из этого вещества сформировались новые звёзды, планеты и мы.
Получается, космос гораздо ближе, чем кажется.
Он не только над нашей головой, но и в каждом вдохе, каждом движении, каждой мысли.
В следующий раз, когда посмотришь на ночное небо, вспомни: ты тоже часть этой истории.`;

  function id() {
    return typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function countWords(text) {
    return (String(text || '').match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu) || []).length;
  }

  function durationMs(text) {
    return Math.round(countWords(text) * 60000 / WORDS_PER_MINUTE);
  }

  function splitSentences(text) {
    const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n+/);
    const segmenter = typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('ru', { granularity: 'sentence' }) : null;
    return paragraphs.flatMap(paragraph => {
      if (segmenter) return Array.from(segmenter.segment(paragraph), part => part.segment.trim())
        .flatMap(part => part.split(/(?<=…|\.{3})\s+(?=[«“"']?\p{Lu})/u));
      return (paragraph.match(/[^.!?…]+(?:[.!?…]+[»”"')\]]*|$)/gu) || []).map(part => part.trim());
    }).filter(part => countWords(part) > 0);
  }

  function createScenes(text) {
    return splitSentences(text).map(text => ({ id: id(), text }));
  }

  function timeline(scenes) {
    let end = 0;
    return scenes.flatMap((scene, index) => {
      const duration = durationMs(scene.text);
      if (!duration) return [];
      const cue = { id: scene.id, index, text: scene.text.trim(), startMs: end, endMs: end + duration, durationMs: duration };
      end += duration;
      return [cue];
    });
  }

  function totalDuration(scenes) {
    return scenes.reduce((sum, scene) => sum + durationMs(scene.text), 0);
  }

  function srtTime(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor(safe / 60000) % 60;
    const seconds = Math.floor(safe / 1000) % 60;
    return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':') + ',' + String(safe % 1000).padStart(3, '0');
  }

  function clockTime(ms) {
    const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function plural(number, forms) {
    const lastTwo = Math.abs(number) % 100;
    const last = lastTwo % 10;
    return forms[lastTwo >= 11 && lastTwo <= 19 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2];
  }

  function wordLabel(count) {
    return count + ' ' + plural(count, ['слово', 'слова', 'слов']);
  }

  function wrapSubtitle(text, width = 42) {
    // Keep imported line breaks and markup out of SRT. Empty lines delimit cues.
    const words = String(text).replace(/[<>]/g, char => char === '<' ? '‹' : '›').trim().split(/\s+/u);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else current += (current ? ' ' : '') + word;
    }
    if (current) lines.push(current);
    return lines.join('\n');
  }

  function generateSrt(scenes) {
    const cues = timeline(scenes);
    return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${wrapSubtitle(cue.text)}\n`).join('\n');
  }

  function createProject(demo = false) {
    const script = demo ? DEMO_SCRIPT : '';
    const scenes = createScenes(script);
    return {
      version: 1, id: id(), name: demo ? 'Мы сделаны из звёзд' : 'Новый Short',
      script, sourceScript: script, scenes, selectedSceneId: scenes[0]?.id || null,
      style: { caption: 'accent', size: 'medium', theme: 'cosmos' }, updatedAt: new Date().toISOString()
    };
  }

  function parseProject(value) {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || data.version !== 1 || typeof data.name !== 'string' || data.name.length > 80 ||
        typeof data.script !== 'string' || data.script.length > 1000000 || !Array.isArray(data.scenes) || data.scenes.length > 5000) {
      throw new Error('Файл не является проектом Shorts Studio версии 1.');
    }
    const seen = new Set();
    const scenes = data.scenes.map(scene => {
      if (!scene || typeof scene.text !== 'string' || scene.text.length > 1000000) throw new Error('В файле повреждены данные сцен.');
      const sceneId = typeof scene.id === 'string' && scene.id && !seen.has(scene.id) ? scene.id : id();
      seen.add(sceneId);
      return { id: sceneId, text: scene.text };
    });
    const style = data.style || {};
    return {
      version: 1, id: typeof data.id === 'string' ? data.id : id(), name: data.name,
      script: data.script, sourceScript: typeof data.sourceScript === 'string' ? data.sourceScript : data.script,
      scenes, selectedSceneId: scenes.some(scene => scene.id === data.selectedSceneId) ? data.selectedSceneId : scenes[0]?.id || null,
      style: {
        caption: ['accent', 'classic', 'outline'].includes(style.caption) ? style.caption : 'accent',
        size: ['small', 'medium', 'large'].includes(style.size) ? style.size : 'medium',
        theme: ['cosmos', 'dusk', 'minimal'].includes(style.theme) ? style.theme : 'cosmos'
      },
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString()
    };
  }

  function fileName(name) {
    const safe = String(name || 'Мой Short').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').replace(/[.\s]+$/g, '').trim();
    return safe.slice(0, 80) || 'Мой Short';
  }

  return { WORDS_PER_MINUTE, DEMO_SCRIPT, id, countWords, durationMs, splitSentences, createScenes, timeline,
    totalDuration, srtTime, clockTime, plural, wordLabel, wrapSubtitle, generateSrt, createProject, parseProject, fileName };
});
