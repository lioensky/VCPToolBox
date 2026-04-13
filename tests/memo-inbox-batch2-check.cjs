const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const memoFormat = require('../Plugin/MemoInboxAPI/memoFormat.js');
  const attachmentStore = require('../Plugin/MemoInboxAPI/attachmentStore.js');
  const { createMemoStore } = require('../Plugin/MemoInboxAPI/memoStore.js');

  const fixedDate = new Date('2026-04-10T08:09:10.000Z');

  const memoId = memoFormat.createMemoId();
  assert.match(memoId, /^memo_[a-z0-9]+$/);

  const fileName = memoFormat.buildMemoFileName({
    createdAt: fixedDate,
    memoId: 'memo_test123',
  });
  assert.equal(fileName, '2026-04-10-08_09_10-memo_test123.txt');

  const formatted = memoFormat.formatMemoContent({
    createdAt: fixedDate,
    maidName: 'MemoInbox',
    content: '记录正文',
    attachments: ['/pw=KEY/images/memo-inbox/2026/04/10/a.png'],
    metadata: {
      memoId: 'memo_test123',
      source: 'api',
    },
    tags: ['标签1', '标签2'],
  });
  assert.equal(
    formatted,
    [
      '[2026-04-10] - MemoInbox',
      '记录正文',
      'Attachments: /pw=KEY/images/memo-inbox/2026/04/10/a.png',
      'Meta: memoId=memo_test123, source=api',
      'Tag: 标签1, 标签2',
    ].join('\n'),
  );

  const parsed = memoFormat.parseMemoContent(formatted);
  assert.equal(parsed.header.date, '2026-04-10');
  assert.equal(parsed.header.maidName, 'MemoInbox');
  assert.equal(parsed.content, '记录正文');
  assert.deepEqual(parsed.attachments, ['/pw=KEY/images/memo-inbox/2026/04/10/a.png']);
  assert.deepEqual(parsed.tags, ['标签1', '标签2']);
  assert.equal(parsed.meta.memoId, 'memo_test123');
  assert.equal(parsed.meta.source, 'api');
  assert.equal(memoFormat.extractMemoIdFromFileName(fileName), 'memo_test123');

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-inbox-batch2-'));
  try {
    const runtimeContext = {
      projectBasePath: tempRoot,
      memoDiaryName: 'MyMemos',
      memoMaidName: 'MemoInbox',
      memoRootPath: path.join(tempRoot, 'dailynote', 'MyMemos'),
      memoTrashPath: path.join(tempRoot, 'dailynote', 'MyMemos', '.trash'),
      memoImageRootPath: path.join(tempRoot, 'image', 'memo-inbox'),
      imageServerKey: 'image-key',
    };

    await fs.mkdir(runtimeContext.memoRootPath, { recursive: true });
    await fs.mkdir(runtimeContext.memoTrashPath, { recursive: true });
    await fs.mkdir(runtimeContext.memoImageRootPath, { recursive: true });

    const storedAttachments = await attachmentStore.storeAttachments({
      memoId: 'memo_attach1',
      inputs: [
        {
          kind: 'base64',
          value: 'data:image/png;base64,aGVsbG8=',
        },
      ],
      runtimeContext,
      now: fixedDate,
    });
    assert.equal(storedAttachments.length, 1);
    assert.equal(storedAttachments[0].mimeType, 'image/png');
    assert.equal(
      storedAttachments[0].url,
      '/pw=image-key/images/memo-inbox/2026/04/10/memo_attach1-1.png',
    );

    const attachmentStat = await fs.stat(
      path.join(runtimeContext.memoImageRootPath, '2026', '04', '10', 'memo_attach1-1.png'),
    );
    assert.equal(attachmentStat.isFile(), true);

    const pluginCalls = [];
    const pluginManager = {
      async processToolCall(toolName, args) {
        pluginCalls.push({ toolName, args });
        const targetDir = path.join(runtimeContext.memoRootPath);
        await fs.mkdir(targetDir, { recursive: true });
        const targetFile = path.join(
          targetDir,
          `2026-04-10-08_09_10-${args.fileName}.txt`,
        );
        const tagLine =
          toolName === 'DailyNote'
            ? `Tag: ${args.Tag}`
            : 'Tag: 自动标签';
        await fs.writeFile(
          targetFile,
          `[2026-04-10] - MemoInbox\n${args.Content ?? args.contentText}\n${tagLine}`,
          'utf8',
        );
        return {
          status: 'success',
          message: `Diary saved to ${targetFile}`,
        };
      },
    };

    const memoStore = createMemoStore({
      runtimeContext: {
        ...runtimeContext,
        pluginManager,
      },
      memoFormat,
    });

    const createdMemo = await memoStore.create({
      content: '新的 memo',
      source: 'api',
      attachments: storedAttachments,
    });

    assert.equal(pluginCalls.length, 1);
    assert.equal(pluginCalls[0].toolName, 'DailyNoteWrite');
    assert.match(pluginCalls[0].args.maidName, /^\[MyMemos\]MemoInbox$/);
    assert.equal(createdMemo.content, '新的 memo');
    assert.equal(createdMemo.meta.source, 'api');
    assert.equal(createdMemo.attachments.length, 1);
    assert.deepEqual(createdMemo.tags, ['自动标签']);

    const explicitMemo = await memoStore.create({
      memoId: 'memo_explicit123',
      content: '显式标签 memo',
      source: 'api',
      tags: ['显式标签', '去重验证'],
    });

    assert.equal(pluginCalls.length, 2);
    assert.equal(pluginCalls[1].toolName, 'DailyNote');
    assert.equal(pluginCalls[1].args.Tag, '显式标签, 去重验证');
    assert.ok(!String(pluginCalls[1].args.Content).includes('Tag: 显式标签, 去重验证'));
    assert.deepEqual(explicitMemo.tags, ['显式标签', '去重验证']);

    const explicitMemoPath = path.join(
      runtimeContext.memoRootPath,
      '2026-04-10-08_09_10-memo_explicit123.txt',
    );
    const explicitRaw = await fs.readFile(explicitMemoPath, 'utf8');
    assert.equal((explicitRaw.match(/^Tag:\s*/gm) || []).length, 1);

    const loadedMemo = await memoStore.getById(createdMemo.memoId);
    assert.equal(loadedMemo.memoId, createdMemo.memoId);

    const updatedMemo = await memoStore.update(createdMemo.memoId, {
      content: '更新后的 memo',
      tags: ['手动标签'],
    });
    assert.equal(updatedMemo.content, '更新后的 memo');
    assert.deepEqual(updatedMemo.tags, ['手动标签']);

    const listResult = await memoStore.list({ limit: 10 });
    assert.equal(listResult.items.length, 2);
    assert.ok(listResult.items.some((item) => item.memoId === createdMemo.memoId));
    assert.ok(listResult.items.some((item) => item.memoId === explicitMemo.memoId));

    await memoStore.softDelete(createdMemo.memoId);
    const trashed = await memoStore.listTrash();
    assert.equal(trashed.items.length, 1);
    assert.equal(trashed.items[0].memoId, createdMemo.memoId);

    await memoStore.restore(createdMemo.memoId);
    const restored = await memoStore.getById(createdMemo.memoId);
    assert.equal(restored.memoId, createdMemo.memoId);

    await memoStore.purge(createdMemo.memoId);
    await assert.rejects(() => memoStore.getById(createdMemo.memoId), /MEMO_NOT_FOUND/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('memo-inbox-batch2-check:ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
