'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
function decode(b) {
    assert(Buffer.isBuffer(b) && b.length % 4 === 0);
    return Float32Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
}
function unit(v) {
    let sq = 0;
    for (const x of v) { assert(Number.isFinite(x)); sq += x*x; }
    assert(sq > 1e-12);
    const n = Math.sqrt(sq);
    return Float32Array.from(v, x => x / n);
}
function cosine(a, b) {
    assert.equal(a.length, b.length);
    let dot=0, aa=0, bb=0;
    for (let i=0;i<a.length;i++) {
        dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i];
    }
    return aa>0 && bb>0 ? dot/Math.sqrt(aa*bb) : 0;
}
async function main() {
    const [dbArg,binaryArg,outArg,mode]=process.argv.slice(2);
    assert(dbArg && binaryArg && outArg && ['C4','D24','D32'].includes(mode));
    const db=path.resolve(dbArg);
    assert(path.basename(db).startsWith('ags-benchmark-'));
    const binary=path.resolve(binaryArg);
    const native=require(binary);
    const kb=structuredClone(require('../rag_params.json').KnowledgeBaseManager);
    const axes=mode==='C4'?4:mode==='D24'?24:32;
    Object.assign(kb.geometry.local,{maxNeighbors:mode==='C4'?48:96,maxBasis:axes});
    let reader=new Database(db,{readonly:true,fileMustExist:true});
    const tagStmt=reader.prepare('SELECT id,name,vector FROM tags WHERE id=?');
    const definitions=[
        ['coordinates',[4814]],['asset-space',[30438]],['love-constant',[3029]],
        ['quantification-axiom',[4826]],['systemic-crisis',[10981]],
        ['huawei-parent',[2985]],
        ['huawei-auto',[40770,40783]],['lunarium',[41604,40117,40089]],
        ['iran',[29251,23943]]
    ];
    const queries=definitions.map(([key,ids])=>{
        const tags=ids.map(id=>{ const r=tagStmt.get(id); assert(r,`missing tag ${id}`);return r; });
        const vs=tags.map(t=>unit(decode(t.vector)));
        const q=unit(Array.from(vs[0],(_,i)=>vs.reduce((s,v)=>s+v[i],0)));
        return {key,ids,names:tags.map(t=>t.name),q,top:[]};
    });
    // Document-vector proxy queries exercise off-Tag residual directions.
    // Self retrieval is in-sample; never report recall/accuracy from these cases.
    const chunkDefinitions = [
        ['chunk-huawei', 10640, [40770,40783]],
        ['chunk-lunarium', 11385, [41604]],
        ['chunk-iran', 9889, [29251]],
        ['chunk-risk', 5493, [10981]],
        ['chunk-coordinates', 5777, [4814]],
        ['chunk-love', 11321, [3029]]
    ];
    for (const [key,chunkId,ids] of chunkDefinitions) {
        const row=reader.prepare('SELECT vector FROM chunks WHERE id=?').get(chunkId);
        assert(row?.vector, `missing proxy chunk ${chunkId}`);
        const labels=ids.map(id=>{ const t=tagStmt.get(id); assert(t); return t.name; });
        queries.push({key,ids,names:labels,q:unit(decode(row.vector)),top:[],proxyChunkId:chunkId});
    }
    const dim=queries[0].q.length;
    const tags=reader.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
    // Same query and SQL facts => fixed candidate pool across native builds.
    for (const row of reader.prepare('SELECT id,vector FROM chunks WHERE vector IS NOT NULL ORDER BY id').iterate()) {
        const v=decode(row.vector);
        if(v.length!==dim) continue;
        for(const query of queries) {
            const score=cosine(query.q,v);
            if(!Number.isFinite(score)) continue;
            query.top.push({id:row.id,score,vectorScore:score});
            if(query.top.length>100) {
                query.top.sort((a,b)=>b.score-a.score||a.id-b.id);
                query.top.length=50;
            }
        }
    }
    for(const query of queries) {
        query.top.sort((a,b)=>b.score-a.score||a.id-b.id);
        query.top.length=Math.min(50,query.top.length);
        assert(query.top.length>0);
    }
    reader.close();reader=null;
    const index=new native.VexusIndex(dim,tags+16);
    const runtime=new native.NativeKnowledgeRuntime(index);
    const report={
        mode,binarySha256:digest(fs.readFileSync(binary)),cases:[],
        parameters:{
            geometry:kb.geometry,
            pipeline:'Rust PipelineConfig defaults, no per-case tuning',
            readout:'Rust NativeConfig defaults; fixed candidate Top-50; includeTrace=true'
        },
        limits:[
            'Tag-vector/mixture and in-sample document-vector proxies, NOT original user query embeddings.',
            'Document proxy self retrieval leaks the source document; no recall/accuracy claims permitted.',
            'Fixed raw-cosine candidate pool, NOT production candidate recall or labeled relevance.',
            'Exact label supplied as queryText; optional core uses the same Tag labels.',
            'Native defaults are explicit experimental conditions, not a claim of full frontend configuration equivalence.'
        ]
    };
    const save=()=>fs.writeFileSync(path.resolve(outArg),JSON.stringify(report,null,2)+'\n');
    try {
        runtime.openAndInitStore(db);
        report.geometry=await index.computeMemoGeometry(db,'memo-D-pipeline-benchmark',
            JSON.stringify({...kb.geometry,forceRecompute:true}));
        report.recovery=await index.recoverFromSqlite(db,'tags');
        report.artifact=await index.rebuildMemoArtifact(db,
            JSON.stringify({modelSig:'memo-D-pipeline-benchmark',effectiveConfig:kb}));
        assert(report.artifact.success);
        save();
        for(const query of queries) {
            for(const explicitCore of [false,true]) {
                const queryId=`${query.key}-${explicitCore?'core':'free'}`;
                const queryText=query.names.join(' ');
                const pipeline=await index.runMemoPipeline(db,report.artifact.artifactSig,
                    JSON.stringify({queryId,queryText,coreTags:explicitCore?query.names:[],ghostTags:[],config:{}}),
                    query.q,new Float32Array());
                const metadata=JSON.parse(pipeline.metadataJson);
                assert(metadata.observationHandle);
                assert(metadata.diagnostics.observationCached);
                const raw=await index.rerankRivermemoTopologyV3(db,report.artifact.artifactSig,
                    JSON.stringify({
                        observationHandle:metadata.observationHandle,dimension:dim,
                        topK:query.top.length,includeTrace:true,query:{text:queryText,vector:[]},
                        candidates:query.top,queryState:{queryId},config:{}
                    }));
                const topology=typeof raw==='string'?JSON.parse(raw):raw;
                assert(Array.isArray(topology.results));
                assert(topology.results.every(r=>Number.isFinite(r.finalScore ?? r.score)));
                assert.equal(topology.diagnostics.offeredCandidates,query.top.length);
                report.cases.push({
                    key:query.key,explicitCore,ids:query.ids,names:query.names,
                    querySource:query.proxyChunkId ? 'in-sample-document-vector-proxy' : 'tag-vector-or-mixture',
                    proxyChunkId:query.proxyChunkId ?? null,
                    candidateHash:digest(JSON.stringify(query.top)),metadata,topology,
                    enhancedVectorHash:digest(Buffer.from(pipeline.enhancedVector.buffer,
                        pipeline.enhancedVector.byteOffset,pipeline.enhancedVector.byteLength))
                });
                save();
                console.log(JSON.stringify({
                    mode,key:query.key,explicitCore,matched:metadata.matchedTags,
                    core:metadata.coreTagsMatched,pipelineMs:metadata.diagnostics.totalMs,
                    top:topology.results.slice(0,5).map(r=>({id:r.chunkId,score:r.finalScore??r.score}))
                }));
            }
        }
        report.success=true;
    } finally {
        reader?.close();
        runtime.shutdown();
        save();
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});