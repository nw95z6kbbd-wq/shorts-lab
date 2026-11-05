'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const I=require('../js/export-inspector.js');
const read=name=>Buffer.from(fs.readFileSync('tests/fixtures/editor-export/'+name));
const expected={durationMs:1000,hasAudio:true};
function vint(b,p,id=false){let n=1,mask=128;while(!(b[p]&mask)){mask>>=1;n++;}let value=id?b[p]:b[p]&~mask;for(let i=1;i<n;i++)value=value*256+b[p+i];return {n,value};}
function videoBlocks(b){const found=[];function walk(start,end){for(let p=start;p<end;){const id=vint(b,p,true),size=vint(b,p+id.n),data=p+id.n+size.n,stop=data+size.value;if([0x18538067,0x1f43b675].includes(id.value))walk(data,stop);else if(id.value===0xa3&&b[data]===0x81)found.push(data);p=stop;}}walk(0,b.length);return found;}
function boxes(b,start=0,end=b.length){const out=[];for(let p=start;p<end;){const n=b.readUInt32BE(p);assert.ok(n>=8);out.push({type:b.toString('ascii',p+4,p+8),start:p,data:p+8,end:p+n});p+=n;}return out;}
function child(b,parent,type){return boxes(b,parent.data,parent.end).find(x=>x.type===type);}
function videoTrack(b){const moov=boxes(b).find(x=>x.type==='moov');return boxes(b,moov.data,moov.end).filter(x=>x.type==='trak').find(t=>{const h=child(b,child(b,t,'mdia'),'hdlr');return b.toString('ascii',h.data+8,h.data+12)==='vide';});}
function withCompositionOffsets(b,offsets){
 const trak=videoTrack(b),stbl=child(b,child(b,child(b,trak,'mdia'),'minf'),'stbl');
 const ctts=Buffer.alloc(16+8*offsets.length);ctts.writeUInt32BE(ctts.length);ctts.write('ctts',4);ctts[8]=1;ctts.writeUInt32BE(offsets.length,12);
 offsets.forEach((offset,i)=>{ctts.writeUInt32BE(1,16+i*8);ctts.writeInt32BE(offset,20+i*8);});
 function rewrite(start,end){return Buffer.concat(boxes(b,start,end).map(x=>{
  let data=Buffer.from(b.subarray(x.data,x.end));
  if(['moov','trak','mdia','minf','stbl'].includes(x.type))data=rewrite(x.data,x.end);
  if(x.start===stbl.start){assert.ok(!child(b,x,'ctts'));data=Buffer.concat([data,ctts]);}
  if(x.type==='stco')for(let i=0;i<data.readUInt32BE(4);i++)data.writeUInt32BE(data.readUInt32BE(8+i*4)+ctts.length,8+i*4);
  const head=Buffer.alloc(8);head.writeUInt32BE(data.length+8);head.write(x.type,4);return Buffer.concat([head,data]);
 }));}return rewrite(0,b.length);
}
test('D1: a full-span 24-packet WebM cannot hide collapsed middle timestamps and a 666ms hole',()=>{
 const b=read('vp9-opus.webm'),blocks=videoBlocks(b);assert.equal(blocks.length,24);
 for(const p of blocks){const ms=b.readInt16BE(p+1);if(ms>=200&&ms<=800)b.writeInt16BE(167,p+1);}
 assert.throws(()=>I.assertExpected(I.inspectBytes(b),expected),{code:'INCOMPLETE'});
});
test('WebM accepts bounded VFR jitter, but detects a hole without duplicate timestamps',()=>{
 const valid=read('vp9-opus.webm'),blocks=videoBlocks(valid);for(let i=1;i<blocks.length-1;i++)valid.writeInt16BE(valid.readInt16BE(blocks[i]+1)+(i%2?8:-8),blocks[i]+1);
 I.assertExpected(I.inspectBytes(valid),expected);
 const bad=read('vp9-opus.webm'),positions=videoBlocks(bad);for(let i=5;i<20;i++)bad.writeInt16BE(168+i,positions[i]+1);
 assert.throws(()=>I.assertExpected(I.inspectBytes(bad),expected),{code:'INCOMPLETE'});
});
test('fragmented MP4 checks internal composition intervals, retaining valid reordered presentation',()=>{
 function compose(offsets){
  const b=read('fragmented.mp4'),moof=boxes(b).find(x=>x.type==='moof'),traf=boxes(b,moof.data,moof.end).find(t=>t.type==='traf'&&b.readUInt32BE(child(b,t,'tfhd').data+4)===1),target=child(b,traf,'trun'),extra=offsets.length*4;
  function rewrite(start,end){return Buffer.concat(boxes(b,start,end).map(x=>{
   let data=Buffer.from(b.subarray(x.data,x.end));
   if(['moof','traf'].includes(x.type))data=rewrite(x.data,x.end);
   if(x.type==='trun'){
    const flags=b.readUInt32BE(x.data)&0xffffff;assert.ok(flags&1);data.writeInt32BE(data.readInt32BE(8)+extra,8);
    if(x.start===target.start){const head=8+4+(flags&4?4:0),stride=[256,512,1024,2048].filter(f=>flags&f).length*4;assert.equal(flags&2048,0);const parts=[data.subarray(0,head)];offsets.forEach((offset,i)=>{const c=Buffer.alloc(4);c.writeInt32BE(offset);parts.push(data.subarray(head+i*stride,head+(i+1)*stride),c);});data=Buffer.concat(parts);data.writeUInt32BE(0x1000000|flags|2048,0);}
   }
   const h=Buffer.alloc(8);h.writeUInt32BE(data.length+8);h.write(x.type,4);return Buffer.concat([h,data]);
  }));}return rewrite(0,b.length);
 }
 const bad=Array.from({length:24},(_,i)=>i>=5&&i<20?2048-i*512:0);
 assert.throws(()=>I.assertExpected(I.inspectBytes(compose(bad)),expected),{code:'INCOMPLETE'});
 const reordered=Array(24).fill(0);reordered[5]=512;reordered[6]=-512;I.assertExpected(I.inspectBytes(compose(reordered)),expected);
});
test('classic MP4 composition timestamps cannot hide collapsed frames; decode order may differ from presentation order',()=>{
 const b=read('classic.mp4'),bad=Array.from({length:24},(_,i)=>i>=5&&i<20?2048-i*512:0);
 assert.throws(()=>I.assertExpected(I.inspectBytes(withCompositionOffsets(b,bad)),expected),{code:'INCOMPLETE'});
 const reordered=Array(24).fill(0);reordered[5]=512;reordered[6]=-512;
 I.assertExpected(I.inspectBytes(withCompositionOffsets(b,reordered)),expected);
});
test('classic MP4 retains explicit long VFR holds as explained presentation time',async()=>{
 const ref=require('./fixtures/editor-export/native-mux-reference.json'),original=read(ref.source),samples=ref.video.samples.map((s,i)=>({data:original.subarray(s.offset,s.offset+s.size),key:s.key,duration:i===0?600000:i===23?400000-22*17000:17000}));
 const blob=require('../js/native-mp4.js')({}).mux({video:{description:Buffer.from(ref.video.description,'hex'),samples},durationMs:1000});
 I.assertExpected(I.inspectBytes(new Uint8Array(await blob.arrayBuffer())),{durationMs:1000,hasAudio:false});
});
