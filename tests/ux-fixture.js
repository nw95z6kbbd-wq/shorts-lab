// Test-only fault/latency fixture. The app still uses real IndexedDB transactions.
window.holdUXTransaction = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('shorts-studio.projects', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result, tx = db.transaction(['projects', 'assets'], 'readwrite');
    window.uxHold = true;
    let first = true;
    function pump() {
      const count = tx.objectStore('projects').count();
      count.onsuccess = () => { if (first) { first = false; resolve(); } if (window.uxHold) pump(); };
    }
    tx.oncomplete = () => db.close();
    tx.onabort = () => { db.close(); reject(tx.error); };
    pump();
  };
});
window.quotaUXFailure = () => {
  window.uxPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'projects') throw new DOMException('UX quota test', 'QuotaExceededError');
    return window.uxPut.apply(this, args);
  };
};
window.restoreUXQuota = () => { IDBObjectStore.prototype.put = window.uxPut; };

void 0;
