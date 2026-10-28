window.ShortsEditorReady = (async function () {
  'use strict';
  const C = window.ShortsCore, T = window.ShortsEditorTiming, P = window.ShortsRenderPlan;
  const $ = id => document.getElementById(id);
  const loaded = await window.ShortsStorage.load();
  let project = loaded.project || C.createProject(true);
  let view = 'script';
  let saveTimer, maxSaveTimer, saveEpoch = 0;
  let toastTimer;
  let playing = false;
  let animationFrame = 0;
  let elapsedMs = 0;
  let playbackAnchor = 0;
  let pendingConfirmation = null;
  const sceneNodes = new Map(), durationErrors = new Map();
  let timing = { plan: null, byId: new Map(), error: null }, lastGoodProject = null, commandError = null;
  let subtitlesDirty = true, lastSelectedSceneId = null, previewRevision = 0, playEpoch = 0, editorVisible = true;
  const imageStates = new Map();
  const livePreview = window.ShortsEditorPreview.create({ canvas: $('editorCanvas'), onState: previewState });
  const imageUploads = window.ShortsEditorImages.create({
    owner: () => project.id,
    valid: (id, owner) => editorVisible && !timing.error && project.id === owner && project.selectedSceneId === id && project.scenes.some(s => s.id === id),
    accept: (id, image) => { if (timing.error) return false; T.edit(project, { type: 'image', id, value: image }); editScene({ type: 'image', id, value: image }, true); return true; },
    onState: (id, state, error) => { imageStates.set(id, { state, message: error?.message || (state === 'loading' ? 'Проверяем и загружаем оригинал…' : state === 'ready' ? 'Оригинал принят. Состояние сохранения — в уведомлении.' : 'Загрузка отменена.') }); updateSceneTimings(id); if (project.selectedSceneId === id && state === 'loading') { livePreview.suspend(); previewState({ state: 'loading' }); } else if (project.selectedSceneId === id && state === 'error') previewState({ state: 'error', error }); }
  });

  function previewState({ state, error, timeMs, sceneId }) {
    $('portrait').dataset.previewState = state;
    $('editorCanvas').hidden = state !== 'ready'; $('editorPreviewMessage').hidden = state === 'ready';
    $('editorPreviewMessage').dataset.state = state;
    if (state !== 'error') delete $('editorPreviewMessage').dataset.code;
    if (state === 'ready') { $('editorCanvas').dataset.timeMs = String(Math.floor(timeMs)); $('editorCanvas').dataset.sceneId = sceneId; return; }
    if (state === 'loading') $('editorPreviewMessage').textContent = 'Подготавливаем кадр и исходные изображения…';
    else {
      const number = project.scenes.findIndex(s => s.id === project.selectedSceneId) + 1;
      const sourceIndex = error?.assetId ? project.scenes.findIndex(s => s.imageId === error.assetId) : -1;
      $('editorPreviewMessage').textContent = error?.code === 'TEXT_OVERFLOW' ? 'Сцена ' + number + ': текст не помещается. Сократите текст, уменьшите размер или явно выберите группы субтитров.' :
        (sourceIndex >= 0 ? 'Исходник сцены ' + (sourceIndex + 1) + ': ' : '') + (error?.message || 'Предпросмотр недоступен.') + (['MEMORY_BUDGET','IMAGE_BUDGET'].includes(error?.code) ? ' Используйте меньшие изображения или переход «Без перехода».' : '');
      $('editorPreviewMessage').dataset.code = error?.code || (state === 'empty' ? 'EMPTY' : 'PREVIEW');
      if (state === 'error') pausePlayback();
    }
  }

  function recalculate() {
    try {
      const inputError = commandError || durationErrors.values().next().value;
      if (inputError) throw inputError;
      timing = { ...T.compile(project), error: null };
      lastGoodProject = project;
    } catch (error) { timing = { plan: null, byId: new Map(), error }; }
    subtitlesDirty = true; previewRevision++;
    if (timing.error) imageUploads.cancel();
    imageUploads.retain(new Set([project,lastGoodProject].filter(Boolean).flatMap(p => p.scenes.map(s => s.imageId).filter(Boolean))));
  }

  function showTimingError() {
    const error = timing.error;
    $('editorTimingError').hidden = !error;
    $('editorTimingErrorText').textContent = error ? 'Правки не сохранены: ' + error.message : '';
    $('editorResetTiming').disabled = !lastGoodProject;
    if (error) {
      updateSaveStatus('Ошибка сохранения', true);
      if ($('storageWarning').hidden || $('storageWarning').dataset.timingError) {
        $('storageWarning').hidden = false;
        $('storageWarning').dataset.timingError = 'true';
        $('storageWarning').textContent = 'Исправьте или отмените правку в Студии. ' + error.message;
      }
    } else if ($('storageWarning').dataset.timingError) {
      delete $('storageWarning').dataset.timingError;
      $('storageWarning').hidden = true;
      $('storageWarning').textContent = '';
    }
  }

  function refreshTimingViews() {
    renderStats(); updateSceneTimings();
    if (view === 'subtitles') renderSubtitles();
    renderPreview();
  }

  function editScene(command, reconcile = false) {
    pausePlayback();
    if (command.type === 'remove') { imageUploads.cancel(); imageStates.delete(command.id); }
    try {
      project = T.edit(project, command);
      if (command.type === 'duration') durationErrors.delete(command.id);
      if (command.type === 'remove') durationErrors.delete(command.id);
      commandError = null;
    } catch (error) {
      if (command.type === 'duration') durationErrors.set(command.id, error);
      else commandError = error;
    }
    recalculate(); elapsedMs = sceneStart(project.selectedSceneId);
    if (reconcile) renderScenes();
    changed(); refreshTimingViews();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    return svg;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }

  function updateSaveStatus(text, error = false) {
    $('saveStatus').classList.toggle('error', error);
    $('editorSaveState').textContent = text;
    $('saveStatus').querySelector('use').setAttribute('href', error ? '#i-info' : '#i-check');
  }

  async function saveNow() {
    clearTimeout(saveTimer); clearTimeout(maxSaveTimer); maxSaveTimer = null;
    const epoch = saveEpoch;
    if (timing.error) { showTimingError(); return false; }
    updateSaveStatus('Сохранение…');
    const result = await window.ShortsStorage.save(project);
    if (epoch === saveEpoch) {
      updateSaveStatus(result.ok ? 'Сохранено на устройстве' : 'Ошибка сохранения', !result.ok);
      $('storageWarning').hidden = result.ok;
      if (!result.ok) $('storageWarning').textContent = result.error;
    }
    return result.ok;
  }

  function changed() {
    saveEpoch++;
    project.updatedAt = new Date().toISOString();
    updateSaveStatus('Сохранение…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
    if (!maxSaveTimer) maxSaveTimer = setTimeout(saveNow, 2000);
    if (timing.error) showTimingError(); else lastGoodProject = project;
  }

  function confirmAction(title, description, label, action) {
    if ($('confirmDialog').open) return;
    $('dialogTitle').textContent = title;
    $('dialogDescription').textContent = description;
    $('dialogConfirm').textContent = label;
    pendingConfirmation = action;
    $('confirmDialog').returnValue = '';
    $('confirmDialog').showModal();
  }

  $('confirmDialog').addEventListener('close', () => {
    const action = pendingConfirmation;
    pendingConfirmation = null;
    if ($('confirmDialog').returnValue === 'confirm') action?.();
  });

  function setView(nextView, focusTab = false) {
    view = nextView;
    document.querySelector('.workspace').dataset.currentView = view;
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (button.getAttribute('role') === 'tab') {
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      } else {
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    });
    $('pane-script').hidden = view !== 'script';
    $('pane-subtitles').hidden = view !== 'subtitles';
    $('scenesSection').hidden = view === 'subtitles';
    $('scenesSection').classList.toggle('scene-tab-view', view === 'scenes');
    if (view === 'scenes') {
      $('scenesSection').setAttribute('role', 'tabpanel');
      $('scenesSection').setAttribute('aria-labelledby', 'tab-scenes');
    } else {
      $('scenesSection').removeAttribute('role');
      $('scenesSection').setAttribute('aria-labelledby', 'scenesTitle');
    }
    if (view === 'subtitles' && subtitlesDirty) renderSubtitles();
    if (focusTab) $('tab-' + view).focus();
  }

  function renderStats() {
    const words = C.countWords(project.script), plan = timing.plan;
    $('wordCount').textContent = words;
    $('scriptWordCount').textContent = C.wordLabel(words);
    // This is an explicitly labelled estimate of the original script, not scene timing.
    $('scriptDuration').textContent = '≈ ' + Math.ceil(C.durationMs(project.script) / 1000) + ' сек';
    for (const id of ['sceneCount', 'navSceneCount', 'tabSceneCount', 'sceneHeadingCount']) $(id).textContent = project.scenes.length;
    for (const id of ['totalDuration', 'previewDuration']) {
      $(id).textContent = plan ? T.clock(plan.durationMs) : '—';
      if (plan) { $(id).dataset.durationMs = String(plan.durationMs); $(id).title = C.srtTime(plan.durationMs); }
      else { delete $(id).dataset.durationMs; $(id).title = timing.error.message; }
    }
    $('editorTimingSummary').textContent = plan ? 'Итого: ' + T.clock(plan.durationMs) : 'Расчёт недоступен';
    $('editorTimingMode').value = project.timing || 'reading';
    $('editorTimingBadge').textContent = project.timing === 'manual' ? 'Ручной режим' : '150 слов/мин';
    $('editorSubtitleMode').value = project.subtitles?.mode || 'scene';
    $('editorSubtitlesEnabled').checked = project.subtitles?.enabled !== false;
    $('editorSubtitleMode').disabled = project.subtitles?.enabled === false;
    $('splitScenes').disabled = words === 0;
    for (const id of ['exportSrt', 'exportSrtPanel']) $(id).disabled = !plan?.cues.length;
    for (const id of ['saveProject', 'saveProjectMobile']) $(id).disabled = !!timing.error;
    $('playPreview').disabled = !plan?.durationMs;
    $('scriptChanged').hidden = !project.scenes.length || project.script === project.sourceScript;
    $('sceneFootnote').hidden = !project.scenes.length;
    $('editorSubtitleHint').textContent = !plan ? 'Исправьте ошибку расчёта.' : plan.subtitles.enabled === false ? 'Субтитры отключены: SRT не содержит реплик.' :
      (plan.subtitles.policy === 'editor-scene' ? 'По одной реплике на сцену.' : 'Группы по шесть слов внутри границ сцены.') + ' Таймкоды берутся из общего RenderPlan.';
    showTimingError();
  }

  function emptyState(title, description, showDemo = false) {
    const node = element('div', 'empty-state');
    node.append(icon('scenes'), element('h3', '', title), element('p', '', description));
    if (showDemo) {
      const button = element('button', 'button button-secondary', 'Попробовать пример');
      button.addEventListener('click', loadDemo);
      node.append(button);
    }
    return node;
  }

  function createSceneCard(scene) {
    const card = element('article', 'scene-card'); card.dataset.sceneId = scene.id;
    const select = element('button', 'scene-select'); select.addEventListener('click', () => selectScene(scene.id));
    const content = element('div', 'scene-content'), top = element('div', 'scene-card-top'), label = element('label');
    const meta = element('div', 'scene-meta-row'), clock = element('span', 'scene-timing'), timingText = element('span');
    clock.append(icon('clock'), timingText);
    const remove = element('button', 'scene-delete'); remove.title = 'Удалить сцену'; remove.append(icon('trash'));
    remove.addEventListener('click', () => deleteScene(scene.id)); meta.append(clock, remove); top.append(label, meta);
    const textarea = element('textarea', 'scene-text'); textarea.value = scene.text;
    textarea.placeholder = 'Что произойдёт в этой сцене?'; textarea.rows = 2; textarea.maxLength = 1000000;
    textarea.addEventListener('focus', () => { if (project.selectedSceneId !== scene.id) selectScene(scene.id); });
    textarea.addEventListener('input', () => editScene({ type: 'text', id: scene.id, value: textarea.value }));
    const controls = element('div', 'studio-scene-controls'), durationLabel = element('label', '', 'Длительность, сек');
    const duration = element('input', 'studio-scene-duration'); duration.type = 'text'; duration.inputMode = 'decimal';
    duration.id = 'studio-duration-' + scene.id; duration.autocomplete = 'off'; durationLabel.htmlFor = duration.id;
    duration.setAttribute('aria-describedby', 'editorTimingHelp');
    duration.addEventListener('input', () => editScene({ type: 'duration', id: scene.id, value: duration.value }));
    duration.addEventListener('blur', updateSceneTimings); durationLabel.append(duration);
    const up = element('button', 'studio-move', '↑ Выше'), down = element('button', 'studio-move', '↓ Ниже');
    const move = (direction, button, fallback) => {
      editScene({ type: 'move', id: scene.id, value: direction }, true);
      (button.disabled ? fallback : button).focus({ preventScroll: true });
    };
    up.addEventListener('click', () => move(-1, up, down)); down.addEventListener('click', () => move(1, down, up));
    controls.append(durationLabel, up, down);
    const visuals = element('div', 'studio-visual-controls'), settings = {};
    for (const [key, title, options] of [
      ['visual','Фон',[['animated','Анимированный фон'],['image','Изображение']]],
      ['camera','Камера',[['zoom-in','Приближение'],['zoom-out','Отдаление'],['pan-left','Панорама влево'],['pan-right','Панорама вправо'],['static','Без движения']]],
      ['transition','Переход к сцене',[['none','Без перехода'],['crossfade','Растворение'],['slide','Сдвиг'],['zoom','Мягкий зум']]]
    ]) {
      const titleNode = element('label', '', title), input = element('select', 'studio-scene-' + key);
      for (const [value, text] of options) { const option = element('option', '', text); option.value = value; input.append(option); }
      input.setAttribute('aria-label', title + ' сцены'); input.addEventListener('change', () => { selectScene(scene.id); editScene({ type: key, id: scene.id, value: input.value }); });
      titleNode.append(input); visuals.append(titleNode); settings[key] = input;
    }
    const images = element('div', 'studio-image-controls'), upload = element('button', 'button button-secondary'), imageFile = element('input');
    imageFile.type = 'file'; imageFile.hidden = true; imageFile.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'; imageFile.id = 'studio-image-' + scene.id;
    upload.addEventListener('click', () => imageFile.click());
    imageFile.addEventListener('change', () => {
      const file = imageFile.files[0]; imageFile.value = ''; if (!file || timing.error) return;
      try { C.upgradeProject(project); } catch (error) { imageStates.set(scene.id, { state: 'error', message: error.message }); updateSceneTimings(); return; }
      selectScene(scene.id); imageUploads.load(scene.id, file);
    });
    const removeImage = element('button', 'text-button', 'Удалить изображение');
    removeImage.addEventListener('click', () => { imageUploads.cancel(); imageStates.delete(scene.id); editScene({ type: 'image', id: scene.id, value: null }, true); });
    const imageName = element('span', 'studio-image-name'), imageState = element('span', 'studio-image-state'); imageState.setAttribute('role', 'status');
    images.append(upload, imageFile, removeImage, imageName, imageState);
    content.append(top, textarea, controls, visuals, images); card.append(select, content);
    return { card, select, textarea, timingText, label, remove, duration, up, down, settings, upload, removeImage, imageName, imageState };
  }

  function renderScenes() {
    const ids = new Set(project.scenes.map(scene => scene.id));
    for (const [id, nodes] of sceneNodes) if (!ids.has(id)) { nodes.card.remove(); sceneNodes.delete(id); }
    if (!project.scenes.length) {
      $('sceneList').replaceChildren(emptyState('Здесь начнётся ваша история', 'Разбейте сценарий на сцены или добавьте первую сцену вручную.', !C.countWords(project.script)));
    } else {
      $('sceneList').querySelector('.empty-state')?.remove();
      let cursor = $('sceneList').firstElementChild;
      project.scenes.forEach((scene, index) => {
        let nodes = sceneNodes.get(scene.id);
        if (!nodes) { nodes = createSceneCard(scene); sceneNodes.set(scene.id, nodes); }
        if (nodes.card === cursor) cursor = cursor.nextElementSibling;
        else $('sceneList').insertBefore(nodes.card, cursor);
        const number = String(index + 1).padStart(2, '0');
        if (nodes.select.textContent !== number) nodes.select.textContent = number;
        if (nodes.label.textContent !== 'СЦЕНА ' + number) nodes.label.textContent = 'СЦЕНА ' + number;
        nodes.textarea.id = 'scene-input-' + index; nodes.label.htmlFor = nodes.textarea.id;
        if (nodes.textarea.value !== scene.text) nodes.textarea.value = scene.text;
        nodes.select.setAttribute('aria-label', 'Показать сцену ' + (index + 1));
        nodes.remove.setAttribute('aria-label', 'Удалить сцену ' + (index + 1));
        nodes.up.setAttribute('aria-label', 'Переместить сцену ' + (index + 1) + ' выше');
        nodes.down.setAttribute('aria-label', 'Переместить сцену ' + (index + 1) + ' ниже');
        nodes.duration.setAttribute('aria-label', 'Длительность сцены ' + (index + 1) + ', секунды');
        nodes.up.disabled = index === 0; nodes.down.disabled = index === project.scenes.length - 1;
      });
    }
    updateSceneTimings(); updateSelectedScene();
  }

  function updateSceneTimings(onlyId) {
    for (const scene of typeof onlyId === 'string' ? project.scenes.filter(s => s.id === onlyId) : project.scenes) {
      const node = sceneNodes.get(scene.id), row = timing.byId.get(scene.id); if (!node) continue;
      const text = row ? C.srtTime(row.startMs) + ' → ' + C.srtTime(row.endMs) + ' · ' + T.seconds(row.durationMs) + ' сек' : 'Не рассчитано';
      if (node.timingText.textContent !== text) node.timingText.textContent = text;
      for (const field of ['startMs', 'endMs', 'durationMs']) {
        if (row) { if (node.card.dataset[field] !== String(row[field])) node.card.dataset[field] = String(row[field]); }
        else delete node.card.dataset[field];
      }
      for (const key of ['visual','camera','transition']) {
        const input = node.settings[key], value = scene[key] || ({ visual: 'animated', camera: 'zoom-in', transition: 'crossfade' })[key];
        if (input.value !== value) input.value = value;
        const disabled = !!timing.error || (key === 'camera' && scene.visual !== 'image'); if (input.disabled !== disabled) input.disabled = disabled;
        if (key === 'visual') input.querySelector('[value=image]').disabled = !scene.imageId;
      }
      const uploadLabel = scene.imageId ? 'Заменить изображение' : 'Добавить изображение'; if (node.upload.textContent !== uploadLabel) node.upload.textContent = uploadLabel; if (node.upload.disabled !== !!timing.error) node.upload.disabled = !!timing.error;
      node.removeImage.hidden = !scene.imageId; node.removeImage.disabled = !!timing.error;
      const name = scene.imageName || (scene.imageId ? 'Исходное изображение' : ''); if (node.imageName.textContent !== name) node.imageName.textContent = name;
      const imageStatus = imageStates.get(scene.id); node.imageState.dataset.state = imageStatus?.state || '';
      if (node.imageState.textContent !== (imageStatus?.message || '')) node.imageState.textContent = imageStatus?.message || '';
      node.duration.disabled = project.timing !== 'manual';
      node.duration.setAttribute('aria-invalid', String(durationErrors.has(scene.id)));
      node.duration.title = durationErrors.get(scene.id)?.message || 'Пусто — длительность из RenderPlan по тексту; сохранённое значение действует в ручном режиме.';
      node.duration.placeholder = row ? 'Авто: ' + T.seconds(row.durationMs) : 'Авто';
      if (document.activeElement !== node.duration && !durationErrors.has(scene.id)) node.duration.value = T.seconds(scene.durationMs);
    }
  }

  function renderSubtitles() {
    if (view !== 'subtitles') { subtitlesDirty = true; return; }
    const cues = timing.plan?.cues || [], fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const card = element('div', 'subtitle-cue'); card.dataset.startMs = String(cue.startMs); card.dataset.endMs = String(cue.endMs);
      card.append(element('span', 'cue-number', String(index + 1).padStart(2, '0')),
        element('span', 'cue-time', C.srtTime(cue.startMs) + ' → ' + C.srtTime(cue.endMs)), element('p', 'cue-text', C.wrapSubtitle(cue.text)));
      fragment.append(card);
    });
    if (!cues.length) fragment.append(emptyState(timing.error ? 'Расчёт недоступен' : project.subtitles?.enabled === false ? 'Субтитры отключены' : 'Слова появятся здесь', timing.error?.message || 'Субтитры используют только сцены с положительной длительностью.'));
    $('subtitleList').replaceChildren(fragment); subtitlesDirty = false;
  }

  function sceneStart(id) { return timing.byId.get(id)?.startMs || 0; }

  function updateSelectedScene() {
    const set = (id, selected) => { const node = sceneNodes.get(id); if (node) { node.card.classList.toggle('selected', selected); node.select.setAttribute('aria-pressed', String(selected)); } };
    if (lastSelectedSceneId !== project.selectedSceneId) set(lastSelectedSceneId, false);
    set(project.selectedSceneId, true); lastSelectedSceneId = project.selectedSceneId;
  }

  function updatePlaybackUI() {
    $('playPreview').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('playPreview').setAttribute('aria-label', playing ? 'Приостановить предпросмотр' : 'Воспроизвести предпросмотр');
    $('currentTime').textContent = timing.plan ? T.clock(Math.floor(elapsedMs)) : '—';
    const total = timing.plan?.durationMs || 0;
    $('editorSeek').max = String(total); $('editorSeek').disabled = !total; if (document.activeElement !== $('editorSeek')) $('editorSeek').value = String(Math.floor(elapsedMs));
    $('timelineProgress').style.width = (total ? Math.min(100, elapsedMs / total * 100) : 0) + '%';
  }

  function renderPreview() {
    const index = timing.byId.get(project.selectedSceneId)?.index ?? -1;
    const scene = project.scenes[index];
    $('portrait').className = `editor-canvas-frame theme-${project.style.theme} caption-${project.style.caption} size-${project.style.size}`;
    $('portraitScene').textContent = scene ? String(index + 1).padStart(2, '0') + ' / ' + String(project.scenes.length).padStart(2, '0') : '00 / 00';
    const row = timing.byId.get(scene?.id)?.scene;
    const cue = row ? P.frameAt(timing.plan, Math.max(row.startMs, Math.min(row.endMs - 1, elapsedMs))).cue : null;
    const preview = $('previewText'); preview.hidden = project.subtitles?.enabled === false || !!timing.error;
    if (preview.textContent !== (cue?.text || '')) preview.textContent = cue?.text || ''; // Accessible transcript, never a second visual renderer.
    $('prevScene').disabled = index <= 0; $('nextScene').disabled = index < 0 || index >= project.scenes.length - 1;
    updatePlaybackUI();
    if (!editorVisible || document.hidden) return Promise.resolve(false);
    if (timing.error || !row) {
      livePreview.suspend(); previewState({ state: 'empty', error: timing.error || { code: 'EMPTY', message: scene ? 'У выбранной сцены нулевая длительность. Добавьте текст или задайте ручное время.' : 'Добавьте сцены, чтобы увидеть Canvas-предпросмотр.' } });
      return Promise.resolve(false);
    }
    return livePreview.draw({ project, plan: timing.plan, time: Math.max(row.startMs, Math.min(row.endMs - 1, elapsedMs)), revision: previewRevision });
  }

  function selectScene(id) {
    if (!project.scenes.some(scene => scene.id === id)) return;
    pausePlayback();
    if (project.selectedSceneId !== id) imageUploads.cancel();
    project = { ...project, selectedSceneId: id };
    elapsedMs = sceneStart(id);
    updateSelectedScene();
    renderPreview();
    changed();
  }

  function pausePlayback() {
    playEpoch++;
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(animationFrame);
    updatePlaybackUI();
    changed();
  }

  function play() {
    if (playing) { pausePlayback(); return; }
    const plan = timing.plan; if (!plan?.timeline.length || !editorVisible) return;
    const total = plan.durationMs;
    if (elapsedMs >= total) elapsedMs = 0;
    playing = true; const epoch = ++playEpoch; playbackAnchor = performance.now() - elapsedMs;
    updatePlaybackUI();
    async function frame(now) {
      if (!playing || epoch !== playEpoch) return;
      elapsedMs = Math.min(total, Math.max(0, Math.floor(now - playbackAnchor)));
      const value = P.frameAt(plan, elapsedMs);
      project = { ...project, selectedSceneId: value.scene.id }; updateSelectedScene();
      const prepared = livePreview.status().active;
      const reusable = prepared?.state === 'ready' && prepared.previewSceneId === value.scene.id && prepared.identity.contentRevision === previewRevision;
      const before = performance.now(), ready = await renderPreview();
      if (!playing || epoch !== playEpoch) return;
      // Resource preparation pauses the preview clock instead of skipping scenes.
      if (!reusable) playbackAnchor += performance.now() - before;
      if (!ready) { pausePlayback(); return; }
      updatePlaybackUI();
      if (elapsedMs >= total) { pausePlayback(); return; }
      animationFrame = requestAnimationFrame(frame);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function renderAppearance() {
    document.querySelectorAll('[data-caption]').forEach(button => {
      const active = button.dataset.caption === project.style.caption;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-theme]').forEach(button => {
      const active = button.dataset.theme === project.style.theme;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('captionSize').value = project.style.size;
  }

  function renderAll() {
    recalculate(); elapsedMs = sceneStart(project.selectedSceneId);
    $('projectName').value = project.name;
    $('sidebarProjectName').textContent = project.name || 'Без названия';
    $('scriptText').value = project.script;
    document.title = (project.name || 'Без названия') + ' — Shorts Studio';
    renderStats();
    renderScenes();
    renderSubtitles();
    renderAppearance();
    renderPreview();
    setView(view);
  }

  function replaceProject(nextProject) {
    pausePlayback();
    try { T.compile(nextProject); } catch (error) { toast('Проект не заменён: ' + error.message); return false; }
    imageUploads.cancel(); imageStates.clear(); livePreview.suspend();
    project = nextProject; durationErrors.clear(); commandError = null; lastGoodProject = null;
    view = 'script';
    renderAll();
    changed();
    saveNow();
    return true;
  }

  function hasWork() {
    return project.version === C.STUDIO_VERSION || Boolean(project.script.trim() || project.scenes.some(scene => scene.text.trim()));
  }

  function loadDemo() {
    const action = () => { replaceProject(C.createProject(true)); toast('Пример загружен. Попробуйте изменить любую сцену.'); };
    if (hasWork()) confirmAction('Загрузить демонстрационный проект?', 'Текущий проект будет заменён. При необходимости сначала скачайте его через меню «Проект».', 'Загрузить пример', action);
    else action();
  }

  function splitScenes() {
    const sentences = C.splitSentences(project.script);
    if (!sentences.length) return;
    if (sentences.length > 5000) { toast('В проекте может быть не больше 5 000 сцен. Сократите сценарий.'); return; }
    const same = sentences.length === project.scenes.length && sentences.every((text, index) => text === project.scenes[index].text);
    if (same) { setView('scenes'); toast('Сцены уже соответствуют сценарию. Можно приступать к правкам.'); return; }
    const action = () => {
      pausePlayback();
      imageUploads.cancel(); imageStates.clear();
      const scenes = C.createScenes(project.script);
      project = C.parseProject({ ...project, scenes, sourceScript: project.script, selectedSceneId: scenes[0]?.id || null });
      durationErrors.clear(); commandError = null;
      elapsedMs = 0;
      renderAll();
      changed();
      toast('Готово: ' + project.scenes.length + ' ' + C.plural(project.scenes.length, ['сцена', 'сцены', 'сцен']) + '.');
    };
    if (project.scenes.length) confirmAction('Разбить сценарий заново?', 'Текущие сцены и их правки будут заменены предложениями из сценария. Исходный сценарий сохранится.', 'Заменить сцены', action);
    else action();
  }

  function addScene() {
    if (project.scenes.length >= 5000) { toast('В проекте уже 5 000 сцен.'); return; }
    editScene({ type: 'add' }, true);
    sceneNodes.get(project.selectedSceneId)?.textarea.focus();
  }

  function deleteScene(id) {
    const index = project.scenes.findIndex(scene => scene.id === id); if (index < 0) return;
    const scene = project.scenes[index];
    const action = () => {
      editScene({ type: 'remove', id }, true);
      const focus = project.scenes[Math.min(index, project.scenes.length - 1)];
      if (focus) sceneNodes.get(focus.id)?.select.focus(); else $('addScene').focus();
      toast('Сцена удалена.');
    };
    if (scene.text.trim() || scene.imageId || scene.durationMs != null || durationErrors.has(id)) confirmAction('Удалить сцену ' + (index + 1) + '?', 'Сцена и её параметры будут удалены из раскадровки и субтитров. Исходный сценарий останется.', 'Удалить сцену', action);
    else action();
  }

  function download(content, type, name) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = element('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportSrt() {
    if (timing.error) { showTimingError(); return; }
    const srt = P.generateSrt(timing.plan);
    if (!srt) { toast('Добавьте текст хотя бы в одну сцену.'); return; }
    download(srt, 'application/x-subrip;charset=utf-8', C.fileName(project.name) + '.srt');
    toast('Субтитры скачаны. Их можно импортировать в видеоредактор.');
  }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelector('.editor-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const views = ['script', 'scenes', 'subtitles'];
    const index = views.indexOf(view);
    setView(event.key === 'Home' ? views[0] : event.key === 'End' ? views[2] : views[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3], true);
  });
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); setView('script'); });
  $('scriptText').maxLength = 1000000;
  $('scriptText').addEventListener('input', event => {
    project = { ...project, script: event.target.value }; previewRevision++;
    renderStats();
    changed();
  });
  $('projectName').addEventListener('input', event => {
    project = { ...project, name: event.target.value }; recalculate();
    $('sidebarProjectName').textContent = project.name || 'Без названия';
    document.title = (project.name || 'Без названия') + ' — Shorts Studio';
    changed();
  });
  $('splitScenes').addEventListener('click', splitScenes);
  $('addScene').addEventListener('click', addScene);
  $('loadDemo').addEventListener('click', loadDemo);
  $('newProject').addEventListener('click', () => {
    const action = () => { replaceProject(C.createProject()); $('projectName').focus(); $('projectName').select(); toast('Новый проект создан. Начните со своей идеи.'); };
    if (hasWork()) confirmAction('Начать новую историю?', 'Текущий проект будет заменён. Скачайте его, если захотите вернуться к нему позже.', 'Создать проект', action);
    else action();
  });
  $('editorTimingMode').addEventListener('change', event => editScene({ type: 'timing', value: event.target.value }));
  $('editorSubtitleMode').addEventListener('change', event => editScene({ type: 'subtitle-mode', value: event.target.value }));
  $('editorSubtitlesEnabled').addEventListener('change', event => editScene({ type: 'subtitle-enabled', value: event.target.checked }));
  $('editorResetTiming').addEventListener('click', () => {
    if (!lastGoodProject) return;
    pausePlayback(); project = lastGoodProject; durationErrors.clear(); commandError = null;
    renderAll(); changed();
  });
  $('exportSrt').addEventListener('click', exportSrt);
  $('exportSrtPanel').addEventListener('click', exportSrt);
  $('prevScene').addEventListener('click', () => {
    const index = project.scenes.findIndex(scene => scene.id === project.selectedSceneId);
    if (index > 0) selectScene(project.scenes[index - 1].id);
  });
  $('nextScene').addEventListener('click', () => {
    const index = project.scenes.findIndex(scene => scene.id === project.selectedSceneId);
    if (index < project.scenes.length - 1) selectScene(project.scenes[index + 1].id);
  });
  $('playPreview').addEventListener('click', play);
  $('editorSeek').addEventListener('input', event => {
    if (!timing.plan?.durationMs) return; pausePlayback(); imageUploads.cancel();
    elapsedMs = Math.min(timing.plan.durationMs, Number(event.target.value));
    project = { ...project, selectedSceneId: P.frameAt(timing.plan, elapsedMs).scene.id }; updateSelectedScene(); renderPreview(); changed();
  });
  const modeObserver = new MutationObserver(() => {
    const visible = document.querySelector('.workspace').dataset.mode !== 'video'; if (visible === editorVisible) return;
    editorVisible = visible;
    if (!visible) { pausePlayback(); imageUploads.cancel(); livePreview.suspend(); } else renderPreview();
  });
  modeObserver.observe(document.querySelector('.workspace'), { attributes: true, attributeFilter: ['data-mode'] });
  window.addEventListener('pagehide', () => { imageUploads.cancel(); livePreview.suspend(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { imageUploads.cancel(); livePreview.suspend(); } else if (editorVisible) renderPreview(); });
  document.querySelectorAll('[data-caption]').forEach(button => button.addEventListener('click', () => {
    project = { ...project, style: { ...project.style, caption: button.dataset.caption } }; recalculate();
    renderAppearance(); renderPreview(); changed();
  }));
  document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
    project = { ...project, style: { ...project.style, theme: button.dataset.theme } }; recalculate();
    renderAppearance(); renderPreview(); changed();
  }));
  $('captionSize').addEventListener('change', event => {
    project = { ...project, style: { ...project.style, size: event.target.value } }; recalculate();
    renderPreview(); changed();
  });
  $('saveProject').addEventListener('click', () => {
    download(JSON.stringify(project, null, 2), 'application/json;charset=utf-8', C.fileName(project.name) + '.shorts.json');
    toast('Проект скачан. Откройте его в Shorts Studio, чтобы продолжить работу.');
  });
  $('openProject').addEventListener('click', () => $('projectFile').click());
  $('saveProjectMobile').addEventListener('click', () => $('saveProject').click());
  $('openProjectMobile').addEventListener('click', () => $('openProject').click());
  $('projectFile').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Файл слишком большой. Максимальный размер проекта — 5 МБ.'); return; }
    try {
      const nextProject = C.parseProject(await file.text());
      const action = () => { if (replaceProject(nextProject)) toast('Проект «' + (project.name || 'Без названия') + '» открыт.'); };
      if (hasWork()) confirmAction('Открыть другой проект?', 'Текущий проект будет заменён содержимым файла. При необходимости сначала скачайте его.', 'Открыть проект', action);
      else action();
    } catch (error) {
      toast('Не удалось открыть файл: ' + error.message);
    }
  });
  // Flush the debounce when leaving; visibilitychange also works on mobile browsers.
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pausePlayback(); saveNow(); }
  });
  window.addEventListener('shorts:storage-conflict', event => {
    if (event.detail.slot !== 'editor') return;
    saveEpoch++; updateSaveStatus('Ошибка сохранения', true);
    $('storageWarning').hidden = false;
    $('storageWarning').textContent = 'Проект изменён в другой вкладке. Скачайте текущий текстовый проект перед перезагрузкой.';
  });
  window.addEventListener('storage', event => {
    if (event.key === 'shorts-studio.project.v1') {
      toast('Проект изменён в другой вкладке. Скачайте текущую копию перед перезагрузкой, чтобы сохранить правки.');
    }
  });
  // Additive bridge: the video mode can ask to open a script without touching the active project silently.
  window.ShortsEditor = Object.freeze({
    pause: pausePlayback,
    backupSnapshot() { pausePlayback(); if (timing.error) throw new Error('Сначала исправьте или отмените несохранённую правку Студии: ' + timing.error.message); return structuredClone(project); },
    confirm: confirmAction,
    useScript({ title, scenes }) {
      if (!Array.isArray(scenes) || !scenes.length || scenes.length > 12 || scenes.some(scene => typeof scene.text !== 'string')) throw new Error('Нет сцен для переноса.');
      const next = C.createProject();
      next.name = String(title || 'Сценарий ролика').slice(0, 80);
      next.scenes = scenes.map(scene => ({ id: C.id(), text: scene.text }));
      next.script = next.scenes.map(scene => scene.text).join('\n');
      next.sourceScript = next.script;
      next.selectedSceneId = next.scenes[0].id;
      const action = () => { replaceProject(next); document.dispatchEvent(new Event('shorts:editor-opened')); };
      if (hasWork()) confirmAction('Открыть сценарий ролика в редакторе?', 'Текущий проект редактора будет заменён. При необходимости сначала скачайте его. В редакторе длительность оценивается по словам; настройки видео останутся в отдельном режиме.', 'Открыть сценарий', action);
      else action();
    }
  });
  renderAll();
  if (timing.error) showTimingError();
  else if (loaded.error) {
    $('storageWarning').hidden = false;
    $('storageWarning').textContent = loaded.error;
    updateSaveStatus(loaded.writable ? 'Проверьте сохранение проекта' : 'Ошибка сохранения', true);
    toast(loaded.error);
  } else if (!loaded.project) await saveNow();
  else updateSaveStatus('Сохранено на устройстве');
})();
