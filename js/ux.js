(function () {
  'use strict';
  // Presentation only: existing controller messages follow actual transaction
  // completion. The timers below dismiss a notification; they never save data.
  const workspace = document.querySelector('.workspace');
  const viewport = document.getElementById('studioViewport');
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
  let placementFrame;
  function placeToast() {
    if (indicator.hidden) return;
    // Only the fixed notification moves. Never resize/scroll the workspace or
    // refit the preview in response to saving, text changes or dismissal.
    const visual = window.visualViewport;
    const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toast-safe-bottom')) || 0;
    const top = (visual?.offsetTop || 0) + 12;
    const bottom = Math.min(innerHeight, (visual?.offsetTop || 0) + (visual?.height || innerHeight)) - 12 - safeBottom;
    const left = Math.max(workspace.getBoundingClientRect().left, visual?.offsetLeft || 0) + 12;
    const right = Math.min(innerWidth, (visual?.offsetLeft || 0) + (visual?.width || innerWidth)) - 12;
    const { width, height } = indicator.getBoundingClientRect();
    const obstacles = [...document.querySelectorAll('button,input:not([type=hidden]),textarea,select,a[href],video,.video-render-controls,#toast')]
      .filter(element => element !== indicator && !element.closest('dialog') && element.getClientRects().length)
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
    const xs = [Math.max(left, right - width), left];
    const ys = [...new Set([bottom - height, top, ...obstacles.flatMap(rect => [rect.top - height - 8, rect.bottom + 8])])]
      .filter(y => y >= top && y + height <= bottom).sort((a, b) => b - a);
    let best = { x: xs[0], y: Math.max(top, bottom - height), overlap: Infinity };
    for (const y of ys) for (const x of xs) {
      const overlap = obstacles.reduce((sum, rect) => sum + Math.max(0, Math.min(x + width + 4, rect.right) - Math.max(x - 4, rect.left)) * Math.max(0, Math.min(y + height + 4, rect.bottom) - Math.max(y - 4, rect.top)), 0);
      if (overlap < best.overlap) best = { x, y, overlap };
      if (!overlap) break;
    }
    indicator.style.left = best.x + 'px'; indicator.style.top = best.y + 'px';
    indicator.style.right = 'auto'; indicator.style.bottom = 'auto';
  }
  function schedulePlacement() {
    cancelAnimationFrame(placementFrame);
    placementFrame = requestAnimationFrame(placeToast);
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
      hideTimer = setTimeout(() => { indicator.hidden = true; }, 220);
    }, Math.max(0, until - Date.now()));
    placeToast();
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
  new MutationObserver(schedulePlacement).observe(document.getElementById('toast'), { attributes: true, childList: true, attributeFilter: ['hidden'] });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => { fitPreview(); schedulePlacement(); });
    observer.observe(viewport);
    for (const column of columns) observer.observe(column);
  }
  window.addEventListener('resize', () => { fitPreview(); schedulePlacement(); });
  viewport.addEventListener('scroll', schedulePlacement, { passive: true });
  window.visualViewport?.addEventListener('resize', schedulePlacement);
  window.visualViewport?.addEventListener('scroll', schedulePlacement);
  showSaveState(); showResult();
})();
