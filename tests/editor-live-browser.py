"""Real single-Canvas Editor UI, independently validated profiles, originals and lifecycle."""
import functools,json,os,shutil,tempfile,threading,time,struct
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
from backup_assets import media_payload
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass

def run():
 engine=os.environ.get('LIVE_BROWSER','chromium');entry=os.environ.get('LIVE_ENTRY','index.html');mobile=os.environ.get('LIVE_MOBILE')=='1'
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/';errors=[]
 payload=media_payload();spec=json.loads((ROOT/'tests/fixtures/editor-canvas/spec.json').read_text());template=(ROOT/'tests/fixtures/editor-canvas/reference.svg').read_text()
 try:
  with tempfile.TemporaryDirectory(prefix='editor-live-') as profile,sync_playwright() as p:
   options={'viewport':{'width':390,'height':844} if mobile else {'width':1440,'height':1000},'accept_downloads':True}
   if engine!='webkit':options.update(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
   def launch():
    context=getattr(p,engine).launch_persistent_context(profile,**options);context.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))));return context
   def helpers(page):
    for f in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js']:page.add_script_tag(content=(ROOT/'tests'/f).read_text())
   def open_app(page):
    if entry.startswith('downloads/'):
     def offline(route):
      if route.request.url.endswith('/offline.html'):route.fulfill(body=(ROOT/entry).read_bytes(),content_type='text/html')
      elif route.request.url.startswith(('blob:','data:')):route.continue_()
      else:route.abort()
     page.route('**/*',offline);page.goto(base+'offline.html')
    else:page.goto(base+entry)
    page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');helpers(page)
   context=launch();page=context.new_page();open_app(page);page.evaluate('editorLiveReady()');assert page.locator('#scriptStudio canvas').count()==1
   original=page.evaluate('ShortsEditor.backupSnapshot()');assert original['version']==1
   page.add_script_tag(content=(ROOT/'tests/editor-canvas-fixture.js').read_text());independent=page.evaluate('args=>checkEditorCanvas(...args)',[spec,template,payload]);assert independent['combinations']==27
   accepted=page.evaluate('editorCanvasCaptures');profiles=page.evaluate('([captures,spec])=>editorLiveVerifyProfiles(captures,spec)',[accepted,spec]);assert profiles['combinations']==27
   assert page.evaluate('args=>rejectEditorVisualMutants(...args)',[spec,template,payload])==3
   print(f'PASS [{engine} live Canvas]: actual UI 27 profiles match independent SVG-accepted RGBA; three visual mutants rejected',flush=True)
   project=page.evaluate('''()=>{const p=ShortsCore.upgradeProject(ShortsCore.createProject());p.name='Live images';p.timing='manual';p.scenes=[0,1,2].map(i=>({id:'image-scene-'+i,text:'',durationMs:1000,visual:'animated',imageId:null,imageName:'',camera:'zoom-in',transition:'crossfade'}));p.selectedSceneId=p.scenes[0].id;return p;}''');page.evaluate('p=>editorLiveImport(p)',project);page.locator('#tab-scenes').click()
   ids=[]
   for i,f in enumerate(payload[:3]):
    target=page.locator('.studio-image-controls input').nth(i);target.set_input_files({'name':f['name'],'mimeType':f['type'],'buffer':__import__('base64').b64decode(f['base64'])});page.wait_for_function('i=>document.querySelectorAll(".studio-image-state")[i].dataset.state==="ready"',arg=i);page.evaluate('id=>editorLiveReady(id)',project['scenes'][i]['id']);ids.append(page.evaluate('i=>ShortsEditor.backupSnapshot().scenes[i].imageId',i))
   assert len(set(ids))==3;assert page.evaluate('editorTimingWaitForSave()');saved=page.evaluate('studioUiSnapshot()');assert page.evaluate('ShortsMediaSessions.statistics().sessions')==1
   # Five supported cameras and four transitions use exact shared renderer pixels.
   for camera in ['static','zoom-in','zoom-out','pan-left','pan-right']:
    page.locator('.studio-scene-camera').first.select_option(camera);page.evaluate('editorLiveReady()');assert page.evaluate('p=>editorLiveFrameReference(p)',payload)
   for transition in ['none','crossfade','slide','zoom']:
    page.locator('.studio-scene-transition').nth(1).select_option(transition);page.evaluate('editorLiveReady()');assert page.evaluate('p=>editorLiveFrameReference(p)',payload)
   page.evaluate('editorTimingWaitForSave()');before=page.evaluate('studioUiSnapshot()');page.locator('.studio-move').nth(1).click();page.evaluate('editorTimingWaitForSave()');after=page.evaluate('studioUiSnapshot()');assert {s['id']:s for s in before['editor']['scenes']}=={s['id']:s for s in after['editor']['scenes']};assert before['hashes']==after['hashes'] and before['video']==after['video']
   # Invalid content and declared MIME do not replace the saved original.
   old=page.evaluate('ShortsEditor.backupSnapshot().scenes[0].imageId')
   corrupt=__import__('base64').b64decode(payload[0]['base64'])[:33]+struct.pack('>I',3)+b'IDATbad'+bytes(4)+struct.pack('>I',0)+b'IEND'+bytes(4)
   for content,mime in [(b'not a PNG','image/png'),(__import__('base64').b64decode(payload[0]['base64']),'image/jpeg'),(corrupt,'image/png')]:
    page.locator('.studio-image-controls input').first.set_input_files({'name':'bad.png','mimeType':mime,'buffer':content});page.wait_for_function('["error","ready"].includes(document.querySelector(".studio-image-state").dataset.state)');assert page.locator('.studio-image-state').first.get_attribute('data-state')=='error', page.locator('.studio-image-state').first.inner_text();assert page.evaluate('ShortsEditor.backupSnapshot().scenes[0].imageId')==old;assert page.evaluate('studioUiSnapshot()')['hashes']==after['hashes']
   page.locator('#sceneList .scene-select').first.click();page.evaluate('editorLiveReady()')
   # Replace, retain an inactive image, restore it, then explicit removal.
   f=payload[2];page.locator('.studio-image-controls input').first.set_input_files({'name':f['name'],'mimeType':f['type'],'buffer':__import__('base64').b64decode(f['base64'])});page.wait_for_function('document.querySelector(".studio-image-state").dataset.state==="ready"');page.evaluate('editorLiveReady()');replacement=page.evaluate('ShortsEditor.backupSnapshot().scenes[0].imageId');assert replacement!=old
   page.locator('.studio-scene-visual').first.select_option('animated');page.evaluate('editorLiveReady()');assert page.evaluate('ShortsEditor.backupSnapshot().scenes[0].imageId')==replacement
   page.locator('.studio-scene-visual').first.select_option('image');page.evaluate('editorLiveReady()');page.locator('.studio-image-controls').first.get_by_role('button',name='Удалить изображение').click();page.evaluate('editorLiveReady()');assert page.evaluate('ShortsEditor.backupSnapshot().scenes[0].imageId') is None
   # Real playback and a bounded single owner after repeated Play/Pause.
   for i in range(3):
    page.locator('#playPreview').click();expect(page.locator('#playPreview')).to_have_attribute('aria-label','Приостановить предпросмотр');page.locator('#playPreview').click();page.evaluate('editorLiveReady()');assert page.evaluate('ShortsMediaSessions.statistics().sessions')<=1
   page.evaluate('editorLiveSeek(0,"image-scene-1")');page.locator('#playPreview').click();page.wait_for_function('document.querySelector("#timelineProgress").style.width==="100%"',timeout=15000);expect(page.locator('#playPreview')).to_have_attribute('aria-label','Воспроизвести предпросмотр')
   # Overflow is visible; neither placeholder text nor clipped frames are painted.
   page.locator('#scene-input-0').fill('Слишком длинный текст '*500);page.wait_for_function('document.getElementById("editorPreviewMessage").dataset.code==="TEXT_OVERFLOW"');expect(page.locator('#editorCanvas')).to_be_hidden();expect(page.locator('#editorPreviewMessage')).to_contain_text('Сцена 1')
   page.locator('#scene-input-0').fill('');page.evaluate('editorLiveReady()');assert page.locator('#previewText').inner_text()==''
   page.locator('#tab-subtitles').click();page.locator('#editorSubtitlesEnabled').uncheck();page.evaluate('editorLiveReady()');assert page.evaluate('editorTimingAssert().srt')=='';page.locator('#editorSubtitlesEnabled').check();page.locator('#tab-scenes').click()
   page.locator('.studio-scene-duration').first.fill('-1');expect(page.locator('#editorTimingError')).to_be_visible();expect(page.locator('#editorCanvas')).to_be_hidden();page.locator('.studio-scene-duration').first.fill('1');page.evaluate('editorLiveReady()')
   page.evaluate('editorTimingWaitForSave()');before=page.evaluate('studioUiSnapshot()');context.close();context=launch();page=context.new_page();open_app(page);page.evaluate('editorLiveReady()');assert page.evaluate('studioUiSnapshot()')==before
   page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible();bundle=page.evaluate('async()=>{const b=await ShortsBackupFormat.importArchive(await(await fetch(backupDownload.href)).blob());return {version:b.manifest.version,projects:b.projects,assets:b.assets.size};}');assert bundle['version']==2 and bundle['projects']['editor']==before['editor'] and bundle['assets']>=2;page.locator('#backupCancel').click()
   # Independent browser context actually imports the ZIP through the UI.
   pixel_before=page.evaluate('editorLiveHash()');page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible()
   with page.expect_download() as download:page.locator('#backupDownload').click()
   archive=Path(profile)/'live.shorts.zip';download.value.save_as(archive);page.locator('#backupCancel').click()
   fresh_browser=getattr(p,engine).launch(**{k:v for k,v in options.items() if k in ['executable_path','args']});fresh=fresh_browser.new_context(viewport=options['viewport']);target=fresh.new_page();open_app(target);target.locator('#backupFile').set_input_files(archive);expect(target.locator('#backupConfirm')).to_be_visible()
   with target.expect_navigation(wait_until='load'):target.locator('#backupConfirm').click()
   target.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');helpers(target);target.evaluate('editorLiveReady()');transferred=target.evaluate('studioUiSnapshot()')
   assert sorted(transferred['hashes'].values())==sorted(before['hashes'].values());assert [s['id'] for s in transferred['editor']['scenes']]==[s['id'] for s in before['editor']['scenes']];assert target.evaluate('editorLiveHash()')==pixel_before;fresh.close();fresh_browser.close()
   page.locator('#openVideoMode').click();page.wait_for_function('ShortsMediaSessions.statistics().sessions===0');page.locator('#backToEditor').click();page.evaluate('editorLiveReady()');assert page.evaluate('studioUiSnapshot()')==before
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   # Missing originals fail visibly and leave committed projects/media intact.
   bad=page.evaluate('()=>{const p=ShortsEditor.backupSnapshot();p.id=ShortsCore.id();p.name="Missing original";p.selectedSceneId=p.scenes[0].id;p.scenes[0].visual="image";p.scenes[0].imageId="absent-original";return p;}');page.evaluate('p=>editorLiveImport(p)',bad)
   page.wait_for_function('editorPreviewMessage.dataset.code==="MISSING_ORIGINAL"');expect(page.locator('#editorCanvas')).to_be_hidden();assert page.evaluate('studioUiSnapshot()')==before
   # 5000-scene UI with real originals: only the selected window is resolved.
   large=page.evaluate('p=>{p=structuredClone(p);p.id=ShortsCore.id();p.name="Large bounded preview";p.scenes=Array.from({length:5000},(_,i)=>({...p.scenes[1+i%2],id:"large-"+i,text:""}));p.selectedSceneId="large-4000";return p;}',before['editor'])
   page.evaluate('window.liveStorage=ShortsStorage;window.liveReads=[];window.ShortsStorage=Object.freeze({...liveStorage,asset:async id=>{liveReads.push(id);return liveStorage.asset(id);}})')
   page.evaluate('p=>editorLiveImport(p)',large);page.evaluate('editorLiveReady("large-4000")');assert page.locator('#scriptStudio canvas').count()==1;assert page.locator('.studio-image-controls img').count()==0;assert page.evaluate('liveReads.length')<=2;assert page.evaluate('ShortsMediaSessions.statistics().sessions')==1
   page.evaluate('''()=>{const original=ShortsVideoMedia.decodeImage;window.releaseLiveDecode=false;window.liveDecodeStarted=false;window.restoreLiveDecode=()=>ShortsVideoMedia.decodeImage=original;ShortsVideoMedia.decodeImage=async blob=>{liveDecodeStarted=true;while(!releaseLiveDecode)await new Promise(r=>setTimeout(r,10));return original(blob);};}''')
   # A new content revision starts a real gated native decode, then gets cancelled.
   page.locator('#tab-scenes').click();page.locator('.studio-scene-camera').nth(4000).select_option('pan-left');page.wait_for_function('window.liveDecodeStarted');page.locator('#nextScene').click();page.locator('#prevScene').click();page.evaluate('()=>{window.releaseLiveDecode=true;restoreLiveDecode();}');page.evaluate('editorLiveReady("large-4000")')
   page.locator('#openVideoMode').click();page.wait_for_function('ShortsMediaSessions.statistics().sessions===0 && ShortsMediaSessions.statistics().residentBytes===0');page.locator('#backToEditor').click();page.evaluate('editorLiveReady("large-4000")')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors;context.close()
   print(f'PASS [{engine} {entry} mobile={mobile}]: actual image/camera/transition frames, PNG/JPG/WebP originals, replace/remove/inactive refs, stable reorder, invalid files, overflow, seek/play/pause/end, reload/ZIP and mode teardown',flush=True)
 finally:server.shutdown();server.server_close()
if __name__=='__main__':run()
