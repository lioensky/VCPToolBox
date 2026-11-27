'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rebuildEmojiGeneratedLists } = require('../routes/admin/emojis');

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-emoji-lists-'));
    const imageRootDir = path.join(root, 'image');
    const listsDir = path.join(root, 'generated_lists');

    fs.mkdirSync(path.join(imageRootDir, '在册表情包'), { recursive: true });
    fs.writeFileSync(path.join(imageRootDir, '在册表情包', 'a.png'), 'png');
    fs.mkdirSync(path.join(imageRootDir, '普通相册'), { recursive: true });
    fs.mkdirSync(listsDir, { recursive: true });

    fs.writeFileSync(path.join(listsDir, '在册表情包.txt'), 'a.png');
    fs.writeFileSync(path.join(listsDir, '已删表情包.txt'), 'gone.png|missing.png');
    fs.writeFileSync(path.join(listsDir, '普通相册.txt'), 'x.png');

    return { root, imageRootDir, listsDir };
}

test('rebuild drops orphan emoji list files and keeps the live pack', async () => {
    const { root, imageRootDir, listsDir } = makeFixture();
    try {
        const result = await rebuildEmojiGeneratedLists({ imageRootDir, listsDir });

        assert.deepEqual([...result.removed].sort(), ['已删表情包', '普通相册'].sort());
        assert.equal(result.removedCount, 2);
        assert.equal(fs.existsSync(path.join(listsDir, '已删表情包.txt')), false);
        assert.equal(fs.existsSync(path.join(listsDir, '普通相册.txt')), false);
        assert.equal(fs.existsSync(path.join(listsDir, '在册表情包.txt')), true);
        assert.equal(fs.readFileSync(path.join(listsDir, '在册表情包.txt'), 'utf8'), 'a.png');
        assert.equal(result.generatedCount, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('rebuild is idempotent and leaves non-list files alone', async () => {
    const { root, imageRootDir, listsDir } = makeFixture();
    try {
        fs.writeFileSync(path.join(listsDir, 'README.md'), 'keep me');
        const first = await rebuildEmojiGeneratedLists({ imageRootDir, listsDir });
        const second = await rebuildEmojiGeneratedLists({ imageRootDir, listsDir });

        assert.equal(first.removedCount, 2);
        assert.equal(second.removedCount, 0);
        assert.equal(second.updatedCount, 0);
        assert.equal(fs.existsSync(path.join(listsDir, 'README.md')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});