(function () {
  'use strict';
  const NAME = 'shorts-studio.projects';
  // Physical writer fence: the shipped v1 client always opens version 1.
  const DATABASE_VERSION = 2;
  const failure = (code, message) => Object.assign(new Error(message), { code });
  function normalize(slot, value) {
    if (slot === 'editor') return ShortsCore.parseProject(value);
    if (slot !== 'video') throw failure('INVALID', 'Неизвестный раздел проекта.');
    if (value?.version !== 1) throw failure('UNSUPPORTED', 'Неизвестная версия видеопроекта. Обновите приложение; данные не заменены.');
    const result = ShortsVideoCore.parseDraft(value);
    for (const role of ['voice', 'music']) {
      const id = value[role + 'AssetId'];
      if (id != null && (typeof id !== 'string' || !id || id.length > 200)) throw failure('INVALID', 'Повреждена ссылка на аудио.');
      result[role + 'AssetId'] = id || null;
      result[role + 'Name'] = typeof value[role + 'Name'] === 'string' ? value[role + 'Name'].slice(0, 200) : '';
    }
    return result;
  }
  function assetUses(slot, input) {
    const state = normalize(slot, input), uses = new Map();
    function use(id, kind) {
      if (!id) return;
      if (uses.has(id) && (uses.get(id) === 'image') !== (kind === 'image')) throw failure('INVALID', 'Один исходник используется как изображение и аудио.');
      uses.set(id, kind);
    }
    if (slot === 'editor' && state.version === 1) return uses;
    state.scenes.forEach(scene => use(scene.imageId, 'image'));
    for (const role of ['voice', 'music']) use(slot === 'editor' ? state.audio[role].assetId : state[role + 'AssetId'], role);
    return uses;
  }
  function references(slot, state) { return [...assetUses(slot, state).keys()]; }
  function validateRecord(record) {
    if (!record) return;
    if (record.schemaVersion !== 1) throw failure('UNSUPPORTED', 'Неизвестный формат записи хранилища. Обновите приложение.');
    // Never replace a future head with a readable but outdated recovery state.
    try { normalize(record.id, record.state); } catch (error) { if (error.code === 'UNSUPPORTED') throw error; }
    if (record.previous) normalize(record.id, record.previous.state);
  }
  function previousState(slot, current) {
    if (!current) return null;
    validateRecord(current);
    try { return { state: normalize(slot, current.state), revision: current.revision, missingAssets: current.missingAssets || [] }; }
    catch (error) {
      if (error.code === 'UNSUPPORTED') throw error;
      if (!current.previous) throw failure('CORRUPT', 'Сохранённый проект повреждён. Автоматическая замена отключена.');
      normalize(slot, current.previous.state); return current.previous;
    }
  }
  function sameOriginal(prior, file) {
    if (!prior.bytes || prior.type !== file.type || prior.name !== file.name || prior.kind !== file.kind) return false;
    const a = new Uint8Array(prior.bytes), b = new Uint8Array(file.bytes);
    if (a.length !== b.length) return false;
    const aa = new Uint32Array(a.buffer, 0, Math.floor(a.length / 4)), bb = new Uint32Array(b.buffer, 0, Math.floor(b.length / 4));
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    for (let i = aa.length * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function addOriginal(assets, file, abort) {
    const request = assets.get(file.id);
    request.onsuccess = () => {
      try {
        if (!request.result) assets.add(file);
        else if (!sameOriginal(request.result, file)) throw failure('COLLISION', 'Конфликт идентификатора исходника. Прежний файл и проект не изменены.');
      } catch (error) { abort(error); }
    };
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
          request = indexedDB.open(name, DATABASE_VERSION);
          request.onupgradeneeded = () => {
            // A blocked/timed-out open cannot be cancelled. Abort a late upgrade
            // instead of changing the DB after the caller was told it failed.
            if (ended) { request.transaction.abort(); return; }
            for (const store of ['projects', 'assets', 'meta']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'id' });
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
            validateRecord(current);
            for (const file of supplied) addOriginal(assets, file, abort);
            const missing = current?.missingAssets || [];
            for (const id of ids) {
              const check = assets.getKey(id);
              check.onsuccess = () => { if (!check.result && !supplied.some(file => file.id === id) && !missing.includes(id)) abort(failure('MISSING', 'Не удалось сохранить один из медиафайлов. Предыдущая версия проекта не изменена.')); };
            }
            const previous = previousState(slot, current);
            const record = { id: slot, schemaVersion: 1, revision: expectedRevision + 1, state, previous, missingAssets: missing.filter(id => ids.includes(id)), updatedAt: new Date().toISOString() };
            projects.put(record); done(record);
            // Retain both current and previous snapshots; never touch the legacy DB.
            const all = projects.getAll();
            all.onsuccess = () => {
              try {
                const used = new Set(all.result.flatMap(p => { validateRecord(p); return [...references(p.id, p.state), ...(p.previous ? references(p.id, p.previous.state) : [])]; }));
                const cursor = assets.openKeyCursor();
                cursor.onsuccess = () => { const item = cursor.result; if (item) { if (!used.has(item.key)) assets.delete(item.key); item.continue(); } };
              } catch (error) { abort(error); }
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
    // Backup operations do not delete legacy data or change record envelopes.
    // Read originals in one transaction, serially bounding temporary clones.
    function backupAssets(ids, limit) {
      return transaction(['assets'], 'readonly', (tx, done, abort) => {
        const result = []; let index = 0, total = 0;
        function next() {
          if (index === ids.length) { done(result); return; }
          const request = tx.objectStore('assets').get(ids[index++]);
          request.onsuccess = () => {
            const asset = request.result;
            if (asset) {
              total += asset.bytes?.byteLength || asset.blob?.size || 0;
              if (total > limit) { abort(failure('LIMIT', 'Материалы превышают предел ZIP-копии 64 МиБ.')); return; }
              result.push(asset);
            }
            next();
          };
        }
        next();
      });
    }
    async function restoreBackup(input, expected, files) {
      const states = { editor: normalize('editor', input.editor), video: normalize('video', input.video) };
      const required = new Set([...references('editor', states.editor), ...references('video', states.video)]), media = await prepare(files);
      if (media.length !== required.size || new Set(media.map(file=>file.id)).size !== media.length || media.some(file=>!required.has(file.id))) throw failure('MISSING', 'Неполный набор исходных файлов восстановления.');
      return transaction(['projects','assets'], 'readwrite', (tx, done, abort) => {
        const projects = tx.objectStore('projects'), assets = tx.objectStore('assets'), request = projects.getAll();
        request.onsuccess = () => {
          try {
            const current = new Map(request.result.map(record=>[record.id,record])), result = [];
            for (const record of request.result) validateRecord(record);
            for (const slot of ['editor','video']) if ((current.get(slot)?.revision || 0) !== expected[slot]) throw failure('CONFLICT', 'Проект изменён в другой вкладке. Восстановление отменено, прежние данные не заменены.');
            for (const file of media) addOriginal(assets, file, abort);
            for (const slot of ['editor','video']) {
              const previous = previousState(slot, current.get(slot));
              const record={id:slot,schemaVersion:1,revision:expected[slot]+1,state:states[slot],previous,missingAssets:[],updatedAt:new Date().toISOString()};
              projects.put(record);result.push(record);
            }
            // No asset deletion here. A failed transaction rolls back both heads
            // and new originals; successful replacement retains previous media.
            done(result);
          } catch (error) { abort(error); }
        };
      });
    }
    return Object.freeze({ read: slot => read('projects', slot), async asset(id) {
      const asset = await read('assets', id);
      if (asset?.bytes) return { ...asset, blob: new Blob([asset.bytes], { type: asset.type || '' }) };
      return asset;
    }, migration: () => read('meta', 'legacy-v1'), save, migrate, backupAssets, restoreBackup, close() { connection?.close(); connection = null; } });
  }
  window.ShortsProjectDB = Object.freeze({ DATABASE_VERSION, createRepository, normalize, assetUses, references, validateRecord });
})();
