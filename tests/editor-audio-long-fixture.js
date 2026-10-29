/* Synthetic MP3 only. Test the same original through legacy Video and Editor. */
window.editorLongAudioProbe=async function(file){
 const blob=new Blob([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],{type:file.type});
 let buffer=await ShortsVideoRecorder.decodeAudio(blob);
 const video={duration:buffer.duration,sampleRate:buffer.sampleRate,channels:buffer.numberOfChannels,frames:buffer.length,pcmBytes:buffer.length*buffer.numberOfChannels*4,originalBytes:blob.size};
 audioCheck(video.duration>214.6&&video.duration<214.9&&video.channels===2,'representative real MP3 '+JSON.stringify(video));
 buffer=null;
 const id=ShortsCore.id();ShortsStorage.stage(id,blob,file.name,'music');
 const previous=ShortsMediaSessions.create({owner:{slot:'editor',projectId:'old-budget-proof'}});
 try{await previous.prepare([{id,kind:'audio'}]);throw Error('old full-PCM budget did not reject representative MP3');}
 catch(e){audioCheck(e.code==='DECODED_BUDGET','legacy resource limit '+e.message);}
 finally{await previous.dispose();ShortsStorage.discard(id);}
 return video;
};
window.editorLongAudioInfo=async function(){
 const p=ShortsEditor.backupSnapshot(),s=ShortsRenderSessions.createAudio({slot:'editor',project:p,plan:ShortsRenderAdapters.fromEditor(p),contentRevision:901});
 await s.prepare();const lease=s.acquire();
 try{
  const b=lease.audio(p.audio.music.assetId);audioCheck(b.duration===30&&b.numberOfChannels===2,'bounded real MP3 PCM '+JSON.stringify({duration:b?.duration,channels:b?.numberOfChannels,plan:s.plan.durationMs,info:s.status().audioInfo}));
  const result={...s.status().audioInfo.find(i=>i.assetId===p.audio.music.assetId),originalBytes:(await ShortsStorage.asset(p.audio.music.assetId)).blob.size};
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext,context=new Offline(1,30*16000,16000);
  const mix=(window.editorAudioUnobservedMix||ShortsVideoAudio.connectMix)(context,{musicBuffer:b,musicVolume:.25,voiceVolume:0,fadeIn:1,fadeOut:1,durationSeconds:30,destination:context.destination});mix.start(0);const out=await context.startRendering();mix.stop();
  const data=out.getChannelData(0),rms=(a,z)=>{const samples=data.subarray(a*16000,z*16000);return Math.sqrt(samples.reduce((v,x)=>v+x*x,0)/samples.length);};result.fade=[rms(.05,.15),rms(2,2.1),rms(29.85,29.95)];
  audioCheck(result.fade[0]<result.fade[1]*.2&&result.fade[2]<result.fade[1]*.2,'actual 30s prefix fades '+JSON.stringify(result));return result;
 }finally{lease.release();await s.dispose();}
};
window.editorLongVideoUpload=async function(file){
 const editor=ShortsEditor.backupSnapshot(),dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],file.name,{type:file.type}));videoMusic.files=dt.files;videoMusic.dispatchEvent(new Event('change',{bubbles:true}));
 await editorLiveUntil(()=>videoMusicInfo.textContent.includes(file.name)&&!removeVideoMusic.hidden&&!videoMusic.disabled,'actual Video MP3 acceptance');
 audioCheck(ShortsVideoBackup.snapshot().musicName===file.name,'Video DTO music reference');audioCheck(JSON.stringify(ShortsEditor.backupSnapshot())===JSON.stringify(editor),'Video upload mutated Editor');return videoMusicInfo.textContent;
};
