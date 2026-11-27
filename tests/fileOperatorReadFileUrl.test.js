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
  const requests = [
    { command: 'ReadFile', filePath: url },
    { command1: 'ReadFile', filePath1: url, command2: 'ReadFile', filePath2: note },
    { command: 'ReadFile', filePath: url + '#ignored' }
  ];
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../Plugin/FileOperator/FileOperator.js')], {
    encoding: 'utf8', input: requests.map(r => JSON.stringify(r)).join('\n')+'\n', timeout: 15000,
    env: { ...process.env, ALLOWED_DIRECTORIES: dir, DEBUG_MODE: 'false' }
  });
  const [single, batch, invalid] = output.trim().split(/\r?\n/).map(s => JSON.parse(s));
  for (const result of [single, batch]) {
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.ok(JSON.stringify(result.result.content).includes('data:image/jpeg;base64,' + bytes.toString('base64')));
  }
  assert.ok(JSON.stringify(batch.result.content).includes('native-path-ok'));
  assert.equal(invalid.status, 'error');
});