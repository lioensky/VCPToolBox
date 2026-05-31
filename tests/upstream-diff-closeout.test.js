const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('R9 closeout keeps admin-required plugins denied when auth code is unavailable', () => {
  const source = readRepoFile('Plugin.js');

  assert.match(source, /Failed to obtain auth code for admin-required hybrid plugin/);
  assert.match(source, /Failed to obtain auth code for admin-required plugin/);
  assert.match(source, /Execution denied/);
  assert.doesNotMatch(source, /Execution will proceed without it/);
});

test('R9 closeout keeps DailyNote legacy and structured success fields', () => {
  const source = readRepoFile('Plugin/DailyNote/dailynote.js');

  assert.match(source, /message:\s*`Diary saved to \$\{filePath\}`/);
  assert.match(source, /result:\s*\{[\s\S]*targetFile:\s*filePath[\s\S]*fileName:\s*finalFileName/);
  assert.match(source, /const legacyResult\s*=\s*`Successfully edited diary file: \$\{modifiedFilePath\}`/);
  assert.match(source, /result:\s*legacyResult/);
  assert.match(source, /message:\s*`\$\{maid \|\| 'AI'\} 已成功更新/);
  assert.match(source, /details:\s*\{[\s\S]*targetFile:\s*modifiedFilePath[\s\S]*fileName:\s*finalFileName/);
});

test('R9 closeout keeps GPTImageGen chat endpoint and gated base64 previews', () => {
  const source = readRepoFile('Plugin/GPTImageGen/GPTImageGen.js');

  assert.match(source, /USE_CHAT_COMPLETIONS_MODE/);
  assert.match(source, /\/v1\/chat\/completions/);
  assert.match(source, /image_generation/);
  assert.match(source, /function shouldFallbackToChatCompletions\(error\)/);

  const bufferPushIndex = source.indexOf('savedBuffers.push({ buffer: imageBuffer, contentType })');
  assert.ok(bufferPushIndex > 0);
  const precedingGate = source.lastIndexOf('if (params.showBase64)', bufferPushIndex);
  assert.ok(precedingGate > 0);

  assert.match(source, /for \(const \{ buffer, contentType \} of savedBuffers\)/);
  assert.match(source, /url:\s*`data:\$\{imageMimeType\};base64,\$\{buffer\.toString\('base64'\)\}`/);
  assert.match(source, /const details = \{/);
});
