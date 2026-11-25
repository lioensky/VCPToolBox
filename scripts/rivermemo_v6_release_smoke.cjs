'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=fs.realpathSync(path.join(process.env.LOCALAPPDATA,'VCP-Experiments/RiverMemoV6'));
const run=fs.realpathSync(path.join(base,'native-baseline-111e6fce649b455795eba9097af84276'));
const db=fs.realpathSync(path.join(run,'knowledge_base.sqlite'));
assert.equal(path.dirname(db),run);assert.equal(path.dirname(run),base);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const parse=x=>typeof x==='string'?JSON.parse(x):x;
const native=require(path.resolve(process.argv[2])), idx=new native.VexusIndex(3072,65536),rt=new native.NativeKnowledgeRuntime(idx);
const spec=read(path.join(run,'construction-spec-0c8270238d1b49caa88918c509cecdd7.json'));
const sig='51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3';
async function main(){
 try{
  rt.openAndInitStore(db);
  for(const key of ['auto','phone','general']){
   const ref=read(path.join(base,'context-pools-oRifL4',key+'.json')),text=ref.text;
   const vec=Float32Array.from(read(path.join(base,'gen1051-gemini2-q3-v1',key+'.json')).embedding);
   await idx.recoverFromSqlite(db,'tags');
   const inputs={},handles=[];
   try {
    for(const [track,route] of [['tdb','cosine'],['warped','warped_ags']]){
     const config={...spec.cfg,baseTagBoost:.6,tagRoutingMode:route};
     const p=await idx.runMemoPipeline(db,sig,JSON.stringify({queryText:text,coreTags:[],ghostTags:[],config}),vec,new Float32Array());
     const m=parse(p.metadataJson);assert.equal(m.artifactSig,sig);handles.push(m.observationHandle);
     inputs[track]={observationHandle:m.observationHandle,query:{text},queryState:{queryId:null},tagRouting:m.diagnostics.tagRouting,config:spec.configs[track]};
    }
    const plan={scope:{maid:'小克',folders:[],excludedFolders:['已整理','夜伽','MusicDiary'],includeMusic:false,searchAll:false,timeRange:null},modelSig:'4ac787df185f4522',engineMode:'rivermemo',artifactSig:sig,k:30,candidateK:30,abMode:true,warpedAb:true,useBm25:false,queryTokens:[],riverInput:inputs.tdb,warpedRiverInput:inputs.warped};
    const ab=parse(await rt.executeLightMemoQuery(JSON.stringify(plan),vec));assert.equal(ab.schema,'vcp-lightmemo-result-v1');
    for(const track of ['tdb','warped']){
     assert.deepEqual(ab.recallPools[track],ref.pools[track]);
     const r=parse(await idx.rerankRivermemoTopologyV3(db,sig,JSON.stringify({...inputs[track],query:{text,vector:[]},dimension:3072,topK:30,includeTrace:true,candidates:ab.recallPools[track].map(id=>({id}))})));
     assert.equal(r.algorithmVersion,'rivermemo.topological-transport-omega-v6.1');assert.equal(r.results.length,30);
     for(const [i,x] of r.results.entries()){
      assert.ok(Number.isFinite(x.score));assert.ok(!i||r.results[i-1].score>=x.score);
      assert.ok(Math.abs(x.score-Math.max(0,Math.min(1,x.baseScore+x.topologyBonus)))<1e-8);
      assert.ok(Number.isFinite(x.topologyV3.transportedQueryScore));
     }
     console.log(key,track,JSON.stringify({route:r.parameters.selectedChartSourceTargetOmegaAngle,gate:r.parameters.wormholeGate,top3:r.results.slice(0,3).map(x=>x.id),pedal:r.results.find(x=>x.id===11124)?.rank??null}));
    }
   }finally{for(const h of handles)idx.releaseMemoObservation(h);}
  }
 }finally{rt.shutdown();}
}
main().catch(e=>{console.error(e);process.exitCode=1});