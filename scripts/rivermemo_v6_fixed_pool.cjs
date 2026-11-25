'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [dir,attachment]=process.argv.slice(2);
const base=fs.realpathSync(path.join(process.env.LOCALAPPDATA,'VCP-Experiments/RiverMemoV6'));
const run=fs.realpathSync(dir);
assert.equal(path.dirname(run),base);assert.match(path.basename(run),/^native-baseline-[0-9a-f]{32}$/);
const db=fs.realpathSync(path.join(run,'knowledge_base.sqlite'));assert.equal(path.dirname(db),run);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const input=fs.readFileSync(attachment,'utf8').split(/\r?\n/);
const pools=JSON.parse(input.find(s=>s.startsWith('候选 ID 与交集：')).split('：').slice(1).join('：'));
const configs=input.filter(s=>s.startsWith('parsedConfig\t')).map(s=>JSON.parse(s.split('\t')[1]));
assert.equal(configs.length,2);
const headers=input.flatMap((s,i)=>s.startsWith('Chunk\t角色\t语义基础分')?[i]:[]);
assert.equal(headers.length,2);
const q=Float32Array.from(JSON.parse(fs.readFileSync(path.join(base,'gen1051-gemini2-q3-v1/auto.json'),'utf8')).embedding);
assert.equal(sha(Buffer.from(q.buffer)),'c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f');
const sig='51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3',text='华为汽车的幽默操作';
const bin=path.resolve(__dirname,'../rust-vexus-lite/vexus-lite.win32-x64-msvc.node');
assert.equal(sha(fs.readFileSync(bin)),'66a7865ae43a1d64d9d12e35b7256ebc22faf883f08f5c3924f97a1ce38f76cb');
const native=require(bin),idx=new native.VexusIndex(3072,65536),rt=new native.NativeKnowledgeRuntime(idx);
const prior=JSON.parse(fs.readFileSync(path.join(run,'baseline-observation.json'),'utf8'));
const report={sig,baseTagBoost:.6,tracks:{}};
async function main(){
try {
 rt.openAndInitStore(db);await idx.recoverFromSqlite(db,'tags');
 for(const [ti,name] of ['tdb','warped'].entries()){
  const pool=pools[name], ref=[];
  assert.equal(sha(JSON.stringify(pool)),['663bb674e223073806eca5ac5128061819956829765f459021115bb4e88407bc','31c19f1787fc38d408d2087f9a871c48dfd1cce89119acade0ca411e558fbe3e'][ti]);
  for(let i=headers[ti]+1;i<input.length;i++){const a=input[i].split('\t');if(!/^\d+$/.test(a[0])||a.length<13)break;ref.push({id:+a[0],score:+a[10]});}
  assert.equal(ref.length,30);assert.deepEqual([...ref.map(r=>r.id)].sort((a,b)=>a-b),[...pool].sort((a,b)=>a-b));
  const track=report.tracks[name]={};
  for(const [arm,decay] of [['baseline',.7],['ordinaryDecay',.25]]){
   const config=structuredClone(prior.cfg);config.baseTagBoost=.6;config.tagRoutingMode=ti?'warped_ags':'cosine';config.spikeRouting.wormholeDecay=decay;
   const p=await idx.runMemoPipeline(db,sig,JSON.stringify({queryId:null,queryText:text,coreTags:[],ghostTags:[],config}),q,new Float32Array());
   const m=JSON.parse(p.metadataJson);assert.equal(m.artifactSig,sig);assert.ok(m.observationHandle);
   const raw=await idx.rerankRivermemoTopologyV3(db,sig,JSON.stringify({observationHandle:m.observationHandle,dimension:3072,topK:30,includeTrace:true,query:{text,vector:[]},candidates:pool.map(id=>({id})),queryState:{queryId:null},config:configs[ti]}));
   const out=typeof raw==='string'?JSON.parse(raw):raw;
   const rows=out.results.map(r=>({id:r.chunkId??r.id,score:r.finalScore??r.score}));
   assert.equal(rows.length,30);assert.ok(rows.every(r=>Number.isFinite(r.score)));
   track[arm]={effectiveTagBoost:m.effectiveTagBoost,sensing:m.diagnostics.sensing,rows,diagnostics:out.diagnostics};
   if(arm==='baseline'){
    const errors=ref.map((r,i)=>({i:i+1,expected:r,actual:rows[i]})).filter(v=>v.expected.id!==v.actual.id||Math.abs(v.expected.score-v.actual.score)>.00005001);
    track.baselineErrors=errors;console.log(name,'baseline discrepancies:',errors.length,JSON.stringify(errors.slice(0,3)),'effective boost:',m.effectiveTagBoost);
    if(errors.length)break;
   }else{
    for(const k of [3,10]){
     const a=track.baseline.rows.slice(0,k).map(r=>r.id),b=rows.slice(0,k).map(r=>r.id);
     console.log(name,'k',k,'before',a,'after',b,'in',b.filter(id=>!a.includes(id)),'out',a.filter(id=>!b.includes(id)));
    }
   }
  }
 }
}finally{try{rt.shutdown()}finally{const f=path.join(run,`fixed-pool-${crypto.randomUUID()}.json`);fs.writeFileSync(f,JSON.stringify(report,null,2),{flag:'wx'});console.log('report:',f)}}
assert.ok(Object.values(report.tracks).every(t=>t.ordinaryDecay),'baseline not reproduced; do not infer ranking effect');
}
main().catch(e=>{console.error(e);process.exitCode=1});