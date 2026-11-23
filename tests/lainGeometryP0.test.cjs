'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {bucket,windowMask,summarize,upperBounds,slack,excludable} = require('../scripts/lain-geometry/p0-summary.cjs');

test('duplicate cuts form empty bins; singleton exactly at cut belongs only to right bin', () => {
    const cuts = Float32Array.of(0,0,0,1,2,3,4);
    assert.equal(bucket(0,cuts,0),3);
    assert.equal(windowMask(0,0,cuts,0), 1 << 3);
    assert.equal(windowMask(-1,0,cuts,0), (1 << 0) | (1 << 3));
    assert.equal(windowMask(4,7,cuts,0), 1 << 7);
});

test('exhaustive small windows: bounds contain E and chimera is independent of summary', () => {
    const cuts = Float32Array.from([0,0,0,1,2,3,4, 0,0,0,1,2,3,4]);
    const rows = Float32Array.of(-1,3, 3,-1);
    const s = summarize(rows,2,cuts);
    let observedChimera = false;
    for(let l=-2;l<=4;l++) for(let h=l;h<=5;h++) {
        const lo = [l,l], hi=[h,h];
        const masks = lo.map((v,j)=>windowMask(v,hi[j],cuts,7*j));
        const {aabb,bins}=upperBounds(s,lo,hi,masks);
        const hit=x=>Number(x>=l && x<=h);
        const E=Number(hit(rows[0]) || hit(rows[2]))+Number(hit(rows[1]) || hit(rows[3]));
        const M=Math.max(hit(rows[0])+hit(rows[1]),hit(rows[2])+hit(rows[3]));
        for(const U of [aabb,bins]) {
            const delta=slack(U,E,M);
            assert.equal(delta.env+delta.chimera,U-M);
            assert.ok(U<=2);
        }
        if(E>M) observedChimera=true;
    }
    assert.ok(observedChimera);
});

test('each summary can be tighter; tie excludes only strictly worse minimum id', () => {
    const c=Float32Array.of(0,1,2,3,4,5,6);
    function scores(rows,x) {
        return upperBounds(summarize(Float32Array.from(rows),1,c),[x],[x],[windowMask(x,x,c,0)]);
    }
    assert.deepEqual(scores([0,4],2),{aabb:1,bins:0});
    assert.deepEqual(scores([0],0.5),{aabb:0,bins:1});
    const k={score:3,id:4294967300};
    assert.equal(excludable(3,k.id,k),false);
    assert.equal(excludable(3,k.id+1,k),true);
    assert.equal(excludable(4,k.id+1,k),false);
});