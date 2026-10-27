(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.ShortsVideoCore = factory(root.ShortsCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const WIDTH = 720, HEIGHT = 1280, FPS = 24;
  const IDEA_LIMIT = 280; // Existing UTF-16 limit, shared by input feedback and draft validation.
  const DEMO_IDEA = 'Мистическая история про заброшенный дом';
  const DEMO_SCENES = [
    'Этот заброшенный дом помнил то, что я забыл.',
    'Ночью в пустом окне вдруг зажёгся свет.',
    'За дверью кто-то тихо назвал моё имя.',
    'На полу лежала моя детская фотография.',
    'Но я никогда здесь не был.',
    'На обороте написано: «С возвращением домой». '
  ];
  const TEMPLATES = {
    mystery: ['Ночью в пустом окне вдруг зажёгся свет.', 'За дверью кто-то тихо назвал моё имя.', 'На полу лежала моя детская фотография.', 'Но я никогда здесь не был.', 'На обороте написано: «С возвращением домой».'],
    space: ['Подними голову и представь бесконечное ночное небо.', 'Свет далёких звёзд летел к нам годами.', 'За каждой светящейся точкой скрывается целая история.', 'А мы видим лишь маленькую часть Вселенной.', 'Какое открытие ждёт нас за следующим горизонтом?'],
    sunrise: ['Большой путь начинается с одного маленького шага.', 'Не обязательно знать все ответы заранее.', 'Сегодня попробуй сделать то, что давно откладывал.', 'Даже небольшой результат уже меняет твою историю.', 'Какой первый шаг ты сделаешь прямо сейчас?'],
    neon: ['В привычном мире всегда есть необычный ракурс.', 'Остановись на секунду и присмотрись к деталям.', 'Иногда одна случайная встреча меняет всё.', 'Так обычный день становится началом новой истории.', 'А что случится, если сделать следующий шаг?']
  };

  function themeForIdea(idea) {
    if (/космос|зв[её]зд|планет|вселен|галактик/iu.test(idea)) return 'space';
    if (/мист|страш|заброш|призрак|тайн|хоррор|дом|ночь|лес/iu.test(idea)) return 'mystery';
    if (/мотивац|мечт|успех|путь|шаг|привычк|начать|путешеств/iu.test(idea)) return 'sunrise';
    return 'neon';
  }

  function generateFromIdea(value) {
    const idea = String(value || '').trim().replace(/\s+/gu, ' ');
    if (idea.length < 3 || !C.countWords(idea)) throw new Error('Опишите идею хотя бы несколькими словами.');
    if (idea.length > IDEA_LIMIT) throw new Error('Сократите идею до ' + IDEA_LIMIT + ' символов.');
    const theme = themeForIdea(idea);
    let hook = idea.replace(/[.!?…]+/gu, ',').replace(/[,\s]+$/gu, '');
    if (hook.length > 240) hook = hook.slice(0, 237).replace(/\s+\S*$/u, '') + '…';
    const script = ['Представь: ' + hook + '.', ...TEMPLATES[theme]].join('\n');
    return {
      version: 1, idea, title: idea.slice(0, 80), theme, caption: 'accent',
      durationSeconds: 18, volume: 0.7, format: 'auto', edited: false,
      timing: 'auto', musicVolume: .25, musicFadeIn: 1, musicFadeOut: 1,
      scenes: C.createScenes(script).slice(0, 12)
    };
  }

  function demo() {
    const draft = generateFromIdea(DEMO_IDEA);
    draft.title = 'Дом, который помнит';
    draft.scenes = DEMO_SCENES.map(text => ({ id: C.id(), text: text.trim() }));
    return draft;
  }

  function parseDraft(value) {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || data.version !== 1 || typeof data.idea !== 'string' || data.idea.length > IDEA_LIMIT ||
        typeof data.title !== 'string' || data.title.length > 80 || !Array.isArray(data.scenes) ||
        data.scenes.length > 12 || data.scenes.some(scene => !scene || typeof scene.text !== 'string' || scene.text.length > 280)) {
      throw new Error('Не удалось прочитать черновик видео.');
    }
    const ids = new Set();
    const scenes = data.scenes.map(scene => {
      const id = typeof scene.id === 'string' && scene.id && !ids.has(scene.id) ? scene.id : C.id();
      ids.add(id);
      if (scene.durationSeconds != null && (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds < .5 || scene.durationSeconds > 60)) throw new Error('Некорректная длительность сцены.');
      return { id, text: scene.text, durationSeconds: scene.durationSeconds ?? null,
        visual: scene.visual === 'image' ? 'image' : 'animated',
        imageId: typeof scene.imageId === 'string' ? scene.imageId : null,
        imageName: typeof scene.imageName === 'string' ? scene.imageName.slice(0, 200) : '',
        camera: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'static'].includes(scene.camera) ? scene.camera : 'zoom-in',
        transition: ['crossfade', 'slide', 'zoom', 'none'].includes(scene.transition) ? scene.transition : 'crossfade' };
    });
    return {
      version: 1, idea: data.idea, title: data.title,
      scenes,
      durationSeconds: [15, 18, 20, 30, 60].includes(data.durationSeconds) ? data.durationSeconds : 18,
      theme: ['mystery', 'space', 'sunrise', 'neon'].includes(data.theme) ? data.theme : 'mystery',
      caption: ['accent', 'classic', 'outline'].includes(data.caption) ? data.caption : 'accent',
      volume: Number.isFinite(data.volume) ? Math.max(0, Math.min(1, data.volume)) : 0.7,
      format: data.format === 'webm' ? 'webm' : 'auto', edited: data.edited === true,
      timing: data.timing === 'manual' ? 'manual' : 'auto',
      musicVolume: Number.isFinite(data.musicVolume) ? Math.max(0, Math.min(1, data.musicVolume)) : .25,
      musicFadeIn: Number.isFinite(data.musicFadeIn) ? Math.max(0, Math.min(10, data.musicFadeIn)) : 1,
      musicFadeOut: Number.isFinite(data.musicFadeOut) ? Math.max(0, Math.min(10, data.musicFadeOut)) : 1
    };
  }

  // Compatibility facade. All timing/cues/frame selection live in RenderPlan.
  const shared = () => typeof module === 'object' && module.exports ? require('./render-plan.js') : globalThis.ShortsRenderPlan;
  const adapters = () => typeof module === 'object' && module.exports ? require('./render-adapters.js') : globalThis.ShortsRenderAdapters;
  function chunks(text, size = 6) { return shared().chunks(text, size); }
  function makePlan(draft) { return shared().legacyView(adapters().fromVideo(draft, { legacy: true }), draft); }
  function frameAt(plan, elapsedMs) { return shared().frameAt(plan, elapsedMs); }
  function generateSrt(plan) { return shared().generateSrt(plan); }

  function supportedFormats(isSupported, hasAudio = false, preference = 'auto') {
    const mp4 = hasAudio
      ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4'];
    const webm = hasAudio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return (preference === 'webm' ? webm : [...mp4, ...webm]).filter(type => {
      try { return Boolean(isSupported(type)); } catch (_) { return false; }
    });
  }

  function extensionFor(type) {
    const mime = String(type).split(';')[0].trim().toLowerCase();
    if (mime === 'video/mp4') return 'mp4';
    if (mime === 'video/webm') return 'webm';
    throw new Error('Браузер вернул неизвестный формат видео.');
  }

  function cameraRect(imageWidth, imageHeight, progress, mode = 'zoom-in') {
    if (!(imageWidth > 0 && imageHeight > 0)) throw new Error('Изображение не имеет размеров.');
    const t = Math.max(0, Math.min(1, progress));
    const smooth = t * t * (3 - 2 * t);
    const zoom = mode === 'zoom-in' ? 1.02 + .16 * smooth : mode === 'zoom-out' ? 1.18 - .16 * smooth : mode === 'static' ? 1 : 1.15;
    const scale = Math.max(WIDTH / imageWidth, HEIGHT / imageHeight) * zoom;
    const width = imageWidth * scale, height = imageHeight * scale;
    const pan = mode === 'pan-left' ? 1 - smooth : mode === 'pan-right' ? smooth : .5;
    return { x: -(width - WIDTH) * pan, y: -(height - HEIGHT) / 2, width, height };
  }

  function musicEnvelope(seconds, endSeconds, fadeIn = 1, fadeOut = 1) {
    if (seconds < 0 || seconds >= endSeconds) return 0;
    return Math.max(0, Math.min(1, fadeIn > 0 ? seconds / fadeIn : 1, fadeOut > 0 ? (endSeconds - seconds) / fadeOut : 1));
  }

  // MediaRecorder's streaming WebM often omits Duration. Add it without re-encoding.
  // Indexed files are only patched in place: shifting their cluster offsets would break seeking.
  function patchWebmDuration(bytes, durationMs) {
    if (!(bytes instanceof Uint8Array) || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Некорректные данные длительности WebM.');
    function element(offset, limit) {
      const start = offset;
      if (offset >= limit || !bytes[offset]) throw new Error('Повреждён заголовок WebM.');
      let idWidth = 1;
      while (idWidth <= 4 && !(bytes[offset] & (1 << (8 - idWidth)))) idWidth++;
      if (idWidth > 4 || offset + idWidth >= limit) throw new Error('Повреждён идентификатор WebM.');
      let id = 0;
      for (let i = 0; i < idWidth; i++) id = id * 256 + bytes[offset++];
      const sizeStart = offset;
      if (!bytes[offset]) throw new Error('Повреждён размер WebM.');
      let sizeWidth = 1;
      while (sizeWidth <= 8 && !(bytes[offset] & (1 << (8 - sizeWidth)))) sizeWidth++;
      if (sizeWidth > 8 || offset + sizeWidth > limit) throw new Error('Повреждён размер WebM.');
      let size = bytes[offset] & ((1 << (8 - sizeWidth)) - 1);
      let unknown = size === (1 << (8 - sizeWidth)) - 1;
      offset++;
      for (let i = 1; i < sizeWidth; i++) { unknown = unknown && bytes[offset] === 255; size = size * 256 + bytes[offset++]; }
      if (!unknown && (!Number.isSafeInteger(size) || offset + size > limit)) throw new Error('WebM обрезан.');
      return { id, start, sizeStart, sizeWidth, size, unknown, data: offset, end: unknown ? limit : offset + size };
    }
    function sizeBytes(value, minWidth) {
      let width = minWidth;
      while (value >= 2 ** (7 * width) - 1) width++;
      if (width > 8) throw new Error('Слишком большой WebM.');
      const result = new Uint8Array(width);
      for (let i = width - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
      result[0] |= 1 << (8 - width);
      return result;
    }
    function concat(...parts) {
      const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    }
    let segment;
    for (let offset = 0; offset < bytes.length;) {
      const part = element(offset, bytes.length);
      if (part.id === 0x18538067) { segment = part; break; }
      offset = part.end;
    }
    if (!segment) throw new Error('Не найден видеоконтейнер WebM.');
    let info, indexed = false;
    for (let offset = segment.data; offset < segment.end;) {
      const part = element(offset, segment.end);
      if (part.id === 0x1549a966) info = part;
      if (part.id === 0x114d9b74 || part.id === 0x1c53bb6b) indexed = true;
      offset = part.end;
    }
    if (!info || info.unknown) return bytes;
    let scale = 1000000, duration;
    for (let offset = info.data; offset < info.end;) {
      const part = element(offset, info.end);
      if (part.id === 0x2ad7b1) { scale = 0; for (let i = part.data; i < part.end; i++) scale = scale * 256 + bytes[i]; }
      if (part.id === 0x4489) duration = part;
      offset = part.end;
    }
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Некорректная шкала времени WebM.');
    const value = durationMs * 1000000 / scale;
    if (duration && [4, 8].includes(duration.size)) {
      const result = bytes.slice();
      const view = new DataView(result.buffer, duration.data, duration.size);
      if (duration.size === 8) view.setFloat64(0, value, false); else view.setFloat32(0, value, false);
      return result;
    }
    if (indexed || duration) return bytes;
    const durationElement = new Uint8Array(11);
    durationElement.set([0x44, 0x89, 0x88]); new DataView(durationElement.buffer).setFloat64(3, value, false);
    const newInfo = concat(bytes.slice(info.start, info.sizeStart), sizeBytes(info.size + 11, info.sizeWidth), bytes.slice(info.data, info.end), durationElement);
    const delta = newInfo.length - (info.end - info.start);
    return concat(bytes.slice(0, segment.sizeStart),
      segment.unknown ? bytes.slice(segment.sizeStart, segment.data) : sizeBytes(segment.size + delta, segment.sizeWidth),
      bytes.slice(segment.data, info.start), newInfo, bytes.slice(info.end));
  }

  return { WIDTH, HEIGHT, FPS, IDEA_LIMIT, DEMO_IDEA, demo, generateFromIdea, themeForIdea, parseDraft, chunks, makePlan, frameAt, generateSrt, supportedFormats, extensionFor, patchWebmDuration, cameraRect, musicEnvelope };
});
