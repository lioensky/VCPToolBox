const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
    classifyExternalPluginManifest,
    classifyExternalPluginManifests
} = require('../modules/externalPluginSafetyGate');

function makeManifest(overrides = {}) {
    return {
        name: 'ExternalEcho',
        pluginSource: 'external',
        basePath: 'external/ExternalEcho',
        pluginType: 'synchronous',
        entryPoint: { command: 'node external-echo.js' },
        communication: { protocol: 'stdio', timeout: 1000 },
        ...overrides
    };
}

test('classifier observes built-in legacy manifests without changing behavior', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        name: 'SciCalculator',
        pluginSource: 'legacy',
        basePath: 'Plugin/SciCalculator'
    }), {
        projectRoot: 'A:/repo',
        builtInPluginNames: ['SciCalculator']
    });

    assert.equal(result.pluginName, 'SciCalculator');
    assert.equal(result.pluginSource, 'legacy');
    assert.equal(result.isExternal, false);
    assert.equal(result.duplicateOfBuiltIn, false);
    assert.equal(result.decision, 'observe');
    assert.equal(result.risk, 'executes_process');
});

test('classifier would block external command plugins pending explicit allow policy', () => {
    const result = classifyExternalPluginManifest(makeManifest(), {
        projectRoot: 'A:/repo'
    });

    assert.equal(result.isExternal, true);
    assert.equal(result.decision, 'would_block');
    assert.equal(result.risk, 'executes_process');
    assert.equal(result.entryPointKind, 'command');
    assert.equal(result.basePath, path.resolve('A:/repo', 'external/ExternalEcho'));
    assert.match(result.reasons.join('\n'), /explicit allow policy/);
});

test('classifier keeps forced external source evidence internally consistent', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        pluginSource: undefined
    }), {
        isExternal: true
    });

    assert.equal(result.pluginSource, 'external');
    assert.equal(result.isExternal, true);
    assert.equal(result.decision, 'would_block');
});

test('classifier identifies direct script entrypoints as code-load risk', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        pluginType: 'messagePreprocessor',
        entryPoint: { script: 'index.js' },
        communication: { protocol: 'direct' }
    }));

    assert.equal(result.entryPointKind, 'script');
    assert.equal(result.risk, 'loads_code');
    assert.equal(result.decision, 'would_block');
    assert.match(result.reasons.join('\n'), /load plugin code/);
});

test('classifier flags external names that duplicate built-in plugins', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        name: 'SciCalculator'
    }), {
        builtInPluginNames: new Set(['SciCalculator'])
    });

    assert.equal(result.duplicateOfBuiltIn, true);
    assert.equal(result.decision, 'would_block');
    assert.match(result.reasons.join('\n'), /duplicates a built-in plugin/);
});

test('classifier reports missing or unsupported entrypoints as unknown risk', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        entryPoint: {},
        communication: {}
    }));

    assert.equal(result.entryPointKind, 'unknown');
    assert.equal(result.risk, 'unknown');
    assert.equal(result.decision, 'would_block');
    assert.match(result.reasons.join('\n'), /entrypoint is missing or unsupported/);
});

test('classification evidence does not leak plugin config or secret-like values', () => {
    const result = classifyExternalPluginManifest(makeManifest({
        pluginSpecificEnvConfig: {
            API_TOKEN: 'SECRET_VALUE_SHOULD_NOT_APPEAR',
            harmless: 'VISIBLE_VALUE_SHOULD_NOT_APPEAR'
        }
    }));
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes('SECRET_VALUE_SHOULD_NOT_APPEAR'), false);
    assert.equal(serialized.includes('VISIBLE_VALUE_SHOULD_NOT_APPEAR'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'pluginSpecificEnvConfig'), false);
});

test('classifier supports batch classification without mutating manifests', () => {
    const manifests = [
        makeManifest({ name: 'ExternalEcho' }),
        makeManifest({ name: 'BuiltInTool', pluginSource: 'legacy' })
    ];
    const before = JSON.stringify(manifests);
    const results = classifyExternalPluginManifests(manifests, {
        builtInPluginNames: ['BuiltInTool']
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].decision, 'would_block');
    assert.equal(results[1].decision, 'observe');
    assert.equal(JSON.stringify(manifests), before);
});
