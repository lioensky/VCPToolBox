'use strict';

// Build rust-vexus-lite/target/tdb-validation first. Never overwrite or load
// production data here; every native integration fixture owns a temporary DB.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bindingPath = process.env.TDB_NATIVE_BINDING
    ? path.resolve(process.env.TDB_NATIVE_BINDING)
    : path.join(root, 'rust-vexus-lite', 'target', 'tdb-validation',
        `vexus-lite.${process.platform}-${process.arch}-${process.platform === 'win32' ? 'msvc' : 'gnu'}.node`);
const tests = [
    'rust-vexus-lite/test.js',
    'tests/diaryIndexAtomicDelta.test.js',
    'tests/tagIndexGenerationalBaseline.test.js',
    'tests/tagConsistencyIncrementalIndex.test.js',
    'tests/nativeKnowledgeRuntimeRegistry.test.js',
    'tests/nativeHybridRiverQueryPlan.test.js',
    'tests/kbmNativeLifecycle.test.js',
    'tests/nativeMemoManifestCompatibility.test.js'
];

for (const test of tests) {
    console.log(`\n=== TDB acceptance: ${test} ===`);
    const source = `
        const binding = require(${JSON.stringify(bindingPath)});
        const entry = require.resolve('./rust-vexus-lite');
        const caps = new binding.NativeKnowledgeRuntime(
            new binding.VexusIndex(3, 16)).capabilities();
        require('node:assert/strict').ok(caps.capabilities.includes('index.tdb-vec.v1'));
        require('node:assert/strict').ok(caps.capabilities.includes('index.cosine-score.v1'));
        require.cache[entry] = { id: entry, filename: entry, loaded: true, exports: binding };
        require(${JSON.stringify('./' + test)});
    `;
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: root, stdio: 'inherit'
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${test} failed (${result.signal || result.status})`);
}
console.log('\nTDB isolated native acceptance: all eight entry points passed.');