"""Real Editor UI, canonical timings/SRT, isolated media safety, ZIP and restart."""
import functools,json,os,shutil,tempfile,threading,time
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import expect,sync_playwright
from backup_assets import media_payload
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*_args):pass

def run():
    engine=os.environ.get('TIMING_BROWSER','chromium');entry=os.environ.get('TIMING_ENTRY','index.html');mobile=os.environ.get('TIMING_MOBILE')=='1'
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}/'
    fixture=json.loads((ROOT/'tests/fixtures/studio-safety/projects-1.4.0.json').read_text());payload=media_payload();errors=[]
    try:
      with tempfile.TemporaryDirectory(prefix='editor-timing-') as profile,sync_playwright() as p:
        options={'viewport':{'width':390,'height':844} if mobile else {'width':1440,'height':1000},'accept_downloads':True}
        if engine!='webkit':options.update(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
        def launch():
            c=getattr(p,engine).launch_persistent_context(profile,**options);c.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))));return c
        def scripts(page):
            for f in ['studio-data-fixture.js','editor-timing-fixture.js']:page.add_script_tag(content=(ROOT/'tests'/f).read_text())
        def open_app(page):
            if entry.startswith('downloads/'):
                def offline(route):
                    if route.request.url.endswith('/offline.html'):route.fulfill(body=(ROOT/entry).read_bytes(),content_type='text/html')
                    elif route.request.url.startswith(('blob:','data:')):route.continue_()
                    else:route.abort()
                page.route('**/*',offline);page.goto(base+'offline.html')
            else:page.goto(base+entry)
            page.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');scripts(page)
        def scenes(page):page.locator('#tab-scenes').click()
        def check(page):return page.evaluate('editorTimingAssert()')
        def saved(page):return page.evaluate('editorTimingWaitForSave()')
        def snapshot(page):return page.evaluate('studioUiSnapshot()')
        def srt(page,button='exportSrt'):
            expected=check(page)['srt']
            with page.expect_download() as item:page.locator('#'+button).click()
            target=Path(profile)/'captions.srt';item.value.save_as(target);assert target.read_text()==expected
        context=launch();page=context.new_page();page.goto(base+'tests/fixtures/backup-seed.html')
        for name in ['core.js','video-core.js','project-db.js']:page.add_script_tag(content=(ROOT/'js'/name).read_text())
        scripts(page);seed=page.evaluate('([b,p])=>seedEditorTimingFixture(b,p,1)',[fixture,payload]);open_app(page);scenes(page)
        ids=[s['id'] for s in seed['editor']['scenes']];assert check(page)['project']==seed['editor']
        page.locator('#scene-input-0').fill('Новый текст 🌌 one два три четыре пять шесть семь');assert check(page)['project']['version']==1
        assert page.locator('#scene-input-0').evaluate('n=>n===document.activeElement');saved(page)
        # Legacy text/reorder does not write DTO2; ZIP remains v1.
        first=page.locator('.scene-card').first;first.locator('.studio-move').nth(1).click();reordered=check(page)['project'];assert [s['id'] for s in reordered['scenes']]==[ids[1],ids[0],ids[2]] and reordered['selectedSceneId']==ids[0]
        saved(page);srt(page)
        page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible()
        assert page.evaluate('async()=> (await ShortsBackupFormat.importArchive(await(await fetch(backupDownload.href)).blob())).manifest.version')==1;page.locator('#backupCancel').click()
        # Explicit duration setting is the upgrade action; preserve overrides in Reading.
        page.locator('#editorTimingMode').select_option('manual');field=page.locator('.studio-scene-duration').nth(1);field.fill('1,234')
        assert field.evaluate('n=>n===document.activeElement');assert check(page)['project']['scenes'][1]['durationMs']==1234
        page.locator('.studio-scene-duration').first.fill('2.345');page.evaluate('editorTimingStartTrace()');page.locator('#editorTimingMode').select_option('reading');check(page)
        page.locator('#editorTimingMode').select_option('manual');assert page.locator('.studio-scene-duration').first.input_value()=='2,345';page.locator('.studio-scene-duration').first.fill('');assert check(page)['project']['scenes'][0]['durationMs'] is None, page.evaluate('({events:editorTimingEvents,field:document.querySelector(".studio-scene-duration").value,duration:ShortsEditor.backupSnapshot().scenes[0].durationMs})')
        saved(page);before=snapshot(page)
        for raw in ['-1','NaN','Infinity','0','1.0001','9007199254740.992']:
            field.fill(raw);assert field.input_value()==raw;assert page.evaluate('b=>editorTimingErrorAssert(b)',before)
        field.fill('1,234');saved(page);check(page)
        # Chunk failure keeps typed 1ms draft, DB unchanged; explicit policy repair.
        page.locator('#tab-subtitles').click();page.locator('#editorSubtitleMode').select_option('chunks');check(page);srt(page,'exportSrtPanel');saved(page);before=snapshot(page)
        scenes(page);field.fill('0.001');assert page.evaluate('b=>editorTimingErrorAssert(b)',before);assert field.input_value()=='0.001'
        page.locator('#tab-subtitles').click();page.locator('#editorSubtitleMode').select_option('scene');assert check(page)['project']['scenes'][1]['durationMs']==1;saved(page);srt(page,'exportSrtPanel')
        page.locator('#editorSubtitlesEnabled').uncheck();assert check(page)['plan']['cues']==[];expect(page.locator('#exportSrtPanel')).to_be_disabled();expect(page.locator('#previewText')).to_be_hidden();saved(page)
        page.locator('#editorSubtitlesEnabled').check();scenes(page);field.fill('1.234');saved(page)
        # Programmatic replacement through real JSON import preserves the full DTO2
        # and loads supported media settings; no new media UI is introduced.
        media_editor=page.evaluate('([b])=>{const p=ShortsCore.upgradeProject(b.editor);p.scenes=p.scenes.slice(0,3);return p;}',[fixture])
        # Existing shared media are in video and survive the text-only editor edits.
        media_editor['scenes'][0].update(imageId='ui-red.png',imageName='red.png',visual='image',durationMs=1357,camera='pan-left',transition='slide')
        media_editor['scenes'][1].update(imageId='ui-red.png',imageName='red.png',visual='animated',durationMs=2468)
        media_editor['audio']['voice'].update(assetId='ui-voice.wav',name='voice.wav',volume=.81)
        media_editor['audio']['music'].update(assetId='ui-music.wav',name='music.wav',volume=.19,fadeInMs=123,fadeOutMs=456)
        media_editor['timing']='manual';media_editor['selectedSceneId']=media_editor['scenes'][1]['id']
        page.locator('#projectFile').set_input_files({'name':'studio.shorts.json','mimeType':'application/json','buffer':json.dumps(media_editor).encode()});page.locator('#dialogConfirm').click();scenes(page);saved(page);before=snapshot(page)
        scene_map={s['id']:s for s in before['editor']['scenes']};selected=before['editor']['selectedSceneId'];page.locator('.scene-card').nth(1).locator('.studio-move').nth(1).click();saved(page);after=snapshot(page)
        assert {s['id']:s for s in after['editor']['scenes']}==scene_map and after['editor']['selectedSceneId']==selected and after['video']==before['video'] and after['hashes']==before['hashes'];check(page);srt(page)
        page.locator('#openVideoMode').click();page.locator('#backToEditor').click();assert check(page)['project']==after['editor']
        # Actual ZIP v2, actual clean-context UI import, remapped originals byte-exact.
        page.locator('[data-backup-export]:visible').first.click();expect(page.locator('#backupDownload')).to_be_visible()
        with page.expect_download() as item:page.locator('#backupDownload').click()
        archive=Path(profile)/'project.shorts.zip';item.value.save_as(archive);page.locator('#backupCancel').click()
        assert page.evaluate('async encoded=> (await ShortsBackupFormat.importArchive(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]))).manifest.version', __import__('base64').b64encode(archive.read_bytes()).decode())==2
        clean=getattr(p,engine).launch(**({k:v for k,v in options.items() if k in ['executable_path','args']}));fresh=clean.new_context(viewport=options['viewport']);target=fresh.new_page();open_app(target)
        target.locator('#backupFile').set_input_files(archive);expect(target.locator('#backupConfirm')).to_be_visible();
        with target.expect_navigation(wait_until='load'):target.locator('#backupConfirm').click()
        target.wait_for_function('window.ShortsEditor && window.ShortsVideoRestored && !document.body.inert');scripts(target);restored=check(target)['project'];restored_snapshot=snapshot(target)
        assert [s['id'] for s in restored['scenes']]==[s['id'] for s in after['editor']['scenes']];assert restored['timing']==after['editor']['timing'];assert sorted(restored_snapshot['hashes'].values())==sorted(after['hashes'].values())
        # Compare full settings after undoing only the intentional asset-ID remap.
        reverse={new:old for new,h in restored_snapshot['hashes'].items() for old,oh in after['hashes'].items() if h==oh}
        def undo_refs(v):
            if isinstance(v,dict):return {k:undo_refs(x) for k,x in v.items()}
            if isinstance(v,list):return [undo_refs(x) for x in v]
            return reverse.get(v,v) if isinstance(v,str) else v
        assert undo_refs(restored)==after['editor'];assert undo_refs(restored_snapshot['video'])==after['video'];fresh.close();clean.close()
        context.close();context=launch();page=context.new_page();open_app(page);assert snapshot(page)==after;check(page)
        # 5000 cards: one text edit must not recreate a card, change focus, IDs or
        # generate hidden subtitle DOM. Measure actual UI latency for the report.
        large=dict(after['editor']);large['timing']='reading';large['scenes']=[dict(after['editor']['scenes'][0],id='large-'+str(i),text='сцена '+str(i)) for i in range(5000)];large['selectedSceneId']='large-0'
        page.locator('#projectFile').set_input_files({'name':'large.shorts.json','mimeType':'application/json','buffer':json.dumps(large).encode()});page.locator('#dialogConfirm').click();scenes(page);expect(page.locator('.scene-card')).to_have_count(5000)
        page.evaluate('window.timingFirstCard=document.querySelector(".scene-card");window.timingLastCard=document.querySelector(".scene-card:last-child");window.timingIds=ShortsEditor.backupSnapshot().scenes.map(s=>s.id);window.timingAdded=0;window.timingObserver=new MutationObserver(rs=>{for(const r of rs)for(const n of r.addedNodes)if(n.nodeType===1&&n.matches(".scene-card"))timingAdded++;});timingObserver.observe(sceneList,{childList:true});')
        start=time.monotonic();page.locator('#scene-input-0').fill('Изменено слово');elapsed=time.monotonic()-start
        assert page.evaluate('timingFirstCard===document.querySelector(".scene-card")&&timingLastCard===document.querySelector(".scene-card:last-child")&&timingAdded===0&&JSON.stringify(timingIds)===JSON.stringify(ShortsEditor.backupSnapshot().scenes.map(s=>s.id))');assert page.locator('#scene-input-0').evaluate('n=>n===document.activeElement');check(page)
        page.locator('#scene-input-0').fill('');assert page.locator('.scene-card').first.get_attribute('data-duration-ms')=='0';check(page)
        page.locator('#scene-input-0').fill('🌌 …');assert page.locator('.scene-card').first.get_attribute('data-duration-ms')=='0';check(page)
        page.locator('#scene-input-0').fill('Кириллица латиница Unicode 漢字 emoji 🌌 '+'длинноеслово'*400);check(page)
        assert page.evaluate('JSON.stringify(timingIds)===JSON.stringify(ShortsEditor.backupSnapshot().scenes.map(s=>s.id))')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'horizontal overflow'
        page.locator('#addScene').click();expect(page.locator('.scene-card')).to_have_count(5000);saved(page);context.close();assert not errors,errors
        print(f'PASS [{engine} Editor timing {entry}, mobile={mobile}]: Reading/Manual/fallback, stable IDs/media/reorder, UI=RenderPlan=actual SRT, chunk errors and invalid drafts never committed, ZIP1/2, clean restore, full browser restart; 5000-card edit {elapsed:.3f}s, no card recreation',flush=True)
    finally:server.shutdown();server.server_close()
if __name__=='__main__':run()
