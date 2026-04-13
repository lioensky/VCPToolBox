const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDailyNoteInternals(tempRoot) {
  const filePath = path.resolve(__dirname, '../Plugin/DailyNote/dailynote.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports = { processTags, handleCreateCommand };`;

  const fsPromises = require('node:fs/promises');
  const realProcess = process;
  const sandboxProcess = {
    env: {
      PROJECT_BASE_PATH: tempRoot,
      KNOWLEDGEBASE_ROOT_PATH: path.join(tempRoot, 'dailynote'),
      DAILY_NOTE_EXTENSION: 'txt',
    },
    stdin: {
      setEncoding() {},
      on() {},
      read() { return null; },
    },
    stdout: { write() {} },
    exit() {},
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === 'dotenv') {
        return { config() { return {}; } };
      }
      return require(id);
    },
    __dirname: path.dirname(filePath),
    __filename: filePath,
    process: sandboxProcess,
    console: {
      error() {},
      warn() {},
      log() {},
    },
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });
  return {
    ...sandbox.module.exports,
    fsPromises,
    restore() {
      process.env = realProcess.env;
    },
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'daily-note-dedup-'));
  const { handleCreateCommand } = loadDailyNoteInternals(tempRoot);

  const result = await handleCreateCommand({
    maid: '[MyMemos]MemoInbox',
    Date: '2026-04-10',
    Content: '显式标签创建去重测试',
    Tag: 'explicit-fix, single-tag-line',
    fileName: 'daily-note-tag-dedup',
  });

  assert.equal(result.status, 'success');
  const savedPath = result.message.replace('Diary saved to ', '');
  const raw = fs.readFileSync(savedPath, 'utf8');
  assert.equal((raw.match(/^Tag:\s*/gm) || []).length, 1);
  assert.match(raw, /Tag: explicit-fix, single-tag-line/);

  console.log('daily-note-create-tag-dedup:ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
