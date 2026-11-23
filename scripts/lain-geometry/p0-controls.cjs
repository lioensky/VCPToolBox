'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {trueTiles,shuffledTiles}=require('./tiles.cjs');
const {exactScan}=require('./scalar-reference.cjs');
const [root,out,mode]=process.argv.slice(2);
const p=path.join(root,'plate-a'), read=(file,T)=>{const b=fs.readFileSync(file);return new T(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
const ids=read(path.join(p,'ids.u64le'),BigUint64Array);
function write(file,v){fs.writeFileSync(path.join(out,file),Buffer.from(v.buffer,v.byteOffset,v.byteLength),{flag:'wx'});}
if(mode==='orders'){
 const tm=JSON.parse(fs.readFileSync(path.join(root,'tiles-a.json')));
 const base=trueTiles(ids,read(path.join(p,'angle.f32le'),Float32Array),read(path.join(p,'radius.f32le'),Float32Array));
 for(const [i,seed] of [null,1,2,3,4,5].entries()){
  const t=seed===null?base:shuffledTiles(base,seed), order=t.flat();
  const stable=BigUint64Array.from(order,s=>ids[s]);
  if(crypto.createHash('sha256').update(Buffer.from(stable.buffer)).digest('hex')!==tm.plates[i].orderedIdsSha256)throw Error('membership mismatch');
  write(`order-${i}.u32`,Uint32Array.from(order));
 }
}else if(mode==='oracle'){
 const matrix=read(path.join(p,'vectors.f32le'),Float32Array);
 const ends=read(path.join(out,'ends.f64'),Float64Array),D=3072;
 if(!ends.length||ends.length%(2*D))throw Error('bad endpoint frame');
 const fd=fs.openSync(path.join(out,'scores.u32'),'wx');
 try{
  for(let i=0;i<ends.length;i+=2*D){
   const {scores,topK}=exactScan(ids,matrix,ends.subarray(i,i+D),ends.subarray(i+D,i+2*D),10);
   fs.writeFileSync(fd,Buffer.from(scores.buffer));
   fs.appendFileSync(path.join(out,'topk.jsonl'),JSON.stringify(topK)+'\n');
  }
 }finally{fs.closeSync(fd);}
}else throw Error('unknown mode');