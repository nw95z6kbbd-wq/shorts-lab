"""Isolated real-browser tests for DTO/DB writer fencing; never touches user data."""
import json
import os
from pathlib import Path
import shutil
import uuid
from playwright.sync_api import sync_playwright
from backup_assets import media_payload

ROOT=Path(__file__).resolve().parents[1]


def run():
    engine=os.environ.get('PERSISTENCE_BROWSER','chromium')
    with sync_playwright() as p:
        launch={} if engine=='webkit' else {'executable_path':os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),'args':['--no-sandbox']}
        browser=getattr(p,engine).launch(**launch)
        try:
            context=browser.new_context();page=context.new_page()
            page.route('http://studio-safety.test/**',lambda route:route.fulfill(body='<html></html>',content_type='text/html'))
            page.goto('http://studio-safety.test/')
            page.add_script_tag(content=(ROOT/'js/core.js').read_text());page.add_script_tag(content=(ROOT/'js/video-core.js').read_text())
            page.add_script_tag(content=(ROOT/'tests/fixtures/studio-safety/project-db-1.4.0.js').read_text());page.evaluate('window.LegacyProjectDB=ShortsProjectDB;')
            page.add_script_tag(content=(ROOT/'js/project-db.js').read_text());page.add_script_tag(content=(ROOT/'tests/studio-data-fixture.js').read_text())
            baseline=json.loads((ROOT/'tests/fixtures/studio-safety/projects-1.4.0.json').read_text())
            result=page.evaluate('async ([baseline,payload])=>testStudioDataSafety(baseline,payload)',[baseline,media_payload()])
            assert result['databases']==4,result
            print(f'PASS [{engine} Studio safety]: '+json.dumps(result),flush=True)
            # Two actual tabs: a frozen shipped client, not just a simulated GC.
            old=context.new_page();old.route('http://studio-safety.test/**',lambda route:route.fulfill(body='<html></html>',content_type='text/html'));old.goto('http://studio-safety.test/old-tab')
            for file in ['tests/fixtures/studio-safety/core-1.4.0.js','js/video-core.js','tests/fixtures/studio-safety/project-db-1.4.0.js']:old.add_script_tag(content=(ROOT/file).read_text())
            name='two-tabs-'+uuid.uuid4().hex
            old.evaluate('''async ([name,b,payload])=>{window.oldRepository=ShortsProjectDB.createRepository(name);const f=payload.find(f=>f.name==='red.png'),blob=new Blob([Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))],{type:f.type});await oldRepository.migrate([{id:'editor',state:b.editor},{id:'video',state:b.video}],[{id:b.video.scenes[0].imageId,name:f.name,kind:'image',blob}],{});}''',[name,baseline,media_payload()])
            page.evaluate('''async ([name,b])=>{const r=ShortsProjectDB.createRepository(name),p=ShortsCore.upgradeProject(b.editor);p.scenes[0].imageId=b.video.scenes[0].imageId;await r.save('editor',p,1);r.close();}''',[name,baseline])
            assert old.evaluate('''async b=>{try{await oldRepository.save('video',{...b.video,title:'Stale tab cleanup'},1);return false;}catch(e){return e.name==='VersionError';}}''',baseline)
            assert page.evaluate('''async ([name,id])=>{const r=ShortsProjectDB.createRepository(name),a=await r.asset(id),e=await r.read('editor');r.close();return a.blob.size>0&&e.state.version===2;}''',[name,baseline['video']['scenes'][0]['imageId']]);old.close()
            print(f'PASS [{engine} two real tabs]: frozen 1.4.0 cannot reopen v2 or delete shared Studio originals',flush=True)
            assert page.evaluate('baseline=>seedStudioAdapterFixture(baseline)',baseline) is None
            page.add_script_tag(content=(ROOT/'js/storage.js').read_text())
            assert page.evaluate('testStudioAdapterSafety()')
            print(f'PASS [{engine} Studio adapter]: future head blocks autosave/recovery overwrite; incomplete v2 ZIP refused',flush=True)
        finally:browser.close()


if __name__=='__main__':run()
