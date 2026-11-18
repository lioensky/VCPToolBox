'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../KnowledgeBaseManager');
const Manager = kb.constructor;

test('explicit zero penalties, empty ignore rules and trimmed startup flag survive configuration', () => {
    const values = {
        LANG_PENALTY_UNKNOWN: '0',
        LANG_PENALTY_CROSS_DOMAIN: '0.27',
        IGNORE_FOLDERS: '',
        IGNORE_PREFIXES: '',
        IGNORE_SUFFIXES: '',
        KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP: ' false '
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    try {
        Object.assign(process.env, values);
        const manager = new Manager();
        assert.equal(manager.config.langPenaltyUnknown, 0);
        assert.equal(manager.config.langPenaltyCrossDomain, 0.27);
        assert.equal(manager.config.fullScanOnStartup, false);
        assert.deepEqual(manager.config.ignoreFolders, []);
        assert.deepEqual(manager.config.ignorePrefixes, []);
        assert.deepEqual(manager.config.ignoreSuffixes, []);
        for (const raw of [undefined, '', ' ', 'NaN', '-1', '2', '0.2junk']) {
            assert.equal(manager._readOptionalPenalty(raw), undefined);
        }
        assert.equal(manager._readOptionalPenalty('1'), 1);
        assert.equal(manager._readOptionalPenalty('0'), 0);
        assert.equal(Object.hasOwn(manager.config, 'deleteRebuildThreshold'), false);
        assert.equal(Object.hasOwn(manager.config, 'tagExpandMaxCount'), false);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('initial snapshot permission requires explicit generational configuration', () => {
    const keys = ['KNOWLEDGEBASE_PERSIST_TAG_INDEX', 'KNOWLEDGEBASE_PERSIST_CHUNK_INDEX'];
    const previous = keys.map(key => process.env[key]);
    try {
        for (const raw of [undefined, '', 'always', 'true', 'false', 'none', 'invalid', ' generational ']) {
            for (const key of keys) {
                if (raw === undefined) delete process.env[key];
                else process.env[key] = raw;
            }
            const config = new Manager().config;
            assert.equal(config.tagIndexAllowInitial, raw === ' generational ');
            assert.equal(config.chunkIndexAllowInitial, raw === ' generational ');
        }
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
});

test('training status HTTP endpoint returns task state without starting training', async () => {
    const express = require('express');
    const router = require('../routes/admin/rag');
    const task = { taskId: 'test', status: 'running', phase: 'geometry' };
    const app = express();
    app.use(router({
        vectorDBManager: { tagMemoEngine: { getTrainingStatus: () => task } }
    }));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/rag-active-full-training/status`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, task });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});