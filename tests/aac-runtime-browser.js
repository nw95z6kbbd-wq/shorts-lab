/* Only synthetic test inputs are accepted by the Python runner. */
(function(root){
 'use strict';
 function plan(original){
  const P=root.AACRuntimeProbe;
  const calibration=[];for(let r=0;r<2;r++)for(const n of [16384,17024])calibration.push({name:`cal-${r}-${n}`,source:P.stimulus(n,0x74a51d32+r)});
  const exports=[1024,1025,2048,144000].map(n=>({name:`control-${n}`,source:P.stimulus(n)}));
  exports.push({name:'original-144000',source:original});return {calibration,exports};
 }
 // Explicit local-only FFmpeg encoder replay. This tests real AudioDecoder and
 // correlation/mux oracles; it NEVER constitutes WebCodecs encoder evidence.
 function replayEncoder(records){
  return class {
   static async isConfigSupported(){return {supported:true};}
   constructor(o){this.o=o;this.state='unconfigured';this.encodeQueueSize=0;this.parts=[];}
   configure(){this.state='configured';}
   encode(frame){
    const piece=new Float32Array(frame.numberOfFrames*2);
    for(let c=0;c<2;c++){const plane=new Float32Array(frame.numberOfFrames);frame.copyTo(plane,{planeIndex:c,format:'f32-planar'});for(let i=0;i<plane.length;i++)piece[i*2+c]=plane[i];}
    this.parts.push(piece);
   }
   async flush(){
    const pcm=new Float32Array(this.parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of this.parts){pcm.set(part,offset);offset+=part.length;}
    const raw=Uint8Array.from(atob(root.SafariAACProbe.pcm64(pcm)),c=>c.charCodeAt(0));
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
    const record=records[digest];if(!record)throw Error('Replay PCM identity mismatch');
    record.chunks.forEach((c,i)=>{
     const data=Uint8Array.from(atob(c),x=>x.charCodeAt(0));
     this.o.output({timestamp:Math.round(i*1024e6/48000),duration:21333,type:'key',byteLength:data.length,copyTo:b=>b.set(data)},
      i===0?{decoderConfig:{codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,description:Uint8Array.from(atob(record.asc),x=>x.charCodeAt(0))}}:{});
    });
   }
   close(){this.state='closed';this.parts=[];}
  };
 }
 async function run(original,replay,reference){
  const {exports}=plan(original),evidence=[],result={status:'incomplete',mode:replay?'FFmpeg AAC encoder replay / real Chromium AudioDecoder':'real WebCodecs encoder and decoder',exports:[]};
  root.AACRuntimeEvidence=evidence;root.AACRuntimeResult=result;
  // Copy WebIDL globals with their actual Window receiver; do not inherit a
  // Window facade (crypto and other getters reject that receiver).
  const io={AudioEncoder:replay?replayEncoder(replay):root.AudioEncoder,AudioDecoder:root.AudioDecoder,
   AudioData:root.AudioData,EncodedAudioChunk:root.EncodedAudioChunk,crypto:root.crypto,
   SafariAACProbe:root.SafariAACProbe,AACDecoderReference:reference};
  const api=root.AACRuntimeProbe.create(io);let index=0;
  try{
   const profile=await api.calibrate({onEvidence:r=>evidence.push({...r,label:(r.kind==='decoder-reference'?'decoder-reference-':'cal-')+index++})});
   result.profile={delay:profile.delay,ascHex:profile.ascHex,packetDelta:profile.packetDelta,decoderProof:profile.decoderProof};
   for(const item of exports){
    const measured=await api.verify(item.source,profile,{onEvidence:r=>evidence.push({...r,label:item.name})});
    result.exports.push({label:item.name,...measured});
   }
   result.status='candidate-measured';
  }catch(e){result.status='refused';result.error={code:e.code||e.name};}
  return result;
 }
 const api={plan,replayEncoder,run};if(typeof module==='object')module.exports=api;else root.AACRuntimeBrowser=api;
})(globalThis);
