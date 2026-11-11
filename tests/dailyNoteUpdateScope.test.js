const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('DailyNote updates stay within the selected folder scope', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-note-scope-'));
    const pluginPath = path.resolve(__dirname, '../Plugin/DailyNote/dailynote.js');
    const pluginRequire = createRequire(pluginPath);
    const source = await fs.readFile(pluginPath, 'utf8');
    const moduleObject = { exports: {} };
    vm.runInNewContext(source, {
        require: name => name === 'dotenv' ? { config() {} } : pluginRequire(name),
        module: moduleObject,
        exports: moduleObject.exports,
        __dirname: path.dirname(pluginPath),
        process: {
            env: { KNOWLEDGEBASE_ROOT_PATH: root, DAILY_NOTE_FUZZY_DIFF: 'true' },
            pid: process.pid
        },
        console,
        setTimeout
    }, { filename: pluginPath });
    const { dispatchCommand } = moduleObject.exports;
    const target = 'This is the original diary content to replace safely.';
    const replacement = 'Updated diary content.';
    const folders = ['nova的知识', 'nova的日记', '公共的知识', '公共的日记', '桌面的知识', '桌面的知识备份', 'other的知识'];
    const diaryPath = folder => path.join(root, folder, 'note.txt');
    async function reset(contents = {}) {
        for (const folder of folders) {
            await fs.mkdir(path.join(root, folder), { recursive: true });
            await fs.writeFile(diaryPath(folder), contents[folder] || 'Unrelated diary.');
        }
    }
    async function update(args) {
        return dispatchCommand({ command: 'update', target, replace: replacement, ...args });
    }
    async function unchanged(folder) {
        assert.equal(await fs.readFile(diaryPath(folder), 'utf8'), target);
    }
    try {
        for (const [name, args, destination] of [
            ['own folder fallback', { maid: 'nova', folder: 'nova的知识' }, 'nova的日记'],
            ['public folder fallback', { maid: 'nova', folder: '公共的知识' }, '公共的日记'],
            ['no folder uses owner scope', { maid: 'nova' }, 'nova的日记'],
            ['legacy folder syntax', { maid: '[公共的知识]nova' }, '公共的日记'],
            ['explicit other category', { maid: 'nova', folder: '桌面的知识' }, '桌面的知识'],
            ['missing own folder stays in owner scope', { maid: 'nova', folder: 'nova的不存在' }, 'nova的日记'],
            ['case-insensitive folder key', { maid: 'nova', FOLDER: '公共的知识' }, '公共的日记']
        ]) {
            await t.test(name, async () => {
                await reset({ [destination]: target, 'other的知识': target });
                const result = await update(args);
                assert.equal(result.status, 'success');
                assert.equal(result.result.folder, destination);
                await unchanged('other的知识');
            });
        }
        for (const [name, args, outside] of [
            ['own scope excludes public', { maid: 'nova', folder: 'nova的知识' }, '公共的知识'],
            ['public scope excludes owner', { maid: 'nova', folder: '公共的知识' }, 'nova的知识'],
            ['other category has no fallback', { maid: 'nova', folder: '桌面的知识' }, '桌面的知识备份'],
            ['missing category has no fuzzy resolution', { maid: 'nova', folder: '桌面的知' }, '桌面的知识'],
            ['no folder excludes other agents', { maid: 'nova' }, 'other的知识'],
            ['missing identity rejects global search', {}, 'other的知识'],
            ['empty normalized identity rejects global search', { maid: '日记本' }, 'other的知识'],
            ['invalid folder type rejects fallback', { maid: 'nova', folder: 123 }, 'nova的知识']
        ]) {
            await t.test(name, async () => {
                await reset({ [outside]: target });
                const result = await update(args);
                assert.equal(result.status, 'error');
                if (result.result?.fuzzyDiff) {
                    assert.notEqual(result.result.fuzzyDiff.candidateFile, diaryPath(outside));
                }
                await unchanged(outside);
            });
        }
        await t.test('filename fragment supports timestamp prefixes and refuses ambiguity', async () => {
            await reset({ 'other的知识': target });
            const first = path.join(root, 'nova的知识', '2026-10-29-12_30_00-ProjectAlpha.md');
            const second = path.join(root, 'nova的日记', '2026-10-28-08_00_00-ProjectBeta.txt');
            await fs.writeFile(first, target);
            await fs.writeFile(second, target);
            try {
                const ambiguous = await update({ maid: 'nova', fileName: 'Project' });
                assert.equal(ambiguous.code, 'DAILY_NOTE_AMBIGUOUS_TARGET');
                assert.equal(await fs.readFile(first, 'utf8'), target);
                assert.equal(await fs.readFile(second, 'utf8'), target);
                const result = await update({ maid: 'nova', fileName: 'projectalpha' });
                assert.equal(result.status, 'success');
                assert.equal(await fs.readFile(first, 'utf8'), replacement);
                assert.equal(await fs.readFile(second, 'utf8'), target);
                assert.equal((await update({ maid: 'nova', fileName: 'note' })).status, 'error');
                await unchanged('other的知识');
            } finally {
                await fs.unlink(first);
                await fs.unlink(second);
            }
        });
        await t.test('duplicate targets across owner folders reject all writes', async () => {
            await reset({ 'nova的知识': target, 'nova的日记': target });
            const result = await update({ maid: 'nova', folder: 'nova的知识' });
            assert.equal(result.code, 'DAILY_NOTE_AMBIGUOUS_TARGET');
            assert.equal(result.result.matchCount, 2);
            await unchanged('nova的知识');
            await unchanged('nova的日记');
        });
        await t.test('duplicate targets within a file reject all writes', async () => {
            const repeated = target + '\\n' + target;
            await reset({ 'nova的知识': repeated });
            const result = await update({ maid: 'nova' });
            assert.equal(result.code, 'DAILY_NOTE_AMBIGUOUS_TARGET');
            assert.equal(result.result.matchCount, 2);
            assert.equal(await fs.readFile(diaryPath('nova的知识'), 'utf8'), repeated);
        });
        await t.test('exact and loose matches both count toward ambiguity', async () => {
            await reset({ 'nova的知识': target, 'nova的日记': target.toUpperCase() });
            assert.equal((await update({ maid: 'nova' })).code, 'DAILY_NOTE_AMBIGUOUS_TARGET');
            await unchanged('nova的知识');
        });
        await t.test('unique loose match replaces the original span correctly', async () => {
            await reset({ 'nova的知识': target.replaceAll(' ', '   ') + ' SUFFIX' });
            assert.equal((await update({ maid: 'nova' })).status, 'success');
            assert.equal(await fs.readFile(diaryPath('nova的知识'), 'utf8'), replacement + ' SUFFIX');
        });
        await t.test('exact filename disambiguates files without expanding scope', async () => {
            await reset({ 'nova的知识': target });
            const extraPath = path.join(root, 'nova的知识', 'chosen.md');
            await fs.writeFile(extraPath, target);
            try {
                assert.equal((await update({ maid: 'nova' })).code, 'DAILY_NOTE_AMBIGUOUS_TARGET');
                const result = await update({ maid: 'nova', fileName: 'chosen.md' });
                assert.equal(result.status, 'success');
                assert.equal(result.result.fileName, 'chosen.md');
                await unchanged('nova的知识');
                assert.equal((await update({ maid: 'nova', fileName: '../note.txt' })).status, 'error');
            } finally {
                await fs.unlink(extraPath);
            }
        });
        await t.test('longer target disambiguates within the namespace', async () => {
            await reset({ 'nova的知识': target + ' unique ending', 'nova的日记': target });
            assert.equal((await update({ maid: 'nova', target: target + ' unique ending' })).status, 'success');
            await unchanged('nova的日记');
        });
        await t.test('directory junction cannot redirect owner scope', async () => {
            await reset({ 'other的知识': target });
            await fs.symlink(path.join(root, 'other的知识'), path.join(root, 'nova的链接'), 'junction');
            assert.equal((await update({ maid: 'nova' })).status, 'error');
            await unchanged('other的知识');
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});