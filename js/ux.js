(function () {
  'use strict';
  // Presentation only: existing controller messages follow actual transaction
  // completion. The timers below dismiss a notification; they never save data.
  const workspace = document.querySelector('.workspace');
  const viewport = document.getElementById('studioViewport');
  const dock = document.getElementById('noticeDock');
  const indicator = document.getElementById('saveStatus');
  const label = document.getElementById('saveStatusText');
  const sources = [document.getElementById('editorSaveState'), document.getElementById('videoDraftStatus')];
  const columns = [...document.querySelectorAll('.preview-column,.video-preview-column')];
  const panel = document.querySelector('.video-preview-panel');
  const download = document.getElementById('downloadVideo');
  const states = new Map();
  let dismissTimer, hideTimer;
  const classify = text => text.startsWith('Сохранено') ? 'saved' : text.startsWith('Ошибка') ? 'error' : text.startsWith('Проверьте') ? 'warning' : 'pending';
  function fitPreview() {
    for (const column of columns) {
      if (!column.offsetHeight) continue;
      const media = column.querySelector('.portrait-wrap,.video-canvas-wrap');
      const chrome = column.getBoundingClientRect().height - media.getBoundingClientRect().height;
      const available = viewport.clientHeight - 32;
      // Scale only the displayed portrait, never the Canvas backing resolution.
      const mediaHeight = Math.max(160, Math.floor(available - chrome));
      column.style.setProperty('--preview-media-height', mediaHeight + 'px');
      column.classList.toggle('preview-sticky', innerWidth > 760 && chrome + 160 <= available);
    }
  }
  function fitNotices() {
    // A dedicated bottom gutter prevents notices from covering ANY workspace
    // control, including mobile Download. It collapses when the notices leave.
    const visible = [...dock.children].some(child => !child.hidden);
    const keyboard = window.visualViewport && visualViewport.scale === 1 ? Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) : 0;
    dock.style.bottom = 'calc(' + keyboard + 'px + 12px + env(safe-area-inset-bottom, 0px))';
    const bottom = parseFloat(getComputedStyle(dock).bottom) || 12;
    document.documentElement.style.setProperty('--notice-space', (visible ? Math.ceil(dock.getBoundingClientRect().height + bottom + 12) : keyboard) + 'px');
    fitPreview();
  }
  function showSaveState() {
    clearTimeout(dismissTimer); clearTimeout(hideTimer);
    const source = workspace.dataset.mode === 'video' ? sources[1] : sources[0];
    const current = states.get(source);
    if (!current) return;
    const { text, state, until } = current;
    const owner = source === sources[1] ? 'Видеопроект. ' : 'Текстовый проект. ';
    indicator.dataset.state = state;
    indicator.dataset.mode = source === sources[1] ? 'video' : 'editor';
    indicator.setAttribute('aria-live', state === 'error' || state === 'warning' ? 'assertive' : 'polite');
    const detail = state === 'error' ? document.getElementById(source === sources[1] ? 'videoError' : 'storageWarning').textContent.trim() : text;
    indicator.title = owner + (detail || text);
    indicator.setAttribute('aria-label', owner + text);
    indicator.querySelector('use').setAttribute('href', state === 'saved' ? '#i-check' : state === 'pending' ? '#i-clock' : '#i-info');
    const visible = state !== 'saved' || until > Date.now();
    indicator.hidden = !visible;
    indicator.dataset.visible = String(visible);
    const nextLabel = { saved: 'Сохранено на устройстве', error: 'Ошибка сохранения', warning: 'Проверьте сохранение', pending: text.startsWith('Восстановление') ? 'Восстановление…' : 'Сохранение…' }[state];
    if (label.textContent !== nextLabel) label.textContent = nextLabel;
    if (visible && state === 'saved') dismissTimer = setTimeout(() => {
      indicator.dataset.visible = 'false';
      hideTimer = setTimeout(() => { indicator.hidden = true; fitNotices(); }, 220);
    }, Math.max(0, until - Date.now()));
    fitNotices();
  }
  function readSource(source) {
    const text = source.textContent.trim(), state = classify(text), previous = states.get(source);
    if (!previous || previous.text !== text) states.set(source, { text, state, until: state === 'saved' ? Date.now() + 2500 : 0 });
  }
  function showResult() {
    panel.classList.toggle('has-video-result', !download.hidden);
    fitPreview();
  }
  for (const source of sources) {
    readSource(source);
    new MutationObserver(() => { readSource(source); showSaveState(); }).observe(source, { childList: true, subtree: true, characterData: true });
  }
  new MutationObserver(() => { showSaveState(); fitPreview(); }).observe(workspace, { attributes: true, attributeFilter: ['data-mode'] });
  new MutationObserver(showResult).observe(download, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(fitNotices).observe(document.getElementById('toast'), { attributes: true, childList: true, attributeFilter: ['hidden'] });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(fitNotices);
    observer.observe(dock); observer.observe(viewport);
    for (const column of columns) observer.observe(column);
  }
  window.addEventListener('resize', fitNotices);
  window.visualViewport?.addEventListener('resize', fitNotices);
  window.visualViewport?.addEventListener('scroll', fitNotices);
  showSaveState(); showResult();
})();
