'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');

function readDefaultMode(envValue) {
    const env = { ...process.env };
    if (envValue === undefined) {
        delete env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_ENABLED;
    } else {
        env.KNOWLEDGEBASE_NATIVE_RIVER_QUERY_ENABLED = envValue;
    }

    const result = spawnSync(
        process.execPath,
        [
            '-e',
            "const kb=require('./KnowledgeBaseManager');" +
            "process.stdout.write(String(kb.config.nativeRiverQueryEnabled));"
        ],
        {
            cwd: workspaceRoot,
            env,
            encoding: 'utf8'
        }
    );
    assert.equal(
        result.status,
        0,
        result.stderr || 'KnowledgeBaseManager child process failed'
    );
    return result.stdout.trim().endsWith('true');
}

test('native River joint query is the default production mode', () => {
    assert.equal(readDefaultMode(undefined), true);
});

test('native River joint query can only be disabled explicitly', () => {
    assert.equal(readDefaultMode('false'), false);
    assert.equal(readDefaultMode('true'), true);
});