// Test-only fault/latency fixture. The app still uses real IndexedDB transactions.
window.holdUXTransaction = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('shorts-studio.projects', ShortsProjectDB.DATABASE_VERSION);
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

window.uxLayoutSnapshot = () => {
  const rect = element => {
    const box = element.getBoundingClientRect();
    return ['x', 'y', 'width', 'height'].map(key => Math.round(box[key] * 1000) / 1000);
  };
  const view = document.getElementById('studioViewport');
  return {
    document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, document.body.scrollWidth, document.body.scrollHeight, scrollX, scrollY],
    viewport: [view.clientWidth, view.clientHeight, view.scrollWidth, view.scrollHeight, view.scrollLeft, view.scrollTop],
    blocks: [...document.querySelectorAll('#mainContent,.workspace,.studio-grid,.video-grid,.preview-column,.video-preview-column,.editor-column,.video-editor,#portrait,#videoCanvas,#generatedVideo')].filter(e => e.getClientRects().length).map(e => [e.id || e.className, rect(e)])
  };
};
window.uxToastOverlapsControls = () => {
  const toast = document.getElementById('saveStatus').getBoundingClientRect();
  return [...document.querySelectorAll('#downloadVideo,#recordVideo,#cancelVideo,#playGeneratedPreview,#playPreview,#videoSeek')].filter(e => e.getClientRects().length).some(e => {
    const r = e.getBoundingClientRect();
    return Math.min(toast.right, r.right) > Math.max(toast.left, r.left) && Math.min(toast.bottom, r.bottom) > Math.max(toast.top, r.top);
  });
};
void 0;

// Geometry only: no project text, filenames or source media in CI diagnostics.
window.uxPreviewGeometry = () => {
  const rect = e => {const r=e.getBoundingClientRect();return Object.fromEntries(['x','y','top','bottom','width','height'].map(k=>[k,r[k]]));};
  const elements={};
  for(const selector of ['#studioViewport','.workspace','#mainContent','.studio-grid','.preview-column','.preview-panel','.portrait-wrap','#portrait','#editorCanvas','.playback','#editorSeek','.preview-note','.appearance-panel']){
    const e=document.querySelector(selector),s=getComputedStyle(e);
    elements[selector]={rect:rect(e),client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight,e.scrollLeft,e.scrollTop],css:{position:s.position,top:s.top,width:s.width,height:s.height,minHeight:s.minHeight,aspectRatio:s.aspectRatio,overflow:s.overflow,display:s.display,alignItems:s.alignItems,alignSelf:s.alignSelf,flexShrink:s.flexShrink,mediaHeight:s.getPropertyValue('--preview-media-height')},className:e.className};
  }
  return {userAgent:navigator.userAgent,inner:[innerWidth,innerHeight],document:[document.documentElement.clientWidth,document.documentElement.clientHeight,document.documentElement.scrollWidth,document.documentElement.scrollHeight,scrollX,scrollY],visual:visualViewport&&{width:visualViewport.width,height:visualViewport.height,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft,scale:visualViewport.scale},devicePixelRatio,elements};
};
