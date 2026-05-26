const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'Plugin', 'DoubaoGen', 'DoubaoGen.js'),
    'utf8'
);

test('DoubaoGen disables model fallback when args.model is explicit', () => {
    assert.match(
        source,
        /const modelExplicit = typeof args\.model === 'string' && args\.model\.trim\(\);/
    );
    assert.match(
        source,
        /const model = modelExplicit \? args\.model\.trim\(\) : DEFAULT_MODEL_ID;/
    );
    assert.match(
        source,
        /return callAPI\(body, 0, null, \{ allowModelFallback: !modelExplicit \}\);/
    );
    assert.match(
        source,
        /if \(allowModelFallback && failedModels\.size <= MAX_MODEL_FALLBACK\)/
    );
});
