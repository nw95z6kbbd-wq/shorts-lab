/* Test-owned originals and actual audio signal assertions, shared by all engines. */
window.audioCheck=(value,label)=>{if(!value)throw Error('Editor audio: '+label);};
window.editorAudioReady=()=>editorLiveUntil(()=>['ready','silent','error'].includes(document.getElementById('editorAudioState').dataset.state),'audio prepared');
window.editorAudioUpload=async function(role,file){
 const input=document.getElementById(role==='voice'?'editorVoiceFile':'editorMusicFile'),dt=new DataTransfer();
 dt.items.add(new File([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],file.name,{type:file.type}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 await editorLiveUntil(()=>document.getElementById(role==='voice'?'editorVoiceStatus':'editorMusicStatus').dataset.state!=='loading','upload '+role);
 return document.getElementById(role==='voice'?'editorVoiceStatus':'editorMusicStatus').dataset.state;
};
window.editorAudioTap=function(){
 if(window.editorAudioTaps)return;window.editorAudioTaps=[];
 const connect=ShortsVideoAudio.connectMix;
 ShortsVideoAudio.connectMix=function(context,options){
  const analyser=context.createAnalyser();analyser.fftSize=2048;analyser.connect(options.destination);
  const mix=connect(context,{...options,destination:analyser}),tap={context,options,analyser,when:null,stopped:false};editorAudioTaps.push(tap);
  return {start(when){tap.when=when;mix.start(when);},stop(){tap.stopped=true;mix.stop();analyser.disconnect();}};
 };
};
window.editorAudioNoticeOverPlay=async function(){
 const button=document.getElementById('playPreview');button.scrollIntoView({block:'center'});
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const notice=document.getElementById('toast'),old={style:notice.getAttribute('style'),hidden:notice.hidden,text:notice.textContent},r=button.getBoundingClientRect();
 notice.style=`position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;bottom:auto;transform:none;z-index:10000;padding:0`;
 notice.textContent='Информация';notice.hidden=false;
 const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
 audioCheck(hit===button||button.contains(hit),'informational toast intercepts the actual Play hit target');
 window.restoreAudioNotice=()=>{old.style===null?notice.removeAttribute('style'):notice.setAttribute('style',old.style);notice.hidden=old.hidden;notice.textContent=old.text;};
};
window.editorAudioSignal=()=>{
 const tap=editorAudioTaps.at(-1);audioCheck(tap&&!tap.stopped,'active actual mixer');
 const samples=new Float32Array(tap.analyser.fftSize);tap.analyser.getFloatTimeDomainData(samples);
 const rms=Math.sqrt(samples.reduce((n,v)=>n+v*v,0)/samples.length),clock=Math.min(tap.options.durationSeconds*1000,(tap.options.offsetSeconds+Math.max(0,tap.context.currentTime-tap.when))*1000);
 return {rms,clock,canvas:Number(editorCanvas.dataset.timeMs),scene:editorCanvas.dataset.sceneId,offset:tap.options.offsetSeconds,context:tap.context.state,voiceVolume:tap.options.voiceVolume,musicVolume:tap.options.musicVolume,fadeIn:tap.options.fadeIn,fadeOut:tap.options.fadeOut};
};
window.editorAudioPlaying=async function(minTime=200){
 await editorLiveUntil(()=>{const tap=editorAudioTaps.at(-1);return tap&&!tap.stopped&&tap.context.currentTime-tap.when>=minTime/1000&&Number(editorCanvas.dataset.timeMs)>=minTime;},'running audio clock');
 const result=editorAudioSignal();audioCheck(Math.abs(result.clock-result.canvas)<125,'Canvas/audio offset '+JSON.stringify(result));return result;
};
window.editorAudioOffline=async function(){
 const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;audioCheck(Offline,'offline audio support');
 const rms=(buffer,a,b)=>{const data=buffer.getChannelData(0).slice(Math.floor(a*buffer.sampleRate),Math.floor(b*buffer.sampleRate));return Math.sqrt(data.reduce((n,v)=>n+v*v,0)/data.length);};
 async function render({voiceVolume=0,musicVolume=0,fadeIn=0,fadeOut=0,musicDuration=4,voiceDuration=4,offsetSeconds=0}={}){
  const context=new Offline(1,16000*4,16000),tone=(hz,seconds)=>{const b=context.createBuffer(1,16000*seconds,16000),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=.08*Math.sin(2*Math.PI*hz*i/16000);return b;};
  const mix=ShortsVideoAudio.connectMix(context,{voiceBuffer:tone(440,voiceDuration),musicBuffer:tone(880,musicDuration),voiceVolume,musicVolume,fadeIn,fadeOut,durationSeconds:4,offsetSeconds,destination:context.destination});mix.start(0);const out=await context.startRendering();mix.stop();return out;
 }
 const long=await render({voiceVolume:.4,voiceDuration:8,musicVolume:.25,musicDuration:8}),voiceShort=await render({voiceVolume:.4,voiceDuration:1});
 const voiceLow=await render({voiceVolume:.2}),voiceHigh=await render({voiceVolume:.4}),musicLow=await render({musicVolume:.2}),musicHigh=await render({musicVolume:.4}),fade=await render({musicVolume:.4,fadeIn:1,fadeOut:1}),short=await render({musicVolume:.4,musicDuration:2,fadeOut:1}),seek=await render({musicVolume:.4,fadeIn:1,fadeOut:1,offsetSeconds:2});
 const levels={longEnd:rms(long,3.8,3.9),shortVoiceTail:rms(voiceShort,1.5,1.6),voiceRatio:rms(voiceHigh,1,1.2)/rms(voiceLow,1,1.2),musicRatio:rms(musicHigh,1,1.2)/rms(musicLow,1,1.2),fade:[rms(fade,.05,.15),rms(fade,1.5,1.6),rms(fade,3.85,3.95)],shortTail:rms(short,2.5,2.6),seekStart:rms(seek,.2,.3),seekEnd:rms(seek,2.4,2.5)};
 audioCheck(levels.longEnd>.01&&levels.shortVoiceTail<.00001,'long/short source boundaries');audioCheck(levels.voiceRatio>1.95&&levels.voiceRatio<2.05,'voice gain '+JSON.stringify(levels));audioCheck(levels.musicRatio>1.95&&levels.musicRatio<2.05,'music gain');
 audioCheck(levels.fade[0]<levels.fade[1]*.2&&levels.fade[2]<levels.fade[1]*.2,'actual fades '+JSON.stringify(levels));audioCheck(levels.shortTail<.00001&&levels.seekEnd<.00001,'no loop, absolute seek and project cutoff');audioCheck(levels.seekStart>.01,'seek retains absolute envelope');return levels;
};
window.editorAudioSettings=function(){
 const set=(id,value)=>{const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
 set('editorVoiceVolume','40');set('editorMusicVolume','25');set('editorMusicFadeIn','0,250');set('editorMusicFadeOut','0.5');
};
window.editorAudioNoLeaks=()=>{
 const live=[...new Set((window.editorAudioTaps||[]).map(t=>t.context))].filter(c=>c.state!=='closed');
 audioCheck(live.length<=1,'bounded context count '+live.length);return {liveContexts:live.length,sessions:ShortsMediaSessions.statistics().sessions,residentBytes:ShortsMediaSessions.statistics().residentBytes};
};
window.editorAudioShort=function(file,seconds){
 const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)).slice(0,44+16000*2*seconds),view=new DataView(bytes.buffer);
 view.setUint32(4,bytes.length-8,true);view.setUint32(40,bytes.length-44,true);
 return {...file,name:file.name.replace('.wav','-short.wav'),base64:btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''))};
};
