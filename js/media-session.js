(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ShortsMediaSessions = factory({
    original: id => root.ShortsStorage.asset(id),
    image: blob => root.ShortsVideoMedia.decodeImage(blob),
    audio: blob => root.ShortsVideoRecorder.decodeAudio(blob),
    audioWindow: root.ShortsAudioWindow
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (io, globalOptions) {
  'use strict';
  const MIB = 1048576;
  const DEFAULTS = Object.freeze({ maxImages: 16, maxOriginalBytes: 64 * MIB, maxDecodedBytes: 96 * MIB, maxImagePixels: 16 * 1000000, maxAudioBytes: 64 * MIB });
  const globalLimits = Object.freeze({ maxSessions: 8, maxResidentBytes: 256 * MIB, ...(globalOptions || {}) });
  const error = (code, message, details = {}, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code, ...details });
  const abortError = () => error('CANCELLED', 'Подготовка медиа отменена.');
  const noJSON = () => { throw error('RUNTIME', 'Runtime-сессии и заимствованные ресурсы нельзя сохранять в проект или ZIP.'); };
  let live = 0, resident = 0, peakResident = 0, decoding = false, serial = 0;
  const queue = [], audioPool = new Map();
  let scratchBytes=0,peakScratchBytes=0,audioDecodes=0;
  for (const value of Object.values(globalLimits)) if (!Number.isSafeInteger(value) || value <= 0) throw error('LIMITS', 'Некорректный общий бюджет медиа.');

  function pump() {
    if (decoding || !queue.length) return;
    const item = queue.shift(); item.started = true; item.off(); decoding = true;
    Promise.resolve().then(item.run).then(item.resolve, item.reject).finally(() => { decoding = false; pump(); });
  }
  function scheduled(run, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const item = { run, resolve, reject, started: false, off: () => signal.removeEventListener('abort', stop) };
      function stop() { if (!item.started) { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); item.off(); reject(abortError()); } }
      signal.addEventListener('abort', stop, { once: true }); queue.push(item); pump();
    });
  }
  function interruptible(promise, signal) {
    return new Promise((resolve, reject) => {
      const stop = () => reject(abortError());
      if (signal.aborted) { reject(abortError()); return; }
      signal.addEventListener('abort', stop, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }
  // Inspect dimensions BEFORE the existing image decoder allocates pixels.
  // This is a bounded header probe, not a replacement image decoder.
  async function dimensions(blob) {
    const b = new Uint8Array(await blob.slice(0, 262144).arrayBuffer()), v = new DataView(b.buffer);
    const text = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
    const actual=b.length>=8&&[137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x)?'image/png':b[0]===255&&b[1]===216?'image/jpeg':text(0,4)==='RIFF'&&text(8,4)==='WEBP'?'image/webp':null;
    if(actual&&blob.type&&blob.type!=='application/octet-stream'&&blob.type!==actual)throw error('MEDIA_TYPE','MIME изображения не совпадает с его содержимым.');
    if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((x,i) => b[i] === x)) {
      let p = 8;
      while (p + 8 <= b.length) {
        const n = v.getUint32(p), type = text(p + 4, 4);
        if (type === 'acTL') throw error('IMAGE_ANIMATED', 'Runtime-сессия пока поддерживает только статические PNG/WebP.');
        if (type === 'IDAT' || type === 'IEND') return [v.getUint32(16), v.getUint32(20)];
        p += n + 12;
      }
    } else if (b.length >= 2 && b[0] === 255 && b[1] === 216) {
      let p = 2;
      while (p + 4 <= b.length) {
        if (b[p++] !== 255) break;
        while (b[p] === 255) p++;
        const marker = b[p++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (p + 2 > b.length) break;
        const n = v.getUint16(p); if (n < 2) break;
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && p + 7 <= b.length) return [v.getUint16(p + 5), v.getUint16(p + 3)];
        p += n;
      }
    } else if (b.length >= 30 && text(0,4) === 'RIFF' && text(8,4) === 'WEBP') {
      let p = 12;
      while (p + 8 <= b.length) {
        const type = text(p,4), n = v.getUint32(p + 4,true), a = p + 8;
        if (type === 'VP8X' && a + 10 <= b.length) {
          if (b[a] & 2) throw error('IMAGE_ANIMATED', 'Runtime-сессия пока поддерживает только статические PNG/WebP.');
          return [1 + b[a+4] + (b[a+5]<<8) + (b[a+6]<<16), 1 + b[a+7] + (b[a+8]<<8) + (b[a+9]<<16)];
        }
        if (type === 'VP8 ' && a + 10 <= b.length && text(a+3,3) === '\x9d\x01\x2a') return [v.getUint16(a+6,true)&16383,v.getUint16(a+8,true)&16383];
        if (type === 'VP8L' && a + 5 <= b.length && b[a] === 47) { const bits=v.getUint32(a+1,true);return [1+(bits&16383),1+((bits>>>14)&16383)]; }
        p = a + n + (n & 1);
      }
    }
    throw error('IMAGE_HEADER', 'Не удалось проверить размеры статического PNG/JPG/WebP в первых 256 КиБ.');
  }

  function create({ owner, limits: options = {}, audioDurationMs = null } = {}) {
    if(audioDurationMs!==null&&(!Number.isSafeInteger(audioDurationMs)||audioDurationMs<0))throw error('OFFSET','Некорректное окно подготовки аудио.');
    if (!owner || !['editor','video'].includes(owner.slot) || typeof owner.projectId !== 'string' || !owner.projectId) throw error('IDENTITY', 'Укажите слот и идентификатор владельца медиа.');
    for(const key of ['contentRevision','savedRevision'])if(owner[key]!=null&&(!Number.isSafeInteger(owner[key])||owner[key]<0))throw error('IDENTITY','Некорректная редакция или ревизия владельца.');
    if(owner.sessionId!=null&&typeof owner.sessionId!=='string')throw error('IDENTITY','Некорректный идентификатор управляющей сессии.');
    if (live >= globalLimits.maxSessions) throw error('SESSION_LIMIT', 'Слишком много незакрытых runtime-сессий. Освободите предыдущие ресурсы.');
    const limits = Object.freeze({ ...DEFAULTS, ...options });
    for (const [key, value] of Object.entries(limits)) if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 0) throw error('LIMITS', 'Некорректный бюджет медиа.');
    live++;
    const identity = Object.freeze({ slot:owner.slot, projectId:owner.projectId, contentRevision:owner.contentRevision ?? null, savedRevision:owner.savedRevision ?? null, renderSessionId:owner.sessionId ?? null, mediaSessionId: 'media-' + ++serial });
    const controller = new AbortController(), records = new Map();
    let state = 'created', outcome = null, cause = null, generation = 0, consumers = 0, pending = 0, originalBytes = 0, decodedBytes = 0, imagePixels = 0, finished = false, preparation;
    let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
    const terminal = () => ['error','cancelled','disposed'].includes(state);
    function reserve(record, original, decoded) {
      if (originalBytes + original > limits.maxOriginalBytes || decodedBytes + decoded > limits.maxDecodedBytes || resident + original + decoded > globalLimits.maxResidentBytes) throw error('MEMORY_BUDGET', 'Медиа превышают рабочий бюджет памяти runtime-сессии. Используйте меньшие исходники или освободите другие сессии.');
      originalBytes += original; decodedBytes += decoded; resident += original + decoded;
      peakResident = Math.max(peakResident,resident);
      record.originalBytes += original; record.decodedBytes += decoded;
    }
    function release(record) {
      if (record.released || record.loading) return;
      record.released = true;
      try { if (record.kind === 'image') record.decoded?.dispose(); } finally {
        originalBytes -= record.originalBytes; decodedBytes -= record.decodedBytes; resident -= record.originalBytes + record.decodedBytes;
        imagePixels -= record.imagePixels || 0;
        if(record.poolKey){const pooled=audioPool.get(record.poolKey);if(pooled&&!--pooled.users)audioPool.delete(record.poolKey);}
        record.decoded = null; record.blob = null;
      }
    }
    function cleanup() {
      if (!terminal() || consumers) return;
      for (const record of records.values()) { try { release(record); } catch(e) { cause ||= error('CLEANUP','Не удалось освободить один из временных ресурсов.',{},e); } }
      if (!pending && !finished) { finished = true; live--; resolveClosed(); }
    }
    function close(next, reason) {
      if (!terminal()) { state = next; outcome = next; cause = reason || null; generation++; controller.abort(); }
      cleanup(); return closed;
    }
    function current(epoch) { if (controller.signal.aborted || epoch !== generation) throw abortError(); }
    async function loadWindowAudio(record,epoch){
      let scratch=0;
      const workspace=bytes=>{
        if(scratch+bytes>limits.maxDecodedBytes||resident+bytes>globalLimits.maxResidentBytes)throw error('AUDIO_DECODE_BUDGET',`Полное декодирование MP3 требует ${((scratch+bytes)/MIB).toFixed(1)} МиБ временных данных (предел ${limits.maxDecodedBytes/MIB} МиБ); общий расчётный объём ${((resident+bytes)/MIB).toFixed(1)} МиБ при лимите ${globalLimits.maxResidentBytes/MIB} МиБ. Выберите более короткий исходник.`,{assetId:record.id});
        scratch+=bytes;scratchBytes+=bytes;resident+=bytes;peakResident=Math.max(peakResident,resident);peakScratchBytes=Math.max(peakScratchBytes,scratchBytes);
      };
      pending++;record.loading=true;
      const operation=scheduled(async()=>{
        try{
          current(epoch);workspace(record.blob.size);
          const info=await io.audioWindow.probe(record.blob);current(epoch);
          if(!info)return false;
          const key=JSON.stringify([identity.slot,identity.projectId,record.id,audioDurationMs,info.hash]);
          const windowBytes=Math.min(info.samples,Math.max(1,Math.ceil(audioDurationMs*info.sampleRate/1000)))*info.channels*4;
          if(windowBytes>limits.maxAudioBytes)throw error('DECODED_BUDGET',`Аудио для длительности проекта требует ${(windowBytes/MIB).toFixed(1)} МиБ PCM; предел на дорожку ${limits.maxAudioBytes/MIB} МиБ. Сократите проект или исходник.`,{assetId:record.id});
          reserve(record,0,windowBytes);
          let pooled=audioPool.get(key);
          if(!pooled){
            workspace(info.fullPcmBytes);audioDecodes++;
            const prepared=await io.audioWindow.decode(info,audioDurationMs);current(epoch);
            pooled={...prepared,users:0};audioPool.set(key,pooled);
          }
          current(epoch);reserve(record,0,pooled.info.retainedPcmBytes-windowBytes);
          pooled.users++;record.poolKey=key;record.decoded=pooled.buffer;record.audioInfo=pooled.info;return true;
        }finally{scratchBytes-=scratch;resident-=scratch;}
      },controller.signal).finally(()=>{record.loading=false;pending--;cleanup();});
      return await interruptible(operation,controller.signal);
    }
    async function load(item, epoch) {
      let stored;
      pending++;
      const reading = Promise.resolve().then(() => { current(epoch); return io.original(item.id); }).finally(() => { pending--; cleanup(); });
      try { stored = await interruptible(reading,controller.signal); }
      catch (e) { if (controller.signal.aborted) throw abortError(); throw error('ORIGINAL_UNAVAILABLE', 'Не удалось прочитать исходный файл.',{assetId:item.id},e); }
      current(epoch);
      if (!stored) throw error('MISSING_ORIGINAL', 'Исходный файл отсутствует. Выберите оригинал повторно.',{assetId:item.id});
      if (!(stored.blob instanceof Blob) || !stored.blob.size || (stored.id != null && stored.id !== item.id)) throw error('ORIGINAL_INVALID', 'Повреждены данные исходного файла.',{assetId:item.id});
      const image = item.kind === 'image', category = stored.kind === 'image';
      if (!['image','voice','music'].includes(stored.kind) || image !== category || (stored.type && stored.type !== stored.blob.type) || (image && stored.blob.type && !['image/png','image/jpeg','image/webp','application/octet-stream'].includes(stored.blob.type)) || (!image && /^image\//.test(stored.blob.type))) throw error('MEDIA_TYPE', 'Тип исходника не соответствует ссылке проекта.',{assetId:item.id});
      const record = { id:item.id,kind:item.kind,blob:stored.blob,decoded:null,originalBytes:0,decodedBytes:0,loading:false,released:false };
      reserve(record,stored.blob.size,0); records.set(item.id,record);
      if(!image&&audioDurationMs!==null&&io.audioWindow&&await loadWindowAudio(record,epoch))return;
      current(epoch);
      let budget;
      if (image) {
        pending++; record.loading = true;
        const header = Promise.resolve().then(() => { current(epoch); return dimensions(record.blob); }).finally(() => { record.loading = false; pending--; cleanup(); });
        let size; try { size = await interruptible(header,controller.signal); } catch(e) { current(epoch); throw error(e.code || 'IMAGE_HEADER',e.message,{assetId:item.id},e); }
        current(epoch); const pixels = size[0] * size[1];
        if (!size[0] || !size[1] || !Number.isSafeInteger(pixels) || pixels > 40000000 || pixels + imagePixels > limits.maxImagePixels) throw error('IMAGE_BUDGET', 'Разрешение изображений превышает рабочий бюджет runtime-сессии.',{assetId:item.id});
        imagePixels += pixels; record.imagePixels = pixels; budget = pixels * 4;
      } else budget = limits.maxAudioBytes;
      reserve(record,0,budget); pending++; record.loading = true;
      const operation = scheduled(async () => {
        current(epoch);
        let decoded;
        try {
          decoded = await (image ? io.image(record.blob) : io.audio(record.blob));
          current(epoch);
          const bytes = image ? (decoded.width * decoded.height * 4) : decoded.length * decoded.numberOfChannels * 4;
          if (!Number.isSafeInteger(bytes) || bytes <= 0 || (!image && bytes > limits.maxAudioBytes) || (image && bytes !== budget)) throw error('DECODED_BUDGET', image?'Размер декодированного изображения не совпадает с заголовком.':`Полный PCM аудио требует ${(bytes/MIB).toFixed(1)} МиБ; предел ${limits.maxAudioBytes/MIB} МиБ на дорожку. Для этого контейнера подготовка короткого участка пока не поддерживается.`,{assetId:item.id,decodedBytes:bytes,maxAudioBytes:limits.maxAudioBytes});
          reserve(record,0,bytes - budget); record.decoded = decoded; decoded = null;
        } catch (e) {
          if (controller.signal.aborted) throw abortError();
          throw error(e.code || (image ? 'IMAGE_DECODE' : 'AUDIO_DECODE'),e.message || 'Не удалось декодировать исходник.',{assetId:item.id},e);
        } finally { if (image && decoded) decoded.dispose(); }
      },controller.signal).finally(() => { record.loading = false; pending--; cleanup(); });
      await interruptible(operation,controller.signal); current(epoch);
    }
    function prepare(requirements, { signal } = {}) {
      if (terminal()) return Promise.reject(error('STATE', 'Создайте новую сессию для повторной подготовки.'));
      if (preparation) return preparation;
      if (state !== 'created') return Promise.reject(error('STATE', 'Создайте новую сессию для повторной подготовки.'));
      state = 'preparing'; const epoch = ++generation;
      const stop = () => close('cancelled',abortError());
      signal?.addEventListener('abort',stop,{once:true}); if (signal?.aborted) stop();
      preparation = (async () => {
        try {
          const unique = new Map();
          for (const item of requirements) {
            if (!item || typeof item.id !== 'string' || !item.id || item.id.length>200 || /[\u0000-\u0020\u007f]/.test(item.id) || /^(blob:|data:)|:\/\//i.test(item.id) || !['image','audio'].includes(item.kind)) throw error('REFERENCES','Некорректная постоянная ссылка runtime-медиа.');
            if (unique.has(item.id) && unique.get(item.id).kind !== item.kind) throw error('REFERENCES','Один исходник указан как изображение и аудио.');
            unique.set(item.id,{...item});
          }
          if ([...unique.values()].filter(x=>x.kind==='image').length > limits.maxImages) throw error('IMAGE_COUNT','Слишком много уникальных изображений для рабочего набора runtime-сессии.');
          for (const item of unique.values()) { current(epoch); await load(item,epoch); }
          current(epoch); state = 'ready'; return identity;
        } catch(e) { if (!terminal()) close('error',e); throw controller.signal.aborted && outcome === 'cancelled' ? abortError() : e; }
        finally { signal?.removeEventListener('abort',stop); cleanup(); }
      })();
      return preparation;
    }
    function acquire() {
      if (state !== 'ready') throw error('STATE','Медиа не подготовлены или сессия закрыта.');
      consumers++; let returned = false;
      const images = new Map(); for(const [id,r] of records)if(r.kind==='image')images.set(id,r.decoded.image);
      return Object.freeze({ identity, resources:Object.freeze({images,toJSON:noJSON}),
        audio(id) { if (returned) throw error('RELEASED','Ресурсы уже возвращены.'); const r=records.get(id);return r?.kind === 'audio' ? r.decoded : null; },
        release() { if(returned)return;returned=true;images.clear();consumers--;cleanup(); }, toJSON:noJSON });
    }
    return Object.freeze({ identity, prepare, acquire,
      cancel: () => close('cancelled',abortError()), dispose: () => close('disposed'),
      status: () => Object.freeze({state,outcome,generation,consumers,pending,originalBytes,decodedBytes,imagePixels,audioInfo:[...records.values()].filter(r=>r.audioInfo).map(r=>({assetId:r.id,...r.audioInfo})),cleanupPending:terminal()&&!finished,error:cause ? {code:cause.code,message:cause.message,assetId:cause.assetId,causeCode:cause.cause?.code||cause.cause?.name||null} : null}),
      toJSON:noJSON });
  }
  return Object.freeze({ create, DEFAULTS, globalLimits, statistics: () => Object.freeze({sessions:live,residentBytes:resident,peakResidentBytes:peakResident,scratchBytes,peakScratchBytes,audioDecodes,pooledAudio:audioPool.size,decoding,queued:queue.length}) });
});
