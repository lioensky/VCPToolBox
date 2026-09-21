const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ignore-'));
fs.copyFileSync(path.resolve(__dirname, '../.gitignore'), path.join(pluginRoot, '.gitignore'));
const init = spawnSync('git', ['init', '--quiet'], { cwd: pluginRoot, encoding: 'utf8' });
assert.equal(init.status, 0, init.stderr);
test.after(() => {
  assert.equal(path.dirname(fs.realpathSync.native(pluginRoot)), fs.realpathSync.native(os.tmpdir()));
  fs.rmSync(pluginRoot, {recursive:true,force:true});
});
const safePluginRoot = pluginRoot.replace(/\\/g, '/');

function isIgnored(relativePath) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${safePluginRoot}`,
      'check-ignore',
      '--no-index',
      '--quiet',
      '--',
      relativePath,
    ],
    {
      cwd: pluginRoot,
      encoding: 'utf8',
    },
  );

  assert.ok(
    result.status === 0 || result.status === 1,
    `git check-ignore failed for ${relativePath}: ${result.stderr}`,
  );
  return result.status === 0;
}

test('private environment files and backup variants are ignored safely', () => {
  const ignoredPaths = [
    '.env',
    '.env.local',
    '.env.backup',
    'config.env',
    'config.env.local',
    'config.env.bak',
    'config.env.backup',
    'settings.bak',
    'settings.backup',
    'settings~',
  ];

  for (const ignoredPath of ignoredPaths) {
    assert.equal(isIgnored(ignoredPath), true, `${ignoredPath} should be ignored`);
  }

  assert.equal(isIgnored('config.env.example'), false);
});
