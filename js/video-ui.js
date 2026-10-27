(async function () {
  'use strict';
  const C = window.ShortsCore, V = window.ShortsVideoCore, R = window.ShortsVideoRecorder;
  const M = window.ShortsVideoMedia;
  const P = window.ShortsRenderPlan, A = window.ShortsRenderAdapters;
  const $ = id => document.getElementById(id);
  await window.ShortsEditorReady;
  const loaded = await window.ShortsStorage.load('video');
  let draft = loaded.project || V.demo(), loadError = loaded.error || '';
  let active = false, busy = false, decoding = false, manuallyEdited = draft.edited;
  let plan, resources = { images: new Map() }, audioBuffer = null, musicBuffer = null, resultUrl = '', recorderAbort = null;
  let previewing = false, previewStarting = false, previewFrame = 0, previewOffset = 0, previewEpoch = 0, previewAudio;
  let audioEpoch = 0, musicEpoch = 0, saveTimer, maxSaveTimer, saveEpoch = 0, lastRenderSecond = -1;
  const assets = new Map();
  const audioProblems = new Map();
  function releaseUnused(saved) {
    const used = new Set(draft.scenes.map(scene => scene.imageId));
    for (const [id, asset] of assets) if (!used.has(id)) {
      asset.dispose(); assets.delete(id);
      if (saved) M.remove(id).catch(() => {});
    }
  }
  const sceneNodes = new Map();
  const originalTitle = $('studioTitle').firstChild.textContent;
  const originalDescription = $('studioDescription').textContent;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function error(message) { $('videoError').textContent = message; $('videoError').hidden = !message; }
  function clock(ms) { return C.clockTime(Math.floor(ms / 1000) * 1000); }

  async function saveNow() {
    clearTimeout(saveTimer); clearTimeout(maxSaveTimer); saveTimer = maxSaveTimer = null;
    const epoch = saveEpoch;
    $('videoDraftStatus').textContent = 'Сохранение…';
    const result = await window.ShortsStorage.save({ ...draft, edited: manuallyEdited }, 'video');
    for (const [id, asset] of assets) asset.persisted = !window.ShortsStorage.pending(id);
    for (const scene of draft.scenes) {
      const label = sceneNodes.get(scene.id)?.card.querySelector('.scene-image-name');
      if (label) label.textContent = (scene.imageName || 'Изображение сцены') + (assets.get(scene.imageId)?.persisted === false ? ' · только в этой вкладке' : '');
    }
    if (epoch === saveEpoch) {
      $('videoDraftStatus').textContent = result.ok ? ($('videoIdea').value.length > V.IDEA_LIMIT ? 'Проверьте сохранение · идея превышает лимит' : 'Сохранено на устройстве') : 'Ошибка сохранения · новые файлы только во вкладке';
      if (result.ok) releaseUnused(true); else error(result.error);
    }
    return result.ok;
  }
  function saveSoon() {
    saveEpoch++;
    $('videoDraftStatus').textContent = 'Сохранение…';
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300);
    if (!maxSaveTimer) maxSaveTimer = setTimeout(saveNow, 2000);
  }
  function mediaLoading() {
    clearTimeout(saveTimer); clearTimeout(maxSaveTimer); saveTimer = maxSaveTimer = null;
    saveEpoch++;
    $('videoDraftStatus').textContent = 'Сохранение…';
  }
  function setMode(open) {
    if (!open) {
      stopPreview();
      recorderAbort?.abort(new DOMException('Запись отменена при переходе в редактор.', 'AbortError'));
    } else window.ShortsEditor.pause();
    active = open;
    document.querySelector('.workspace').dataset.mode = open ? 'video' : 'editor';
    $('videoStudio').hidden = !open; $('scriptStudio').hidden = open;
    $('backToEditor').hidden = !open; $('projectName').disabled = open;
    $('projectName').hidden = open; $('videoBreadcrumb').hidden = !open;
    $('openVideoMode').setAttribute('aria-expanded', String(open));
    $('openVideoMode').classList.toggle('active', open);
    if (open) $('openVideoMode').setAttribute('aria-current', 'page');
    else $('openVideoMode').removeAttribute('aria-current');
    document.querySelectorAll('.nav-item[data-view]').forEach(button => {
      const selected = !open && document.querySelector('.editor-tab.active')?.dataset.view === button.dataset.view;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('studioTitle').firstChild.textContent = open ? 'Создать видео по идее' : originalTitle;
    $('studioDescription').textContent = open ? 'Ваша история. Живые фоны. Настоящий видеофайл.' : originalDescription;
    if (open) { redraw(); updateSupport(); }
  }
  function showFile(show) {
    const visible = show && Boolean(resultUrl);
    $('generatedVideo').hidden = !visible; $('videoCanvas').hidden = visible;
    $('videoPreviewHeading').textContent = visible ? 'Готовое видео' : 'Анимация ролика';
    $('showVideoCanvas').classList.toggle('active', !visible); $('showVideoCanvas').setAttribute('aria-pressed', String(!visible));
    $('showVideoFile').classList.toggle('active', visible); $('showVideoFile').setAttribute('aria-pressed', String(visible));
    $('videoSeek').hidden = visible; document.querySelector('.video-preview-controls').hidden = visible;
    if (!visible) $('generatedVideo').pause();
  }
  function invalidateResult() {
    $('generatedVideo').pause(); $('generatedVideo').removeAttribute('src'); $('generatedVideo').load();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = '';
    $('downloadVideo').hidden = true; $('downloadVideo').removeAttribute('href');
    $('videoOutputTabs').hidden = true; $('videoFileInfo').hidden = true;
    $('videoProgress').hidden = true; $('videoProgress').value = 0;
    showFile(false);
  }
  function updateSupport() {
    const support = R.capabilities(Boolean(audioBuffer || musicBuffer), draft.format);
    let message = '';
    if (!support.supported) message = 'Запись MP4/WebM недоступна в этом браузере. Попробуйте актуальный Chrome, Edge, Firefox или Safari. Сценарий и анимированный предпросмотр остаются доступны.';
    else if (!support.audio) message = 'Этот браузер может записывать видео без звука, но не поддерживает добавление аудиодорожки.';
    $('videoSupport').textContent = message; $('videoSupport').hidden = !message;
    const mp4 = support.formats.some(type => type.startsWith('video/mp4'));
    $('videoFormatHint').textContent = support.supported ? (mp4 ? 'Браузер поддерживает MP4. Если кодек не запустится, попробуем WebM.' : 'Для выбранных настроек доступен WebM. Файл будет скачан с расширением .webm.') : 'Видеокодек для записи не найден.';
    $('recordVideo').disabled = busy || decoding || !plan || !support.supported;
    $('playGeneratedPreview').disabled = busy || decoding || previewStarting || !plan;
    $('videoSeek').disabled = busy || decoding || !plan;
    $('videoAudio').disabled = busy || decoding || !support.audio;
    $('videoMusic').disabled = busy || decoding || !support.audio;
    $('videoDuration').disabled = busy || decoding || draft.timing === 'manual';
    for (const [id, nodes] of sceneNodes) nodes.camera.disabled = busy || decoding || draft.scenes.find(scene => scene.id === id)?.visual !== 'image';
    $('addVideoScene').disabled = busy || draft.scenes.length >= 12;
    $('videoSrt').disabled = busy || !plan;
    $('videoToEditor').disabled = busy || !plan;
  }
  function lockControls() {
    document.querySelectorAll('.video-editor input, .video-editor select, .video-editor textarea, .video-editor button').forEach(control => { control.disabled = busy || decoding; });
    $('recordVideo').hidden = busy; $('cancelVideo').hidden = !busy;
    updateSupport();
  }
  function updateTime() {
    const duration = plan?.durationMs || draft.durationSeconds * 1000;
    $('videoPreviewTime').textContent = clock(previewOffset) + ' / ' + C.clockTime(duration);
    $('videoSeek').max = duration; $('videoSeek').value = previewOffset;
  }
  function redraw() {
    updateTime();
    if (!plan) {
      const ctx = $('videoCanvas').getContext('2d');
      if (ctx) { ctx.fillStyle = '#171020'; ctx.fillRect(0, 0, 720, 1280); ctx.fillStyle = '#c6a7df'; ctx.font = '28px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Добавьте текст в сцены', 360, 640); }
      return;
    }
    try { window.ShortsVideoRenderer.render($('videoCanvas'), plan, previewOffset, resources); }
    catch (cause) { plan = null; error(cause.message || 'Не удалось нарисовать предпросмотр.'); updateSupport(); }
  }
  function rebuild() {
    let problem = '';
    try {
      for (const role of ['voice', 'music']) {
        if (draft[role + 'AssetId'] && !(role === 'voice' ? audioBuffer : musicBuffer)) throw new Error(audioProblems.get(role) || 'Восстанавливаем аудио…');
      }
      plan = A.fromVideo(draft);
      resources = { images: new Map([...assets].map(([id, asset]) => [id, asset.image])) };
      if (plan.timeline.some(scene => scene.visual === 'image' && !resources.images.has(scene.imageId))) throw new Error('Для сцен с изображениями выберите файлы заново или переключите их на анимированный фон.');
    } catch (cause) { plan = null; problem = cause.message; }
    $('videoPlanError').textContent = problem; $('videoPlanError').hidden = !problem;
    $('videoTotalTime').textContent = plan ? 'Итого: ' + (plan.durationMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 }) + ' сек · ' + (draft.timing === 'manual' ? 'сумма длительностей сцен' : 'автоматическая разбивка') : 'Исправьте настройки сцен перед записью.';
    updateSceneTimes(); updateSupport();
  }
  function changed() {
    stopPreview(); error(''); invalidateResult(); previewOffset = 0;
    rebuild(); redraw(); saveSoon();
    $('videoRenderStatus').textContent = 'Запись займёт ' + (plan ? (plan.durationMs / 1000).toLocaleString('ru-RU') : '—') + ' секунд. Оставьте вкладку открытой.';
  }
  function updateSceneTimes() {
    $('videoSceneCount').textContent = draft.scenes.length;
    draft.scenes.forEach(scene => {
      const cue = plan?.timeline.find(item => item.id === scene.id);
      const nodes = sceneNodes.get(scene.id);
      if (nodes) {
        nodes.time.textContent = cue ? clock(cue.startMs) + ' · ' + ((cue.endMs - cue.startMs) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек' : 'Сцена не включена в таймлайн';
        if (document.activeElement !== nodes.duration) nodes.duration.value = draft.timing === 'manual' ? scene.durationSeconds ?? '' : cue ? (cue.endMs - cue.startMs) / 1000 : '';
      }
    });
  }
  function renderScenes() {
    sceneNodes.clear();
    const fragment = document.createDocumentFragment();
    draft.scenes.forEach((scene, index) => {
      const card = node('article', 'video-scene-card');
      const number = node('span', 'scene-select', String(index + 1).padStart(2, '0'));
      const content = node('div', 'scene-content');
      const top = node('div', 'scene-card-top');
      const label = node('label', '', 'СЦЕНА ' + String(index + 1).padStart(2, '0')); label.htmlFor = 'video-scene-' + index;
      const meta = node('div', 'scene-meta-row');
      const time = node('span', 'scene-timing');
      const remove = node('button', 'scene-delete', '×'); remove.setAttribute('aria-label', 'Удалить видеосцену ' + (index + 1));
      remove.addEventListener('click', () => {
        const action = () => { draft.scenes.splice(index, 1); manuallyEdited = true; renderScenes(); changed(); };
        if (scene.text.trim()) window.ShortsEditor.confirm('Удалить сцену ролика?', 'Текст этой сцены будет удалён только из черновика видео.', 'Удалить сцену', action); else action();
      });
      meta.append(time, remove); top.append(label, meta);
      const textarea = node('textarea', 'scene-text'); textarea.id = 'video-scene-' + index;
      textarea.rows = 2; textarea.maxLength = 280; textarea.value = scene.text; textarea.placeholder = 'Короткая фраза для этой сцены';
      textarea.addEventListener('input', () => { scene.text = textarea.value; manuallyEdited = true; changed(); });
      const settings = node('div', 'scene-media-settings');
      function select(labelText, key, options, fallback) {
        const label = node('label', '', labelText), control = node('select');
        control.id = 'video-scene-' + key + '-' + index;
        for (const [value, text] of options) { const option = node('option', '', text); option.value = value; control.append(option); }
        control.value = scene[key] || fallback;
        control.addEventListener('change', () => { scene[key] = control.value; manuallyEdited = true; changed(); });
        label.append(control); settings.append(label); return control;
      }
      select('Визуальный ряд', 'visual', [['animated', 'Анимированный фон'], ['image', 'Моё изображение']], 'animated');
      const camera = select('Движение камеры', 'camera', [['zoom-in', 'Приближение'], ['zoom-out', 'Отдаление'], ['pan-left', 'Панорама влево'], ['pan-right', 'Панорама вправо'], ['static', 'Без движения']], 'zoom-in');
      select('Переход к сцене', 'transition', [['crossfade', 'Растворение'], ['slide', 'Сдвиг'], ['zoom', 'Мягкий зум'], ['none', 'Без перехода']], 'crossfade');
      const durationLabel = node('label', '', 'Длительность, сек'), duration = node('input');
      duration.type = 'number'; duration.min = '.5'; duration.max = '60'; duration.step = '.001'; duration.id = 'video-scene-duration-' + index;
      duration.addEventListener('input', () => { useManualTiming(); scene.durationSeconds = duration.value === '' ? null : Number(duration.value); manuallyEdited = true; changed(); });
      durationLabel.append(duration); settings.append(durationLabel);
      const imageRow = node('div', 'scene-image-row');
      const asset = assets.get(scene.imageId);
      if (asset) { const thumbnail = node('img', 'scene-image-thumb'); thumbnail.src = asset.url; thumbnail.alt = 'Изображение сцены ' + (index + 1); imageRow.append(thumbnail); }
      const upload = node('label', 'button button-secondary audio-upload', asset ? 'Заменить изображение' : 'Выбрать изображение');
      const file = node('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'; file.id = 'video-scene-image-' + index;
      file.addEventListener('change', async () => {
        const selected = file.files[0]; file.value = ''; if (!selected || busy || decoding) return;
        stopPreview(); invalidateResult(); error(''); decoding = true; mediaLoading(); lockControls();
        let decoded;
        try {
          decoded = await M.decodeImage(selected);
          const id = C.id(); let stored = true;
          try { await M.put(id, selected, selected.name); } catch (_) { stored = false; }
          decoded.persisted = false; assets.set(id, decoded); decoded = null; scene.imageId = id; scene.imageName = selected.name; scene.visual = 'image';
          manuallyEdited = true; renderScenes(); changed(); await saveNow();
          if (!stored) error('Изображение доступно для предпросмотра и экспорта, но браузер не сохранил его. После перезагрузки выберите файл заново.');
        } catch (cause) { decoded?.dispose(); error(cause.message); saveSoon(); }
        finally { decoding = false; lockControls(); }
      });
      upload.append(file); imageRow.append(upload);
      if (scene.imageId) {
        imageRow.append(node('span', 'scene-image-name', (scene.imageName || 'Изображение сцены') + (asset?.persisted === false ? ' · только в этой вкладке' : '')));
        const removeImage = node('button', 'text-button', 'Убрать');
        removeImage.addEventListener('click', () => { scene.imageId = null; scene.imageName = ''; scene.visual = 'animated'; manuallyEdited = true; renderScenes(); changed(); });
        imageRow.append(removeImage);
      }
      content.append(top, textarea, settings, imageRow); card.append(number, content); fragment.append(card);
      sceneNodes.set(scene.id, { card, time, textarea, duration, camera });
    });
    if (!draft.scenes.length) fragment.append(node('div', 'empty-state', 'Добавьте сцену или создайте сценарий по идее.'));
    $('videoScenes').replaceChildren(fragment); updateSceneTimes();
  }
  function updateIdeaCounter() {
    const count = $('videoIdea').value.length, limit = V.IDEA_LIMIT;
    const exceeded = count > limit, near = !exceeded && count >= Math.ceil(limit * .9);
    $('videoIdeaCounter').textContent = count + ' / ' + limit + ' символов';
    $('videoIdeaCounter').dataset.state = exceeded ? 'error' : near ? 'near' : 'normal';
    $('videoIdea').setAttribute('aria-invalid', String(exceeded));
    if (exceeded && !$('videoDraftStatus').textContent.startsWith('Ошибка')) $('videoDraftStatus').textContent = 'Проверьте сохранение · идея превышает лимит';
    $('videoIdea').setCustomValidity(exceeded ? 'Сократите идею до ' + limit + ' символов.' : '');
    $('videoIdeaWarning').textContent = exceeded ? 'Лимит превышен. Идея пока не сохранена: сократите текст. Лишнее не удалено.' : near ? 'Вы приближаетесь к лимиту идеи.' : '';
    return !exceeded;
  }
  function renderForm() {
    $('videoIdea').value = draft.idea; updateIdeaCounter(); $('videoTitle').value = draft.title;
    $('videoDuration').value = draft.durationSeconds; $('videoTheme').value = draft.theme;
    $('videoCaption').value = draft.caption; $('videoFormat').value = draft.format;
    $('videoVolume').value = Math.round(draft.volume * 100); $('videoVolumeValue').value = Math.round(draft.volume * 100) + '%';
    $('videoTiming').value = draft.timing || 'auto';
    $('videoMusicVolume').value = Math.round((draft.musicVolume ?? .25) * 100); $('videoMusicVolumeValue').value = $('videoMusicVolume').value + '%';
    $('videoMusicFadeIn').value = draft.musicFadeIn ?? 1; $('videoMusicFadeOut').value = draft.musicFadeOut ?? 1;
    rebuild(); renderScenes(); redraw(); lockControls();
  }
  function replaceDraft(next) {
    stopPreview(); draft = { ...next, voiceAssetId: draft.voiceAssetId, voiceName: draft.voiceName, musicAssetId: draft.musicAssetId, musicName: draft.musicName }; manuallyEdited = false; previewOffset = 0;
    error(''); invalidateResult(); renderForm(); changed();
  }
  function replaceWithConfirmation(next) {
    if (manuallyEdited) window.ShortsEditor.confirm('Заменить сцены ролика?', 'Ручные правки сцен этого видеочерновика будут заменены. Проект основного редактора останется прежним.', 'Заменить сцены', () => replaceDraft(next));
    else replaceDraft(next);
  }
  function stopPreview() {
    previewEpoch++; previewing = false; previewStarting = false;
    cancelAnimationFrame(previewFrame); previewAudio?.stop(); previewAudio = null;
    $('generatedVideo').pause();
    $('playGeneratedPreview').querySelector('span').textContent = 'Смотреть';
    $('playGeneratedPreview').querySelector('use').setAttribute('href', '#i-play');
    updateSupport();
  }
  async function playPreview() {
    if (busy || !plan || previewStarting) return;
    if (previewing) { stopPreview(); return; }
    showFile(false); error('');
    if (previewOffset >= plan.durationMs) previewOffset = 0;
    const epoch = ++previewEpoch;
    previewStarting = true; updateSupport();
    try {
      const session = await R.playMix({ voiceBuffer: audioBuffer, musicBuffer, ...P.audioOptions(plan), offsetSeconds: previewOffset / 1000 });
      if (epoch !== previewEpoch || !active || busy) { session.stop(); return; }
      previewAudio = session; previewStarting = false; previewing = true;
      $('playGeneratedPreview').querySelector('span').textContent = 'Пауза';
      $('playGeneratedPreview').querySelector('use').setAttribute('href', '#i-pause');
      updateSupport();
      const anchor = performance.now() - previewOffset;
      function frame(now) {
        if (!previewing || epoch !== previewEpoch) return;
        previewOffset = Math.min(plan.durationMs, now - anchor); redraw();
        if (!plan || previewOffset >= plan.durationMs) { stopPreview(); return; }
        previewFrame = requestAnimationFrame(frame);
      }
      previewFrame = requestAnimationFrame(frame);
    } catch (cause) { if (epoch === previewEpoch) { stopPreview(); error(cause.message); } }
  }
  async function recordVideo() {
    if (busy || decoding || !plan) return;
    stopPreview(); error(''); invalidateResult();
    busy = true; lockControls(); showFile(false); previewOffset = 0; lastRenderSecond = -1;
    $('videoProgress').hidden = false; $('videoProgress').value = 0;
    $('videoRenderStatus').textContent = 'Подготовка видеокодека…';
    const controller = new AbortController(); recorderAbort = controller;
    try {
      const result = await R.record({
        canvas: $('videoCanvas'), plan, resources, audioBuffer, musicBuffer, ...P.audioOptions(plan), format: plan.exportSettings.format, signal: controller.signal,
        onFormat(type) { $('videoRenderStatus').textContent = 'Запись ' + V.extensionFor(type).toUpperCase() + '…'; },
        onProgress(fraction, elapsed) {
          $('videoProgress').value = Math.round(fraction * 100);
          previewOffset = elapsed; updateTime();
          const second = Math.floor(elapsed / 1000);
          if (second !== lastRenderSecond) {
            lastRenderSecond = second;
            $('videoRenderStatus').textContent = elapsed >= plan.durationMs ? 'Завершаем видеофайл…' : 'Запись ' + clock(elapsed) + ' из ' + C.clockTime(plan.durationMs) + '. Не скрывайте вкладку.';
          }
        }
      });
      resultUrl = URL.createObjectURL(result.blob);
      $('generatedVideo').src = resultUrl;
      $('downloadVideo').href = resultUrl;
      $('downloadVideo').download = C.fileName(draft.title) + '.' + result.extension;
      $('downloadVideo').hidden = false; $('videoOutputTabs').hidden = false;
      $('videoFileInfo').textContent = result.extension.toUpperCase() + ' · ' + V.WIDTH + ' × ' + V.HEIGHT + ' · ' + C.clockTime(result.durationMs) + ' · ' + (result.blob.size / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МБ' + (audioBuffer && musicBuffer ? ' · голос + музыка' : audioBuffer || musicBuffer ? ' · с аудио' : ' · без аудио');
      $('videoFileInfo').hidden = false;
      $('videoProgress').value = 100; $('videoRenderStatus').textContent = 'Готово! Видео можно посмотреть и скачать.';
      showFile(true);
    } catch (cause) {
      $('videoProgress').hidden = true; $('videoProgress').value = 0;
      previewOffset = 0; redraw();
      $('videoRenderStatus').textContent = cause.name === 'AbortError' ? 'Запись отменена. Можно начать заново.' : 'Запись не завершена. Исправьте ошибку и попробуйте снова.';
      if (cause.name !== 'AbortError') error(cause.message || 'Не удалось записать видео. Попробуйте WebM.');
    } finally { busy = false; recorderAbort = null; lockControls(); }
  }
  function downloadText(text, type, fileName) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = node('a'); link.href = url; link.download = fileName;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function useManualTiming() {
    if (draft.timing === 'manual') return;
    let automatic;
    try { automatic = V.makePlan(draft); } catch (_) {}
    for (const scene of draft.scenes) {
      const cue = automatic?.timeline.find(item => item.id === scene.id);
      scene.durationSeconds = cue ? Math.max(.5, (cue.endMs - cue.startMs) / 1000) : 3;
    }
    draft.timing = 'manual'; $('videoTiming').value = 'manual';
  }

  async function restoreMedia() {
    const ids = [...new Set(draft.scenes.map(scene => scene.imageId).filter(Boolean))];
    decoding = true; lockControls();
    try {
      for (const id of ids) {
        try { const stored = await M.get(id); if (stored?.file) { const asset = await M.decodeImage(stored.file); asset.persisted = true; assets.set(id, asset); } }
        catch (_) { /* Missing images block export in rebuild. */ }
      }
      for (const [role, info, remove] of [['voice', 'videoAudioInfo', 'removeVideoAudio'], ['music', 'videoMusicInfo', 'removeVideoMusic']]) {
        const id = draft[role + 'AssetId']; if (!id) continue;
        $(remove).hidden = false; $(info).textContent = 'Восстановление аудио…';
        try {
          const stored = await window.ShortsStorage.asset(id);
          if (!stored?.blob) throw new Error('Файл отсутствует в хранилище.');
          const decoded = await R.decodeAudio(stored.blob);
          if (role === 'voice') audioBuffer = decoded; else musicBuffer = decoded;
          $(info).textContent = (stored.name || draft[role + 'Name']) + ' · ' + decoded.duration.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек';
        } catch (cause) {
          const message = (role === 'voice' ? 'Голос' : 'Музыка') + ': ' + cause.message + ' Выберите файл повторно или явно уберите дорожку.';
          audioProblems.set(role, message); $(info).textContent = message;
        }
      }
    } finally { decoding = false; renderForm(); }
  }

  $('openVideoMode').addEventListener('click', () => setMode(true));
  $('createVideoMode').addEventListener('click', () => setMode(true));
  $('backToEditor').addEventListener('click', () => setMode(false));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { if (active) setMode(false); }));
  document.querySelector('.brand').addEventListener('click', () => { if (active) setMode(false); });
  document.addEventListener('shorts:editor-opened', () => setMode(false));
  $('videoIdea').addEventListener('input', () => { if (updateIdeaCounter()) { draft.idea = $('videoIdea').value; saveSoon(); } });
  $('generateIdea').addEventListener('click', () => {
    try {
      if (!updateIdeaCounter()) { $('videoIdea').focus(); return; }
      const generated = V.generateFromIdea($('videoIdea').value);
      replaceWithConfirmation({ ...generated, durationSeconds: draft.durationSeconds, caption: draft.caption, volume: draft.volume, format: draft.format, musicVolume: draft.musicVolume, musicFadeIn: draft.musicFadeIn, musicFadeOut: draft.musicFadeOut });
    } catch (cause) { error(cause.message); }
  });
  $('videoDemo').addEventListener('click', () => replaceWithConfirmation(V.demo()));
  $('videoTitle').addEventListener('input', () => { draft.title = $('videoTitle').value; changed(); });
  [['videoDuration', 'durationSeconds'], ['videoTheme', 'theme'], ['videoCaption', 'caption'], ['videoFormat', 'format']].forEach(([id, field]) => {
    $(id).addEventListener('change', () => { draft[field] = field === 'durationSeconds' ? Number($(id).value) : $(id).value; changed(); });
  });
  $('videoVolume').addEventListener('input', () => { draft.volume = Number($('videoVolume').value) / 100; $('videoVolumeValue').value = $('videoVolume').value + '%'; changed(); });
  $('videoTiming').addEventListener('change', () => {
    if ($('videoTiming').value === 'manual') useManualTiming(); else draft.timing = 'auto';
    manuallyEdited = true; changed();
  });
  $('videoMusicVolume').addEventListener('input', () => { draft.musicVolume = Number($('videoMusicVolume').value) / 100; $('videoMusicVolumeValue').value = $('videoMusicVolume').value + '%'; changed(); });
  for (const [id, key] of [['videoMusicFadeIn', 'musicFadeIn'], ['videoMusicFadeOut', 'musicFadeOut']]) {
    $(id).addEventListener('change', () => {
      const value = Number($(id).value);
      if (!Number.isFinite(value) || value < 0 || value > 10) { $(id).value = draft[key] ?? 1; error('Время появления и затухания музыки должно быть от 0 до 10 секунд.'); return; }
      draft[key] = value; changed();
    });
  }
  $('addVideoScene').addEventListener('click', () => {
    if (draft.scenes.length >= 12 || busy) return;
    const scene = { id: C.id(), text: '', durationSeconds: 3 }; draft.scenes.push(scene); manuallyEdited = true;
    renderScenes(); changed(); sceneNodes.get(scene.id).textarea.focus();
  });
  $('videoAudio').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || busy || decoding) return;
    const previous = audioBuffer;
    const epoch = ++audioEpoch;
    stopPreview(); invalidateResult(); error(''); decoding = true; mediaLoading(); audioBuffer = null;
    $('removeVideoAudio').hidden = true; $('videoAudioInfo').textContent = 'Читаем аудиофайл…'; lockControls();
    try {
      const decoded = await R.decodeAudio(file);
      if (epoch !== audioEpoch) return;
      audioBuffer = decoded;
      const id = C.id(); window.ShortsStorage.stage(id, file, file.name, 'voice');
      draft.voiceAssetId = id; draft.voiceName = file.name; audioProblems.delete('voice');
      changed(); await saveNow();
      $('videoAudioInfo').textContent = file.name + ' · ' + decoded.duration.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек';
      $('removeVideoAudio').hidden = false;
    } catch (cause) { if (epoch === audioEpoch) { audioBuffer = previous; $('videoAudioInfo').textContent = draft.voiceName || 'Без аудиодорожки'; $('removeVideoAudio').hidden = !previous && !draft.voiceAssetId; error(cause.message); saveSoon(); } }
    finally { if (epoch === audioEpoch) { decoding = false; rebuild(); lockControls(); } }
  });
  $('removeVideoAudio').addEventListener('click', () => {
    audioEpoch++; decoding = false; audioBuffer = null; draft.voiceAssetId = null; draft.voiceName = ''; audioProblems.delete('voice'); $('videoAudioInfo').textContent = 'Без аудиодорожки'; $('removeVideoAudio').hidden = true; changed();
  });
  $('videoMusic').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || busy || decoding) return;
    const previous = musicBuffer;
    const epoch = ++musicEpoch;
    stopPreview(); invalidateResult(); error(''); decoding = true; mediaLoading(); musicBuffer = null;
    $('removeVideoMusic').hidden = true; $('videoMusicInfo').textContent = 'Читаем аудиофайл…'; lockControls();
    try {
      const decoded = await R.decodeAudio(file);
      if (epoch !== musicEpoch) return;
      musicBuffer = decoded;
      const id = C.id(); window.ShortsStorage.stage(id, file, file.name, 'music');
      draft.musicAssetId = id; draft.musicName = file.name; audioProblems.delete('music');
      changed(); await saveNow();
      $('videoMusicInfo').textContent = file.name + ' · ' + decoded.duration.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек';
      $('removeVideoMusic').hidden = false;
    } catch (cause) { if (epoch === musicEpoch) { musicBuffer = previous; $('videoMusicInfo').textContent = draft.musicName || 'Без музыки'; $('removeVideoMusic').hidden = !previous && !draft.musicAssetId; error(cause.message); saveSoon(); } }
    finally { if (epoch === musicEpoch) { decoding = false; rebuild(); lockControls(); } }
  });
  $('removeVideoMusic').addEventListener('click', () => {
    musicEpoch++; musicBuffer = null; draft.musicAssetId = null; draft.musicName = ''; audioProblems.delete('music'); $('videoMusicInfo').textContent = 'Без музыки'; $('removeVideoMusic').hidden = true; changed();
  });
  $('playGeneratedPreview').addEventListener('click', playPreview);
  $('videoSeek').addEventListener('input', () => { stopPreview(); previewOffset = Number($('videoSeek').value); redraw(); });
  $('recordVideo').addEventListener('click', recordVideo);
  $('cancelVideo').addEventListener('click', () => recorderAbort?.abort(new DOMException('Запись отменена.', 'AbortError')));
  $('showVideoCanvas').addEventListener('click', () => { showFile(false); redraw(); });
  $('showVideoFile').addEventListener('click', () => { stopPreview(); showFile(true); });
  $('videoSrt').addEventListener('click', () => { if (plan) downloadText(V.generateSrt(plan), 'application/x-subrip;charset=utf-8', C.fileName(draft.title) + '.srt'); });
  $('videoToEditor').addEventListener('click', () => { stopPreview(); window.ShortsEditor.useScript({ title: draft.title, scenes: draft.scenes }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPreview(); if (saveTimer) saveNow(); } });
  window.addEventListener('pagehide', () => { stopPreview(); recorderAbort?.abort(new DOMException('Страница закрыта.', 'AbortError')); if (saveTimer) saveNow(); invalidateResult(); });
  window.addEventListener('shorts:storage-conflict', event => {
    if (event.detail.slot !== 'video') return;
    saveEpoch++; $('videoDraftStatus').textContent = 'Ошибка сохранения';
    error('Проект изменён в другой вкладке. Автосохранение остановлено; ваши правки остаются здесь. Перед перезагрузкой скачайте нужное видео или скопируйте текст.');
  });
  // Read-only bridge for a coherent portable snapshot; no recorder/mixer changes.
  function backupIdle() { if (busy || decoding) throw new Error('Дождитесь завершения записи или загрузки медиа перед ZIP-копией/восстановлением.');stopPreview(); }
  window.ShortsVideoBackup = Object.freeze({
    assertIdle: backupIdle,
    snapshot() {
      backupIdle();
      if ($('videoIdea').value.length > V.IDEA_LIMIT) throw new Error('Сначала исправьте превышение лимита идеи: несохранённый текст нельзя молча исключить из ZIP.');
      stopPreview();return structuredClone({...draft,edited:manuallyEdited});
    }
  });
  renderForm();
  document.body.inert = false;
  await restoreMedia();
  if (!loaded.project && !loadError) await saveNow();
  else if (!loadError) $('videoDraftStatus').textContent = 'Сохранено на устройстве';
  window.ShortsVideoRestored = true;
  if (loadError) {
    $('videoDraftStatus').textContent = loaded.writable ? 'Проверьте сохранённые данные' : 'Ошибка сохранения';
    error(loadError);
  }
})();
