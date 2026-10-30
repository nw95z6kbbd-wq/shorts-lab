"""Required native Safari H.264/AAC and WebM, HTTP and real standalone file origin."""
import base64,functools,json,threading,subprocess
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from backup_assets import media_payload
from runtime_session_native import command_result
from safari_file_entry import prepare_native_file_entry
from editor_export_checks import verify_file,component
from editor_recording_evidence import inspect_recording

def check_native_editor_export(root,script,command,click):
 class Handler(SimpleHTTPRequestHandler):
  def log_message(self,*args):pass
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start();grants=[]
 def execute(code,args=None):
  return command_result(command('POST','/execute/async',{'script':(root/'tests/runtime-diagnostics.js').read_text()+'\nconst done=arguments[arguments.length-1];Promise.resolve().then(async()=>{'+code+'}).then(value=>done({ok:true,value}),e=>done({ok:false,failure:ShortsRuntimeDiagnostics.failure(e)}));','args':args or []}))
 def encoded(name):
  return execute('const blob=window[arguments[0]];if(!blob||blob.size>64*1048576)throw Error("Missing/big diagnostic recording");return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({type:blob.type,data:r.result.slice(r.result.lastIndexOf(",")+1)});r.onerror=reject;r.readAsDataURL(blob);});',[name])
 try:
  print('::notice title=Native export initial window::'+json.dumps(command('GET','/window/rect')),flush=True)
  command('POST','/window/rect',{'width':1440,'height':1000,'x':0,'y':0})
  evidence=[]
  for entry in [f'http://127.0.0.1:{server.server_port}/index.html',(root/'downloads/Shorts-Studio.html').as_uri()]:
   if entry.startswith('file:'):grants.append(prepare_native_file_entry(entry,command))
   command('POST','/url',{'url':entry});execute('await ShortsEditorReady;return true;')
   for name in ['studio-data-fixture.js','editor-timing-fixture.js','editor-live-fixture.js','editor-export-fixture.js']:script((root/'tests'/name).read_text())
   for mode,audio in [('auto',True),('webm',True),('auto',False)]:
    label=('file' if entry.startswith('file:') else 'http')+'-'+mode+'-'+str(audio);folder=root/'test-results/editor-canvas/editor-export'/label;folder.mkdir(parents=True,exist_ok=True)
    prepared=execute('return await prepareEditorExportFixture(arguments[0],arguments[1]);',[media_payload(),{'format':mode,'audio':audio}])
    if mode=='auto':assert any(t.startswith('video/mp4') for t in prepared['formats']), 'This Safari has no compatible H.264/AAC encoder: actual MP4 requirement not verified'
    script((root/'tests/editor-export-safari-diagnostics.js').read_text());script('window.stopExportTrace=installEditorExportTrace();')
    print('::notice title=Native export visible canvas::'+json.dumps(script('const r=exportCanvas.getBoundingClientRect();return {screen:[screen.availWidth,screen.availHeight,devicePixelRatio,screenX,screenY],hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===exportCanvas,viewport:[innerWidth,innerHeight],rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:document.visibilityState,focus:document.hasFocus(),capture:typeof HTMLCanvasElement.prototype.captureStream};')),flush=True)
    click('#editorExportStart')
    try:
     result=execute('return await finishEditorExportFixture();');data=encoded('editorExportBlob');path=folder/('recording.'+result['extension']);path.write_bytes(base64.b64decode(data['data']));actual=verify_file(path,result,audio)
     if mode=='auto':assert result['container']=='mp4' and actual['video']=='h264' and (not audio or actual['audio']=='aac'),result
     else:assert result['container']=='webm'
     if audio:assert execute('return await exerciseEditorExportErrors();')==['missing image','overflow','resource count']
     evidence.append({'entry':entry,'mode':mode,'actual':actual})
    except Exception as failure:
     print('::error title=Editor export native trace::'+json.dumps(script('return {states:exportStates,progress:exportProgress.slice(-6),trace:{recorders:editorExportTrace.recorders,contexts:editorExportTrace.contexts.map(c=>({rate:c.sampleRate,state:c.state,time:c.currentTime})),progress:editorExportTrace.progress.slice(-8)}};')),flush=True)
     try:
      script('stopExportTrace();');execute('await setupEditorExportMatrix();return true;')
      matrix=[]
      for config in [
       {'mixer':True,'monitor':True,'captureFirst':True,'lateAudio':True,'opaque':True,'realAudio':True,'renderer':True,'readback':True,'type':'video/mp4;codecs=avc1.42001f,mp4a.40.2','cssWidth':90},
       {'mixer':True,'monitor':True,'captureFirst':True,'lateAudio':True,'opaque':True,'realAudio':True,'renderer':True,'readback':True,'type':'video/mp4;codecs=avc1.42001f,mp4a.40.2','cssWidth':180},
       {'mixer':True,'monitor':True,'captureFirst':True,'lateAudio':True,'opaque':True,'realAudio':True,'renderer':True,'readback':True,'type':'video/mp4;codecs=avc1.42001f,mp4a.40.2','cssWidth':270},
       {'mixer':True,'monitor':True,'captureFirst':True,'lateAudio':True,'opaque':True,'realAudio':True,'renderer':True,'readback':True,'type':'video/mp4;codecs=avc1.42001f,mp4a.40.2','cssWidth':360},
      ]:
       script('window.exportMatrixConfig=arguments[0];',[config]);click('#exportMatrix');row=execute('return await exportMatrixPromise;')
       if row.get('bytes'):
        data=encoded('exportMatrixBlob');path=folder/('matrix-'+str(len(list(folder.glob('matrix-*.mp4'))))+'.mp4');path.write_bytes(base64.b64decode(data['data']));row['independent']=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_entries','stream=codec_name,codec_type,profile,level,width,height,nb_read_frames,start_time,duration:format=duration','-of','json',str(path)]))
       matrix.append(row)
       print('::notice title=Failure-only native graph case::'+json.dumps(row),flush=True)
     except Exception as diagnostic:print('::warning title=Native matrix failure::'+str(diagnostic)[:800],flush=True)
     finally:execute('document.getElementById("exportMatrix")?.remove();window.exportMatrixLease?.release();await window.exportMatrixSession?.dispose();return true;')
     try:
      data=encoded('exportRawBlob');failed=folder/('failed'+('.mp4' if data['type'].startswith('video/mp4') else '.webm'));failed.write_bytes(base64.b64decode(data['data']));actual=inspect_recording(failed)
      colors=[]
      pts=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json',str(failed)]))['frames']
      for point in [.5,1.5,2.5]:
       indices=[i for i,f in enumerate(pts) if float(f['best_effort_timestamp_time'])<=point];index=indices[-1] if indices else 0
       raw=subprocess.run(['ffmpeg','-v','error','-i',str(failed),'-an','-vf',f"select='eq(n,{index})',crop=100:100:300:400,scale=1:1",'-frames:v','1','-threads:v','1','-pix_fmt','rgb24','-f','rawvideo','-'],capture_output=True)
       if raw.returncode:raise RuntimeError('Held frame decode: '+raw.stderr.decode(errors='replace')[-800:])
       colors.append(list(raw.stdout[:3]))
      print('::notice title=Rejected export actual content::'+json.dumps({'colors':colors,'voice':component(failed,440,1),'music':component(failed,880,1),'musicFade':[component(failed,880,.03),component(failed,880,2.9)]}),flush=True)
      print('::error title=Native Editor export independent evidence::'+json.dumps({'failure':str(failure),'mime':data['type'],'formats':prepared['formats'],'streams':actual['streams'],'video':actual['video'],'audio':actual['audio'],'format':actual['format']}),flush=True)
      (folder/'state.json').write_text(json.dumps(script('return {states:window.exportStates,progress:window.exportProgress,status:window.exportJob?.status()};'),ensure_ascii=False,indent=2))
     except Exception as diagnostic:print('::warning title=Editor export evidence::'+str(diagnostic)[:500],flush=True)
     repeats=[];script('window.exportOriginalBitmap=window.createImageBitmap;')
     try:
      for backend in ['native','element','cpu-mirror']:
       row={'backend':backend}
       script('window.createImageBitmap=arguments[0]==="element"?undefined:window.exportOriginalBitmap;',[backend])
       if backend=='cpu-mirror':script('window.stopCpuMirror=attachExportCpuMirror(exportCanvas);')
       try:
        execute('await exportJob.prepare({project:exportOriginal,canvas:exportCanvas,contentRevision:8});return true;');click('#editorExportStart');result=execute('return await finishEditorExportFixture();');row['valid']=True;row['file']={k:result[k] for k in ['container','videoCodec','audioCodec','durationMs']}
       except Exception as diagnostic:row['error']=str(diagnostic)[:450]
       row['raw']=execute('return exportRawBlob?ShortsExportInspector.inspectBytes(new Uint8Array(await exportRawBlob.arrayBuffer())):null;');repeats.append(row)
       execute('await exportJob.cancel();return true;')
       if backend=='cpu-mirror':row['mirror']=script('return stopCpuMirror();')
      print('::notice title=Failure-only controller decoder comparison::'+json.dumps(repeats),flush=True)
     finally:script('window.createImageBitmap=window.exportOriginalBitmap;')
     raise
    script('stopExportTrace();');execute('await disposeEditorExportFixture();return true;')
  print('::notice title=Native Safari Editor export confirmed::'+json.dumps(evidence),flush=True)
 finally:
  for grant in grants:grant.unlink(missing_ok=True)
  server.shutdown();server.server_close()
