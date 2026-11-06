/* Bounded synthetic candidate. Deliberately NOT loaded by the application.
 * Requires independent raw-decoder/MP4 confirmation before production use. */
(function(root){
 'use strict';
 const RATE=48000,UNIT=1024,PREFIX=4096,MAX_SOURCE=144000,MAX_DELAY=4096;
 const CONFIG=Object.freeze({codec:'mp4a.40.2',sampleRate:RATE,numberOfChannels:2,bitrate:128000});
 const fail=code=>{throw Object.assign(new Error('AAC runtime calibration refused: '+code),{code});};
 const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
 function stimulus(n,seed=0x74a51d32){
  if(!Number.isSafeInteger(n)||n<1024||n>MAX_SOURCE)fail('SOURCE_BUDGET');
  const pcm=new Float32Array(n*2);let state=seed,left=0,right=0;
  const noise=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2147483648-1;};
  for(let i=0;i<n;i++){left=.6*left+.4*noise();right=.6*right+.4*noise();pcm[i*2]=.5*left;pcm[i*2+1]=.5*right;}
  return pcm;
 }
 function wrap(source){
  if(!(source instanceof Float32Array)||source.length%2||source.length<2048||source.length>MAX_SOURCE*2||!source.every(Number.isFinite))fail('SOURCE_BUDGET');
  const frames=source.length/2,pcm=new Float32Array((frames+PREFIX*2)*2);
  pcm.set(stimulus(2048,0x5b713e9a));pcm.set(source,PREFIX*2);
  pcm.set(stimulus(2048,0x13ec9085),(PREFIX+frames+2048)*2);
  return {pcm,sourceFrames:frames,prefix:PREFIX,markers:[{name:'head',start:0,frames:2048},{name:'tail',start:PREFIX+frames+2048,frames:2048}]};
 }
 // Mean-centered NCC with explicit competing-peak evidence. The search bound is
 // a supported calibration domain, never a guessed delay or gap tolerance.
 function correlate(reference,decoded,markers,maxDelay=MAX_DELAY){
  if(!Number.isInteger(maxDelay)||maxDelay<0||maxDelay>MAX_DELAY)fail('SEARCH_BUDGET');
  const evidence=[];
  for(const marker of markers){
   const {start,frames}=marker;if(!Number.isInteger(start)||!Number.isInteger(frames)||frames<64||start<0||(start+frames)*2>reference.length)fail('MARKER_BOUNDS');
   for(let c=0;c<2;c++){
    let mean=0,energy=0;for(let i=0;i<frames;i++)mean+=reference[(start+i)*2+c];mean/=frames;
    const template=new Float64Array(frames);for(let i=0;i<frames;i++){template[i]=reference[(start+i)*2+c]-mean;energy+=template[i]**2;}
    const scores=[];
    for(let lag=0;lag<=maxDelay&&start+frames+lag<=decoded.length/2;lag++){
     let dot=0,sum=0,squares=0;for(let i=0;i<frames;i++){const y=decoded[(start+lag+i)*2+c];dot+=template[i]*y;sum+=y;squares+=y*y;}
     const denominator=Math.sqrt(Math.max(0,squares-sum*sum/frames)*energy);scores.push(denominator>1e-12?dot/denominator:0);
    }
    let lag=0;for(let i=1;i<scores.length;i++)if(scores[i]>scores[lag])lag=i;
    let other=-1;for(let i=0;i<scores.length;i++)if(Math.abs(i-lag)>8)other=Math.max(other,scores[i]);
    const correlation=scores[lag]??0; evidence.push({name:marker.name,channel:c,lag,correlation,peakSeparation:correlation-other});
   }
  }
  if(!evidence.length||evidence.some(e=>e.correlation<.45||e.peakSeparation<.05))fail('AMBIGUOUS_CONTENT');
  // A sample-exact edit must have one answer, not an interval of plausible trim.
  const delay=evidence[0].lag;if(evidence.some(e=>e.lag!==delay))fail('INCONSISTENT_CONTENT_DELAY');
  return {delay,evidence};
 }
 function content(reference,decoded,offset){
  const n=reference.length/2;if(!Number.isSafeInteger(offset)||offset<0||offset+n>decoded.length/2)fail('MISSING_SOURCE_TAIL');
  let firstUseful=0,lastUseful=n-1;
  while(firstUseful<n&&reference[firstUseful*2]===0&&reference[firstUseful*2+1]===0)firstUseful++;
  while(lastUseful>=0&&reference[lastUseful*2]===0&&reference[lastUseful*2+1]===0)lastUseful--;
  const windows=[['first',0,1024],['middle',Math.floor(n/2)-512,1024],['end',n-1024,1024],['last640',n-640,640],['first64',0,64],['last64',n-64,64]];
  if(firstUseful<n){windows.push(['firstUseful64',Math.min(firstUseful,n-64),64],['lastUseful64',Math.max(0,lastUseful-63),64]);}
  for(let start=0;start<n;start+=UNIT)windows.push(['block-'+start,Math.min(start,n-UNIT),UNIT]);
  return windows.map(([name,start,width])=>{
   const correlations=[];for(let c=0;c<2;c++){
    let xy=0,xx=0,yy=0;for(let i=0;i<width;i++){const x=reference[(start+i)*2+c],y=decoded[(offset+start+i)*2+c];xy+=x*y;xx+=x*x;yy+=y*y;}
    if(xx===0){correlations.push(null);continue;} // silence is explicitly not correlation evidence
    correlations.push(xy/Math.sqrt(Math.max(xx*yy,1e-30)));
   }
   if(correlations.some(v=>v!==null&&v<.45))fail('SOURCE_CONTENT_MISMATCH');
   return {name,start,frames:width,correlations,silentChannels:correlations.map((v,c)=>v===null?c:null).filter(c=>c!==null)};
  });
 }
 function timing(chunks){
  if(!chunks.length||chunks.length>192)fail('PACKET_BUDGET');const first=chunks[0].timestamp;
  if(!Number.isSafeInteger(first))fail('PACKET_TIMESTAMPS');
  for(let i=0;i<chunks.length;i++){
   const c=chunks[i];if(!Number.isSafeInteger(c.timestamp)||Math.abs(c.timestamp-first-i*UNIT*1e6/RATE)>1)fail('PACKET_TIMESTAMPS');
   // A missing duration is not zero and is not a measured coded duration.
   // AAC-LC/1024 is independently verified from ASC and decoded frame count.
   if(c.duration!=null&&(!Number.isSafeInteger(c.duration)||Math.abs(c.duration-UNIT*1e6/RATE)>1))fail('PACKET_DURATION');
  }
  return first;
 }
 function create(io=root){
  const helper=io.SafariAACProbe||root.SafariAACProbe;if(!helper)fail('MISSING_ASC_PARSER');
  async function measure(source,{signal,onEvidence=()=>{}}={}){
   const wrapped=wrap(source),record={schema:1,config:{...CONFIG},sourceFrames:wrapped.sourceFrames,prefix:PREFIX,markers:wrapped.markers,
    inputPCMBase64:helper.pcm64(wrapped.pcm),inputs:[],chunks:[],decodes:{},events:[],error:null};
   const end=Math.ceil(wrapped.pcm.length/2/UNIT)*UNIT+2*UNIT,deadline=Date.now()+20000;
   let encoder,decoder,failed,created=0,closed=0,decodedCreated=0,decodedClosed=0,byteCount=0,descriptionBytes=0;
   let rejectFailure;const failure=new Promise((_,reject)=>{rejectFailure=reject;});failure.catch(()=>{});
   const reject=e=>{failed||=e;rejectFailure(failed);};
   const check=()=>{signal?.throwIfAborted();if(failed)throw failed;if(Date.now()>deadline)fail('DEADLINE');};
   const abort=()=>reject(signal.reason||Object.assign(new Error('Aborted'),{name:'AbortError'}));signal?.addEventListener('abort',abort,{once:true});
   async function wait(p){check();let timer;try{return await Promise.race([p,failure,new Promise((_,r)=>{timer=setTimeout(()=>r(Object.assign(new Error('Calibration deadline'),{code:'DEADLINE'})),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}}
   const chunks=[];let description,asc,dc;
   async function decode(mode){
    const pieces=[],frames=[];let count=0;
    decoder=new io.AudioDecoder({output(frame){decodedCreated++;try{
     if(frame.sampleRate!==RATE||frame.numberOfChannels!==2||frame.numberOfFrames<UNIT||frame.numberOfFrames%UNIT||count+frame.numberOfFrames>200000)fail('DECODER_SKIPPING_OR_FORMAT');
     const out=new Float32Array(frame.numberOfFrames*2);for(let c=0;c<2;c++){const plane=new Float32Array(frame.numberOfFrames);frame.copyTo(plane,{planeIndex:c,format:'f32-planar'});for(let i=0;i<plane.length;i++){if(!Number.isFinite(plane[i]))fail('DECODE_NONFINITE');out[i*2+c]=plane[i];}}
     const origin=mode==='shifted'?1000000:chunks[0].timestamp;
     if(!Number.isSafeInteger(frame.timestamp)||Math.abs(frame.timestamp-origin-count*1e6/RATE)>1)fail('DECODER_TIMELINE');
     frames.push({timestamp:frame.timestamp,numberOfFrames:frame.numberOfFrames,sampleRate:frame.sampleRate,numberOfChannels:frame.numberOfChannels,duration:frame.duration??null});pieces.push(out);count+=frame.numberOfFrames;
    }catch(e){reject(e);}finally{frame.close();decodedClosed++;}},error:reject});
    try{
     const config={...dc,description:mode==='cookie'?description:asc};
     if(!(await wait(io.AudioDecoder.isConfigSupported(config))).supported)fail('DECODER_UNAVAILABLE');
     decoder.configure(config);
     for(let i=0;i<chunks.length;i++){
      check();while(decoder.decodeQueueSize>=4){await wait(tick());}
      decoder.decode(new io.EncodedAudioChunk({...chunks[i],timestamp:mode==='shifted'?1000000+Math.round(i*UNIT*1e6/RATE):chunks[i].timestamp}));
     }
     await wait(decoder.flush());check();
     if(count!==chunks.length*UNIT)fail('DECODER_SKIPPING_OR_SHORT_OUTPUT');
     const pcm=new Float32Array(count*2);let offset=0;for(const p of pieces){pcm.set(p,offset);offset+=p.length;}
     record.decodes[mode]={frames,pcmBase64:helper.pcm64(pcm)};return pcm;
    }finally{if(decoder.state!=='closed')decoder.close();decoder=null;}
   }
   try{
    check();if(!io.AudioEncoder||!io.AudioDecoder||!io.AudioData||!io.EncodedAudioChunk)fail('WEB_CODECS_UNAVAILABLE');
    if(!(await wait(io.AudioEncoder.isConfigSupported(CONFIG))).supported)fail('AAC_UNAVAILABLE');
    encoder=new io.AudioEncoder({output(chunk,metadata){try{
     if(chunks.length>=192||chunk.byteLength<1||(byteCount+=chunk.byteLength)>2*1048576)fail('PACKET_BUDGET');
     const config=metadata?.decoderConfig;
     if(config){
      if(config.codec!==CONFIG.codec||config.sampleRate!==RATE||config.numberOfChannels!==2||!config.description)fail('DECODER_CONFIG');
      const raw=ArrayBuffer.isView(config.description)?new Uint8Array(config.description.buffer,config.description.byteOffset,config.description.byteLength):new Uint8Array(config.description);
      if((descriptionBytes+=raw.length)>65536)fail('DESCRIPTION_BUDGET');const candidate=helper.ascFromDescription(raw);
      if(candidate.length<2||candidate.length>64||candidate[0]>>>3!==2||((candidate[0]&7)<<1|candidate[1]>>>7)!==3||((candidate[1]>>>3)&15)!==2||(candidate[1]&7))fail('ASC_CONFIG');
      if(asc&&(candidate.length!==asc.length||candidate.some((b,i)=>b!==asc[i])))fail('CHANGING_ASC');
      description=raw.slice();asc=candidate.slice();dc={codec:config.codec,sampleRate:config.sampleRate,numberOfChannels:config.numberOfChannels};
     }
     const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);const native={type:chunk.type,timestamp:chunk.timestamp,data};if(chunk.duration!=null)native.duration=chunk.duration;chunks.push(native);
     record.chunks.push({timestamp:chunk.timestamp,duration:chunk.duration??null,durationPresent:chunk.duration!=null,type:chunk.type,dataBase64:bytes64(data),metadata:helper.metadataRecord(metadata)});
    }catch(e){reject(e);}},error:reject});
    encoder.configure(CONFIG);
    for(let offset=0;offset<end;offset+=UNIT){
     check();while(encoder.encodeQueueSize>=2){await wait(tick());}
     const data=new Float32Array(UNIT*2);for(let c=0;c<2;c++)for(let i=0;i<UNIT;i++)data[c*UNIT+i]=wrapped.pcm[(offset+i)*2+c]||0;
     const frame=new io.AudioData({format:'f32-planar',sampleRate:RATE,numberOfChannels:2,numberOfFrames:UNIT,timestamp:Math.round(offset*1e6/RATE),data});created++;
     record.inputs.push({offset,frames:frame.numberOfFrames,timestamp:frame.timestamp,duration:frame.duration??null,sampleRate:frame.sampleRate,numberOfChannels:frame.numberOfChannels,sourceFrames:Math.max(0,Math.min(UNIT,wrapped.pcm.length/2-offset))});
     try{encoder.encode(frame);}finally{frame.close();closed++;}
    }
    record.events.push('flush-called');await wait(encoder.flush());record.events.push('flush-resolved');check();encoder.close();encoder=null;record.events.push('encoder-closed');
    if(!asc)fail('MISSING_ASC');const origin=timing(chunks);
    const decoded=await decode('cookie');
    for(const mode of ['asc','shifted']){const other=await decode(mode);if(other.length!==decoded.length||other.some((v,i)=>Math.abs(v-decoded[i])>1e-6))fail('DECODER_SIDE_TRIMMING');}
    const measured=correlate(wrapped.pcm,decoded,wrapped.markers);
    if(Math.abs(origin)>1&&Math.abs(origin+measured.delay*1e6/RATE)>1)fail('UNEXPLAINED_TIMESTAMP_ORIGIN');
    if(wrapped.pcm.length/2+measured.delay>decoded.length/2)fail('MISSING_CANARY_TAIL');
    const verified=content(source,decoded,PREFIX+measured.delay);
    check();const result={delay:measured.delay,trim:PREFIX+measured.delay,presentationFrames:source.length/2,
     decodedFrames:decoded.length/2,servicePrefixFrames:PREFIX,serviceSuffixFrames:PREFIX,
     codedPaddingAfterEnvelope:decoded.length/2-measured.delay-wrapped.pcm.length/2,
     nonPresentationTailFrames:decoded.length/2-PREFIX-measured.delay-source.length/2,completionZeroFrames:end-wrapped.pcm.length/2,
     submittedFrames:end,packetDelta:chunks.length-end/UNIT,ascHex:Array.from(asc,b=>b.toString(16).padStart(2,'0')).join(''),
     markers:measured.evidence,content:verified};
    record.measurement=result;return result;
   }catch(e){record.error={code:e.code||e.name};throw e;}
   finally{
    if(encoder&&encoder.state!=='closed')encoder.close();if(decoder&&decoder.state!=='closed')decoder.close();signal?.removeEventListener('abort',abort);
    record.resources={created,closed,decodedCreated,decodedClosed,encoderClosed:!encoder||encoder.state==='closed',decoderClosed:!decoder||decoder.state==='closed'};
    onEvidence(record);
   }
  }
  async function checkDecoderReference(reference,options={}){
   if(reference?.schema!==1||reference.sourceFrames!==16384||!Array.isArray(reference.chunks)||!reference.chunks.length||reference.chunks.length>192||
      !Number.isSafeInteger(reference.rawContentDelay)||reference.rawContentDelay<0||reference.rawContentDelay>MAX_DELAY||
      Object.keys(CONFIG).some(k=>reference.config?.[k]!==CONFIG[k]))fail('DECODER_REFERENCE_UNAVAILABLE');
   const source=stimulus(reference.sourceFrames),w=wrap(source),end=Math.ceil(w.pcm.length/2/UNIT)*UNIT+2*UNIT;
   const full=new Float32Array(end*2);full.set(w.pcm);
   const from64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
   const packets=reference.chunks.map(c=>({...c,data:from64(c.dataBase64)})),size=packets.reduce((n,c)=>n+c.data.length,0);
   if(size>2*1048576)fail('REFERENCE_BUDGET');
   const payload=new Uint8Array(size);let at=0;for(const c of packets){payload.set(c.data,at);at+=c.data.length;}
   const cryptoAPI=io.crypto||root.crypto;if(!cryptoAPI?.subtle)fail('REFERENCE_CHECK_UNAVAILABLE');
   const hash=async b=>Array.from(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
   if(await hash(from64(helper.pcm64(full)))!==reference.inputSHA256||await hash(payload)!==reference.payloadSHA256)fail('DECODER_REFERENCE_IDENTITY');
   const asc=from64(reference.ascBase64);
   // This adapter only transports a fixed, independently decoded reference to
   // the real AudioDecoder. It is not a runtime encoder measurement.
   class ReferenceTransport{
    static async isConfigSupported(){return {supported:true};}
    constructor(o){this.o=o;this.state='unconfigured';this.encodeQueueSize=0;this.offset=0;}
    configure(){this.state='configured';}
    encode(frame){
     if(frame.numberOfFrames!==UNIT||frame.timestamp!==Math.round(this.offset*1e6/RATE)||this.offset+UNIT>end)fail('REFERENCE_INPUT');
     for(let c=0;c<2;c++){const plane=new Float32Array(UNIT);frame.copyTo(plane,{planeIndex:c,format:'f32-planar'});for(let i=0;i<UNIT;i++)if(plane[i]!==full[(this.offset+i)*2+c])fail('REFERENCE_INPUT');}
     this.offset+=UNIT;
    }
    async flush(){
     if(this.offset!==end)fail('REFERENCE_INPUT');
     packets.forEach((c,i)=>this.o.output({type:c.type,timestamp:c.timestamp,duration:c.duration,byteLength:c.data.length,copyTo:b=>b.set(c.data)},i===0?{decoderConfig:{...CONFIG,description:asc}}:{}));
    }
    close(){this.state='closed';}
   }
   const referenceIO={AudioEncoder:ReferenceTransport,AudioDecoder:io.AudioDecoder,AudioData:io.AudioData,
    EncodedAudioChunk:io.EncodedAudioChunk,crypto:cryptoAPI,SafariAACProbe:helper};
   const measured=await create(referenceIO).measure(source,{...options,onEvidence:r=>options.onEvidence?.({...r,kind:'decoder-reference',expectedRawDelay:reference.rawContentDelay})});
   if(measured.delay!==reference.rawContentDelay||measured.decodedFrames!==reference.rawDecodedFrames)fail('DECODER_REFERENCE_MISMATCH');
   return Object.freeze({payloadSHA256:reference.payloadSHA256,verifiedRawDelay:measured.delay,decodedFrames:measured.decodedFrames});
  }
  const profiles=new WeakSet();
  async function calibrate(options={}){
   const decoderProof=await checkDecoderReference(io.AACDecoderReference,options);
   const measurements=[];
   for(let repeat=0;repeat<2;repeat++)for(const n of [16384,17024])measurements.push(await measure(stimulus(n,0x74a51d32+repeat),options));
   await checkDecoderReference(io.AACDecoderReference,options);
   const first=measurements[0];if(measurements.some(m=>m.delay!==first.delay||m.ascHex!==first.ascHex||m.packetDelta!==first.packetDelta))fail('CALIBRATION_NOT_REPEATABLE');
   const profile=Object.freeze({delay:first.delay,ascHex:first.ascHex,packetDelta:first.packetDelta,decoderProof,config:CONFIG,measurements:Object.freeze(measurements)});profiles.add(profile);return profile;
  }
  async function verify(source,profile,options){
   if(!profiles.has(profile))fail('UNTRUSTED_PROFILE');
   const measured=await measure(source,options);
   if(measured.delay!==profile.delay||measured.ascHex!==profile.ascHex||measured.packetDelta!==profile.packetDelta)fail('EXPORT_DIFFERS_FROM_CALIBRATION');
   return measured;
  }
  return {measure,calibrate,verify,checkDecoderReference};
 }
 function bytes64(data){let s='';for(let i=0;i<data.length;i+=8192)s+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(s);}
 const api={RATE,UNIT,PREFIX,MAX_SOURCE,MAX_DELAY,CONFIG,stimulus,wrap,correlate,content,timing,create};
 if(typeof module==='object')module.exports=api;else root.AACRuntimeProbe=api;
})(globalThis);
