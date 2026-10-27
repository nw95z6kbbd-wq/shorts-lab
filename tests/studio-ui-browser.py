"""New Studio DTO through real UI autosave and full browser-process restart."""
import base64
import functools
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import expect,sync_playwright
from backup_assets import media_payload

ROOT=Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*_args):pass


def run():
    engine=os.environ.get('PERSISTENCE_BROWSER','chromium');entry=os.environ.get('STUDIO_ENTRY','index.html')
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/';errors=[]
    baseline=json.loads((ROOT/'tests/fixtures/studio-safety/projects-1.4.0.json').read_text());payload=media_payload()
    try:
        with tempfile.TemporaryDirectory(prefix='studio-dto-profile-') as profile,sync_playwright() as p:
            def launch():
                options={'viewport':{'width':1440,'height':1000}}
                if engine!='webkit':options.update(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
                context=getattr(p,engine).launch_persistent_context(profile,**options);context.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))));return context
            context=launch();page=context.new_page();page.goto(base+'tests/fixtures/backup-seed.html')
            for name in ['core.js','video-core.js','project-db.js']:page.add_script_tag(content=(ROOT/'js'/name).read_text())
            page.add_script_tag(content=(ROOT/'tests/studio-data-fixture.js').read_text());seed=page.evaluate('([b,p])=>seedStudioUiFixture(b,p)',[baseline,payload])
            page.goto(base+entry);page.wait_for_function('window.ShortsVideoRestored && window.ShortsEditor && !document.body.inert')
            assert page.evaluate('ShortsEditor.backupSnapshot()')==seed['editor']
            page.add_script_tag(content=(ROOT/'tests/studio-data-fixture.js').read_text())
            text=seed['editor']['script']+'\nНовая редакция сценария 🌌.';page.locator('#scriptText').fill(text)
            page.wait_for_function('text=>ShortsEditor.backupSnapshot().script===text',arg=text)
            assert page.evaluate('e=>waitForStudioUiSave(e)',{'script':text,'sceneText':seed['editor']['scenes'][0]['text']})
            assert page.evaluate('ShortsEditor.backupSnapshot().script')==text,'script before scene navigation'
            page.locator('.sidebar [data-view="scenes"]').click();page.locator('#scene-input-0').fill('Сцена после редактирования: изображение и настройки сохранены.')
            assert page.evaluate('e=>waitForStudioUiSave(e)',{'script':text,'sceneText':'Сцена после редактирования: изображение и настройки сохранены.'})
            assert page.evaluate('ShortsEditor.backupSnapshot().script')==text,'script after scene edit'
            page.add_script_tag(content=(ROOT/'tests/studio-data-fixture.js').read_text());before=page.evaluate('studioUiSnapshot()')
            expected=dict(seed['editor']);expected['script']=text;expected['scenes'][0]['text']=before['editor']['scenes'][0]['text'];expected['updatedAt']=before['editor']['updatedAt'];assert before['editor']==expected,{key:{'expected':expected.get(key),'actual':before['editor'].get(key)} for key in set(expected)|set(before['editor']) if expected.get(key)!=before['editor'].get(key)}
            assert before['video']==seed['video']
            for f in payload:assert before['hashes']['ui-'+f['name']]==hashlib.sha256(base64.b64decode(f['base64'])).hexdigest()
            page.locator('#openVideoMode').click();page.locator('#backToEditor').click();assert page.evaluate('ShortsEditor.backupSnapshot()')==before['editor']
            page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible();expect(page.locator('#backupError')).to_be_hidden()
            bundle=page.evaluate('''async()=>{const blob=await(await fetch(backupDownload.href)).blob(),b=await ShortsBackupFormat.importArchive(blob);return {version:b.manifest.version,projects:b.projects,hashes:Object.fromEntries(await Promise.all([...b.assets].map(async([id,a])=>[id,await ShortsBackupFormat.sha256(new Uint8Array(await a.blob.arrayBuffer()))])))};}''')
            assert bundle['version']==2 and bundle['projects']=={'editor':before['editor'],'video':before['video']} and bundle['hashes']==before['hashes']
            page.locator('#backupCancel').click()
            assert page.evaluate('studioUiSnapshot()')==before
            context.close();context=launch();page=context.new_page();page.goto(base+entry);page.wait_for_function('window.ShortsVideoRestored && window.ShortsEditor && !document.body.inert')
            page.add_script_tag(content=(ROOT/'tests/studio-data-fixture.js').read_text());assert page.evaluate('studioUiSnapshot()')==before
            assert page.evaluate('ShortsEditor.backupSnapshot()')==before['editor'];context.close();assert not errors,errors
            print(f'PASS [{engine} Studio UI {entry}]: DTO 2 fields, independent drafts and PNG/JPG/WebP/voice/music SHA-256 preserved after UI edits, mode switching and full browser-process restart',flush=True)
    finally:server.shutdown();server.server_close()


if __name__=='__main__':run()
