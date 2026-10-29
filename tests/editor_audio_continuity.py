"""Real Editor scene boundaries with continuous MP3; shared by all engines."""
from editor_audio_long_checks import long_audio_payload

def check_editor_audio_continuity(root,execute,click,images):
 result=[];music=long_audio_payload(root)[1]
 for use_images in [False,True]:
  execute('await editorBoundarySetup(arguments[0],arguments[1]);return true;',[use_images,music])
  if use_images:
   for i in range(4):execute('return await editorLiveUpload(arguments[0],arguments[1]);',[i,images[i%3]])
   execute('await editorLiveSeek(0,"boundary-0");await editorAudioReady();return true;')
  execute('editorBoundaryArm(arguments[0]);return true;',[use_images]);click('#playPreview')
  result.append(execute('return await editorBoundaryMeasure();'))
  click('#openVideoMode');execute('await editorLiveUntil(()=>ShortsMediaSessions.statistics().sessions===0,"continuity teardown");audioCheck(editorAudioNoLeaks().liveContexts===0,"continuity contexts survive teardown");return true;');click('#backToEditor');execute('await editorAudioReady();await editorLiveReady();return true;')
 return result
