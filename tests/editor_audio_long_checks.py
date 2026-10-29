"""Representative generated 44.1kHz stereo MP3; never ships third-party music."""
import base64,json

def long_audio_payload(root):
 return [{'name':name,'type':'audio/mpeg','base64':base64.b64encode((root/'tests/fixtures/editor-audio/long'/name).read_bytes()).decode()} for name in ['tone-2s-stereo.mp3','tone-215s-stereo.mp3','tone-400s-stereo.mp3']]

def check_editor_long_audio(root,execute,click):
 short,long,oversized=long_audio_payload(root)
 click('#openVideoMode');video_label=execute('return await editorLongVideoUpload(arguments[0]);',[long]);click('#removeVideoMusic');click('#backToEditor');execute('await editorAudioReady();await editorLiveReady();return true;')
 video=execute('return await editorLongAudioProbe(arguments[0]);',[long]);video['actualUiLabel']=video_label
 execute('const p=ShortsEditor.backupSnapshot();p.id=ShortsCore.id();p.name="Long MP3 acceptance";p.selectedSceneId=p.scenes[0].id;p.scenes.forEach(s=>s.durationMs=10000);await editorLiveImport(p);await editorLiveReady();await editorAudioReady();return true;')
 assert execute('return await editorAudioUpload("music",arguments[0]);',[short])=='ready'
 execute('await editorAudioReady();return true;')
 before=execute('return ShortsMediaSessions.statistics().audioDecodes;')
 assert execute('return await editorAudioUpload("music",arguments[0]);',[long])=='ready'
 execute('await editorAudioReady();audioCheck(editorAudioState.dataset.state==="ready",editorAudioState.textContent);return true;')
 after=execute('return ShortsMediaSessions.statistics().audioDecodes;')
 assert after-before==1,('MP3 validation/playback decoded twice',before,after)
 info=execute('return await editorLongAudioInfo();')
 assert info['durationSeconds']>214.6 and info['fullPcmBytes']>64*1048576 and info['retainedPcmBytes']==30*44100*2*4,info
 execute('editorSeek.value="15000";editorSeek.dispatchEvent(new Event("input",{bubbles:true}));await editorLiveReady("audio-scene-1",15000);return true;')
 click('#playPreview');signal=execute('return await editorAudioPlaying(30);');assert signal['rms']>.0001 and signal['offset']==15,signal
 click('#playPreview');execute('await editorAudioPaused();return true;');click('#playPreview');resumed=execute('return await editorAudioPlaying(30);');assert resumed['offset']>=15,resumed
 # Replacement while playing; subsequent failures preserve this exact DTO/media.
 assert execute('return await editorAudioUpload("music",arguments[0]);',[short])=='ready'
 execute('await editorAudioReady();return true;')
 assert execute('return await editorAudioUpload("music",arguments[0]);',[long])=='ready'
 execute('await editorAudioReady();await editorTimingWaitForSave();return true;');saved=execute('return await studioUiSnapshot();')
 for item in [{**short,'base64':'SUQz'}, {**short,'base64':'//0AAA=='},oversized]:
  count=execute('return ShortsMediaSessions.statistics().audioDecodes;')
  assert execute('return await editorAudioUpload("music",arguments[0]);',[item])=='error'
  assert execute('return ShortsMediaSessions.statistics().audioDecodes;')==count,'Rejected MP3 entered native decode'
  if item is oversized: assert '96' in execute('return editorMusicStatus.textContent;')
  assert execute('return await studioUiSnapshot();')==saved,'Bad MP3 changed project/originals'
 # Real decoder budget is rejected before native allocation, while the accepted
 # UI music and original remain unchanged. Different window avoids a cache hit.
 execute('''const p=ShortsEditor.backupSnapshot(),s=ShortsMediaSessions.create({owner:{slot:'editor',projectId:p.id},audioDurationMs:15000,limits:{maxDecodedBytes:8*1048576}});const n=ShortsMediaSessions.statistics().audioDecodes;try{await s.prepare([{id:p.audio.music.assetId,kind:'audio'}]);throw Error('budget unexpectedly accepted');}catch(e){audioCheck(['AUDIO_DECODE_BUDGET','MEMORY_BUDGET'].includes(e.code),'real budget refusal '+e.message);}finally{await s.dispose();}audioCheck(ShortsMediaSessions.statistics().audioDecodes===n,'native decode started despite budget');return true;''')
 assert execute('return await studioUiSnapshot();')==saved
 click('#openVideoMode');execute('await editorLiveUntil(()=>ShortsMediaSessions.statistics().sessions===0,"long music teardown");audioCheck(ShortsMediaSessions.statistics().pooledAudio===0&&ShortsMediaSessions.statistics().scratchBytes===0&&ShortsMediaSessions.statistics().residentBytes===0,"long PCM leak");return true;');click('#backToEditor');execute('await editorAudioReady();await editorLiveReady();return true;')
 assert execute('return await studioUiSnapshot();')==saved
 return {'legacyVideo':video,'editor':info,'nativeDecodesForUploadAndPreview':after-before,'signal':signal,'resumed':resumed,'saved':saved}
