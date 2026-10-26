"""Exercise the actual legacy adapter under a mid-migration failure and retry."""
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with tempfile.TemporaryDirectory(prefix='shorts-db-profile-') as profile, sync_playwright() as p:
        engine=os.environ.get('PERSISTENCE_BROWSER','chromium')
        browser=p.webkit.launch_persistent_context(profile) if engine=='webkit' else p.chromium.launch_persistent_context(profile, executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
        try:
            page=browser.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.route('http://shorts.test/**',lambda r:r.fulfill(body='<html></html>',content_type='text/html'))
            def core():
                page.goto('http://shorts.test/')
                for name in ('core.js','video-core.js','project-db.js'):page.add_script_tag(content=(ROOT/'js'/name).read_text())
            def adapter():page.add_script_tag(content=(ROOT/'js/storage.js').read_text())
            core()
            old=page.evaluate('''async()=>{
              const e=ShortsCore.createProject();e.name='Независимый редактор';e.script='Оригинал';
              const v=ShortsVideoCore.demo();v.title='Независимое видео';v.scenes[0].imageId='old';v.scenes[0].visual='image';
              const raw={editor:JSON.stringify(e),video:JSON.stringify(v)};
              localStorage.setItem('shorts-studio.project.v1',raw.editor);localStorage.setItem('shorts-studio.video.v1',raw.video);
              await new Promise((resolve,reject)=>{const q=indexedDB.open('shorts-studio.media.v1',1);q.onupgradeneeded=()=>q.result.createObjectStore('images',{keyPath:'id'});q.onsuccess=()=>{const db=q.result,t=db.transaction('images','readwrite');t.objectStore('images').put({id:'old',name:'original.png',file:new Blob(['unchanged original'])});t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};});
              return raw;
            }''')
            page.evaluate('''()=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='meta')throw new DOMException('full','QuotaExceededError');return originalPut.call(this,value);};}''')
            adapter()
            failed=page.evaluate('async()=>{const loaded=await ShortsStorage.load("editor");const save=await ShortsStorage.save({...loaded.project,name:"Must not replace"});const db=ShortsProjectDB.createRepository();return {loaded,save,head:await db.read("editor"),asset:await db.asset("old"),migration:await db.migration()};}')
            assert failed['loaded']['project']['name']=='Независимый редактор' and failed['loaded']['error']
            assert not failed['save']['ok'] and not failed['head'] and not failed['asset'] and not failed['migration']
            page.evaluate('()=>{IDBObjectStore.prototype.put=window.originalPut;}')
            core();adapter()
            recovered=page.evaluate('''async()=>{const e=await ShortsStorage.load('editor'),v=await ShortsStorage.load('video');const saved=await ShortsStorage.save({...e.project,name:'Новый редактор'});return {e,v,saved,oldEditor:localStorage.getItem('shorts-studio.project.v1'),oldVideo:localStorage.getItem('shorts-studio.video.v1'),copied:await (await ShortsStorage.asset('old')).blob.text()};}''')
            assert recovered['e']['project']['name']=='Независимый редактор' and recovered['v']['project']['title']=='Независимое видео'
            assert recovered['saved']['ok'] and recovered['oldEditor']==old['editor'] and recovered['oldVideo']==old['video'] and recovered['copied']=='unchanged original'
            original=page.evaluate('''async()=>await new Promise(resolve=>{const q=indexedDB.open('shorts-studio.media.v1',1);q.onsuccess=()=>{const db=q.result,t=db.transaction('images','readonly'),get=t.objectStore('images').get('old');get.onsuccess=async()=>{resolve(await get.result.file.text());db.close();};};})''')
            assert original=='unchanged original'
            # An old tab writes after migration: detect it, never replace the new head.
            page.evaluate('localStorage.setItem("shorts-studio.project.v1","{late invalid old data")')
            core();adapter()
            late=page.evaluate('async()=>await ShortsStorage.load("editor")')
            assert late['project']['name']=='Новый редактор' and 'старой версии' in late['error']
            assert not errors,errors
            print(f'PASS [{engine} migration adapter]: mid-migration quota rolls back every new store, editing stays volatile, retry succeeds, independent legacy states and original files untouched, late old-tab writes do not overwrite new state',flush=True)
        finally:browser.close()


if __name__=='__main__':run()
