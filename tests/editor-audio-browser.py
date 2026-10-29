"""Actual audio controls, mixed signals, persistent restart and ZIP transfer."""
import base64,functools,json,os,shutil,tempfile,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
from backup_assets import media_payload
from editor_audio_checks import check_editor_audio,audio_helpers
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
def run():
 engine=os.environ.get('EDITOR_AUDIO_BROWSER','chromium');mobile=os.environ.get('EDITOR_AUDIO_MOBILE')=='1';entry=os.environ.get('EDITOR_AUDIO_ENTRY','index.html')
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/';errors=[]
 try:
  with tempfile.TemporaryDirectory(prefix='editor-audio-') as profile,sync_playwright() as p:
   opts={'viewport':{'width':390,'height':844} if mobile else {'width':1440,'height':1000}}
   if engine=='chromium':opts.update(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
   def launch():return getattr(p,engine).launch_persistent_context(profile,**opts)
   def open_app(page):
    page.on('pageerror',lambda e:errors.append(str(e)));page.goto(base+entry);page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');audio_helpers(ROOT,lambda s:page.add_script_tag(content=s))
   context=launch();page=context.new_page();open_app(page)
   def execute(code,args=None):
    try:return page.evaluate('([code,args])=>new Function("return (async function(){"+code+"}).apply(null,arguments)").apply(null,args)',[code,args or []])
    except Exception:
     state=page.evaluate('''()=>({audio:editorAudioState.textContent,preview:portrait.dataset.previewState,label:playPreview.getAttribute('aria-label'),seek:editorSeek.value,time:editorCanvas.dataset.timeMs,scene:editorCanvas.dataset.sceneId,taps:window.editorAudioTaps?.slice(-8).map(t=>({offset:t.options.offsetSeconds,when:t.when,now:t.context.currentTime,context:t.context.state,stopped:t.stopped})),errors:document.getElementById('editorTimingErrorText').textContent,media:ShortsMediaSessions.statistics()})''')
     print('::error title=Editor audio state::'+json.dumps({'engine':engine,'mobile':mobile,'phase':code[:120],'state':state}).replace('%','%25'),flush=True);raise
   result=check_editor_audio(execute,lambda selector:page.locator(selector).click(),media_payload());saved=result.pop('saved');print('PASS actual audio: '+json.dumps(result),flush=True)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   context.close();context=launch();page=context.new_page();open_app(page);page.evaluate('editorLiveReady()');page.evaluate('editorAudioReady()');assert page.evaluate('studioUiSnapshot()')==saved
   page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible()
   with page.expect_download() as download:page.locator('#backupDownload').click()
   archive=Path(profile)/'audio.shorts.zip';download.value.save_as(archive);page.locator('#backupCancel').click()
   bundle=page.evaluate('async b=>{const z=await ShortsBackupFormat.importArchive(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))]));return {version:z.manifest.version,editor:z.projects.editor,assets:z.assets.size};}',base64.b64encode(archive.read_bytes()).decode());assert bundle['version']==2 and bundle['editor']==saved['editor'] and bundle['assets']>=3
   browser=getattr(p,engine).launch(**{k:v for k,v in opts.items() if k in ('executable_path','args')});fresh=browser.new_context(viewport=opts['viewport']);target=fresh.new_page();open_app(target);target.locator('#backupFile').set_input_files(archive);expect(target.locator('#backupConfirm')).to_be_visible()
   with target.expect_navigation(wait_until='load'):target.locator('#backupConfirm').click()
   target.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');audio_helpers(ROOT,lambda s:target.add_script_tag(content=s));target.evaluate('editorAudioReady()');target.evaluate('editorLiveReady()');restored=target.evaluate('studioUiSnapshot()')
   assert sorted(restored['hashes'].values())==sorted(saved['hashes'].values());assert restored['editor']['audio']['voice']['volume']==.4;assert restored['editor']['audio']['music']['fadeInMs']==250
   assert restored['editor']['scenes']==[{**s,'imageId':restored['editor']['scenes'][i]['imageId']} for i,s in enumerate(saved['editor']['scenes'])]
   target.evaluate('editorLiveSeek(0,"audio-scene-0")');target.evaluate('editorAudioTap()');target.locator('#playPreview').click();assert target.evaluate('editorAudioPlaying()')['rms']>.0001;target.locator('#playPreview').click()
   # Missing original is a visible runtime error, not a silent success.
   target.evaluate('''async()=>{const p=ShortsEditor.backupSnapshot();p.id=ShortsCore.id();p.name='Missing audio original';p.audio.voice.assetId='not-in-this-storage';await editorLiveImport(p);await editorAudioReady();audioCheck(editorAudioState.dataset.state==='error'&&editorAudioState.textContent.includes('Исходный файл отсутствует'),'missing original diagnostic');}''')
   assert not errors,errors;fresh.close();browser.close();context.close()
   print(f'PASS [{engine} audio mobile={mobile} {entry}]: voice/music actual UI, live clock and signal, independent gains/fades, pause/resume/seek, cancellation, invalid drafts, full browser restart, ZIP2 clean context, exact original hashes, missing source and mode cleanup',flush=True)
 finally:server.shutdown();server.server_close()
if __name__=='__main__':run()
