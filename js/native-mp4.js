(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.ShortsNativeMP4=factory({
    VideoEncoder:root.VideoEncoder,AudioEncoder:root.AudioEncoder,VideoFrame:root.VideoFrame,AudioData:root.AudioData,
    OfflineAudioContext:root.OfflineAudioContext||root.webkitOfflineAudioContext,
    playable:type=>!!root.document.createElement('video').canPlayType(type),
    render:(...args)=>root.ShortsVideoRenderer.render(...args),mix:(...args)=>root.ShortsVideoAudio.connectMix(...args),
    workspace:owner=>root.ShortsMediaSessions.workspace(owner),yield:()=>new Promise(r=>setTimeout(r,0))
  });
})(typeof globalThis!=='undefined'?globalThis:this,function(io){
  'use strict';
  const error=(code,message,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),{code});
  const AVC={codec:'avc1.42001f',width:720,height:1280,bitrate:2600000,framerate:24,avc:{format:'avc'},latencyMode:'realtime'};
  const AAC={codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,bitrate:128000};
  async function support(audio){
    if(!io.VideoEncoder||!io.VideoFrame||audio&&(!io.AudioEncoder||!io.AudioData||!io.OfflineAudioContext))return null;
    // Every successful export must also pass this browser's playback probe.
    // Do not query an encoder for a container/codec the browser cannot decode.
    if(io.playable&&!io.playable('video/mp4;codecs=avc1.42001f'+(audio?',mp4a.40.2':'')))return null;
    try{const v=await io.VideoEncoder.isConfigSupported(AVC),a=audio?await io.AudioEncoder.isConfigSupported(AAC):null;if(!v.supported||audio&&!a.supported)return null;return Object.freeze({video:Object.freeze({...AVC,avc:Object.freeze({format:'avc'})}),audio:audio?Object.freeze({...AAC}):null,mimeType:'video/mp4;codecs=avc1.42001f'+(audio?',mp4a.40.2':'')});}catch(_){return null;}
  }
  function audioSpecificConfig(bytes) {
    if(!(bytes instanceof Uint8Array)||bytes.length<2||bytes.length>65536)throw error('CODEC','Неверное описание AAC encoder.');
    const bad=()=>{throw error('CODEC','Повреждён или не поддерживается AAC ES_Descriptor encoder.');};
    if(bytes[0]===3){
      // Older Cocoa AudioEncoder returns its MPEG-4 magic cookie rather than
      // the AudioSpecificConfig. Parse descriptors; never search for a byte tag.
      const descriptor=(at,end)=>{if(at+2>end)bad();const tag=bytes[at++];let length=0,done=false;for(let n=0;n<4;n++){if(at>=end)bad();const value=bytes[at++];length=length*128+(value&127);if(!(value&128)){done=true;break;}}if(!done||at+length>end)bad();return{tag,data:at,end:at+length};};
      const es=descriptor(0,bytes.length);if(es.tag!==3||es.end!==bytes.length||es.data+3>es.end)bad();const flags=bytes[es.data+2];let at=es.data+3;
      if(flags&128)at+=2;if(flags&64){if(at>=es.end)bad();at+=1+bytes[at];}if(flags&32)at+=2;
      const dc=descriptor(at,es.end);if(dc.tag!==4||dc.data+13>dc.end||bytes[dc.data]!==64||(bytes[dc.data+1]>>>2)!==5)bad();
      const asc=descriptor(dc.data+13,dc.end);if(asc.tag!==5||asc.end!==dc.end||asc.end-asc.data<2)bad();
      if(dc.end<es.end){const sl=descriptor(dc.end,es.end);if(sl.tag!==6||sl.end!==es.end||sl.end-sl.data!==1||bytes[sl.data]!==2)bad();}
      bytes=bytes.slice(asc.data,asc.end);
    }
    // This backend explicitly requests AAC-LC, 48 kHz stereo. Do not manufacture
    // a config from that request or relabel another actual codec/rate/channel set.
    if(bytes.length>64||bytes[0]>>>3!==2||((bytes[0]&7)<<1|bytes[1]>>>7)!==3||((bytes[1]>>>3)&15)!==2)throw error('CODEC','Encoder не вернул AAC-LC 48 кГц stereo.');
    return bytes;
  }
  const text=s=>Uint8Array.from(s,c=>c.charCodeAt(0));
  const uint=(n,size=4)=>{if(!Number.isSafeInteger(n)||n<0||n>=2**(size*8))throw error('MUX','Неверное число в MP4.');const b=new Uint8Array(size);for(let i=size-1;i>=0;i--){b[i]=n%256;n=Math.floor(n/256);}return b;};
  const zeros=n=>new Uint8Array(n),cat=(...arrays)=>{const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let p=0;for(const a of arrays){out.set(a,p);p+=a.length;}return out;};
  const box=(name,...parts)=>{const payload=cat(...parts);return cat(uint(payload.length+8),text(name),payload);};
  const full=(name,payload,version=0,flags=0)=>box(name,uint(version,1),uint(flags,3),payload);
  const matrix=cat(uint(65536),zeros(12),uint(65536),zeros(12),uint(1073741824));
  function runs(samples){const out=[];for(const s of samples){if(!Number.isSafeInteger(s.duration)||s.duration<1)throw error('MUX','Неверная длительность MP4 sample.');const last=out.at(-1);if(last&&last.duration===s.duration)last.count++;else out.push({count:1,duration:s.duration});}return cat(uint(out.length),...out.map(s=>cat(uint(s.count),uint(s.duration))));}
  function mux({video,audio=null,durationMs}){
    if(!video?.samples?.length||!video.description?.length||!Number.isSafeInteger(durationMs)||durationMs<=0)throw error('MUX','Нет подготовленных видеоданных MP4.');
    for(const t of [video,...(audio?[audio]:[])]){if(!(t.description instanceof Uint8Array)||!t.description.length||t.description.length>65536||!t.samples.length||t.samples.length>20000||t.samples.some(s=>!(s.data instanceof Uint8Array)||!s.data.length))throw error('MUX','Неверная структура MP4 sample.');}
    if(video.samples.reduce((n,s)=>n+s.data.length,0)+(audio?audio.samples.reduce((n,s)=>n+s.data.length,0):0)>64*1048576)throw error('OUTPUT_BUDGET','Медиаданные MP4 превышают 64 МиБ.');
    const ftyp=box('ftyp',text('isom'),uint(512),text('isomiso2avc1mp41')),tracks=[{...video,id:1,kind:'video',scale:1000000}];if(audio)tracks.push({...audio,id:2,kind:'audio',scale:48000});
    let offset=ftyp.length+8;for(const t of tracks){t.offset=offset;t.total=t.samples.reduce((n,s)=>n+s.duration,0);offset+=t.samples.reduce((n,s)=>n+s.data.length,0);}
    const movieDuration=Math.max(durationMs,...tracks.map(t=>Math.ceil(t.total/t.scale*1000)));
    const mvhd=full('mvhd',cat(zeros(8),uint(1000),uint(movieDuration),uint(65536),uint(256,2),zeros(10),matrix,zeros(24),uint(tracks.length+1)));
    function track(t){
      const video=t.kind==='video',tkhd=full('tkhd',cat(zeros(8),uint(t.id),zeros(4),uint(Math.ceil(t.total/t.scale*1000)),zeros(8),zeros(4),uint(video?0:256,2),zeros(2),matrix,uint(video?720*65536:0),uint(video?1280*65536:0)),0,7);
      const mdhd=full('mdhd',cat(zeros(8),uint(t.scale),uint(t.total),uint(0x55c4,2),zeros(2)));
      const hdlr=full('hdlr',cat(zeros(4),text(video?'vide':'soun'),zeros(12),text('Shorts Studio\0')));
      let entry;
      if(video){entry=box('avc1',zeros(6),uint(1,2),zeros(16),uint(720,2),uint(1280,2),uint(72*65536),uint(72*65536),zeros(4),uint(1,2),zeros(32),uint(24,2),uint(65535,2),box('avcC',t.description));}
      else{
        const descriptor=(tag,payload)=>{if(payload.length>127)throw error('MUX','Слишком длинное описание AAC.');return cat(uint(tag,1),uint(payload.length,1),payload);};
        const config=descriptor(4,cat(uint(64,1),uint(21,1),zeros(3),uint(128000),uint(128000),descriptor(5,t.description)));
        const esds=full('esds',descriptor(3,cat(uint(t.id,2),uint(0,1),config,descriptor(6,uint(2,1)))));
        entry=box('mp4a',zeros(6),uint(1,2),zeros(8),uint((t.description[1]>>>3)&15,2),uint(16,2),zeros(4),uint(48000*65536),esds);
      }
      const stsd=full('stsd',cat(uint(1),entry)),stts=full('stts',runs(t.samples)),stsc=full('stsc',cat(uint(1),uint(1),uint(t.samples.length),uint(1))),stsz=full('stsz',cat(uint(0),uint(t.samples.length),...t.samples.map(s=>uint(s.data.length)))),stco=full('stco',cat(uint(1),uint(t.offset)));
      const sync=video?full('stss',cat(uint(t.samples.filter(s=>s.key).length),...t.samples.flatMap((s,i)=>s.key?[uint(i+1)]:[]))):zeros(0);
      const dinf=box('dinf',full('dref',cat(uint(1),full('url ',zeros(0),0,1))));
      const minf=box('minf',video?full('vmhd',zeros(8),0,1):full('smhd',zeros(4)),dinf,box('stbl',stsd,stts,stsc,stsz,stco,sync));
      return box('trak',tkhd,box('mdia',mdhd,hdlr,minf));
    }
    const moov=box('moov',mvhd,...tracks.map(track)),data=tracks.flatMap(t=>t.samples.map(s=>s.data)),bytes=data.reduce((n,a)=>n+a.length,0);
    return new Blob([ftyp,uint(bytes+8),text('mdat'),...data,moov],{type:'video/mp4'});
  }
  async function encode({canvas,plan,resources,voiceBuffer,musicBuffer,voiceVolume,musicVolume,fadeIn,fadeOut,recordingPolicy,signal,onProgress=()=>{},onFormat=()=>{}}){
    if(!Number.isSafeInteger(plan.durationMs)||plan.durationMs<1||Math.ceil(plan.durationMs*(voiceBuffer||musicBuffer?2728000:2600000)/8000)>recordingPolicy.maxBytes)throw error('OUTPUT_BUDGET','План превышает проверенный рабочий предел кодирования.');
    const config=recordingPolicy.nativeSupport;if(!config||config.video.codec!==AVC.codec||plan.source.mode!=='editor')throw error('FORMAT','Нет проверенной конфигурации нативного MP4.');
    const hasAudio=Boolean(voiceBuffer||musicBuffer);if(hasAudio!==Boolean(config.audio))throw error('AUDIO','Конфигурация AAC не соответствует проекту.');
    const budget=io.workspace(plan.source.projectId),video={description:null,samples:[]},audio=hasAudio?{description:null,samples:[]}:null;let ve,ae,offline,mix,pcm,offlinePending,failed,outputBytes=0,closed=false;
    let rejectFailure;const failure=new Promise((_,reject)=>rejectFailure=reject);failure.catch(()=>{});
    const fail=cause=>{if(closed)return;failed||=cause?.code?cause:error('ENCODER',cause?.message||'Ошибка нативного кодирования.',cause);rejectFailure(failed);};
    const check=()=>{signal?.throwIfAborted();if(failed)throw failed;};
    const abort=()=>fail(signal.reason||new DOMException('Экспорт отменён.','AbortError'));signal?.addEventListener('abort',abort,{once:true});
    const wait=promise=>Promise.race([promise,failure]);
    const output=(target,kind)=>(chunk,metadata)=>{try{
      if(closed)return;check();if(outputBytes+chunk.byteLength>recordingPolicy.maxBytes)throw error('OUTPUT_BUDGET','Видео превышает рабочий предел результата.');budget.reserve(chunk.byteLength);outputBytes+=chunk.byteLength;
      if(metadata?.decoderConfig?.description){const d=metadata.decoderConfig.description,raw=(ArrayBuffer.isView(d)?new Uint8Array(d.buffer,d.byteOffset,d.byteLength):new Uint8Array(d)).slice(),next=kind==='audio'?audioSpecificConfig(raw):raw;if(target.description&&(next.length!==target.description.length||next.some((v,i)=>v!==target.description[i])))throw error('CODEC','Encoder изменил конфигурацию дорожки во время записи.');target.description=next;}
      const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);target.samples.push({data,timestamp:chunk.timestamp,duration:chunk.duration,key:chunk.type==='key'});
    }catch(cause){fail(cause);}};
    async function drain(encoder){while(encoder.encodeQueueSize>=2){check();let done;const pending=new Promise(resolve=>{done=resolve;encoder.addEventListener('dequeue',done,{once:true});if(encoder.encodeQueueSize<2)done();});try{await wait(pending);}finally{encoder.removeEventListener('dequeue',done);}}}
    try{
      check();budget.reserve(720*1280*4*3);onFormat(config.mimeType);
      if(hasAudio){
        const frames=Math.ceil(plan.durationMs*48),bytes=frames*2*4;if(bytes>64*1048576)throw error('DECODED_BUDGET','Смешанное PCM превышает проверенный предел 64 МиБ.');budget.reserve(bytes);
        offline=new io.OfflineAudioContext(2,frames,48000);mix=io.mix(offline,{voiceBuffer,musicBuffer,voiceVolume,musicVolume,fadeIn,fadeOut,durationSeconds:plan.durationMs/1000,destination:offline.destination});mix.start(0);offlinePending=offline.startRendering();pcm=await offlinePending;offlinePending=null;check();mix.stop();mix=null;
        ae=new io.AudioEncoder({output:output(audio,'audio'),error:fail});ae.configure(config.audio);
        for(let offset=0;offset<frames;offset+=1024){check();await drain(ae);const n=Math.min(1024,frames-offset),data=new Float32Array(n*2);for(let c=0;c<2;c++)data.set(pcm.getChannelData(c).subarray(offset,offset+n),c*n);const frame=new io.AudioData({format:'f32-planar',sampleRate:48000,numberOfChannels:2,numberOfFrames:n,timestamp:Math.round(offset/48000*1e6),data});try{ae.encode(frame);}finally{frame.close();}}
        await wait(ae.flush());ae.close();ae=null;pcm=null;offline=null;budget.release(bytes);
      }
      ve=new io.VideoEncoder({output:output(video,'video'),error:fail});ve.configure(config.video);const stamps=new Set();for(let i=0;i<Math.ceil(plan.durationMs*24/1000);i++)stamps.add(Math.round(i*1e6/24));for(const item of [...plan.timeline,...plan.cues])if(item.startMs<plan.durationMs)stamps.add(item.startMs*1000);const times=[...stamps].sort((a,b)=>a-b),count=times.length,durations=new Map();if(count>20000)throw error('ENCODING_BUDGET','План содержит слишком много отдельных видеокадров.');onProgress(0,0);
      for(let i=0;i<count;i++){
        check();await drain(ve);const timestamp=times[i],end=times[i+1]??plan.durationMs*1000;durations.set(timestamp,end-timestamp);
        io.render(canvas,plan,timestamp/1000,resources);const frame=new io.VideoFrame(canvas,{timestamp,duration:end-timestamp});try{ve.encode(frame,{keyFrame:i%48===0});}finally{frame.close();}
        onProgress(Math.min(.98,(i+1)/count),(i+1)===count?plan.durationMs:timestamp/1000);if(i%4===0)await io.yield();
      }
      await wait(ve.flush());ve.close();ve=null;check();if(video.samples.length!==count)throw error('INCOMPLETE','Нативный encoder потерял входные кадры.');
      // WebKit's MediaTime conversion can quantize 1041667 us to 1041666 us.
      // Check every packet against its ordered input (within one microsecond),
      // then keep exact input durations. Counts, order and completeness stay strict.
      let previous=-1;for(let i=0;i<video.samples.length;i++){
        const sample=video.samples[i],expected=times[i];
        if(!Number.isSafeInteger(sample.timestamp)||sample.timestamp<=previous||Math.abs(sample.timestamp-expected)>1)throw error('ENCODER_TIMESTAMPS','Encoder изменил временные метки: кадр '+i+', фактически '+sample.timestamp+' мкс, вход '+expected+' мкс, предыдущая '+previous+' мкс.');
        sample.duration=durations.get(expected);previous=sample.timestamp;
      }
      if(!video.samples[0]?.key)throw error('CODEC','Нет начального ключевого кадра H.264.');
      if(audio){if(!audio.samples.length)throw error('INCOMPLETE','Нет AAC-пакетов.');for(const sample of audio.samples)sample.duration=sample.duration?Math.round(sample.duration*48000/1e6):1024;}
      budget.reserve(outputBytes);const blob=mux({video,audio,durationMs:plan.durationMs});if(blob.size>recordingPolicy.maxBytes)throw error('OUTPUT_BUDGET','Завершённый MP4 превышает рабочий предел.');check();
      return{blob,mimeType:config.mimeType,extension:'mp4',width:720,height:1280,durationMs:plan.durationMs};
    }finally{
      signal?.removeEventListener('abort',abort);closed=true;for(const encoder of [ve,ae])if(encoder&&encoder.state!=='closed')try{encoder.close();}catch(_){}
      if(offlinePending)await offlinePending.catch(()=>{});try{mix?.stop();}catch(_){}pcm=null;offline=null;budget.close();
    }
  }
  return Object.freeze({support,encode,mux});
});
