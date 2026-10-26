// Native Safari fixture: real PNG/WAV Blobs, saved through the production adapter.
window.savePersistenceFixture = async function () {
  function wav(frequency) {
    const rate = 16000, count = rate * 4, buffer = new ArrayBuffer(44 + count * 2), d = new DataView(buffer);
    const text = (offset, value) => [...value].forEach((c, i) => d.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); d.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true);
    d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); text(36, 'data'); d.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) d.setInt16(44 + i * 2, 2500 * Math.sin(2 * Math.PI * frequency * i / rate), true);
    return new Blob([buffer], { type: 'audio/wav' });
  }
  const state = ShortsVideoCore.demo(); state.title = 'Проверка сохранения Safari'; state.timing = 'manual';
  state.scenes = state.scenes.slice(0, 2).map((s, i) => ({ ...s, durationSeconds: 1.5, visual: 'image', imageId: 'safari-image-' + i, imageName: 'image-' + i + '.png', camera: i ? 'pan-left' : 'zoom-in', transition: 'crossfade' }));
  for (const [i, color] of ['#ed563e', '#286cdd'].entries()) {
    const c = document.createElement('canvas'); c.width = 800; c.height = 1200;
    const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    ShortsStorage.stage('safari-image-' + i, blob, 'image-' + i + '.png', 'image');
  }
  for (const [role, frequency] of [['voice', 440], ['music', 880]]) {
    state[role + 'AssetId'] = 'safari-' + role; state[role + 'Name'] = role + '.wav';
    ShortsStorage.stage('safari-' + role, wav(frequency), role + '.wav', role);
  }
  state.volume = .65; state.musicVolume = .45; state.musicFadeIn = .2; state.musicFadeOut = .3;
  const saved = await ShortsStorage.save(state, 'video'); if (!saved.ok) throw Error(saved.error);
  return window.persistenceFixtureSnapshot();
};
window.persistenceFixtureSnapshot = async function () {
  const db = ShortsProjectDB.createRepository(), record = await db.read('video'), hashes = {};
  for (const id of ShortsProjectDB.references('video', record.state)) {
    const asset = await db.asset(id);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()));
    hashes[id] = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  db.close(); return { state: record.state, hashes };
};
