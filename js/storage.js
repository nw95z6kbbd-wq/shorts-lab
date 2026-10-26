(function () {
  'use strict';
  document.body.inert = true;
  const DB = window.ShortsProjectDB, repo = DB.createRepository();
  const keys = { editor: 'shorts-studio.project.v1', video: 'shorts-studio.video.v1' };
  const sessions = new Map(), pending = new Map(), legacyAssets = new Map(), legacy = {}, warnings = {};
  let unavailable = null;
  let channel;
  try { channel = new BroadcastChannel('shorts-studio.projects'); } catch (_) {}
  const writer = ShortsCore.id();
  function message(error) {
    if (error.name === 'QuotaExceededError') return 'Хранилище заполнено. Новые правки не сохранены; предыдущая версия доступна. Освободите место на устройстве, не очищая данные Shorts Studio, и повторите сохранение, не закрывая вкладку.';
    if (['SecurityError', 'ReferenceError', 'TypeError'].includes(error.name)) return 'Браузер запретил доступ к IndexedDB. Изменения доступны только в этой вкладке.';
    if (error.name === 'VersionError') return 'Хранилище создано более новой версией приложения. Обновите страницу; данные не заменены.';
    if (['InvalidStateError', 'UnknownError', 'AbortError', 'DataCloneError', 'NotReadableError'].includes(error.name)) return 'Браузер не смог завершить операцию хранилища. Предыдущая версия не заменена; новые правки остаются во вкладке.';
    return error.message || 'Хранилище недоступно. Новые правки доступны только в этой вкладке.';
  }
  function readLegacy() {
    const records = [];
    for (const slot of Object.keys(keys)) {
      try {
        const raw = localStorage.getItem(keys[slot]); legacy[slot] = raw;
        if (raw !== null) {
          try { records.push({ id: slot, state: DB.normalize(slot, JSON.parse(raw)) }); }
          catch (_) { warnings[slot] = 'Старые данные повреждены. Исходник оставлен без изменений и скопирован в резерв миграции; открыт пример.'; }
        }
      } catch (_) { warnings[slot] = 'Старое хранилище localStorage недоступно.'; }
    }
    return records;
  }
  function legacyImages(ids) {
    if (!ids.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      let db, tx, absent = false, ended = false;
      const finish = (error, files) => { if (ended) return; ended = true; clearTimeout(timer); db?.close(); error ? reject(error) : resolve(files); };
      const timer = setTimeout(() => { try { tx?.abort(); } catch (_) {} finish(new Error('Старое хранилище изображений не ответило. Миграция отложена; исходные данные не изменены.')); }, 8000);
      try {
        const request = indexedDB.open('shorts-studio.media.v1');
        request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
        request.onerror = () => finish(absent ? null : request.error, []);
        request.onblocked = () => finish(new Error('Старая база изображений занята другой вкладкой. Закройте её и повторно откройте страницу.'));
        request.onsuccess = () => {
          db = request.result; if (ended) { db.close(); return; }
          db.onversionchange = () => db.close();
          if (!db.objectStoreNames.contains('images')) { finish(null, []); return; }
          tx = db.transaction('images', 'readonly'); const files = [];
          tx.oncomplete = () => finish(null, files);
          tx.onerror = tx.onabort = () => finish(tx.error || new Error('Не удалось прочитать прежние изображения.'));
          for (const id of ids) {
            const get = tx.objectStore('images').get(id);
            get.onsuccess = () => { const file = get.result; if (file?.file instanceof Blob && file.file.size) files.push({ id, blob: file.file, name: file.name || '', kind: 'image' }); };
          }
        };
      } catch (error) { finish(error); }
    });
  }
  const ready = (async () => {
    try {
      const migrated = await repo.migration();
      if (migrated) {
        for (const slot of Object.keys(keys)) {
          try { if (localStorage.getItem(keys[slot]) !== migrated.legacy[slot] && migrated.legacy[slot] !== undefined) warnings[slot] = 'Данные старой версии изменены. Новая сохранённая версия не заменена; для переноса правок из старой вкладки используйте её файл проекта.'; } catch (_) {}
        }
        return;
      }
      const records = readLegacy(), video = records.find(record => record.id === 'video');
      if (Object.keys(keys).some(slot => legacy[slot] === undefined)) throw new Error('Не удалось проверить прежние данные localStorage. Миграция отложена; старые данные не изменены.');
      const files = await legacyImages(video ? DB.references('video', video.state) : []);
      for (const file of files) legacyAssets.set(file.id, file);
      await repo.migrate(records, files, legacy);
      legacyAssets.clear();
    } catch (error) { unavailable = error; readLegacy(); }
  })();
  async function load(slot = 'editor') {
    await ready;
    const session = { revision: 0, queue: Promise.resolve(), conflict: false };
    sessions.set(slot, session);
    if (unavailable) {
      let project = null;
      try { if (legacy[slot]) project = DB.normalize(slot, JSON.parse(legacy[slot])); } catch (_) {}
      return { project, writable: false, error: message(unavailable) + ' Автосохранение отключено до повторного открытия страницы.' };
    }
    try {
      const record = await repo.read(slot); session.revision = record?.revision || 0;
      let project = null, recovery = '';
      if (record) {
        try { project = DB.normalize(slot, record.state); }
        catch (error) {
          if (!record.previous) throw error;
          project = DB.normalize(slot, record.previous.state); recovery = 'Текущее сохранение повреждено. Восстановлена предыдущая корректная версия.';
        }
      }
      return { project, writable: true, error: recovery || warnings[slot] || null };
    } catch (error) { unavailable = error; return { project: null, writable: false, error: 'Не удалось открыть сохранённый проект. Автоматическая замена отключена. ' + message(error) }; }
  }
  function save(project, slot = 'editor') {
    const session = sessions.get(slot), snapshot = structuredClone(project);
    const files = DB.references(slot, snapshot).map(id => pending.get(id)).filter(Boolean);
    const perform = async () => {
      try {
        if (unavailable) throw unavailable;
        if (!session || session.conflict) throw Object.assign(new Error('Проект изменён в другой вкладке. Автосохранение остановлено; ваши правки остаются во вкладке. Перед перезагрузкой сохраните нужный текст или видео.'), { code: 'CONFLICT' });
        const record = await repo.save(slot, snapshot, session.revision, files); session.revision = record.revision;
        for (const file of files) if (pending.get(file.id) === file) pending.delete(file.id);
        channel?.postMessage({ writer, slot, revision: record.revision });
        return { ok: true };
      } catch (error) { if (error.code === 'CONFLICT' && session) session.conflict = true; return { ok: false, error: message(error) }; }
    };
    if (!session) return perform();
    session.queue = session.queue.then(perform, perform); return session.queue;
  }
  if (channel) channel.onmessage = event => {
    const data = event.data, session = sessions.get(data?.slot);
    if (session && data.writer !== writer && data.revision > session.revision) {
      session.conflict = true;
      window.dispatchEvent(new CustomEvent('shorts:storage-conflict', { detail: { slot: data.slot } }));
    }
  };
  window.ShortsStorage = Object.freeze({ ready, load, save,
    stage(id, blob, name, kind) { pending.set(id, { id, blob, name, kind }); },
    async asset(id) { await ready; if (pending.has(id)) return pending.get(id); if (unavailable) { if (legacyAssets.has(id)) return legacyAssets.get(id); throw unavailable; } return repo.asset(id); },
    discard(id) { pending.delete(id); },
    pending: id => pending.has(id)
  });
})();
