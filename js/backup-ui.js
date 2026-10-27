(function () {
  'use strict';
  const $=id=>document.getElementById(id), F=window.ShortsBackupFormat, Z=window.ShortsZip;
  const dialog=$('backupDialog');let running=false, mode='', cancelled=false, committed=false, background=false, downloadUrl='', prepared=null, opener, hasView=false;
  const retired=new Set();
  function retire(url) { if(!url)return;retired.add(url);setTimeout(()=>{URL.revokeObjectURL(url);retired.delete(url);},30000); }
  function status(text) { document.querySelectorAll('[data-backup-status]').forEach(node=>{node.textContent=text;node.title=text;}); }
  function returnFocus(){const target=opener?.getClientRects().length?opener:[...document.querySelectorAll(mode==='import'?'[data-backup-import]':'[data-backup-export]')].find(node=>node.getClientRects().length);target?.focus();}
  function show() { background=false;if(!dialog.open)dialog.showModal(); }
  function reset(title) {
    retire(downloadUrl);downloadUrl='';prepared=null;hasView=true;cancelled=false;committed=false;background=false;
    $('backupTitle').textContent=title;$('backupError').hidden=true;$('backupWarnings').replaceChildren();$('backupProgress').hidden=false;$('backupProgress').value=0;
    for(const id of ['backupDownload','backupConfirm','backupBackground','backupFresh','backupOpen'])$(id).hidden=true;
    $('backupCancel').disabled=false;$('backupCancel').textContent='Отмена';show();
  }
  function progress(text,value) { if(cancelled)throw new DOMException('Операция отменена.','AbortError');$('backupMessage').textContent=text;$('backupProgress').value=Math.round(value*100);status(text); }
  function error(cause) {
    $('backupError').textContent=(cause instanceof RangeError?'Недостаточно памяти для ZIP. Используйте меньший проект или другое устройство.':cause.message || 'Браузер не смог подготовить ZIP.')+' Исходные данные не удалены.';
    $('backupError').hidden=false;$('backupConfirm').hidden=true;$('backupProgress').hidden=true;$('backupCancel').textContent='Закрыть';$('backupBackground').hidden=true;status('Ошибка ZIP — откройте панель для подробностей.');
  }
  async function ready() { await window.ShortsEditorReady;if(!window.ShortsVideoRestored)throw new Error('Дождитесь восстановления исходных медиа после открытия страницы.');window.ShortsVideoBackup.assertIdle(); }
  async function exportZip(button) {
    opener=button;
    if(running || hasView){show();return;}
    reset('Резервная ZIP-копия');running=true;mode='export';
    try {
      await ready();progress('Фиксируем оба черновика и исходные файлы…',0);
      // Both snapshots are taken in the same JS turn. A loading/recording video
      // is rejected; all Blob references are acquired before background editing.
      const projects=F.states({editor:window.ShortsEditor.backupSnapshot(),video:window.ShortsVideoBackup.snapshot()},[],false);
      const assets=await window.ShortsStorage.captureBackup(projects,Z.LIMITS.archive);
      $('backupBackground').hidden=false;
      const media=new Map([...F.usage(projects)].map(([id,kind])=>[id,{...assets.get(id),kind}]));
      await validateMedia({assets:media});
      const archive=await F.exportArchive(projects,assets,window.ShortsProduct.version,p=>progress('Подготовка ZIP: '+Math.round(p*100)+'%',.15+.8*p));
      // WebKit's download process can stall on a Blob assembled from nested
      // Blob parts. Give the download URL one materialized, bounded byte buffer.
      // This changes neither ZIP bytes nor originals; budget one extra archive.
      progress('Подготавливаем совместимое скачивание ZIP…',.97);
      const blob=new Blob([await archive.arrayBuffer()],{type:'application/zip'});
      if(cancelled)throw new DOMException('Отмена','AbortError');
      downloadUrl=URL.createObjectURL(blob);$('backupDownload').href=downloadUrl;$('backupDownload').download=window.ShortsCore.fileName(projects.editor.name)+'.shorts.zip';$('backupDownload').hidden=false;
      progress('ZIP готов: оба черновика и исходные файлы зафиксированы при создании копии. Позднейшие правки в неё не входят. Нажмите «Скачать ZIP-копию».',1);$('backupFresh').hidden=false;$('backupBackground').hidden=true;$('backupCancel').textContent='Закрыть';
    } catch(cause) { if(cause.name!=='AbortError')error(cause); }
    finally { running=false;if(cancelled){retire(downloadUrl);downloadUrl='';prepared=null;status('ZIP отменён.');} }
  }
  async function validateMedia(bundle) {
    for(const asset of bundle.assets.values()) {
      progress('Проверяем исходники: '+asset.name, mode==='export'?.1:.65);
      if(asset.kind==='image') {const decoded=await window.ShortsVideoMedia.decodeImage(asset.blob);decoded.dispose();}
      else await window.ShortsVideoRecorder.decodeAudio(asset.blob);
    }
  }
  async function importZip(file, button) {
    if(running)return;opener=button;reset('Восстановление из ZIP');running=true;mode='import';
    try {
      await ready();window.ShortsEditor.pause();progress('Проверяем структуру и контрольные суммы ZIP…',0);
      const bundle=await F.importArchive(file,p=>progress('Проверяем ZIP: '+Math.round(p*60)+'%',p*.6));
      await validateMedia(bundle);if(cancelled)throw new DOMException('Отмена','AbortError');
      prepared=await F.remap(bundle);if(cancelled){prepared=null;throw new DOMException('Отмена','AbortError');}
      $('backupMessage').textContent='Будут заменены ОБА текущих черновика, включая несохранённые правки (сейчас: «'+$('projectName').value+'» и «'+$('videoTitle').value+'»). В ZIP: Студия «'+bundle.projects.editor.name+'»; видео: «'+bundle.projects.video.title+'». Исходников: '+bundle.assets.size+'. После успешной записи страница перезагрузится. Сначала скачайте текущую ZIP-копию, если она нужна.';
      for(const warning of bundle.warnings){const item=document.createElement('li');item.textContent=warning;$('backupWarnings').append(item);}
      $('backupProgress').hidden=true;$('backupConfirm').hidden=false;status('ZIP проверен. Ожидается подтверждение замены.');
    } catch(cause){if(cause.name!=='AbortError')error(cause);}
    finally{running=false;if(cancelled){prepared=null;status('Восстановление отменено.');}}
  }
  $('backupConfirm').addEventListener('click',async()=>{
    if(!prepared || running)return;running=true;
    try {
      await ready();$('backupConfirm').hidden=true;$('backupCancel').disabled=true;$('backupProgress').hidden=false;progress('Атомарно записываем оба черновика и медиа…',.85);
      await window.ShortsStorage.restoreBackup(prepared.projects,prepared.assets);committed=true;
      progress('Оба черновика восстановлены. Открываем сохранённые данные…',1);
      // Gate stays closed through pagehide, so old controller timers cannot write
      // stale projects over the committed imported originals.
      $('backupOpen').hidden=false;
      try{location.reload();}catch(_){$('backupMessage').textContent='Данные уже записаны. Нажмите «Открыть восстановленные проекты» или перезагрузите страницу.';}
    } catch(cause){$('backupCancel').disabled=false;prepared=null;error(cause);}
    finally{running=false;}
  });
  document.querySelectorAll('[data-backup-export]').forEach(button=>button.addEventListener('click',()=>exportZip(button)));
  document.querySelectorAll('[data-backup-import]').forEach(button=>button.addEventListener('click',()=>{if(running){show();return;}opener=button;$('backupFile').click();}));
  $('backupFile').addEventListener('change',()=>{const file=$('backupFile').files[0];$('backupFile').value='';if(file)importZip(file,opener);});
  $('backupOpen').addEventListener('click',()=>location.reload());
  $('backupFresh').addEventListener('click',()=>{hasView=false;exportZip(opener);});
  $('backupBackground').addEventListener('click',()=>{background=true;dialog.close();});
  $('backupCancel').addEventListener('click',()=>{if(!committed)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(committed || $('backupCancel').disabled)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    if(dialog.open)return; // Ignore an earlier close event after immediate reopen.
    if(background){background=false;returnFocus();return;}
    if(committed)return;hasView=false;cancelled=true;prepared=null;retire(downloadUrl);downloadUrl='';
    if(!running)status('ZIP-копия включает оба режима.');returnFocus();
  });
  window.addEventListener('pagehide',()=>{if(downloadUrl)URL.revokeObjectURL(downloadUrl);for(const url of retired)URL.revokeObjectURL(url);});
})();
