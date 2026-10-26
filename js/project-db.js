(function () {
  'use strict';
  const NAME = 'shorts-studio.projects';
  const failure = (code, message) => Object.assign(new Error(message), { code });
  function normalize(slot, value) {
    if (slot === 'editor') return ShortsCore.parseProject(value);
    if (slot !== 'video') throw failure('INVALID', 'Неизвестный раздел проекта.');
    const result = ShortsVideoCore.parseDraft(value);
    for (const role of ['voice', 'music']) {
      const id = value[role + 'AssetId'];
      if (id != null && (typeof id !== 'string' || !id || id.length > 200)) throw failure('INVALID', 'Повреждена ссылка на аудио.');
      result[role + 'AssetId'] = id || null;
      result[role + 'Name'] = typeof value[role + 'Name'] === 'string' ? value[role + 'Name'].slice(0, 200) : '';
    }
    return result;
  }
  function references(slot, state) {
    if (slot === 'editor') return [];
    return [...new Set([...state.scenes.map(scene => scene.imageId), state.voiceAssetId, state.musicAssetId].filter(Boolean))];
  }
  function createRepository(name = NAME) {
    let connection, opening;
    function open() {
      if (connection) return Promise.resolve(connection);
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let request, ended = false;
        const finish = (error, db) => {
          if (ended) { db?.close(); return; }
          ended = true; clearTimeout(timer);
          if (error) reject(error); else { connection = db; resolve(db); }
        };
        const timer = setTimeout(() => finish(failure('TIMEOUT', 'Хранилище не ответило. Закройте другие вкладки Shorts Studio и повторно откройте страницу.')), 8000);
        try {
          request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => {
            for (const store of ['projects', 'assets', 'meta']) request.result.createObjectStore(store, { keyPath: 'id' });
          };
          request.onblocked = () => finish(failure('BLOCKED', 'Обновление хранилища заблокировано другой вкладкой. Закройте её и перезагрузите страницу.'));
          request.onerror = () => finish(request.error || failure('UNAVAILABLE', 'IndexedDB недоступна.'));
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); connection = null; };
            db.onclose = () => { if (connection === db) connection = null; };
            finish(null, db);
          };
        } catch (error) { finish(error); }
      }).finally(() => { opening = null; });
      return opening;
    }
    async function transaction(stores, mode, run) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let tx, result, cause;
        try { tx = db.transaction(stores, mode); } catch (error) { reject(error); return; }
        const timer = setTimeout(() => { cause = failure('TIMEOUT', 'Сохранение не завершилось вовремя. Предыдущая версия сохранена.'); try { tx.abort(); } catch (_) {} }, 15000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onerror = event => { cause ||= event.target.error; };
        tx.onabort = () => { clearTimeout(timer); reject(cause || tx.error || failure('ABORT', 'Операция хранилища прервана.')); };
        const abort = error => { cause = error; try { tx.abort(); } catch (_) {} };
        try { run(tx, value => { result = value; }, abort); } catch (error) { abort(error); }
      });
    }
    const read = (store, id) => transaction([store], 'readonly', (tx, done) => {
      const request = tx.objectStore(store).get(id); request.onsuccess = () => done(request.result || null);
    });
    async function prepare(files) {
      const result = [];
      for (const file of files) {
        if (!(file.blob instanceof Blob) || !file.blob.size) throw failure('INVALID', 'Медиафайл пуст или повреждён.');
        // ArrayBuffer avoids WebKit's temporary Blob-file preparation failures.
        // Original bytes and MIME are preserved; no base64 or transcoding.
        result.push({ id: file.id, name: file.name || '', kind: file.kind, type: file.blob.type, size: file.blob.size, bytes: await file.blob.arrayBuffer() });
      }
      return result;
    }
    async function save(slot, input, expectedRevision, files = []) {
      const state = normalize(slot, input), ids = references(slot, state);
      // All asynchronous preparation happens before the transaction (Safari).
      const supplied = await prepare(files.filter(file => ids.includes(file.id)));
      return transaction(['projects', 'assets'], 'readwrite', (tx, done, abort) => {
        const projects = tx.objectStore('projects'), assets = tx.objectStore('assets');
        const request = projects.get(slot);
        request.onsuccess = () => {
          try {
            const current = request.result;
            if ((current?.revision || 0) !== expectedRevision) { abort(failure('CONFLICT', 'Проект изменён в другой вкладке. Ваши правки остаются в этой вкладке. Перезагрузите страницу после сохранения нужного текста или видео.')); return; }
            for (const file of supplied) assets.put(file);
            const missing = current?.missingAssets || [];
            for (const id of ids) {
              const check = assets.get(id);
              check.onsuccess = () => { if (!check.result && !missing.includes(id)) abort(failure('MISSING', 'Не удалось сохранить один из медиафайлов. Предыдущая версия проекта не изменена.')); };
            }
            let previous = null;
            if (current) {
              try { previous = { state: normalize(slot, current.state), revision: current.revision, missingAssets: current.missingAssets || [] }; }
              catch (_) { previous = current.previous; if (!previous) throw failure('CORRUPT', 'Сохранённый проект повреждён. Автоматическая замена отключена.'); }
            }
            const record = { id: slot, schemaVersion: 1, revision: expectedRevision + 1, state, previous, missingAssets: missing.filter(id => ids.includes(id)), updatedAt: new Date().toISOString() };
            projects.put(record); done(record);
            // Retain both current and previous snapshots; never touch the legacy DB.
            const all = projects.getAll();
            all.onsuccess = () => {
              const used = new Set(all.result.flatMap(p => [...references(p.id, p.state), ...(p.previous ? references(p.id, p.previous.state) : [])]));
              const cursor = assets.openCursor();
              cursor.onsuccess = () => { const item = cursor.result; if (item) { if (!used.has(item.key)) item.delete(); item.continue(); } };
            };
          } catch (error) { abort(error); }
        };
      });
    }
    async function migrate(records, files, legacy) {
      const prepared = records.map(record => ({ ...record, state: normalize(record.id, record.state) }));
      const media = await prepare(files);
      return transaction(['projects', 'assets', 'meta'], 'readwrite', (tx, done, abort) => {
        const meta = tx.objectStore('meta'), request = meta.get('legacy-v1');
        request.onsuccess = () => {
          if (request.result) { done(false); return; }
          const existing = tx.objectStore('projects').count();
          existing.onsuccess = () => {
            try {
            if (existing.result) { abort(failure('MIGRATION', 'В новой базе уже есть данные без отметки миграции. Автоматическая замена отключена.')); return; }
            const fileIds = new Set(media.map(file => file.id));
            for (const file of media) {
              tx.objectStore('assets').put(file);
            }
            for (const record of prepared) tx.objectStore('projects').put({ id: record.id, schemaVersion: 1, revision: 1, state: record.state, previous: null, missingAssets: references(record.id, record.state).filter(id => !fileIds.has(id)), updatedAt: new Date().toISOString() });
            meta.put({ id: 'legacy-v1', legacy, completedAt: new Date().toISOString() }); done(true);
            } catch (error) { abort(error); }
          };
        };
      });
    }
    return Object.freeze({ read: slot => read('projects', slot), async asset(id) {
      const asset = await read('assets', id);
      if (asset?.bytes) return { ...asset, blob: new Blob([asset.bytes], { type: asset.type || '' }) };
      return asset;
    }, migration: () => read('meta', 'legacy-v1'), save, migrate, close() { connection?.close(); connection = null; } });
  }
  window.ShortsProjectDB = Object.freeze({ createRepository, normalize, references });
})();
