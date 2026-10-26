"""Test the new repository in isolation, without starting either application UI."""
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    with tempfile.TemporaryDirectory(prefix='shorts-db-profile-') as profile, sync_playwright() as p:
        engine = os.environ.get('PERSISTENCE_BROWSER', 'chromium')
        browser = p.webkit.launch_persistent_context(profile) if engine == 'webkit' else p.chromium.launch_persistent_context(profile, executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'])
        try:
            page = browser.new_page()
            # A real origin with an empty document; no editor, legacy saver or UI.
            page.route('http://shorts.test/**', lambda route: route.fulfill(body='<html></html>', content_type='text/html'))
            page.goto('http://shorts.test/')
            for file in ('core.js', 'video-core.js', 'project-db.js'):
                page.add_script_tag(content=(ROOT/'js'/file).read_text())
            result = page.evaluate('''async () => {
              const assert=(value,label)=>{if(!value)throw Error(label);};
              const db=ShortsProjectDB.createRepository('isolated-project-test');
              const editor=ShortsCore.createProject(true), video=ShortsVideoCore.demo();
              video.scenes[0].imageId='legacy-image';video.scenes[0].visual='image';
              video.scenes[1].imageId='missing-legacy-image';video.scenes[1].visual='image';
              const image={id:'legacy-image',blob:new Blob(['original image']),kind:'image',name:'image.png'};
              const legacy={editor:JSON.stringify(editor),video:JSON.stringify(video)};
              assert(await db.migrate([{id:'editor',state:editor},{id:'video',state:video}],[image],legacy),'first migration');
              assert(!await db.migrate([{id:'editor',state:ShortsCore.createProject()}],[],{}),'idempotent migration');
              assert((await db.read('editor')).state.script===editor.script,'editor preserved independently');
              assert((await db.read('video')).state.title===video.title,'video preserved independently');
              assert((await db.migration()).legacy.editor===legacy.editor,'raw recovery retained');
              assert((await db.asset('legacy-image')).blob.size===image.blob.size,'original Blob copied');
              assert((await db.read('video')).missingAssets.includes('missing-legacy-image'),'missing legacy image explicit');
              const state={...(await db.read('video')).state,voiceAssetId:'voice',voiceName:'voice.wav'};
              const voice={id:'voice',kind:'voice',name:'voice.wav',blob:new Blob(['voice original'])};
              const saved=await db.save('video',state,1,[voice]);
              assert(saved.revision===2 && (await db.asset('voice')).blob.size===voice.blob.size,'atomic state plus audio');
              assert(saved.previous.revision===1,'previous snapshot');
              let conflict=false;try{await db.save('video',{...state,title:'stale tab'},1);}catch(e){conflict=e.code==='CONFLICT';}
              assert(conflict && (await db.read('video')).state.title===video.title,'stale writer cannot overwrite');
              const put=IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put=function(value){if(this.name==='projects')throw new DOMException('full','QuotaExceededError');return put.call(this,value);};
              let quota=false;
              try {await db.save('video',{...state,musicAssetId:'new-music'},2,[{id:'new-music',blob:new Blob(['music']),kind:'music'}]);}
              catch(e){quota=e.name==='QuotaExceededError';}finally{IDBObjectStore.prototype.put=put;}
              assert(quota,'quota failure delivered');
              assert((await db.read('video')).revision===2 && !await db.asset('new-music'),'partial asset and state rolled back');
              let missing=false;try{await db.save('video',{...state,musicAssetId:'not-written'},2);}catch(e){missing=e.code==='MISSING';}
              assert(missing && (await db.read('video')).revision===2,'new dangling references forbidden');
              db.close();const reopened=ShortsProjectDB.createRepository('isolated-project-test');
              assert(await (await reopened.asset('voice')).blob.text()==='voice original','Blob survives connection reopen');
              const race=await Promise.allSettled([reopened.save('video',{...state,title:'tab A'},2),reopened.save('video',{...state,title:'tab B'},2)]);
              assert(race.filter(r=>r.status==='fulfilled').length===1 && race.filter(r=>r.status==='rejected'&&r.reason.code==='CONFLICT').length===1,'concurrent CAS serializes writers');
              reopened.close();
              const fresh=ShortsProjectDB.createRepository('migration-abort-test');
              IDBObjectStore.prototype.put=function(value){if(this.name==='meta')throw new DOMException('full','QuotaExceededError');return put.call(this,value);};
              try{await fresh.migrate([{id:'editor',state:editor}],[image],legacy);throw Error('migration should abort');}
              catch(e){assert(e.name==='QuotaExceededError','migration abort reason');}finally{IDBObjectStore.prototype.put=put;}
              assert(!await fresh.read('editor')&&!await fresh.asset('legacy-image')&&!await fresh.migration(),'migration fully rolls back');
              assert(await fresh.migrate([{id:'editor',state:editor}],[image],legacy),'migration retries safely');fresh.close();
              return true;
            }''')
            assert result
            print(f'PASS [{engine} isolated DB]: migration, originals, missing legacy media, atomic commits, previous version, quota rollback, dangling-reference rejection, simultaneous/stale tabs and retry after aborted migration', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
