const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { START, END, normalizeManifest, run } = require('../normalize-plugin-examples');

const block = `${START}\nprompt:「始」测试「末」\n${END}`;
function fixture(command) {
    return { capabilities: { invocationCommands: [{ commandIdentifier: 'Test', ...command }] } };
}

test('moves all complete blocks and preserves text outside them; idempotent', () => {
    const manifest = fixture({ description: `说明\n${block}\n后文${block}结束`, other: 42 });
    assert.equal(normalizeManifest(manifest).changes.length, 1);
    const cmd = manifest.capabilities.invocationCommands[0];
    assert.equal(cmd.description, '说明\n\n后文结束');
    assert.equal(cmd.example, `${block}\n\n${block}`);
    assert.equal(cmd.other, 42);
    assert.equal(normalizeManifest(manifest).changes.length, 0);
});

test('existing example is not overwritten; missing/empty/null example is migrated', () => {
    for (const example of ['existing', '', '  ', null, undefined]) {
        const manifest = fixture({ description: block, example });
        normalizeManifest(manifest);
        assert.equal(manifest.capabilities.invocationCommands[0].example, example === 'existing' ? example : block);
    }
});

test('malformed blocks and invalid example types are not changed', () => {
    for (const description of [`${START}incomplete`, `${END}`, `${START}${block}${END}`]) {
        const manifest = fixture({ description });
        assert.equal(normalizeManifest(manifest).warnings.length, 1);
        assert.equal(manifest.capabilities.invocationCommands[0].description, description);
    }
    const manifest = fixture({ description: block, example: {} });
    assert.equal(normalizeManifest(manifest).warnings.length, 1);
    assert.equal(manifest.capabilities.invocationCommands[0].description, block);
});

test('no blocks, no invocationCommands or no identifier remain unchanged', () => {
    for (const manifest of [{}, fixture({ description: 'plain text' }), {
        invocationCommands: [{ description: block }]
    }]) {
        const original = JSON.stringify(manifest);
        assert.equal(normalizeManifest(manifest).changes.length, 0);
        assert.equal(JSON.stringify(manifest), original);
    }
});

test('preview is read-only; write backs up enabled/disabled configs and preserves BOM/CRLF', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-normalize-'));
    try {
        const root = path.join(temp, 'Plugin');
        const backupRoot = path.join(temp, 'backups');
        await fs.mkdir(path.join(root, 'Fixture'), { recursive: true });
        const original = '\uFEFF' + JSON.stringify(fixture({ description: block }), null, 2).replace(/\n/g, '\r\n') + '\r\n';
        const names = ['plugin-manifest.json', 'plugin-manifest.json.block'];
        for (const name of names) await fs.writeFile(path.join(root, 'Fixture', name), original);
        const preview = await run({ root, backupRoot, log() {} });
        assert.equal(preview.changedFiles, 2);
        for (const name of names) assert.equal(await fs.readFile(path.join(root, 'Fixture', name), 'utf8'), original);
        const applied = await run({ root, backupRoot, write: true, log() {} });
        assert.equal(applied.errors, 0);
        assert.equal(applied.changedFiles, 2);
        const [backupRun] = await fs.readdir(backupRoot);
        for (const name of names) {
            assert.equal(await fs.readFile(path.join(backupRoot, backupRun, 'Fixture', name), 'utf8'), original);
            const output = await fs.readFile(path.join(root, 'Fixture', name), 'utf8');
            assert.ok(output.startsWith('\uFEFF'));
            assert.ok(output.endsWith('\r\n'));
            assert.equal(JSON.parse(output.slice(1)).capabilities.invocationCommands[0].example, block);
        }
        assert.equal((await run({ root, backupRoot, log() {} })).changedFiles, 0);
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
});

test('normalizer and validator ignore browser profiles and non-manifest JSON', async () => {
    const { validateDirectory } = require('../validate-plugin-json');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-scope-'));
    try {
        const root = path.join(temp, 'Plugin');
        const plugin = path.join(root, 'ChromeBridge');
        const profile = path.join(plugin, 'managed-profile', 'FirstPartySetsPreloaded');
        await fs.mkdir(profile, { recursive: true });
        const browserData = '{"site":"a"}\n{"site":"b"}';
        const unrelated = JSON.stringify(fixture({ description: block }));
        await fs.writeFile(path.join(profile, 'sets.json'), browserData);
        await fs.writeFile(path.join(profile, 'plugin-manifest.json'), unrelated);
        await fs.writeFile(path.join(plugin, 'state.json'), unrelated);
        await fs.writeFile(path.join(plugin, 'plugin-manifest.json'), JSON.stringify(fixture({ description: block })));
        const result = await run({ root, backupRoot: path.join(temp, 'backups'), write: true, log() {} });
        assert.equal(result.files, 1);
        assert.equal(result.errors, 0);
        assert.equal(result.changedFiles, 1);
        assert.equal(await fs.readFile(path.join(profile, 'sets.json'), 'utf8'), browserData);
        assert.equal(await fs.readFile(path.join(profile, 'plugin-manifest.json'), 'utf8'), unrelated);
        assert.equal(await fs.readFile(path.join(plugin, 'state.json'), 'utf8'), unrelated);
        const validation = await validateDirectory(root, () => {});
        assert.equal(validation.files, 1);
        assert.equal(validation.invalid, 0);
        await fs.writeFile(path.join(plugin, 'plugin-manifest.json'), '{broken');
        assert.equal((await validateDirectory(root, () => {})).invalid, 1);
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
});