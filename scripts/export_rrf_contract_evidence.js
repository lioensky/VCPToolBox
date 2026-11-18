'use strict';
// Output evidence, NOT native replay inputs.
const fs=require('node:fs'),path=require('node:path');
const [root,output]=process.argv.slice(2);
if(!root||!output)throw Error('usage: node scripts/export_rrf_contract_evidence.js private-dir output.json');
const rounds=Object.fromEntries(['A1','B1','B2','A2'].map(n=>[n,JSON.parse(fs.readFileSync(path.join(root,n+'.json'),'utf8'))]));
const result={
 schema:'rrf-anonymized-output-evidence-v1',
 provenance:'Private-corpus ABBA outputs from combined MGS/RRF/diagnostics build, NOT RRF-only native replay.',
 limitations:['No corpus, query embeddings or native observations.','Candidate IDs remapped within each case.',
 'Not relevance labels; retention is not recall quality.','No TimeDecay or plugin-chain replay.'],
 bindingHashes:Object.fromEntries(Object.entries(rounds).map(([n,v])=>[n,v.bindingHash])),cases:[]
};
for(let i=0;i<rounds.A1.rows.length;i++){
 const old=rounds.A1.rows[i],map=new Map(old.results.map((r,j)=>[r.id,j+1])),runs={};
 for(const [n,data] of Object.entries(rounds)){
 const row=data.rows[i];if(row.error||row.id!==old.id)throw Error('Failed or mismatched case');
 runs[n]={poolHash:row.poolHash,vectorHash:row.vectorHash,results:row.results.map(r=>({
 candidate:map.get(r.id),score:r.score,baseline:r.baseline,active:r.rrf?.active===true,
 fusedScore:r.rrf?.fusedScore??null}))};
 if(runs[n].results.some(r=>!r.candidate))throw Error('Candidate set changed');
 }
 result.cases.push({case:i+1,bucket:old.bucket,runs});
}
fs.writeFileSync(output,JSON.stringify(result)+'\n');