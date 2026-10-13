'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');

test('管理策略：旧环境回退、空名单、精确名单、不限和损坏拒绝', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-policy-'));
    const registry = new JevThirdPartyRegistry();
    registry.policyPath = path.join(dir, 'policy.json');
    const env = { JEV_THIRD_PARTY_ALLOWLIST: 'OldPlugin' };
    try {
        assert.deepEqual(registry.getAllowlist(env), ['OldPlugin']);
        fs.writeFileSync(registry.policyPath, JSON.stringify({ mode: 'selected', allowlist: [] }));
        assert.deepEqual(registry.getAllowlist(env), []);
        fs.writeFileSync(registry.policyPath, JSON.stringify({ mode: 'selected', allowlist: ['AgentMessage', 'AgentMessage'] }));
        assert.deepEqual(registry.getAllowlist(env), ['AgentMessage']);
        fs.writeFileSync(registry.policyPath, JSON.stringify({ mode: 'unrestricted', allowlist: [] }));
        assert.equal(registry.getAllowlist(env), null);
        fs.writeFileSync(registry.policyPath, '{broken');
        assert.deepEqual(registry.getAllowlist(env), []);
        fs.writeFileSync(registry.policyPath, JSON.stringify({ mode: 'selected', allowlist: ['../bad'] }));
        assert.deepEqual(registry.getAllowlist(env), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理路由拒绝非法策略与未注册插件，不落盘', async () => {
    const app = express();
    app.use(express.json());
    app.use(require('../routes/admin/jevRegistry')({ pluginManager: {} }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        for (const body of [
            { mode: 'selected', allowlist: '../bad' },
            { mode: 'selected', allowlist: ['../bad'] },
            { mode: 'invalid', allowlist: [] },
            { mode: 'selected', allowlist: ['DefinitelyNotRegistered_Plfta'] }
        ]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/jev/registry/policy`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            assert.equal(response.status, 400);
        }
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test('管理接口原子保存空名单并立即拒绝全部，可恢复不限模式', async () => {
    const registry = require('../modules/jevThirdPartyRegistry');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-policy-http-'));
    const oldPath = registry.policyPath;
    registry.policyPath = path.join(dir, 'policy.json');
    const app = express();
    app.use(express.json());
    app.use(require('../routes/admin/jevRegistry')({ pluginManager: {}, jevPolicyPath: registry.policyPath }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        for (const mode of ['selected', 'unrestricted']) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/jev/registry/policy`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, allowlist: [] })
            });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.deepEqual(result.experiment.allowlist, mode === 'selected' ? [] : null);
            assert.deepEqual(JSON.parse(fs.readFileSync(registry.policyPath, 'utf8')), { mode, allowlist: [] });
        }
        assert.deepEqual(fs.readdirSync(dir), ['policy.json']);
    } finally {
        registry.policyPath = oldPath;
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});