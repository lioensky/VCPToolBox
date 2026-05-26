const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginSource = fs.readFileSync(path.join(__dirname, '..', 'Plugin.js'), 'utf8');
const contextSource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'toolExecutionContext.js'), 'utf8');

test('DoubaoGen PROJECT_BASE_PATH override survives execution context normalization', () => {
    assert.match(
        contextSource,
        /appendOptionalString\(normalizedContext, executionContext, 'doubaoProjectBasePathOverride'\)/
    );
});

test('PluginManager uses DoubaoGen PROJECT_BASE_PATH override before default project root', () => {
    assert.match(
        pluginSource,
        /pluginName === 'DoubaoGen'[\s\S]*normalizedExecutionContext\.doubaoProjectBasePathOverride/
    );
    assert.match(
        pluginSource,
        /additionalEnv\.PROJECT_BASE_PATH = doubaoProjectBasePathOverride;/
    );
    assert.match(
        pluginSource,
        /else if \(this\.projectBasePath\) \{\s*additionalEnv\.PROJECT_BASE_PATH = this\.projectBasePath;/
    );
});
