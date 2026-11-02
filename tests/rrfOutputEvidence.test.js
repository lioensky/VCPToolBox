'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const evidence=require('../rust-vexus-lite/tests/fixtures/rrf_real_output_evidence.json');
test('anonymized ABBA output evidence preserves order and quality-score contract',()=>{
    assert.equal(evidence.cases.length,85);
    let oldPassed=0,newPassed=0,active=0,changed=0;
    for(const c of evidence.cases){
        const {A1,B1,B2,A2}=c.runs;
        const order=r=>r.results.map(x=>x.candidate);
        assert.equal(A1.poolHash,B1.poolHash);
        for(const r of [B1,B2,A2]) assert.deepEqual(order(r),order(A1));
        assert.deepEqual(A1.results,A2.results);
        assert.deepEqual(B1.results,B2.results);
        const by=new Map(B1.results.map(r=>[r.candidate,r]));
        if(A1.results.some(r=>r.active))active++;
        for(const a of A1.results){
            const b=by.get(a.candidate);
            assert(Number.isFinite(b.score)&&b.score>=0&&b.score<=1);
            assert(Math.abs(b.score-b.baseline)<=1e-12);
            assert.equal(a.active,b.active);
            if(a.active) assert.equal(a.fusedScore,b.fusedScore);
            oldPassed+=Number(a.score>=0.5);
            newPassed+=Number(b.score>=0.5);
            changed+=Number(Math.abs(a.score-b.score)>1e-12);
        }
    }
    assert.equal(active,10); // Includes same-source parameter variants, not independent events.
    assert.equal(changed,960);
    assert.equal(oldPassed,4839);
    assert.equal(newPassed,5743);
    assert.equal(newPassed-oldPassed,904);
});