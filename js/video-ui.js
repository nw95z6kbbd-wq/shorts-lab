(function () {
  'use strict';
  const C = window.ShortsCore, V = window.ShortsVideoCore, R = window.ShortsVideoRecorder;
  const $ = id => document.getElementById(id);
  const KEY = 'shorts-studio.video.v1';
  let draft = V.demo(), loadError = '';
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      try { draft = V.parseDraft(raw); }
      catch (_) {
        try { localStorage.setItem(KEY + '.recovery', raw); } catch (_) {}
        loadError = 'Черновик видео повреждён. Открыт демонстрационный пример. Проект редактора сохранён отдельно.';
      }
    }
  } catch (_) { loadError = 'Автосохранение видео недоступно. Работа возможна, но черновик может не сохраниться после перезагрузки.'; }
  let active = false, busy = false, decoding = false, manuallyEdited = draft.edited;
  let plan, audioBuffer = null, resultUrl = '', recorderAbort = null;
  let previewing = false, previewStarting = false, previewFrame = 0, previewOffset = 0, previewEpoch = 0, previewAudio;
  let audioEpoch = 0, saveTimer, lastRenderSecond = -1;
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

  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...draft, edited: manuallyEdited }));
      $('videoDraftStatus').textContent = 'Черновик сохранён на устройстве';
    } catch (_) {
      $('videoDraftStatus').textContent = 'Черновик не сохранён';
      error('Браузер не смог сохранить черновик видео. Не закрывайте страницу до скачивания результата. Проект редактора хранится отдельно.');
    }
  }
  function saveSoon() {
    $('videoDraftStatus').textContent = 'Сохранение черновика…';
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300);
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
    $('projectName').hidden = open; $('videoBreadcrumb').hidden = !open; $('saveStatus').hidden = open;
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
    const support = R.capabilities(Boolean(audioBuffer), draft.format);
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
    $('addVideoScene').disabled = busy || draft.scenes.length >= 12;
    $('videoSrt').disabled = busy || !plan;
    $('videoToEditor').disabled = busy || !plan;
  }
  function lockControls() {
    document.querySelectorAll('.video-editor input, .video-editor select, .video-editor textarea, .video-editor button').forEach(control => { control.disabled = busy; });
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
    try { window.ShortsVideoRenderer.render($('videoCanvas'), plan, previewOffset); }
    catch (cause) { plan = null; error(cause.message || 'Не удалось нарисовать предпросмотр.'); updateSupport(); }
  }
  function rebuild() {
    try { plan = V.makePlan(draft); } catch (_) { plan = null; }
    updateSceneTimes(); updateSupport();
  }
  function changed() {
    stopPreview(); error(''); invalidateResult(); previewOffset = 0;
    rebuild(); redraw(); saveSoon();
    $('videoRenderStatus').textContent = 'Запись займёт ' + draft.durationSeconds + ' секунд. Оставьте вкладку открытой.';
  }
  function updateSceneTimes() {
    $('videoSceneCount').textContent = draft.scenes.length;
    draft.scenes.forEach(scene => {
      const cue = plan?.timeline.find(item => item.id === scene.id);
      const nodes = sceneNodes.get(scene.id);
      if (nodes) nodes.time.textContent = cue ? clock(cue.startMs) + ' · ' + ((cue.endMs - cue.startMs) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек' : 'Пустая сцена · пропускается';
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
      content.append(top, textarea); card.append(number, content); fragment.append(card);
      sceneNodes.set(scene.id, { card, time, textarea });
    });
    if (!draft.scenes.length) fragment.append(node('div', 'empty-state', 'Добавьте сцену или создайте сценарий по идее.'));
    $('videoScenes').replaceChildren(fragment); updateSceneTimes();
  }
  function renderForm() {
    $('videoIdea').value = draft.idea; $('videoTitle').value = draft.title;
    $('videoDuration').value = draft.durationSeconds; $('videoTheme').value = draft.theme;
    $('videoCaption').value = draft.caption; $('videoFormat').value = draft.format;
    $('videoVolume').value = Math.round(draft.volume * 100); $('videoVolumeValue').value = Math.round(draft.volume * 100) + '%';
    rebuild(); renderScenes(); redraw(); lockControls();
  }
  function replaceDraft(next) {
    stopPreview(); draft = next; manuallyEdited = false; previewOffset = 0;
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
      const session = await R.playAudio(audioBuffer, draft.volume, previewOffset / 1000);
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
        canvas: $('videoCanvas'), plan, audioBuffer, volume: draft.volume, format: draft.format, signal: controller.signal,
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
      $('videoFileInfo').textContent = result.extension.toUpperCase() + ' · ' + V.WIDTH + ' × ' + V.HEIGHT + ' · ' + C.clockTime(result.durationMs) + ' · ' + (result.blob.size / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МБ' + (audioBuffer ? ' · с аудио' : ' · без аудио');
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

  $('openVideoMode').addEventListener('click', () => setMode(true));
  $('createVideoMode').addEventListener('click', () => setMode(true));
  $('backToEditor').addEventListener('click', () => setMode(false));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { if (active) setMode(false); }));
  document.querySelector('.brand').addEventListener('click', () => { if (active) setMode(false); });
  document.addEventListener('shorts:editor-opened', () => setMode(false));
  $('videoIdea').addEventListener('input', () => { draft.idea = $('videoIdea').value; saveSoon(); });
  $('generateIdea').addEventListener('click', () => {
    try {
      const generated = V.generateFromIdea($('videoIdea').value);
      replaceWithConfirmation({ ...generated, durationSeconds: draft.durationSeconds, caption: draft.caption, volume: draft.volume, format: draft.format });
    } catch (cause) { error(cause.message); }
  });
  $('videoDemo').addEventListener('click', () => replaceWithConfirmation(V.demo()));
  $('videoTitle').addEventListener('input', () => { draft.title = $('videoTitle').value; changed(); });
  [['videoDuration', 'durationSeconds'], ['videoTheme', 'theme'], ['videoCaption', 'caption'], ['videoFormat', 'format']].forEach(([id, field]) => {
    $(id).addEventListener('change', () => { draft[field] = field === 'durationSeconds' ? Number($(id).value) : $(id).value; changed(); });
  });
  $('videoVolume').addEventListener('input', () => { draft.volume = Number($('videoVolume').value) / 100; $('videoVolumeValue').value = $('videoVolume').value + '%'; changed(); });
  $('addVideoScene').addEventListener('click', () => {
    if (draft.scenes.length >= 12 || busy) return;
    const scene = { id: C.id(), text: '' }; draft.scenes.push(scene); manuallyEdited = true;
    renderScenes(); changed(); sceneNodes.get(scene.id).textarea.focus();
  });
  $('videoAudio').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || busy) return;
    const epoch = ++audioEpoch;
    stopPreview(); invalidateResult(); error(''); decoding = true; audioBuffer = null;
    $('removeVideoAudio').hidden = true; $('videoAudioInfo').textContent = 'Читаем аудиофайл…'; updateSupport();
    try {
      const decoded = await R.decodeAudio(file);
      if (epoch !== audioEpoch) return;
      audioBuffer = decoded;
      $('videoAudioInfo').textContent = file.name + ' · ' + decoded.duration.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' сек';
      $('removeVideoAudio').hidden = false;
    } catch (cause) { if (epoch === audioEpoch) { $('videoAudioInfo').textContent = 'Без аудиодорожки'; error(cause.message); } }
    finally { if (epoch === audioEpoch) { decoding = false; updateSupport(); } }
  });
  $('removeVideoAudio').addEventListener('click', () => {
    audioEpoch++; decoding = false; audioBuffer = null; $('videoAudioInfo').textContent = 'Без аудиодорожки'; $('removeVideoAudio').hidden = true; changed();
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
  renderForm();
  if (loadError) error(loadError);
})();
