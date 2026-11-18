'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const archived = [
    'agentConditioner', 'candidateSuperset', 'derivedAssetManager',
    'directAnchorReadout', 'dstcObservables', 'experimentArms',
    'fieldWorkspace', 'provenance', 'relativeTopologyMatcher',
    'riverMemoArtifactRepository', 'scaledFieldSolver', 'unifiedPathGeometry'
];

test('retired V10 prototypes are archived and remain loadable without database access', () => {
    for (const name of archived) {
        assert.equal(fs.existsSync(path.join(root, 'modules/tagmemoV10', `${name}.js`)), false);
        assert.ok(require(path.join(root, 'docs/archive/tagmemoV10', `${name}.js`)));
    }
    assert.equal(fs.existsSync(path.join(root, 'modules/tagmemoV10/curveProjector.js')), false);
});

test('Memo production module graph cannot load archived prototypes', () => {
    const visited = new Set();
    const visit = filename => {
        filename = require.resolve(filename);
        if (visited.has(filename)) return;
        visited.add(filename);
        assert.equal(filename.startsWith(path.join(root, 'docs/archive') + path.sep), false);
        const source = fs.readFileSync(filename, 'utf8');
        for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
            visit(path.resolve(path.dirname(filename), match[1]));
        }
    };
    for (const name of ['TagMemoEngine.js', 'TagMemoV10Engine.js', 'RiverMemoEngine.js']) {
        visit(path.join(root, name));
    }
    assert.ok(visited.has(require.resolve('../modules/tagmemoV10/immutable')));
    assert.ok(visited.has(require.resolve('../modules/tagmemoV10/riverObservability')));
});