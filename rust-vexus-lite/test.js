const assert = require('node:assert/strict');
const { VexusIndex, VexusWatcher } = require('./index.js');

function assertNear(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${label}: expected ${expected}, got ${actual}`
  );
}

console.log('Testing Vexus-Lite current API...');

const index = new VexusIndex(3, 10);

index.add(1, new Float32Array([1, 0, 0]));
index.addBatch(
  [2, 3],
  new Float32Array([
    0, 1, 0,
    0, 0, 1,
  ])
);

let stats = index.stats();
assert.equal(stats.totalVectors, 3);
assert.equal(stats.dimensions, 3);
assert.ok(stats.capacity >= 10);

let results = index.search(new Float32Array([1, 0, 0]), 3);
assert.equal(results.length, 3);
assert.equal(results[0].id, 1);
assertNear(results[0].score, 1, 'top search score');

index.remove(2);
stats = index.stats();
assert.equal(stats.totalVectors, 2);

results = index.search(new Float32Array([0, 1, 0]), 2);
assert.equal(results.length, 2);
assert.notEqual(results[0].id, 2);

for (const name of [
  'recoverFromSqlite',
  'computeSvd',
  'computeOrthogonalProjection',
  'computeHandshakes',
  'project',
  'computeIntrinsicResiduals',
  'computePairwiseSimilarities',
]) {
  assert.equal(typeof index[name], 'function', `missing VexusIndex.${name}`);
}

const watcher = new VexusWatcher();
assert.equal(typeof watcher.startWatch, 'function');
assert.equal(typeof watcher.stopWatch, 'function');

console.log(JSON.stringify({
  exports: ['VexusIndex', 'VexusWatcher'],
  stats,
  topResult: results[0],
}));
