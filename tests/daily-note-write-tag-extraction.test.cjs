const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDailyNoteWriteInternals() {
  const filePath = path.resolve(__dirname, '../Plugin/DailyNoteWrite/daily-note-write.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = `${source}\nmodule.exports = { extractTagFromAIResponse, fixTagFormat };`;

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname: path.dirname(filePath),
    __filename: filePath,
    process: {
      env: {},
      stdout: { write() {} },
      stderr: { write() {} },
      stdin: {
        setEncoding() {},
        on() {},
        read() { return null; },
      },
      exitCode: 0,
    },
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
  return sandbox.module.exports;
}

function main() {
  const { extractTagFromAIResponse, fixTagFormat } = loadDailyNoteWriteInternals();

  const thinkResponse = [
    '<think>',
    'I must output ONLY a single line encapsulated within double square brackets.',
    'It must start with [[Tag: and end with ]]',
    '</think>',
    '',
    '[[Tag: VCPToolBox, 记忆系统, 自动标签, RAG召回]]',
  ].join('\n');

  assert.equal(
    extractTagFromAIResponse(thinkResponse),
    'Tag: VCPToolBox, 记忆系统, 自动标签, RAG召回',
    '应忽略 <think> 内的格式说明，只提取最终 Tag 行',
  );

  const multiTagResponse = [
    '分析完成。',
    '[[Tag: 错误示例, 不应命中]]',
    '<think>',
    '这里只是中间推理',
    '</think>',
    '[[Tag: 最终标签1, 最终标签2]]',
  ].join('\n');

  assert.equal(
    extractTagFromAIResponse(multiTagResponse),
    'Tag: 最终标签1, 最终标签2',
    '应优先采用最终出现的有效 Tag 块',
  );

  assert.equal(
    fixTagFormat('Tag: VCPToolBox,记忆系统'),
    'Tag: VCPToolBox, 记忆系统',
  );

  console.log('daily-note-write-tag-extraction:ok');
}

main();
