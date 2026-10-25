(function () {
  'use strict';
  const KEY = 'shorts-studio.project.v1';
  window.ShortsStorage = {
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw === null) return { project: null, error: null };
        try {
          return { project: ShortsCore.parseProject(raw), error: null };
        } catch (error) {
          // Preserve recoverable data before starting a fresh project.
          let recovered = false;
          try { localStorage.setItem(KEY + '.recovery', raw); recovered = true; } catch (_) { /* Saving can be unavailable. */ }
          return { project: null, error: 'Сохранённый проект повреждён. ' + (recovered ? 'Создана резервная копия данных. ' : '') + 'Можно открыть скачанный файл проекта.' };
        }
      } catch (error) {
        return { project: null, error: 'Автосохранение недоступно. Скачивайте проект, чтобы сохранить работу.' };
      }
    },
    save(project) {
      try {
        localStorage.setItem(KEY, JSON.stringify(project));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: 'Не удалось сохранить проект. Возможно, хранилище заполнено или недоступно.' };
      }
    }
  };
})();
