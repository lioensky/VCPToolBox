const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

test('ReadFile consumes FileFetcher URLs and native paths through plugin stdio', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-read-url-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(dir, '中文 # 100%.jpg');
  const note = path.join(dir, 'note.txt');
  const bytes = Buffer.from([255, 216, 255, 217]);
  fs.writeFileSync(image, bytes);
  fs.writeFileSync(note, 'native-path-ok');
  const url = pathToFileURL(image).href;
  const copied = path.join(dir, 'copied-note.txt');
  const noteUrl = pathToFileURL(note).href;
  const copiedUrl = pathToFileURL(copied).href;
  const requests = [
    { command: 'ReadFile', filePath: url },
    { command1: 'ReadFile', filePath1: url, command2: 'ReadFile', filePath2: note },
    { command: 'FileInfo', filePath: url },
    { command: 'CopyFile', sourcePath: noteUrl, destinationPath: copiedUrl },
    { command: 'ApplyDiff', filePath: copiedUrl, target: 'native-path-ok', replace: 'file-url-diff-ok' },
    { command: 'ReadFile', filePath: url + '#ignored' },
    { command: 'FileInfo', filePath: 'file://remote-host/share/note.txt' }
  ];
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../Plugin/FileOperator/FileOperator.js')], {
    encoding: 'utf8', input: requests.map(r => JSON.stringify(r)).join('\n')+'\n', timeout: 15000,
    env: { ...process.env, ALLOWED_DIRECTORIES: dir, DEBUG_MODE: 'false' }
  });
  const [single, batch, info, copyRes, diffRes, invalidHash, invalidHost] = output.trim().split(/\r?\n/).map(s => JSON.parse(s));
  for (const result of [single, batch]) {
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.ok(JSON.stringify(result.result.content).includes('data:image/jpeg;base64,' + bytes.toString('base64')));
  }
  assert.ok(JSON.stringify(batch.result.content).includes('native-path-ok'));
  assert.equal(info.status, 'success', JSON.stringify(info));
  assert.equal(copyRes.status, 'success', JSON.stringify(copyRes));
  assert.equal(diffRes.status, 'success', JSON.stringify(diffRes));
  assert.equal(fs.readFileSync(copied, 'utf8'), 'file-url-diff-ok');
  assert.equal(invalidHash.status, 'error');
  assert.equal(invalidHost.status, 'error');
});

test('MoveFile gracefully falls back to copy+unlink when fs.rename fails with EXDEV across mount points', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-move-exdev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'source.bin');
  const dst = path.join(dir, 'dest.bin');
  const payload = Buffer.from('EXDEV-CROSS-MOUNT-PAYLOAD');
  fs.writeFileSync(src, payload);

  const preload = path.join(dir, 'mock-exdev.cjs');
  fs.writeFileSync(preload, [
    "const fsPromises = require('fs').promises;",
    "const origRename = fsPromises.rename.bind(fsPromises);",
    "fsPromises.rename = async () => { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; };"
  ].join('\n'));

  const output = execFileSync(
    process.execPath,
    ['--require', preload, path.resolve(__dirname, '../Plugin/FileOperator/FileOperator.js')],
    {
      encoding: 'utf8',
      input: JSON.stringify({ command: 'MoveFile', sourcePath: pathToFileURL(src).href, destinationPath: dst }) + '\n',
      timeout: 15000,
      env: { ...process.env, ALLOWED_DIRECTORIES: dir, DEBUG_MODE: 'false' }
    }
  );

  const parsed = JSON.parse(output.trim());
  assert.equal(parsed.status, 'success', JSON.stringify(parsed));
  assert.deepEqual(fs.readFileSync(dst), payload);
  assert.equal(fs.existsSync(src), false);
});