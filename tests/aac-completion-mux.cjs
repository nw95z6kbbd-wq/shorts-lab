'use strict';
// Container experiment only: use the existing writer after measuring raw lag.
const fs=require('node:fs'),path=require('node:path');
async function mux(capture,priming,target) {
 const root=path.join(__dirname,'fixtures/editor-export'),ref=JSON.parse(fs.readFileSync(path.join(root,'native-mux-reference.json'))),original=fs.readFileSync(path.join(root,ref.source));
 const list=ref.video.samples,samples=[];
 for(let repeat=0;repeat<3;repeat++)for(let i=0;i<list.length;i++){
  const p=list[i];samples.push({data:original.subarray(p.offset,p.offset+p.size),key:p.key,duration:i===list.length-1?1000000-p.timestamp:list[i+1].timestamp-p.timestamp});
 }
 const configs=capture.chunks.map(c=>c.metadata?.decoderConfig?.ascBase64).filter(Boolean);
 if(!configs.length||configs.some(c=>c!==configs[0]))throw Error('Missing/changing actual ASC');
 const audio={description:Buffer.from(configs[0],'base64'),mediaTime:priming,presentationFrames:144000,
  samples:capture.chunks.map(c=>({data:Buffer.from(c.dataBase64,'base64'),duration:1024,key:true}))};
 const blob=require('../js/native-mp4.js')({}).mux({video:{description:Buffer.from(ref.video.description,'hex'),samples},audio,durationMs:3000});
 fs.writeFileSync(target,new Uint8Array(await blob.arrayBuffer()));
}
module.exports=mux;
if(require.main===module)mux(JSON.parse(fs.readFileSync(process.argv[2])),Number(process.argv[3]),process.argv[4]).catch(()=>{process.exitCode=1;});
