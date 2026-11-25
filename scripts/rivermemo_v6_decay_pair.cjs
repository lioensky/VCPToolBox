'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const run = fs.realpathSync(process.argv[2]);
const base = fs.realpathSync(path.join(process.env.LOCALAPPDATA, 'VCP-Experiments/RiverMemoV6'));
assert.equal(path.dirname(run), base);
assert.match(path.basename(run), /^native-baseline-[0-9a-f]{32}$/);
const db = fs.realpathSync(path.join(run, 'knowledge_base.sqlite'));
assert.equal(path.dirname(db), run);
const bin = path.resolve(__dirname, '../rust-vexus-lite/vexus-lite.win32-x64-msvc.node');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(hash(fs.readFileSync(bin)), '66a7865ae43a1d64d9d12e35b7256ebc22faf883f08f5c3924f97a1ce38f76cb');
const q = Float32Array.from(JSON.parse(fs.readFileSync(path.join(base, 'gen1051-gemini2-q3-v1/auto.json'), 'utf8')).embedding);
assert.equal(hash(Buffer.from(q.buffer)), 'c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f');
const {cfg, metadata} = JSON.parse(fs.readFileSync(path.join(run,'baseline-observation.json'),'utf8'));
const sig = '51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3';
assert.equal(metadata.artifactSig, sig);
assert.equal(cfg.spikeRouting.baseDecay, 0.25);
assert.equal(cfg.spikeRouting.wormholeDecay, 0.70);
const native = require(bin);
const index = new native.VexusIndex(3072,65536), runtime = new native.NativeKnowledgeRuntime(index);
async function main() {
  const results = [], vectors = [];
  try {
    runtime.openAndInitStore(db);
    await index.recoverFromSqlite(db,'tags');
    for (const decay of [0.70,0.25,0.70]) {
      const config = structuredClone(cfg);
      config.spikeRouting.wormholeDecay = decay;
      const res = await index.runMemoPipeline(db,sig,JSON.stringify({
        queryId:null,queryText:'华为汽车的幽默操作',coreTags:[],ghostTags:[],config
      }),q,new Float32Array());
      const m = JSON.parse(res.metadataJson), s = m.diagnostics.sensing;
      assert.equal(m.artifactSig,sig); assert.ok(m.observationHandle);
      const v = res.enhancedVector;
      assert.ok(v instanceof Float32Array && v.length===3072 && v.every(Number.isFinite));
      vectors.push(Float32Array.from(v));
      results.push({decay,seedCount:s.acceptedSeedNodes,nodes:s.reachedNodes,edges:s.activeEdges,
        maxEdgeFlow:s.maximumEdgeFlow,maxNodeEnergy:s.maximumNodeEnergy,hopMass:s.hopInFlightMass,
        wormholeEvents:s.wormholeEdgesFired,dynamicSelected:s.dynamicWormholeSelected,
        matchedTags:m.matchedTags,enhancedHash:hash(Buffer.from(v.buffer,v.byteOffset,v.byteLength))});
    }
    const [a,,a2]=results;
    console.log(JSON.stringify(results,null,2));
    assert.deepEqual(a,a2,'A/B/A control did not reproduce');
    assert.equal(a.maxEdgeFlow, metadata.diagnostics.sensing.maximumEdgeFlow);
    assert.equal(a.seedCount,7);assert.equal(a.nodes,20);assert.equal(a.edges,13);
    const enhancedL2=Math.sqrt(vectors[0].reduce((s,x,i)=>s+(x-vectors[1][i])**2,0));
    const report={results,enhancedL2,expectedSingleEdgeFlow:a.maxEdgeFlow*.25/.70,
      limits:'maximumEdgeFlow is a graph maximum, not an identified edge; equal counts do not establish equal node or edge sets; no ranking measured'};
    console.log('enhancedL2',enhancedL2,'singleEdgePrediction',report.expectedSingleEdgeFlow);
    fs.writeFileSync(path.join(run,`decay-pair-${crypto.randomUUID()}.json`),JSON.stringify(report,null,2),{flag:'wx'});
  } finally { runtime.shutdown(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});