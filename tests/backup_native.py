"""Actual ZIP bytes and production backup UI in real Safari via W3C WebDriver.

Uses standard library only. The OS file picker/save dialog still needs manual QA;
a real File/DataTransfer supplies the independently verified ZIP to the input.
"""
import base64
import functools
import hashlib
import io
import json
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
import threading
import zipfile
from backup_assets import media_payload


def check_native_backup(root,source_base,script,command,click,wait_for):
    payload=media_payload()
    def async_script(code,args=None):
        result=command('POST','/execute/async',{'script':'const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(done,e=>done({error:e.message}));','args':args or []})
        assert not isinstance(result,dict) or not result.get('error'),result
        return result
    command('POST','/window/rect',{'width':1440,'height':1000})
    command('POST','/url',{'url':source_base+'tests/fixtures/backup-seed.html'})
    for name in ('core.js','video-core.js','project-db.js','storage.js'):script((root/'js'/name).read_text())
    script((root/'tests/backup-fixture.js').read_text())
    async_script('await seedBackupFixture(arguments[0]);return true;',[payload])
    command('POST','/url',{'url':source_base+'index.html'})
    wait_for('window.ShortsVideoRestored')
    script((root/'tests/backup-fixture.js').read_text());script((root/'tests/backup-db-fixture.js').read_text())
    assert async_script('return await testAtomicBackupRepository();')
    expected=async_script('return await backupFixtureSnapshot();')
    script('const e=Array.from(document.querySelectorAll("[data-backup-export]")).find(e=>e.getClientRects().length);e.setAttribute("data-native-backup-export","");')
    click('[data-native-backup-export]');wait_for('!document.getElementById("backupDownload").hidden',seconds=30)
    encoded=async_script('''const blob=await (await fetch(document.getElementById('backupDownload').href)).blob(),bytes=new Uint8Array(await blob.arrayBuffer()),parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(parts.join(''));''')
    archive=base64.b64decode(encoded)
    assert script('return document.getElementById("backupDownload").download.endsWith(".shorts.zip");')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        assert z.testzip() is None;manifest=json.loads(z.read('manifest.json'))
        for file in payload:
            entry=next(a for a in manifest['assets'] if a['name']==file['name']);original=base64.b64decode(file['base64'])
            assert z.read(entry['path'])==original and entry['sha256']==hashlib.sha256(original).hexdigest()
    click('#backupCancel')
    assert async_script('return await backupFixtureSnapshot();')==expected
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path=='/__portable_backup.zip':
                self.send_response(200);self.send_header('Content-Type','application/zip');self.send_header('Content-Length',str(len(archive)));self.end_headers();self.wfile.write(archive)
            else:super().do_GET()
        def log_message(self,*_args):pass
    clean=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
    threading.Thread(target=clean.serve_forever,daemon=True).start()
    try:
        # A second HTTP origin has genuinely empty IndexedDB, without deleting the
        # source or relying on automation browser profile implementation details.
        destination=f'http://127.0.0.1:{clean.server_port}/'
        command('POST','/url',{'url':destination+'index.html'});wait_for('window.ShortsVideoRestored')
        async_script('''const blob=await(await fetch('/__portable_backup.zip')).blob(),transfer=new DataTransfer();transfer.items.add(new File([blob],'portable.shorts.zip',{type:'application/zip'}));const input=document.getElementById('backupFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;''')
        wait_for('!document.getElementById("backupConfirm").hidden',seconds=30)
        # Decline first: both original slots must stay unchanged.
        baseline=async_script('const r=ShortsProjectDB.createRepository(),v=[await r.read("editor"),await r.read("video")];r.close();return v;')
        click('#backupCancel')
        after=async_script('const r=ShortsProjectDB.createRepository(),v=[await r.read("editor"),await r.read("video")];r.close();return v;')
        assert baseline==after
        async_script('''const blob=await(await fetch('/__portable_backup.zip')).blob(),dt=new DataTransfer();dt.items.add(new File([blob],'portable.shorts.zip',{type:'application/zip'}));backupFile.files=dt.files;backupFile.dispatchEvent(new Event('change',{bubbles:true}));return true;''')
        wait_for('!document.getElementById("backupConfirm").hidden',seconds=30);script('window.nativeBackupOldRealm=true;');click('#backupConfirm')
        wait_for('!window.nativeBackupOldRealm && window.ShortsVideoRestored',seconds=30)
        script((root/'tests/backup-fixture.js').read_text());assert async_script('return await backupFixtureSnapshot();')==expected
        click('#openVideoMode');assert script('return document.querySelectorAll(".scene-image-thumb").length;')==3
        assert 'voice.wav' in script('return videoAudioInfo.textContent;') and 'music.wav' in script('return videoMusicInfo.textContent;')
        click('#playGeneratedPreview');wait_for('document.getElementById("videoPreviewTime").textContent.startsWith("0:01")');click('#playGeneratedPreview')
        assert script('return ShortsVideoRecorder.capabilities(true,"webm").supported;'),'Native Safari lacks recording capability; actual restored export not verified'
        click('#recordVideo');wait_for('!document.getElementById("downloadVideo").hidden',seconds=25);wait_for('document.getElementById("generatedVideo").readyState>=1')
        metadata=script('const v=generatedVideo;return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,info:videoFileInfo.textContent};')
        assert metadata['width']==720 and metadata['height']==1280 and 5<metadata['duration']<7.5 and 'голос + музыка' in metadata['info'],metadata
        samples=async_script('''const v=generatedVideo,c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d'),result=[];v.pause();for(const t of [.5,2.7,4.8]){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video seek timeout')),4000);v.onseeked=()=>{clearTimeout(timer);resolve();};v.currentTime=t;});x.drawImage(v,300,400,100,100,0,0,1,1);result.push(Array.from(x.getImageData(0,0,1,1).data).slice(0,3));}return result;''')
        r,b,g=samples;assert r[0]>r[2]*1.5 and b[2]>b[0]*1.5 and g[1]>g[0]*1.5,samples
        print('::notice title=Native Safari ZIP restoration verified::Actual ZIP independently read by Python; PNG/JPG/WebP and two WAV match original bytes; clean-origin restore, cancel/atomic-failure tests, preview and restored video export: '+json.dumps(metadata),flush=True)
    finally:clean.shutdown();clean.server_close()
