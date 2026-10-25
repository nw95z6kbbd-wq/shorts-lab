(function () {
  'use strict';
  const C = window.ShortsCore;
  const $ = id => document.getElementById(id);
  const loaded = window.ShortsStorage.load();
  let project = loaded.project || C.createProject(true);
  let view = 'script';
  let saveTimer;
  let toastTimer;
  let playing = false;
  let animationFrame = 0;
  let elapsedMs = 0;
  let playbackAnchor = 0;
  let pendingConfirmation = null;
  const sceneNodes = new Map();

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
    $('saveStatus').querySelector('span').textContent = text;
    $('saveStatus').querySelector('use').setAttribute('href', error ? '#i-info' : '#i-check');
  }

  function saveNow() {
    clearTimeout(saveTimer);
    const result = window.ShortsStorage.save(project);
    updateSaveStatus(result.ok ? 'Сохранено на устройстве' : 'Не сохранено · скачайте проект', !result.ok);
    $('storageWarning').hidden = result.ok;
    return result.ok;
  }

  function changed() {
    project.updatedAt = new Date().toISOString();
    updateSaveStatus('Сохранение…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
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
    if (focusTab) $('tab-' + view).focus();
  }

  function renderStats() {
    const words = C.countWords(project.script);
    const duration = C.totalDuration(project.scenes);
    $('wordCount').textContent = words;
    $('scriptWordCount').textContent = C.wordLabel(words);
    $('scriptDuration').textContent = '≈ ' + Math.ceil(C.durationMs(project.script) / 1000) + ' сек';
    for (const id of ['sceneCount', 'navSceneCount', 'tabSceneCount', 'sceneHeadingCount']) $(id).textContent = project.scenes.length;
    $('totalDuration').textContent = C.clockTime(duration);
    $('previewDuration').textContent = C.clockTime(duration);
    $('splitScenes').disabled = words === 0;
    $('exportSrt').disabled = duration === 0;
    $('exportSrtPanel').disabled = duration === 0;
    $('playPreview').disabled = duration === 0;
    $('scriptChanged').hidden = !project.scenes.length || project.script === project.sourceScript;
    $('sceneFootnote').hidden = !project.scenes.length;
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

  function renderScenes() {
    sceneNodes.clear();
    const fragment = document.createDocumentFragment();
    project.scenes.forEach((scene, index) => {
      const card = element('article', 'scene-card');
      card.dataset.sceneId = scene.id;
      const select = element('button', 'scene-select', String(index + 1).padStart(2, '0'));
      select.setAttribute('aria-label', `Показать сцену ${index + 1}`);
      select.addEventListener('click', () => selectScene(scene.id));
      const content = element('div', 'scene-content');
      const top = element('div', 'scene-card-top');
      const label = element('label', '', 'СЦЕНА ' + String(index + 1).padStart(2, '0'));
      label.htmlFor = 'scene-input-' + index;
      const meta = element('div', 'scene-meta-row');
      const timing = element('span', 'scene-timing');
      const timingText = element('span');
      timing.append(icon('clock'), timingText);
      const remove = element('button', 'scene-delete');
      remove.setAttribute('aria-label', `Удалить сцену ${index + 1}`);
      remove.title = 'Удалить сцену';
      remove.append(icon('trash'));
      remove.addEventListener('click', () => deleteScene(scene.id));
      meta.append(timing, remove);
      top.append(label, meta);
      const textarea = element('textarea', 'scene-text');
      textarea.id = 'scene-input-' + index;
      textarea.value = scene.text;
      textarea.placeholder = 'Что произойдёт в этой сцене?';
      textarea.rows = 2;
      textarea.maxLength = 1000000;
      textarea.addEventListener('focus', () => { if (project.selectedSceneId !== scene.id) selectScene(scene.id); });
      textarea.addEventListener('input', () => {
        pausePlayback();
        scene.text = textarea.value;
        elapsedMs = sceneStart(scene.id);
        changed();
        renderStats();
        updateSceneTimings();
        renderSubtitles();
        renderPreview();
      });
      content.append(top, textarea);
      card.append(select, content);
      fragment.append(card);
      sceneNodes.set(scene.id, { card, select, textarea, timingText });
    });
    if (!project.scenes.length) fragment.append(emptyState('Здесь начнётся ваша история', 'Разбейте сценарий на сцены или добавьте первую сцену вручную.', !C.countWords(project.script)));
    $('sceneList').replaceChildren(fragment);
    updateSceneTimings();
    updateSelectedScene();
  }

  function updateSceneTimings() {
    let start = 0;
    for (const scene of project.scenes) {
      const duration = C.durationMs(scene.text);
      const seconds = (duration / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
      const node = sceneNodes.get(scene.id);
      if (node) node.timingText.textContent = C.clockTime(Math.floor(start / 1000) * 1000) + ' · ' + seconds + ' сек';
      start += duration;
    }
  }

  function renderSubtitles() {
    const cues = C.timeline(project.scenes);
    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const card = element('div', 'subtitle-cue');
      card.append(element('span', 'cue-number', String(index + 1).padStart(2, '0')),
        element('span', 'cue-time', C.srtTime(cue.startMs) + ' → ' + C.srtTime(cue.endMs)),
        element('p', 'cue-text', C.wrapSubtitle(cue.text)));
      fragment.append(card);
    });
    if (!cues.length) fragment.append(emptyState('Слова появятся здесь', 'Добавьте текст в сцены — мы автоматически подготовим субтитры с таймкодами.'));
    $('subtitleList').replaceChildren(fragment);
  }

  function sceneStart(id) {
    let total = 0;
    for (const scene of project.scenes) {
      if (scene.id === id) return total;
      total += C.durationMs(scene.text);
    }
    return 0;
  }

  function updateSelectedScene() {
    for (const [id, nodes] of sceneNodes) {
      const selected = id === project.selectedSceneId;
      nodes.card.classList.toggle('selected', selected);
      nodes.select.setAttribute('aria-pressed', String(selected));
    }
  }

  function updatePlaybackUI() {
    $('playPreview').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('playPreview').setAttribute('aria-label', playing ? 'Приостановить предпросмотр' : 'Воспроизвести предпросмотр');
    $('currentTime').textContent = C.clockTime(Math.floor(elapsedMs / 1000) * 1000);
    const total = C.totalDuration(project.scenes);
    $('timelineProgress').style.width = (total ? Math.min(100, elapsedMs / total * 100) : 0) + '%';
  }

  function renderPreview() {
    const index = project.scenes.findIndex(scene => scene.id === project.selectedSceneId);
    const scene = project.scenes[index];
    $('portrait').className = `portrait theme-${project.style.theme} caption-${project.style.caption} size-${project.style.size}`;
    $('portraitScene').textContent = scene ? String(index + 1).padStart(2, '0') + ' / ' + String(project.scenes.length).padStart(2, '0') : '00 / 00';
    const text = scene?.text.trim() || (scene ? 'Ваша сцена начинается здесь' : 'У каждой истории есть начало. Какое будет у вашей?');
    const words = text.split(/\s+/u);
    const preview = $('previewText');
    preview.replaceChildren();
    preview.classList.toggle('long-caption', words.length > 28 && words.length <= 60);
    preview.classList.toggle('very-long-caption', words.length > 60);
    if (words.length > 2) {
      preview.append(document.createTextNode(words.slice(0, -2).join(' ') + ' '), element('mark', '', words.slice(-2).join(' ')));
    } else preview.textContent = text;
    preview.scrollTop = 0;
    const segments = document.createDocumentFragment();
    // Keep the indicator legible even for very large projects.
    const first = Math.max(0, index - 11);
    const last = Math.min(project.scenes.length, first + 24);
    for (let i = first; i < last; i++) segments.append(element('span', i < index ? 'passed' : i === index ? 'current' : ''));
    $('portraitSegments').replaceChildren(segments);
    $('prevScene').disabled = index <= 0;
    $('nextScene').disabled = index < 0 || index >= project.scenes.length - 1;
    updatePlaybackUI();
  }

  function selectScene(id) {
    if (!project.scenes.some(scene => scene.id === id)) return;
    pausePlayback();
    project.selectedSceneId = id;
    elapsedMs = sceneStart(id);
    updateSelectedScene();
    renderPreview();
    changed();
  }

  function pausePlayback() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(animationFrame);
    updatePlaybackUI();
    changed();
  }

  function play() {
    if (playing) { pausePlayback(); return; }
    const cues = C.timeline(project.scenes);
    if (!cues.length) return;
    const total = C.totalDuration(project.scenes);
    const selectedCue = cues.find(cue => cue.id === project.selectedSceneId);
    if (elapsedMs >= total) elapsedMs = 0;
    else if (!selectedCue) elapsedMs = (cues.find(cue => cue.index >= project.scenes.findIndex(scene => scene.id === project.selectedSceneId)) || cues[0]).startMs;
    playing = true;
    playbackAnchor = performance.now() - elapsedMs;
    updatePlaybackUI();
    function frame(now) {
      if (!playing) return;
      elapsedMs = Math.min(total, now - playbackAnchor);
      const cue = cues.find(cue => elapsedMs >= cue.startMs && elapsedMs < cue.endMs) || cues[cues.length - 1];
      if (cue.id !== project.selectedSceneId) {
        project.selectedSceneId = cue.id;
        updateSelectedScene();
        renderPreview();
      }
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
    project = nextProject;
    elapsedMs = sceneStart(project.selectedSceneId);
    view = 'script';
    renderAll();
    changed();
    saveNow();
  }

  function hasWork() {
    return Boolean(project.script.trim() || project.scenes.some(scene => scene.text.trim()));
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
      project.scenes = C.createScenes(project.script);
      project.sourceScript = project.script;
      project.selectedSceneId = project.scenes[0]?.id || null;
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
    pausePlayback();
    const scene = { id: C.id(), text: '' };
    project.scenes.push(scene);
    project.selectedSceneId = scene.id;
    elapsedMs = sceneStart(scene.id);
    renderStats();
    renderScenes();
    renderSubtitles();
    renderPreview();
    changed();
    sceneNodes.get(scene.id).textarea.focus();
  }

  function deleteScene(id) {
    const index = project.scenes.findIndex(scene => scene.id === id);
    if (index === -1) return;
    const scene = project.scenes[index];
    const action = () => {
      pausePlayback();
      project.scenes.splice(index, 1);
      if (project.selectedSceneId === id) project.selectedSceneId = project.scenes[Math.min(index, project.scenes.length - 1)]?.id || null;
      elapsedMs = sceneStart(project.selectedSceneId);
      renderStats();
      renderScenes();
      renderSubtitles();
      renderPreview();
      changed();
      const focus = project.scenes[Math.min(index, project.scenes.length - 1)];
      if (focus) sceneNodes.get(focus.id)?.select.focus();
      else $('addScene').focus();
      toast('Сцена удалена.');
    };
    if (scene.text.trim()) confirmAction('Удалить сцену ' + (index + 1) + '?', 'Текст этой сцены будет удалён из раскадровки и субтитров. Исходный сценарий останется.', 'Удалить сцену', action);
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
    const srt = C.generateSrt(project.scenes);
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
    project.script = event.target.value;
    renderStats();
    changed();
  });
  $('projectName').addEventListener('input', event => {
    project.name = event.target.value;
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
  document.querySelectorAll('[data-caption]').forEach(button => button.addEventListener('click', () => {
    project.style.caption = button.dataset.caption;
    renderAppearance(); renderPreview(); changed();
  }));
  document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
    project.style.theme = button.dataset.theme;
    renderAppearance(); renderPreview(); changed();
  }));
  $('captionSize').addEventListener('change', event => {
    project.style.size = event.target.value;
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
      const action = () => { replaceProject(nextProject); toast('Проект «' + (project.name || 'Без названия') + '» открыт.'); };
      if (hasWork()) confirmAction('Открыть другой проект?', 'Текущий проект будет заменён содержимым файла. При необходимости сначала скачайте его.', 'Открыть проект', action);
      else action();
    } catch (error) {
      toast('Не удалось открыть файл. Выберите корректный файл .shorts.json.');
    }
  });
  // Flush the debounce when leaving; visibilitychange also works on mobile browsers.
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pausePlayback(); saveNow(); }
  });
  window.addEventListener('storage', event => {
    if (event.key === 'shorts-studio.project.v1') {
      toast('Проект изменён в другой вкладке. Скачайте текущую копию перед перезагрузкой, чтобы сохранить правки.');
    }
  });
  elapsedMs = sceneStart(project.selectedSceneId);
  renderAll();
  if (loaded.error) {
    $('storageWarning').hidden = false;
    updateSaveStatus('Проверьте сохранение проекта', true);
    toast(loaded.error);
  } else if (!loaded.project) saveNow();
})();
