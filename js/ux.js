(function () {
  'use strict';
  // Presentation only: consume the existing controller messages after their
  // transaction-completion checks. No storage, timers or recorder callbacks.
  const workspace = document.querySelector('.workspace');
  const indicator = document.getElementById('saveStatus');
  const editor = document.getElementById('editorSaveState');
  const video = document.getElementById('videoDraftStatus');
  const header = document.querySelector('.topbar');
  const preview = document.querySelector('.video-preview-column');
  const panel = document.querySelector('.video-preview-panel');
  const download = document.getElementById('downloadVideo');
  function showSaveState() {
    const classify = source => {
      const text = source.textContent.trim();
      return text.startsWith('Сохранено') ? 'saved' : text.startsWith('Ошибка') ? 'error' : text.startsWith('Проверьте') ? 'warning' : 'pending';
    };
    const priority = { saved: 0, pending: 1, warning: 2, error: 3 };
    let source = workspace.dataset.mode === 'video' ? video : editor;
    for (const candidate of [editor, video]) if (priority[classify(candidate)] > priority[classify(source)]) source = candidate;
    const text = source.textContent.trim(), state = classify(source);
    const label = { saved: 'Сохранено', error: 'Ошибка сохранения', warning: 'Проверьте сохранение', pending: text.startsWith('Восстановление') ? 'Восстановление…' : 'Сохранение…' }[state];
    indicator.dataset.state = state;
    indicator.classList.toggle('error', state === 'error');
    document.getElementById('saveStatusText').textContent = label;
    indicator.querySelector('use').setAttribute('href', state === 'saved' ? '#i-check' : state === 'pending' ? '#i-clock' : '#i-info');
    const detail = state === 'error' ? document.getElementById(source === video ? 'videoError' : 'storageWarning').textContent.trim() : text;
    indicator.title = (source === video ? 'Видеопроект. ' : 'Текстовый проект. ') + (detail || text);
    indicator.setAttribute('aria-label', (source === video ? 'Видеопроект. ' : 'Текстовый проект. ') + text);
  }
  function fitPreview() {
    const height = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--studio-header-height', height + 'px');
    // A panel taller than the viewport must scroll with the document: a sticky
    // oversized panel would trap the download controls below the visible area.
    preview.classList.toggle('preview-overflow', preview.offsetHeight > innerHeight - height - 24);
  }
  function showResult() {
    panel.classList.toggle('has-video-result', !download.hidden);
    fitPreview();
  }
  const saveObserver = new MutationObserver(showSaveState);
  for (const source of [editor, video]) saveObserver.observe(source, { childList: true, subtree: true, characterData: true });
  new MutationObserver(() => { showSaveState(); fitPreview(); }).observe(workspace, { attributes: true, attributeFilter: ['data-mode'] });
  new MutationObserver(showResult).observe(download, { attributes: true, attributeFilter: ['hidden'] });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(fitPreview); observer.observe(header); observer.observe(preview);
  }
  window.addEventListener('resize', fitPreview);
  showSaveState(); showResult();
})();
