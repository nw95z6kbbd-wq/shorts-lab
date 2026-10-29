"""The same actual Editor controls/signals exercised by Playwright and Safari."""
import json

def check_editor_audio(execute,click,payload):
    execute('''const p=ShortsCore.upgradeProject(ShortsCore.createProject());p.name='Editor audio acceptance';p.timing='manual';p.scenes=[0,1,2].map(i=>({id:'audio-scene-'+i,text:'',durationMs:2000,visual:'animated',imageId:null,imageName:'',camera:'pan-left',transition:'crossfade'}));p.selectedSceneId='audio-scene-0';await editorLiveImport(p);document.getElementById('tab-scenes').click();await editorLiveReady();return true;''')
    execute('return await editorLiveUpload(0,arguments[0]);',[payload[0]])
    for role,index in [('voice',3),('music',4)]:
        assert execute('return await editorAudioUpload(arguments[0],arguments[1]);',[role,payload[index]])=='ready'
    execute('editorAudioSettings();await editorAudioReady();audioCheck(editorAudioState.dataset.state==="ready",editorAudioState.textContent);return true;')
    offline=execute('return await editorAudioOffline();')
    execute('editorAudioTap();await editorAudioNoticeOverPlay();return true;');click('#playPreview');execute('restoreAudioNotice();return true;')
    signal=execute('return await editorAudioPlaying();');assert signal['rms']>.0001,signal
    assert signal['voiceVolume']==.4 and signal['musicVolume']==.25 and signal['fadeIn']==.25 and signal['fadeOut']==.5,signal
    click('#playPreview')
    paused=execute('''await editorLiveUntil(()=>editorAudioTaps.at(-1).context.state==='suspended','pause context');const time=Number(editorCanvas.dataset.timeMs);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));audioCheck(Number(editorCanvas.dataset.timeMs)===time,'paused Canvas moved');return Number(editorSeek.value);''')
    click('#playPreview');resumed=execute('return await editorAudioPlaying(20);');assert resumed['offset']>0 and abs(resumed['offset']*1000-paused)<2,(resumed,paused)
    execute('editorSeek.value="1800";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveUntil(()=>editorCanvas.dataset.sceneId==="audio-scene-1"&&Number(editorCanvas.dataset.timeMs)>2050,"automatic scene crossing");return true;')
    crossing=execute('return await editorAudioPlaying(20);');assert crossing['clock']>2000 and crossing['offset']>=1.8,crossing
    execute('editorSeek.value="3000";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveUntil(()=>editorAudioTaps.at(-1).options.offsetSeconds>=3&&!editorAudioTaps.at(-1).stopped&&editorCanvas.dataset.sceneId==="audio-scene-1","forward seek");return true;')
    forward=execute('return await editorAudioPlaying(20);');assert forward['offset']>=3 and forward['scene']=='audio-scene-1',forward
    click('#playPreview')
    execute('editorSeek.value="750";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveReady("audio-scene-0",750);return true;')
    click('#playPreview');backward=execute('return await editorAudioPlaying(20);');assert backward['offset']==.75,backward
    click('#nextScene');click('#playPreview');scene=execute('return await editorAudioPlaying(20);');assert scene['offset']==2,scene
    for _ in range(4):
        click('#playPreview');click('#playPreview');execute('await editorAudioPlaying(20);return editorAudioNoLeaks();')
    # Replacing an active original must close its old graph, preserve settings,
    # and never resume a late asynchronous result into a new owner.
    replacement={**payload[4],'name':'replacement-music.wav'}
    assert execute('return await editorAudioUpload("music",arguments[0]);',[replacement])=='ready'
    execute('await editorAudioReady();audioCheck(editorAudioNoLeaks().liveContexts===0,"replaced audio still sounds");return true;')
    original=execute('await editorTimingWaitForSave();return await studioUiSnapshot();')
    for item in [{**payload[3],'name':'broken.wav','base64':'YmFk'}, {**payload[3],'type':'audio/mpeg'}, {**payload[3],'base64':''}]:
        assert execute('return await editorAudioUpload("voice",arguments[0]);',[item])=='error'
        assert execute('return await studioUiSnapshot();')==original,'Rejected audio modified saved projects/originals'
    execute('''window.savedAudioDecoder=ShortsVideoRecorder.decodeAudio;window.audioDecodeEntered=false;window.releaseAudioDecode=false;ShortsVideoRecorder.decodeAudio=async b=>{audioDecodeEntered=true;await editorLiveUntil(()=>releaseAudioDecode,'gated audio decode');return savedAudioDecoder(b);};window.audioFirst=editorAudioUpload('voice',arguments[0]);await editorLiveUntil(()=>audioDecodeEntered,'decode entered');window.audioLatest=editorAudioUpload('voice',arguments[1]);releaseAudioDecode=true;await audioFirst;await audioLatest;ShortsVideoRecorder.decodeAudio=savedAudioDecoder;await editorAudioReady();return true;''',[{**payload[3],'name':'stale-voice.wav'},{**payload[3],'name':'latest-voice.wav'}])
    state=execute('return ShortsEditor.backupSnapshot();');assert state['audio']['voice']['name']=='latest-voice.wav' and state['audio']['music']['name']=='replacement-music.wav'
    execute('await editorTimingWaitForSave();return true;');before_invalid=execute('return await studioUiSnapshot();')
    execute('editorMusicFadeIn.value="-1";editorMusicFadeIn.dispatchEvent(new Event("input",{bubbles:true}));return true;')
    execute('return await editorTimingErrorAssert(arguments[0]);',[before_invalid])
    execute('editorMusicFadeIn.value="0,250";editorMusicFadeIn.dispatchEvent(new Event("input",{bubbles:true}));await editorAudioReady();return true;')
    click('#playPreview');execute('await editorAudioPlaying(20);return true;')
    click('#editorVoiceRemove');execute('await editorAudioReady();audioCheck(editorAudioNoLeaks().liveContexts===0,"voice removal leaves audio graph");return true;')
    click('#playPreview');execute('await editorAudioPlaying(20);audioCheck(!editorAudioTaps.at(-1).options.voiceBuffer,"removed voice still mixed");return true;')
    click('#editorMusicRemove');execute('await editorAudioReady();audioCheck(editorAudioState.dataset.state==="silent"&&editorAudioNoLeaks().liveContexts===0,"music removal leaves graph");return true;')
    # Different roles are independent even when native decodes are serialized.
    execute('await Promise.all([editorAudioUpload("voice",editorAudioShort(arguments[0],1)),editorAudioUpload("music",editorAudioShort(arguments[1],2))]);await editorAudioReady();audioCheck(editorAudioState.dataset.state==="ready","parallel voice/music admission");return true;',[payload[3],payload[4]])
    execute('editorSeek.value="3500";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveReady("audio-scene-1",3500);return true;')
    click('#playPreview');short_signal=execute('return await editorAudioPlaying(150);');assert short_signal['rms']<.00001,short_signal
    click('#playPreview')
    # Finish at the original 6 s boundary; audio source lengths never change it.
    execute('editorSeek.value="5500";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveReady("audio-scene-2",5500);return true;')
    click('#playPreview');execute('await editorLiveUntil(()=>document.getElementById("playPreview").getAttribute("aria-label")==="Воспроизвести предпросмотр"&&timelineProgress.style.width==="100%","project end");return true;')
    execute('await editorTimingWaitForSave();return true;');saved=execute('return await studioUiSnapshot();')
    assert saved['editor']['scenes'][0]['imageId'] and [s['id'] for s in saved['editor']['scenes']]==['audio-scene-0','audio-scene-1','audio-scene-2']
    click('#openVideoMode');resources=execute('await editorLiveUntil(()=>ShortsMediaSessions.statistics().sessions===0,"mode teardown");audioCheck(editorAudioNoLeaks().liveContexts===0,"contexts survive mode switch");return editorAudioNoLeaks();')
    click('#backToEditor');execute('await editorLiveReady();await editorAudioReady();return true;')
    assert execute('return await studioUiSnapshot();')==saved
    return {'offlineSignal':offline,'liveSignal':signal,'shortSourceSilence':short_signal,'pauseMs':paused,'resumed':resumed,'automaticCrossing':crossing,'forwardSeek':forward,'backwardSeek':backward,'sceneNavigation':scene,'resourcesOutsideEditor':resources,'saved':saved}

def audio_helpers(root,script):
    for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js','editor-audio-fixture.js']:
        script((root/'tests'/name).read_text())
