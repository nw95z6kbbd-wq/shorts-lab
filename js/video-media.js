(function () {
  'use strict';
  let database;
  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('Хранилище изображений недоступно.')); return; }
      const request = indexedDB.open('shorts-studio.media.v1', 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Хранилище изображений не ответило.')); }, 3000);
      request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(new Error('Не удалось открыть хранилище изображений.')); };
    });
    database.catch(() => { database = null; });
    return database;
  }
  async function operation(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('images', mode);
      const request = action(transaction.objectStore('images'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(new Error('Изображение не сохранено: хранилище заполнено или недоступно.'));
    });
  }
  async function decodeImage(file) {
    if (!file || !file.size || file.size > 15 * 1024 * 1024) throw new Error('Выберите изображение PNG, JPG или WebP размером до 15 МБ.');
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!png && !jpg && !webp) throw new Error('Поддерживаются только настоящие PNG, JPG и WebP. SVG и другие форматы не загружаются.');
    const url = URL.createObjectURL(file);
    let image;
    try {
      if (typeof createImageBitmap === 'function') {
        try { image = await createImageBitmap(file); } catch (_) { /* Try the image decoder below. */ }
      }
      if (!image) {
        image = new Image(); image.src = url;
        await new Promise((resolve, reject) => { if (image.complete && image.naturalWidth) resolve(); else { image.onload = resolve; image.onerror = reject; } });
      }
      const width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
      if (!width || !height || width * height > 40000000) throw new Error('Слишком большое изображение. Используйте файл не более 40 мегапикселей.');
      return { image, url, width, height, dispose() { image.close?.(); URL.revokeObjectURL(url); } };
    } catch (cause) {
      image?.close?.(); URL.revokeObjectURL(url);
      throw new Error(cause.message?.includes('мегапикселей') ? cause.message : 'Браузер не смог прочитать изображение. Попробуйте другой PNG, JPG или WebP.');
    }
  }
  window.ShortsVideoMedia = {
    decodeImage,
    put: (id, file, name) => operation('readwrite', store => store.put({ id, file, name })),
    get: id => operation('readonly', store => store.get(id)),
    remove: id => operation('readwrite', store => store.delete(id))
  };
})();
