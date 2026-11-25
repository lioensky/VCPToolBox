'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')), sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const base=fs.realpathSync(path.join(process.env.LOCALAPPDATA,'VCP-Experiments/RiverMemoV6'));
const run=fs.realpathSync(path.join(base,'native-baseline-111e6fce649b455795eba9097af84276'));
assert.equal(path.dirname(run),base);
const db=fs.realpathSync(path.join(run,'knowledge_base.sqlite'));assert.equal(path.dirname(db),run);
const spec=read(path.join(run,'construction-spec-0c8270238d1b49caa88918c509cecdd7.json'));
const sig='51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3';
const bin=path.join(__dirname,'../rust-vexus-lite/vexus-lite.win32-x64-msvc.node');
assert.equal(sha(fs.readFileSync(bin)),'66a7865ae43a1d64d9d12e35b7256ebc22faf883f08f5c3924f97a1ce38f76cb');
const native=require(bin),idx=new native.VexusIndex(3072,65536),rt=new native.NativeKnowledgeRuntime(idx);
const queries=[
 ['auto','华为汽车的幽默操作','c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f'],
 ['phone','华为手机的幽默操作','2a8a67325540bbe20422268f6b6e1a1638bb954546c5ab29f0c978565722d9a0'],
 ['general','华为的幽默操作','de6440ea4c38ac92b66165d48ffdfd6f751b812fe4475eb264b9cbe2632786b5']];
const parse=x=>typeof x==='string'?JSON.parse(x):x;
async function main(){
 const out=fs.mkdtempSync(path.join(base,'context-pools-'));console.log('output',out);
 try{
  rt.openAndInitStore(db);
  for(const [key,text,hash] of queries){
   const vec=Float32Array.from(read(path.join(base,'gen1051-gemini2-q3-v1',key+'.json')).embedding);
   assert.equal(sha(Buffer.from(vec.buffer)),hash);
   await idx.recoverFromSqlite(db,'tags');
   const handles=[],inputs={},metas={};
   try{
    for(const [track,route] of [['tdb','cosine'],['warped','warped_ags']]){
     const config={...spec.cfg,baseTagBoost:.6,tagRoutingMode:route};
     const p=await idx.runMemoPipeline(db,sig,JSON.stringify({queryText:text,coreTags:[],ghostTags:[],config}),vec,new Float32Array());
     const m=parse(p.metadataJson);assert.equal(m.artifactSig,sig);assert.ok(m.observationHandle);
     handles.push(m.observationHandle);metas[track]=m.diagnostics.tagRouting;
     inputs[track]={observationHandle:m.observationHandle,query:{text},queryState:{queryId:null},tagRouting:m.diagnostics.tagRouting,config:spec.configs[track]};
    }
    const plan={scope:{maid:'小克',folders:[],excludedFolders:['已整理','夜伽','MusicDiary'],includeMusic:false,searchAll:false,timeRange:null},
      modelSig:'4ac787df185f4522',engineMode:'rivermemo',artifactSig:sig,k:30,candidateK:30,abMode:true,warpedAb:true,
      useBm25:false,queryTokens:[],riverInput:inputs.tdb,warpedRiverInput:inputs.warped};
    const r=parse(await rt.executeLightMemoQuery(JSON.stringify(plan),vec));
    assert.equal(r.schema,'vcp-lightmemo-result-v1');
    const pools=r.recallPools;assert.ok(pools?.tdb && pools?.warped,'missing native pools');
    for(const track of ['tdb','warped']){
     assert.equal(new Set(pools[track]).size,30);assert.equal(pools[track].length,30);
     if(key==='auto')assert.deepEqual(pools[track],spec.pools[track],track+' original recall identity');
    }
    const report={text,hash,sig,pools,tagRouting:metas,scope:r.diagnostics.scope,warpedChunks:r.diagnostics.warpedChunks,tracks:{}};
    for(const track of ['tdb','warped']){
     const result=parse(await idx.rerankRivermemoTopologyV3(db,sig,JSON.stringify({...inputs[track],query:{text,vector:[]},dimension:3072,topK:30,includeTrace:true,candidates:pools[track].map(id=>({id}))})));
     assert.equal(result.results.length,30);
     if(key==='auto')for(const [i,row] of result.results.entries()){
      assert.equal(row.chunkId??row.id,spec.reference[track][i].id);
      assert.ok(Math.abs(row.score-spec.reference[track][i].score)<=.00005001);
     }
     const graph=(track==='tdb'?r.river:r.warpedRiver)?.queryRiverGraph;
     assert.ok(graph && !graph.truncated && graph.nodes.length===graph.totalNodes && graph.edges.length===graph.totalEdges,'incomplete AB graph');
     report.tracks[track]={...result,queryRiverGraph:graph};
    }
    fs.writeFileSync(path.join(out,key+'.json'),JSON.stringify(report),{flag:'wx'});
    console.log(key,'passed',pools.tdb.length,pools.warped.length);
   }finally{for(const h of handles)idx.releaseMemoObservation(h);}
  }
 }finally{rt.shutdown();}
}
main().catch(e=>{console.error(e);process.exitCode=1});