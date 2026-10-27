"""Real portable ZIP, original media, fresh origin state, process restart and export."""
import base64
import functools
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import traceback
import greenlet
import tempfile
import time
import threading
import zipfile
from http.server import ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright
from backup_assets import media_payload

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('backup_media',ROOT/'tests/media-browser.py')
media=importlib.util.module_from_spec(spec);spec.loader.exec_module(media)


def profile_zip(files, compression=zipfile.ZIP_STORED):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',compression) as z:
        for name,content in files.items():z.writestr(name,content)
    data=bytearray(out.getvalue());directory=struct.unpack_from('<I',data,len(data)-6)[0]
    for _ in files:
        length,extra,comment=struct.unpack_from('<HHH',data,directory+28);local=struct.unpack_from('<I',data,directory+42)[0]
        struct.pack_into('<H',data,directory+8,0x800);struct.pack_into('<H',data,local+6,0x800);struct.pack_into('<I',data,directory+38,0)
        directory+=46+length+extra+comment
    return bytes(data)


latest_stage='starting'
def checkpoint(stage):
    global latest_stage
    latest_stage=stage
    print('ZIP checkpoint: '+stage,flush=True)


def watchdog(caller,main_thread):
    frames=[caller.gr_frame,sys._current_frames().get(main_thread)]
    detail=latest_stage+'\n'+'\n'.join(''.join(traceback.format_stack(frame,limit=12)) for frame in frames if frame)
    print('::warning title=ZIP blocked-call stack::'+detail.replace('%','%25').replace('\r','%0D').replace('\n','%0A'),flush=True)


def run():
    engine=os.environ.get('BACKUP_BROWSER','chromium')
    watchdog_timer=threading.Timer(75,watchdog,args=(greenlet.getcurrent(),threading.get_ident()));watchdog_timer.daemon=True;watchdog_timer.start()
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(media.checks.Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/shorts-lab/';url=base+os.environ.get('BACKUP_ENTRY','')
    errors=[]
    try:
        with tempfile.TemporaryDirectory(prefix='shorts-zip-') as tmp,sync_playwright() as p:
            folder=Path(tmp);payload=media_payload(folder)
            downloads=folder/'browser-downloads';downloads.mkdir()
            launch={'downloads_path':str(downloads)}
            if engine!='webkit':launch.update(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
            browser=getattr(p,engine).launch(**launch)
            checkpoint(engine+': adapters before fixtures')
            for fail in (False,True):
                gate_context=browser.new_context();gate=gate_context.new_page();gate.goto(base+'tests/fixtures/backup-seed.html')
                for name in ('core.js','video-core.js','project-db.js','storage.js'):gate.add_script_tag(content=(ROOT/'js'/name).read_text())
                for name in ('ux-fixture.js','backup-storage-fixture.js'):gate.add_script_tag(content=(ROOT/'tests'/name).read_text())
                checkpoint(engine+': storage gate '+str(fail))
                assert gate.evaluate('fail=>testBackupStorageGate(fail)',fail);gate_context.close()
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP adapter]: late autosave cannot overwrite restored heads; failed import resumes original queued saving',flush=True)
            context=browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            def seed(page):
                page.goto(base+'tests/fixtures/backup-seed.html')
                for name in ('core.js','video-core.js','project-db.js','storage.js'):
                    page.add_script_tag(content=(ROOT/'js'/name).read_text())
                page.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
                page.evaluate('files=>seedBackupFixture(files)',payload)
                page.goto(url);page.wait_for_function('window.ShortsVideoRestored')
                page.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
            checkpoint(engine+': original media seed')
            seed(page)
            page.add_script_tag(content=(ROOT/'tests/backup-db-fixture.js').read_text())
            checkpoint(engine+': atomic repository')
            assert page.evaluate('testAtomicBackupRepository()')
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP repository]: two-slot rollback on quota/abort, previous media, missing originals, content collision, repeated and concurrent imports',flush=True)
            page.locator('#openVideoMode').click()
            page.add_script_tag(content=(ROOT/'tests/ux-fixture.js').read_text())
            expected=page.evaluate('backupFixtureSnapshot()')
            page.evaluate('holdUXTransaction()')
            page.locator('#videoTitle').fill('ZIP захватывает незавершённое сохранение')
            expected['video']['title']='ZIP захватывает незавершённое сохранение'
            page.evaluate('''()=>{window.backupOriginalDigest=SubtleCrypto.prototype.digest;window.releaseBackupDigest=false;
              SubtleCrypto.prototype.digest=async function(...args){const value=await window.backupOriginalDigest.apply(this,args);window.backupDigestHeld=true;while(!window.releaseBackupDigest)await new Promise(r=>setTimeout(r,10));return value;};}''')
            checkpoint(engine+': pending-save export')
            page.locator('[data-backup-export]:visible').click()
            page.wait_for_timeout(650);expect(page.locator('#backupDownload')).to_be_hidden()
            page.evaluate('window.uxHold=false')
            page.wait_for_function('window.backupDigestHeld')
            page.locator('#backupBackground').click();expect(page.locator('#backupDialog')).to_be_hidden()
            page.locator('#videoTitle').fill('Правка ПОСЛЕ фиксации ZIP')
            page.evaluate('window.releaseBackupDigest=true')
            page.wait_for_function('Boolean(document.getElementById("backupDownload").getAttribute("href"))')
            page.evaluate('()=>{SubtleCrypto.prototype.digest=window.backupOriginalDigest;}')
            page.locator('[data-backup-export]:visible').click()
            checkpoint(engine+': actual ZIP download link')
            prior_downloads=set(downloads.iterdir())
            with page.expect_download() as item:page.locator('#backupDownload').click()
            checkpoint(engine+': ZIP download event received; verify real downloaded bytes')
            caller=greenlet.getcurrent();main_thread=threading.get_ident()
            download_watchdog=threading.Timer(20,watchdog,args=(caller,main_thread));download_watchdog.daemon=True;download_watchdog.start()
            seen_downloads=set()
            # Read the actual browser download directory with a bounded deadline.
            # WebKit can emit its download event but never settle save_as(). No
            # in-memory substitute is accepted: a complete CRC-valid file must
            # have been written by the browser before we copy it for import.
            archive=folder/'portable.shorts.zip';deadline=time.monotonic()+30
            while True:
                candidates=[file for file in downloads.iterdir() if file not in prior_downloads and file.is_file()]
                content=None
                for file in candidates:
                    size=file.stat().st_size
                    if file not in seen_downloads:
                        checkpoint(engine+': download candidate '+file.name+' size '+str(size));seen_downloads.add(file)
                    if size>64*1048576:raise AssertionError('Browser download exceeded ZIP limit: '+str(size))
                    try:
                        data=file.read_bytes()
                        with zipfile.ZipFile(io.BytesIO(data)) as actual:
                            if actual.testzip() is None:content=data;break
                    except (OSError,ValueError,EOFError,zipfile.BadZipFile):pass
                if content is not None:archive.write_bytes(content);break
                if time.monotonic()>=deadline:
                    diagnostic='Browser did not complete ZIP download: '+str([(file.name,file.stat().st_size) for file in candidates])
                    checkpoint(engine+': '+diagnostic)
                    raise AssertionError(diagnostic)
                # Browser/network/driver processes run independently. A Python
                # sleep keeps this disk deadline bounded even if a WebKit page
                # command is blocked by the outstanding download.
                time.sleep(.1)
            download_watchdog.cancel()
            checkpoint(engine+': complete CRC-valid ZIP exists on disk')
            assert item.value.suggested_filename.endswith('.shorts.zip')
            checkpoint(engine+': downloaded filename verified; close preparation dialog')
            try:page.locator('#backupCancel').click(timeout=10000)
            except Exception as cause:
                checkpoint(engine+': close-after-download failed: '+str(cause)[:1200].replace('\n',' '));raise
            checkpoint(engine+': preparation dialog closed')
            expect(page.locator('#videoTitle')).to_have_value('Правка ПОСЛЕ фиксации ZIP')
            with zipfile.ZipFile(archive) as z:
                assert z.testzip() is None
                manifest=json.loads(z.read('manifest.json'));project=json.loads(z.read('project.json'))
                assert project['video']['title']==expected['video']['title']
                assert set(z.namelist())=={'manifest.json','project.json',*(a['path'] for a in manifest['assets'])}
                for source in payload:
                    a=next(a for a in manifest['assets'] if a['name']==source['name']);original=base64.b64decode(source['base64'])
                    assert z.read(a['path'])==original and a['sha256']==hashlib.sha256(original).hexdigest()
                rawfiles={name:z.read(name) for name in z.namelist()}
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP export]: real independent ZIP read by Python, exact PNG/JPG/WebP and WAV bytes/hashes, pending save and immutable background snapshot',flush=True)

            for recoverable in (False,True):
                historical=browser.new_context();hp=historical.new_page();hp.goto(base+'tests/fixtures/backup-seed.html')
                for name in ('core.js','video-core.js','project-db.js'):hp.add_script_tag(content=(ROOT/'js'/name).read_text())
                hp.evaluate("""async data=>{
                  const e=ShortsCore.createProject(),v=ShortsVideoCore.demo();v.scenes[0].imageId='historical-image';v.scenes[0].imageName='historical.png';v.scenes[0].visual='image';
                  const r=ShortsProjectDB.createRepository();await r.migrate([{id:'editor',state:e},{id:'video',state:v}],[],{});r.close();
                  if(data.recoverable)await new Promise((resolve,reject)=>{const q=indexedDB.open('shorts-studio.media.v1',1);q.onupgradeneeded=()=>q.result.createObjectStore('images',{keyPath:'id'});q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,t=db.transaction('images','readwrite');t.objectStore('images').put({id:'historical-image',name:'historical.png',file:new Blob([Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0))],{type:'image/png'})});t.oncomplete=()=>{db.close();resolve();};};});
                }""",{'recoverable':recoverable,'base64':payload[0]['base64']})
                hp.goto(url);hp.wait_for_function('window.ShortsVideoRestored')
                before=hp.evaluate('async()=>{const r=ShortsProjectDB.createRepository();const v=await r.read("video");r.close();return v;}')
                hp.locator('[data-backup-export]:visible').click()
                if recoverable:expect(hp.locator('#backupDownload')).to_be_visible()
                else:expect(hp.locator('#backupError')).to_contain_text('Нет исходного файла')
                assert hp.evaluate('async()=>{const r=ShortsProjectDB.createRepository();const v=await r.read("video");r.close();return v;}')==before
                assert hp.evaluate('async()=>{const r=ShortsProjectDB.createRepository();const v=await r.asset("historical-image");r.close();return v===null;}')
                if recoverable:
                    assert hp.evaluate("""async()=>await new Promise(resolve=>{const q=indexedDB.open('shorts-studio.media.v1',1);q.onsuccess=()=>{const db=q.result,t=db.transaction('images','readonly'),g=t.objectStore('images').get('historical-image');g.onsuccess=()=>resolve(Boolean(g.result?.file?.size));t.oncomplete=()=>db.close();};})""")
                historical.close()
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP legacy]: absent historical originals fail honestly; remaining legacy PNG can be backed up read-only; no old record/marker/media deletion',flush=True)

            def target():return getattr(p,engine).launch_persistent_context(str(folder/'target-profile'),viewport={'width':1440,'height':1000},accept_downloads=True,**launch)
            checkpoint(engine+': new persistent profile import')
            destination=target();dest=destination.new_page();dest.on('pageerror',lambda e:errors.append(str(e)));dest.goto(url);dest.wait_for_function('window.ShortsVideoRestored')
            dest.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
            def db_snapshot():return dest.evaluate('async()=>{const r=ShortsProjectDB.createRepository(),v=[await r.read("editor"),await r.read("video")];r.close();return v;}')
            baseline=db_snapshot()
            def choose(content):dest.locator('#backupFile').set_input_files({'name':'restore.shorts.zip','mimeType':'application/zip','buffer':content})
            def validated():expect(dest.locator('#backupConfirm')).to_be_visible(timeout=30000)
            choose(archive.read_bytes());validated();dest.locator('#backupCancel').click();expect(dest.locator('#backupDialog')).to_be_hidden();assert db_snapshot()==baseline
            # Every malformed archive must leave both actual persisted slots unchanged.
            future=dict(rawfiles);m=json.loads(future['manifest.json']);m['version']=2;future['manifest.json']=json.dumps(m).encode()
            missing=dict(rawfiles);del missing[next(name for name in missing if name.startswith('assets/'))]
            badhash=dict(rawfiles);m=json.loads(badhash['manifest.json']);m['project']['sha256']='0'*64;badhash['manifest.json']=json.dumps(m).encode()
            badpath=dict(rawfiles);name=next(n for n in badpath if n.startswith('assets/'));badpath['../escape.bin']=badpath.pop(name)
            corrupted=bytearray(archive.read_bytes());corrupted[50]^=1
            for name,content in [('future',profile_zip(future)),('missing',profile_zip(missing)),('checksum',profile_zip(badhash)),('path',profile_zip(badpath)),('compressed-bomb',profile_zip({'assets/'+'a'*64+'.bin':bytes(2*1048576)},zipfile.ZIP_DEFLATED)),('truncated',archive.read_bytes()[:-8]),('corrupt',bytes(corrupted))]:
                choose(content);expect(dest.locator('#backupError')).to_be_visible(timeout=15000);assert db_snapshot()==baseline,name;dest.locator('#backupCancel').click()
            choose(archive.read_bytes());validated()
            dest.evaluate('''()=>{window.zipPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='projects'&&value.id==='video')throw new DOMException('full','QuotaExceededError');return window.zipPut.call(this,value);};}''')
            dest.locator('#backupConfirm').click();expect(dest.locator('#backupError')).to_be_visible();assert db_snapshot()==baseline
            dest.evaluate('()=>{IDBObjectStore.prototype.put=window.zipPut;}');dest.locator('#backupCancel').click()
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP import safety]: explicit cancellation, invalid/future/missing/corrupt/unsafe/compressed archives and mid-write quota keep both original slots intact',flush=True)
            choose(archive.read_bytes());validated()
            with dest.expect_navigation(wait_until='load'):dest.locator('#backupConfirm').click()
            dest.wait_for_function('window.ShortsVideoRestored');dest.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
            assert dest.evaluate('backupFixtureSnapshot()')==expected
            dest.locator('#openVideoMode').click();expect(dest.locator('.scene-image-thumb')).to_have_count(3)
            expect(dest.locator('#videoAudioInfo')).to_contain_text('voice.wav');expect(dest.locator('#videoMusicInfo')).to_contain_text('music.wav')
            for width,height in ((320,568),(390,844),(768,480),(1440,900)):
                dest.set_viewport_size({'width':width,'height':height})
                assert dest.locator('[data-backup-export]:visible').count()==1
                def layout():return dest.evaluate('''()=>{const v=document.getElementById('studioViewport');return {width:v.scrollWidth,height:v.scrollHeight,top:v.scrollTop,blocks:['videoWorkspace','videoScenes','videoPreviewPanel'].map(id=>{const e=document.getElementById(id);if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];})};}''')
                before_layout=layout()
                dest.locator('[data-backup-export]:visible').click();expect(dest.locator('#backupDownload')).to_be_visible()
                assert layout()==before_layout,'ZIP progress must not move document or preview'
                dest.locator('#backupDownload').scroll_into_view_if_needed()
                assert dest.locator('#studioViewport').evaluate('e=>e.scrollWidth<=e.clientWidth')
                assert dest.locator('#backupDialog').evaluate('e=>e.scrollWidth<=e.clientWidth')
                dest.locator('#backupDownload').focus();dest.keyboard.press('Tab')
                assert dest.evaluate('backupDialog.contains(document.activeElement)'),'keyboard stays inside modal'
                dest.keyboard.press('Escape');expect(dest.locator('#backupDialog')).to_be_hidden()
                assert dest.evaluate('document.activeElement.matches("[data-backup-export]")'),'focus returns to visible project action'
                assert layout()==before_layout,'closing ZIP must not move document or preview'
            dest.set_viewport_size({'width':1440,'height':1000})
            original_ids=dest.evaluate('async()=>{const r=ShortsProjectDB.createRepository(),v=await r.read("video");r.close();return ShortsProjectDB.references("video",v.state);}')
            choose(archive.read_bytes());validated()
            with dest.expect_navigation(wait_until='load'):dest.locator('#backupConfirm').click()
            dest.wait_for_function('window.ShortsVideoRestored');dest.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
            assert dest.evaluate('backupFixtureSnapshot()')==expected
            assert dest.evaluate('async()=>{const r=ShortsProjectDB.createRepository(),v=await r.read("video");r.close();return ShortsProjectDB.references("video",v.state);}')==original_ids
            checkpoint(engine+': full process restart')
            destination.close();destination=target();dest=destination.new_page();dest.on('pageerror',lambda e:errors.append(str(e)));dest.goto(url);dest.wait_for_function('window.ShortsVideoRestored');dest.add_script_tag(content=(ROOT/'tests/backup-fixture.js').read_text())
            assert dest.evaluate('backupFixtureSnapshot()')==expected
            dest.locator('#openVideoMode').click();expect(dest.locator('.scene-image-thumb')).to_have_count(3)
            dest.locator('#playGeneratedPreview').click();dest.wait_for_function('document.getElementById("videoPreviewTime").textContent.startsWith("0:01")');dest.locator('#playGeneratedPreview').click()
            if dest.evaluate('ShortsVideoRecorder.capabilities(true,"webm").supported'):
                recording=media.record(dest,folder,'zip-restored',6);voice,music=media.spectrum(recording,1)
                assert voice>.015 and music>.01,(voice,music)
                r=media.average_rgb(recording,.5);b=media.average_rgb(recording,2.7);g=media.average_rgb(recording,4.8)
                assert r[0]>r[2]*1.5 and b[2]>b[0]*1.5 and g[1]>g[0]*1.5,(r,b,g)
                media.no_black_frames(recording)
                ready_href=dest.locator('#downloadVideo').get_attribute('href');ready_info=dest.locator('#videoFileInfo').inner_text()
                dest.locator('[data-backup-export]:visible').click();expect(dest.locator('#backupDownload')).to_be_visible();dest.locator('#backupCancel').click()
                assert dest.locator('#downloadVideo').get_attribute('href')==ready_href and dest.locator('#videoFileInfo').inner_text()==ready_info
                print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP restored export]: actual 9:16 WebM, PNG/JPG/WebP order, voice+music frequencies/fades and no black frames',flush=True)
            else:print(f'LIMITATION [{engine}]: Canvas/MediaRecorder codec unavailable; real ZIP persistence/preview verified; exported files checked in Chromium/native Safari',flush=True)
            print(f'::notice title=ZIP browser verification::PASS [{engine} ZIP transfer]: clean independent browser storage, both modes/settings, repeat import without ID collisions, complete browser process restart, previews and original audio',flush=True)
            destination.close();context.close();browser.close();assert not errors,errors
    finally:watchdog_timer.cancel();server.shutdown();server.server_close()


if __name__=='__main__':run()
