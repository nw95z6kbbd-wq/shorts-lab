'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const C=require('../js/core.js'),V=require('../js/video-core.js'),Z=require('../js/zip-store.js');
const ctx={window:{},ShortsCore:C,ShortsVideoCore:V};vm.runInNewContext(fs.readFileSync('js/project-db.js','utf8'),ctx);
const F=require('../js/backup-format.js')(Z,ctx.window.ShortsProjectDB), sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function wav(hz){const rate=16000,count=rate,buffer=Buffer.alloc(44+count*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)buffer.writeInt16LE(Math.round(2500*Math.sin(i*2*Math.PI*hz/rate)),44+i*2);return buffer;}
function fixture(){
 const projects={editor:C.createProject(true),video:{...V.demo(),voiceAssetId:'voice',voiceName:'voice.wav',musicAssetId:'music',musicName:'music.wav'}};
 const assets=new Map();
 for(const [i,name] of ['red.png','blue.jpg','green.webp'].entries()){
  const id='image-'+i,type=['image/png','image/jpeg','image/webp'][i],blob=new Blob([fs.readFileSync('tests/fixtures/backup-media/'+name)],{type});
  Object.assign(projects.video.scenes[i],{imageId:id,imageName:name,visual:'image'});assets.set(id,{id,name,kind:'image',blob});
 }
 for(const role of ['voice','music'])assets.set(role,{id:role,name:role+'.wav',kind:role,blob:new Blob([wav(role==='voice'?440:880)],{type:'audio/wav'})});
 return{projects,assets};
}
async function archive(){const f=fixture();return{...f,zip:await F.exportArchive(f.projects,f.assets,'test')};}
async function entries(zip){return [...(await Z.read(zip)).entries].map(([path,e])=>({path,blob:e.blob}));}
async function rewrite(zip,change){const files=await entries(zip);await change(files);return Z.create(files);}
function directory(bytes){const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return {d,start:d.getUint32(bytes.length-6,true)};}
test('SHA-256 native and offline fallback match independent vectors and CRC32 is standard',async()=>{
 for(const text of ['', 'abc', 'Привет 🌌', ...[55,56,63,64,65,1048593].map(n=>'a'.repeat(n))]){
  const bytes=Buffer.from(text);assert.equal(await F.sha256(bytes),sha(bytes));assert.equal(await F.sha256(bytes,true),sha(bytes));
 }
 const binary=Uint8Array.from({length:65537},(_,i)=>(i*17)%256);assert.equal(await F.sha256(binary,true),sha(binary));
 assert.equal(await Z.crc32(Buffer.from('123456789')),0xcbf43926);
});
test('real ZIP/STORE round trip preserves both projects, original image/audio bytes and deduplicates payloads',async()=>{
 const {projects,assets,zip}=await archive(), restored=await F.importArchive(zip);
 assert.deepEqual(restored.projects,F.states(projects));
 for(const [id,a] of assets)assert.equal(sha(Buffer.from(await restored.assets.get(id).blob.arrayBuffer())),sha(Buffer.from(await a.blob.arrayBuffer())));
 const remapped=await F.remap(restored),again=await F.remap(restored);assert.deepEqual(remapped.projects,again.projects);
 assert.ok(remapped.projects.video.voiceAssetId.startsWith('backup-'));
 const result=JSON.parse(execFileSync('python3',['-c','import zipfile,io,sys,json;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None;print(json.dumps({"files":z.namelist(),"methods":[i.compress_type for i in z.infolist()]}))'],{input:Buffer.from(await zip.arrayBuffer())}));
 assert.equal(result.files.length,7);assert.ok(result.methods.every(n=>n===0));
 assets.set('music',{...assets.get('music'),blob:assets.get('voice').blob});
 const dedup=await F.exportArchive(projects,assets,'test');assert.equal((await Z.read(dedup)).entries.size,6);
});
test('export whitelists project fields and rejects missing originals instead of creating partial backups',async()=>{
 const {projects,assets}=fixture();projects.editor.apiKey='SECRET';projects.video.token='SECRET';
 const zip=await F.exportArchive(projects,assets,'test'),r=await F.importArchive(zip);assert.equal(r.projects.editor.apiKey,undefined);assert.equal(r.projects.video.token,undefined);
 const raw=await (await Z.read(zip)).bytes('project.json');assert.ok(!Buffer.from(raw).toString().includes('SECRET'),'the ZIP itself must exclude unknown secret fields, not merely discard them on import');
 assets.delete('image-1');await assert.rejects(F.exportArchive(projects,assets,'test'),/Нет исходного/);
});
test('corruption, missing files, future versions and unsupported known settings are rejected',async()=>{
 const {zip}=await archive();
 const broken=new Uint8Array(await zip.arrayBuffer());broken[50]^=1;await assert.rejects(F.importArchive(new Blob([broken])));
 await assert.rejects(F.importArchive(zip.slice(0,zip.size-2)));
 const absent=await rewrite(zip,files=>{files.splice(2,1);});await assert.rejects(F.importArchive(absent),/отсутствующие/);
 const future=await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.version=3;files[0].blob=new Blob([JSON.stringify(m)]);});await assert.rejects(F.importArchive(future),/будущая версия/);
 const badHash=await rewrite(zip,async files=>{const m=JSON.parse(await files[0].blob.text());m.project.sha256='0'.repeat(64);files[0].blob=new Blob([JSON.stringify(m)]);});await assert.rejects(F.importArchive(badHash),/целостность/);
 const badMedia=await rewrite(zip,files=>{files[2].blob=new Blob(['changed media, valid new ZIP CRC']);});await assert.rejects(F.importArchive(badMedia),/контрольная сумма/);
 const modified=await rewrite(zip,async files=>{const p=JSON.parse(await files[1].blob.text());p.video.scenes[0].camera='future-camera';files[1].blob=new Blob([JSON.stringify(p)]);const m=JSON.parse(await files[0].blob.text());m.project.size=files[1].blob.size;m.project.sha256=sha(Buffer.from(await files[1].blob.arrayBuffer()));files[0].blob=new Blob([JSON.stringify(m)]);});await assert.rejects(F.importArchive(modified),/Неподдерживаемое значение/);
});
test('unknown fields are ignored with warning, never evaluated or merged into prototypes',async()=>{
 const {zip}=await archive();
 const modified=await rewrite(zip,async files=>{const p=JSON.parse(await files[1].blob.text());for(let i=0;i<30;i++)p['future'+i]='ignored';p.video.futureSetting={__proto__:null,token:'not copied'};Object.defineProperty(p.editor,'__proto__',{value:{polluted:true},enumerable:true});files[1].blob=new Blob([JSON.stringify(p)]);const m=JSON.parse(await files[0].blob.text());m.project.size=files[1].blob.size;m.project.sha256=sha(Buffer.from(await files[1].blob.arrayBuffer()));files[0].blob=new Blob([JSON.stringify(m)]);});
 const restored=await F.importArchive(modified);assert.equal(restored.warnings.length,20);assert.equal(restored.projects.video.futureSetting,undefined);assert.equal({}.polluted,undefined);
});
test('dangerous/duplicate paths, symlinks, encryption and overlapping local headers are rejected before import',async()=>{
 const {zip}=await archive(),original=new Uint8Array(await zip.arrayBuffer());
 for(const attack of ['path','duplicate','symlink','encrypted','overlap']){
  const bytes=original.slice(),{d,start}=directory(bytes);let pos=start;const assetRecords=[];
  for(let i=0;i<7;i++){const n=d.getUint16(pos+28,true);if(i>=2)assetRecords.push(pos);pos+=46+n;}
  const posA=assetRecords[0],posB=assetRecords[1],len=d.getUint16(posA+28,true),localA=d.getUint32(posA+42,true);
  if(attack==='path'){const name=Buffer.from('../'+'x'.repeat(len-3));bytes.set(name,posA+46);bytes.set(name,localA+30);}
  if(attack==='duplicate'){bytes.set(bytes.slice(posA+46,posA+46+len),posB+46);bytes.set(bytes.slice(posA+46,posA+46+len),d.getUint32(posB+42,true)+30);}
  if(attack==='symlink')d.setUint32(posA+38,0xa1ff0000,true);
  if(attack==='encrypted')d.setUint16(posA+8,0x801,true);
  if(attack==='overlap')d.setUint32(posA+42,0,true);
  await assert.rejects(F.importArchive(new Blob([bytes])),undefined,attack);
 }
});
test('ZIP bombs and size/count limits are rejected without decompression or payload allocation',async()=>{
 let read=false;await assert.rejects(Z.read({size:Z.LIMITS.archive+1,slice(){read=true;throw Error('payload');}}),/объём/);assert.equal(read,false);
 const bomb=execFileSync('python3',['-c','import io,zipfile,sys;b=io.BytesIO();z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED);f=z.open("assets/"+"a"*64+".bin","w");[f.write(bytes(1048576)) for _ in range(80)];f.close();z.close();sys.stdout.buffer.write(b.getvalue())']);
 assert.ok(bomb.length<131072);await assert.rejects(Z.read(new Blob([bomb])),/сжатие/);
 const {zip}=await archive(),bytes=new Uint8Array(await zip.arrayBuffer()),{d,start}=directory(bytes);d.setUint32(start+24,0xffffffff,true);await assert.rejects(Z.read(new Blob([bytes])),/объём/);
 const many=new Uint8Array(await zip.arrayBuffer());new DataView(many.buffer).setUint16(many.length-12,65535,true);await assert.rejects(Z.read(new Blob([many])),/число файлов/);
});
