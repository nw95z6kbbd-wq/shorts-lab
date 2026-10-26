(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ShortsBackupFormat = factory(root.ShortsZip, root.ShortsProjectDB);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Z, DB) {
  'use strict';
  const FORMAT = 'shorts-studio-backup', VERSION = 1, encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const fail = message => { throw new Error(message); };
  const hashPattern = /^[a-f0-9]{64}$/;
  // Small offline fallback for contexts without SubtleCrypto (including some
  // file:// configurations). Processes blocks in bounded, yielding batches.
  async function sha256(bytes, forceFallback = false) {
    if (!forceFallback && globalThis.crypto?.subtle) {
      try{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');}catch(_){/* Offline/file contexts may deny SubtleCrypto; bounded fallback below. */}
    }
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], W = new Uint32Array(64);
    const rotate = (n, r) => (n >>> r) | (n << (32 - r));
    const tail = new Uint8Array(bytes.length % 64 < 56 ? 64 : 128); tail.set(bytes.subarray(bytes.length - bytes.length % 64)); tail[bytes.length % 64] = 128;
    const tailView = new DataView(tail.buffer); tailView.setUint32(tail.length - 8, Math.floor(bytes.length / 0x20000000)); tailView.setUint32(tail.length - 4, bytes.length * 8);
    const full = bytes.length - bytes.length % 64, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < full + tail.length; offset += 64) {
      const part = offset < full ? view : tailView, pos = offset < full ? offset : offset - full;
      for (let i = 0; i < 16; i++) W[i] = part.getUint32(pos + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = W[i - 15], y = W[i - 2];
        W[i] = W[i - 16] + (rotate(x,7)^rotate(x,18)^(x>>>3)) + W[i - 7] + (rotate(y,17)^rotate(y,19)^(y>>>10));
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const t = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + K[i] + W[i]) | 0;
        const u = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
        h=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0;
      }
      [a,b,c,d,e,f,g,h].forEach((n,i) => { H[i]=(H[i]+n)>>>0; });
      if (!(offset % 1048576)) await Z.tick();
    }
    return H.map(n => n.toString(16).padStart(8,'0')).join('');
  }
  function id(value) { if (typeof value !== 'string' || !value || value.length > 200) fail('Некорректный идентификатор проекта или материала.'); return value; }
  function known(raw, normal, warnings, path = '') {
    if (Array.isArray(normal)) {
      if (!Array.isArray(raw) || raw.length !== normal.length) fail('Повреждён список: ' + path);
      normal.forEach((value,i) => known(raw[i], value, warnings, path + '[' + i + ']')); return;
    }
    if (normal && typeof normal === 'object') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Повреждён объект: ' + path);
      for (const key of Object.keys(raw)) if (!Object.hasOwn(normal, key) && warnings.length < 20) warnings.push('Неизвестное поле пропущено: ' + path + '.' + key.slice(0,80));
      for (const key of Object.keys(normal)) if (Object.hasOwn(raw,key)) known(raw[key], normal[key], warnings, path + '.' + key);
      return;
    }
    if (raw !== normal) fail('Неподдерживаемое значение поля: ' + path);
  }
  function states(input, warnings = [], strict = true) {
    if (!input || !input.editor || !input.video) fail('В копии должны быть оба независимых черновика.');
    const result = {};
    for (const slot of ['editor','video']) {
      const state = input[slot], seen = new Set();
      if (!Array.isArray(state.scenes)) fail('Повреждён список сцен.');
      for (const scene of state.scenes) { if(!scene || typeof scene!=='object')fail('Повреждены данные сцены.');id(scene.id); if (seen.has(scene.id)) fail('Повторяющийся идентификатор сцены.'); seen.add(scene.id); }
      if (slot === 'editor') id(state.id);
      result[slot] = DB.normalize(slot, state); if(strict)known(state, result[slot], warnings, slot);
    }
    return result;
  }
  function usage(state) {
    const result = new Map();
    function use(key, kind) { if (!key) return; id(key); if (result.has(key) && (result.get(key)==='image') !== (kind==='image')) fail('Один материал используется как изображение и аудио.'); result.set(key, kind); }
    state.video.scenes.forEach(scene => { if (scene.visual === 'image' && !scene.imageId) fail('В сцене нет исходного изображения. Выберите файл повторно.'); use(scene.imageId,'image'); });
    use(state.video.voiceAssetId,'voice'); use(state.video.musicAssetId,'music'); return result;
  }
  const jsonBlob = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
  async function exportArchive(input, assets, producerVersion, progress = () => {}) {
    const projects = states(input,[],false), required = usage(projects), files = new Map(), records = []; let logicalSize = 0;
    const project = jsonBlob({ format: FORMAT, version: VERSION, ...projects });
    if (project.size > Z.LIMITS.json) fail('Текст проекта превышает предел ZIP-копии: 8 МиБ.');
    const projectHash = await sha256(new Uint8Array(await project.arrayBuffer()));
    for (const [key, kind] of required) {
      const asset = assets.get(key);
      if (!asset?.blob?.size) fail('Нет исходного файла: ' + key + '. Старые записи не удалены. Найдите оригинал и выберите его повторно.');
      if (asset.blob.size > Z.LIMITS.file) fail('Исходный файл превышает 32 МиБ. Данные проекта не изменены.');
      logicalSize += asset.blob.size;
      if (logicalSize + project.size > Z.LIMITS.archive) fail('Материалы проекта превышают 64 МиБ. Копия не создана, исходные данные сохранены.');
      if (String(asset.name || '').length>1024 || /[\\/\x00-\x1f\x7f]/.test(String(asset.name || ''))) fail('Имя исходного файла содержит неподдерживаемые символы. Исходные данные не изменены.');
      const bytes=new Uint8Array(await asset.blob.arrayBuffer());
      const original=typeof File!=='undefined' && asset.blob instanceof File?new Blob([bytes],{type:asset.blob.type}):asset.blob;
      const hash=await sha256(bytes),path='assets/'+hash+'.bin';
      files.set(path, original); records.push({ id: key, kind, name: String(asset.name || ''), type: asset.blob.type, path, size: asset.blob.size, sha256: hash });
      progress(.3 * records.length / Math.max(1, required.size)); await Z.tick();
    }
    const manifest = jsonBlob({ format: FORMAT, version: VERSION, producer: { name: 'Shorts Studio', version: producerVersion }, createdAt: new Date().toISOString(), project: { path: 'project.json', size: project.size, sha256: projectHash }, assets: records });
    if (manifest.size > Z.LIMITS.manifest) fail('Слишком большой manifest ZIP.');
    return Z.create([{ path:'manifest.json',blob:manifest },{ path:'project.json',blob:project }, ...[...files].map(([path,blob])=>({path,blob}))], p=>progress(.3+.7*p));
  }
  function parse(bytes, label) { try { return JSON.parse(decoder.decode(bytes)); } catch (_) { fail('Повреждён JSON: ' + label); } }
  function format(value) { if (value?.format !== FORMAT || value.version !== VERSION) fail('Неизвестный формат или будущая версия ZIP-копии. Нужна совместимая версия Shorts Studio.'); }
  async function importArchive(file, progress = () => {}) {
    const zip = await Z.read(file), manifest = parse(await zip.bytes('manifest.json', Z.LIMITS.manifest),'manifest.json'); format(manifest);
    if (!Array.isArray(manifest.assets) || manifest.assets.length > 14 || manifest.project?.path !== 'project.json' || !hashPattern.test(manifest.project.sha256)) fail('Некорректный manifest копии.');
    const warnings = [], expected = new Set(['manifest.json','project.json']), ids = new Set(); let logicalSize = 0;
    for (const asset of manifest.assets) {
      if(!asset || typeof asset!=='object')fail('Повреждена запись материала.');id(asset.id);
      if (ids.has(asset.id) || !['image','voice','music'].includes(asset.kind) || !hashPattern.test(asset.sha256) || asset.path !== 'assets/'+asset.sha256+'.bin' || typeof asset.name !== 'string' || asset.name.length > 1024 || /[\\/\x00-\x1f\x7f]/.test(asset.name) || typeof asset.type !== 'string' || asset.type.length > 120 || /[^\x20-\x7e]/.test(asset.type) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > Z.LIMITS.file) fail('Некорректные сведения об исходном файле.');
      ids.add(asset.id); expected.add(asset.path); logicalSize += asset.size;
    }
    if (logicalSize > Z.LIMITS.archive) fail('Распакованный объём материалов превышает 64 МиБ.');
    if (zip.entries.size !== expected.size || [...zip.entries.keys()].some(path=>!expected.has(path))) fail('В ZIP есть лишние или отсутствующие файлы.');
    const bytes = await zip.bytes('project.json',Z.LIMITS.json);
    if (bytes.length !== manifest.project.size || await sha256(bytes) !== manifest.project.sha256) fail('Нарушена целостность project.json.');
    const project = parse(bytes,'project.json'); format(project);
    for (const key of Object.keys(project)) if (!['format','version','editor','video'].includes(key)) warnings.push('Неизвестное поле проекта пропущено: '+key.slice(0,80));
    const projects = states(project,warnings), required = usage(projects), blobs = new Map(), assets = new Map();
    if (required.size !== ids.size || [...required].some(([key,kind])=>!ids.has(key) || (kind==='image') !== (manifest.assets.find(a=>a.id===key).kind==='image'))) fail('Список исходников не соответствует ссылкам сцен и звука.');
    for (const [index, asset] of manifest.assets.entries()) {
      let blob = blobs.get(asset.path);
      if (!blob) {
        const bytes = await zip.bytes(asset.path);
        if (await sha256(bytes) !== asset.sha256) fail('Нарушена контрольная сумма материала: '+asset.name);
        blob = new Blob([bytes]); blobs.set(asset.path,blob);
      }
      if (blob.size !== asset.size) fail('Размер материала не совпадает с manifest.');
      assets.set(asset.id,{...asset,blob:blob.slice(0,blob.size,asset.type)}); progress((index+1)/Math.max(1,manifest.assets.length)); await Z.tick();
    }
    return { projects, assets, warnings, manifest };
  }
  async function remap(bundle) {
    const projects = structuredClone(bundle.projects), assets = [], ids = new Map();
    const used=new Set();
    for (const [old, asset] of bundle.assets) {
      const tag=await sha256(encoder.encode(JSON.stringify([asset.kind,asset.name,asset.type])));
      const key='backup-'+asset.sha256+'-'+tag.slice(0,24);ids.set(old,key);
      if(!used.has(key)){assets.push({id:key,blob:asset.blob,name:asset.name,kind:asset.kind});used.add(key);}
    }
    projects.video.scenes.forEach(scene=>{if(scene.imageId)scene.imageId=ids.get(scene.imageId);});
    for (const role of ['voice','music']) if(projects.video[role+'AssetId'])projects.video[role+'AssetId']=ids.get(projects.video[role+'AssetId']);
    return { projects, assets };
  }
  return Object.freeze({ FORMAT, VERSION, sha256, states, usage, exportArchive, importArchive, remap });
});
