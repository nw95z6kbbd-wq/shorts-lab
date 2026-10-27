(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShortsZip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Intentionally narrow ZIP32/STORE profile: no decompressor, ZIP64, encryption,
  // descriptors, executable paths or extraction to a filesystem.
  const LIMITS = Object.freeze({ archive: 64 * 1048576, file: 32 * 1048576, json: 8 * 1048576, manifest: 65536, entries: 32, directory: 16384, assets: 14 });
  const V2_LIMITS = Object.freeze({ ...LIMITS, manifest: 512 * 1024, entries: 514, directory: 65536, assets: 512 });
  const fail = text => { throw new Error(text); };
  const limitsFor = version => version === 1 ? LIMITS : version === 2 ? V2_LIMITS : fail('Неизвестная версия ZIP-профиля.');
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const safePath = path => typeof path === 'string' && /^(manifest\.json|project\.json|assets\/[a-f0-9]{64}\.bin)$/.test(path);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  async function crc32(bytes) {
    let crc = 0xffffffff;
    for (let start = 0; start < bytes.length; start += 1048576) {
      for (let i = start; i < Math.min(bytes.length, start + 1048576); i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      await tick();
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const data = async blob => new Uint8Array(await blob.arrayBuffer());
  function header(size) { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; }
  function sized(size, max) { if (!Number.isSafeInteger(size) || size < 0 || size > max) fail('ZIP превышает допустимый объём. Предел архива — 64 МиБ, файла — 32 МиБ.'); }
  async function create(entries, progress = () => {}, version = 1) {
    const limits = limitsFor(version);
    if (!entries.length || entries.length > limits.entries) fail('Недопустимое число файлов ZIP: максимум ' + limits.entries + '.');
    // Bound headers AND payload before reading any file into an ArrayBuffer.
    let predicted = 22, predictedDirectory = 0; const predictedPaths = new Set();
    for (const entry of entries) {
      if (!safePath(entry.path) || predictedPaths.has(entry.path)) fail('Опасный или повторяющийся путь ZIP.');
      predictedPaths.add(entry.path);
      sized(entry.blob.size, limits.file);
      const length = encoder.encode(entry.path).length;
      predicted += 76 + 2 * length + entry.blob.size; predictedDirectory += 46 + length;
    }
    sized(predicted, limits.archive); sized(predictedDirectory, limits.directory);
    const paths = new Set(), body = [], directory = []; let offset = 0, dirSize = 0;
    for (const [index, entry] of entries.entries()) {
      if (!safePath(entry.path) || paths.has(entry.path)) fail('Опасный или повторяющийся путь ZIP.');
      paths.add(entry.path); sized(entry.blob.size, LIMITS.file);
      const name = encoder.encode(entry.path), bytes = await data(entry.blob), crc = await crc32(bytes);
      const local = header(30); local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true);
      local.view.setUint16(12,33,true); local.view.setUint32(14, crc, true); local.view.setUint32(18, bytes.length, true); local.view.setUint32(22, bytes.length, true); local.view.setUint16(26, name.length, true);
      const central = header(46); central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true); central.view.setUint16(8, 0x800, true);
      central.view.setUint16(14,33,true); central.view.setUint32(16, crc, true); central.view.setUint32(20, bytes.length, true); central.view.setUint32(24, bytes.length, true); central.view.setUint16(28, name.length, true); central.view.setUint32(42, offset, true);
      // Payload stays a Blob part, not a second whole-archive ArrayBuffer.
      body.push(local.bytes,name,typeof File!=='undefined' && entry.blob instanceof File?new Blob([bytes]):entry.blob); directory.push(central.bytes, name);
      offset += 30 + name.length + bytes.length; dirSize += 46 + name.length;
      sized(offset + dirSize + 22, LIMITS.archive); progress((index + 1) / entries.length); await tick();
    }
    const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true); end.view.setUint32(12, dirSize, true); end.view.setUint32(16, offset, true);
    return new Blob([...body, ...directory, end.bytes], { type: 'application/zip' });
  }
  async function read(file, version = 1) {
    const limits = limitsFor(version);
    sized(file.size, limits.archive); if (file.size < 22) fail('Повреждённый ZIP: нет каталога.');
    // Only our comment-free, single-disk profile. This prevents ambiguous appended
    // archives and avoids scanning arbitrary payload for forged end records.
    const tail = await data(file.slice(-22)), end = new DataView(tail.buffer);
    if (end.getUint32(0, true) !== 0x06054b50 || end.getUint16(4, true) || end.getUint16(6, true) || end.getUint16(20, true)) fail('Неподдерживаемый или повреждённый ZIP. Нужен исходный архив Shorts Studio.');
    const count = end.getUint16(10, true), dirSize = end.getUint32(12, true), dirOffset = end.getUint32(16, true);
    if (!count || count > limits.entries || count !== end.getUint16(8, true) || dirOffset + dirSize !== file.size - 22 || dirSize > limits.directory) fail('Недопустимый каталог или число файлов ZIP.');
    const bytes = await data(file.slice(dirOffset, dirOffset + dirSize)), view = new DataView(bytes.buffer), entries = new Map();
    let cursor = 0, localEnd = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) fail('Повреждённый каталог ZIP.');
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const packed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true), n = view.getUint16(cursor + 28, true);
      const extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), start = view.getUint32(cursor + 42, true), crc = view.getUint32(cursor + 16, true);
      if (view.getUint16(cursor+6,true)!==20 || method || flags !== 0x800 || extra || comment || view.getUint16(cursor+36,true) || view.getUint16(cursor + 34, true) || view.getUint32(cursor + 38, true)) fail('ZIP использует сжатие, шифрование, ссылки или расширения. Поддерживается только исходный ZIP Shorts Studio (STORE).');
      sized(size, LIMITS.file); total += size; sized(total, LIMITS.archive);
      if (size !== packed || !n || cursor + 46 + n > bytes.length || start !== localEnd) fail('Повреждённые размеры или пересекающиеся файлы ZIP.');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + n));
      if (!safePath(name) || entries.has(name)) fail('Опасный или повторяющийся путь ZIP.');
      const localBytes = await data(file.slice(start, start + 30 + n));
      if (localBytes.length !== 30 + n) fail('Обрезанный заголовок ZIP.');
      const local = new DataView(localBytes.buffer);
      if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(4,true)!==20 || local.getUint16(6, true) !== flags || local.getUint16(8, true) !== method || local.getUint32(14, true) !== crc || local.getUint32(18, true) !== size || local.getUint32(22, true) !== size || local.getUint16(26, true) !== n || local.getUint16(28, true) || decoder.decode(localBytes.subarray(30)) !== name) fail('Локальный заголовок ZIP не совпадает с каталогом.');
      localEnd = start + 30 + n + size; if (localEnd > dirOffset) fail('Данные файла выходят за границы ZIP.');
      const blob = file.slice(start + 30 + n, localEnd);
      entries.set(name, { blob, size, crc }); cursor += 46 + n;
    }
    if (cursor !== bytes.length || localEnd !== dirOffset) fail('Лишние или неполные данные ZIP.');
    return { entries, async bytes(path, max = LIMITS.file) {
      const entry = entries.get(path); if (!entry) fail('В архиве отсутствует файл: ' + path);
      sized(entry.size, max); const bytes = await data(entry.blob);
      if (await crc32(bytes) !== entry.crc) fail('Нарушена целостность ZIP: ' + path);
      return bytes;
    } };
  }
  return Object.freeze({ LIMITS, V2_LIMITS, limitsFor, safePath, crc32, create, read, tick });
});
