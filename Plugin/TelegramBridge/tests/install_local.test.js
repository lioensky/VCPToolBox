'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function powershellCommand() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  return candidates.find((candidate) => {
    const result = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    return result.status === 0;
  }) ?? null;
}

test('local installer dry-run validates a pinned package without changing target config or state', (t) => {
  const shell = powershellCommand();
  if (!shell) return t.skip('PowerShell is unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-install-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const releaseDir = path.join(temp, 'release');
  const targetRoot = path.join(temp, 'VCPToolBox');
  const targetPlugin = path.join(targetRoot, 'Plugin', 'TelegramBridge');
  fs.mkdirSync(path.join(targetPlugin, 'state'), { recursive: true });
  fs.writeFileSync(path.join(targetPlugin, 'config.env'), 'TELEGRAM_MODE=probe\nPRIVATE=sentinel\n');
  fs.writeFileSync(path.join(targetPlugin, 'state', 'sentinel'), 'keep');

  const packaged = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'package-release.js'),
    '--version', '0.1.0-rc.1',
    '--out-dir', releaseDir,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.stderr);
  const archive = path.join(releaseDir, 'VCP-TelegramBridge-v0.1.0-rc.1.tar.gz');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');

  const result = spawnSync(shell, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'install-local.ps1'),
    '-PackagePath', archive,
    '-TargetRoot', targetRoot,
    '-ExpectedSha256', digest,
    '-DryRun',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /LOCAL_INSTALL_DRY_RUN_OK/);
  assert.equal(
    fs.readFileSync(path.join(targetPlugin, 'config.env'), 'utf8'),
    'TELEGRAM_MODE=probe\nPRIVATE=sentinel\n',
  );
  assert.equal(fs.readFileSync(path.join(targetPlugin, 'state', 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(targetPlugin).sort(), ['config.env', 'state']);
});

test('installer source documents explicit apply and never overwrites private state in place', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'install-local.ps1'), 'utf8');
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$Apply/);
  assert.match(script, /config\.env/);
  assert.match(script, /state/);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+config\.env[^\r\n]+-Force/i);
  assert.match(script, /npm --prefix \$targetPath ci --omit=dev/);
  assert.match(script, /INSTALL_PACKAGE_SCOPE_INVALID/);
});

test('apply pins npm to the plugin and leaves parent dependencies and private state intact', t => {
  const shell = powershellCommand();
  if (!shell) return t.skip('PowerShell is unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-install-scope-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const targetRoot = path.join(temp, 'host');
  const targetPlugin = path.join(targetRoot, 'Plugin', 'TelegramBridge');
  fs.mkdirSync(path.join(targetPlugin, 'state'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'package.json'), '{"name":"host-sentinel"}');
  fs.writeFileSync(path.join(targetRoot, 'node_modules', 'sentinel'), 'parent-keep');
  fs.writeFileSync(path.join(targetPlugin, 'state', 'sentinel'), 'state-keep');
  fs.writeFileSync(path.join(targetPlugin, 'config.env'), 'TELEGRAM_MODE=probe\n');
  const packaged = spawnSync(process.execPath, [path.join(root, 'scripts/package-release.js'),
    '--version', '0.1.0-rc.5', '--out-dir', path.join(temp, 'release')], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.stderr);
  const archive = path.join(temp, 'release', 'VCP-TelegramBridge-v0.1.0-rc.5.tar.gz');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const wrapper = path.join(temp, 'apply-fixture.ps1');
  fs.writeFileSync(wrapper, `
function npm {
  if ($args.Count -ne 4 -or $args[0] -ne '--prefix' -or $args[1] -ne ${quote(targetPlugin)} -or $args[2] -ne 'ci') { throw 'NPM_SCOPE_TEST_FAILED' }
  if (-not (Test-Path -LiteralPath (Join-Path $args[1] 'package-lock.json'))) { throw 'NPM_LOCK_TEST_FAILED' }
  $global:LASTEXITCODE=0
  Write-Output 'SCOPED_NPM_PROBE_OK'
}
& ${quote(path.join(root, 'scripts/install-local.ps1'))} -PackagePath ${quote(archive)} -TargetRoot ${quote(targetRoot)} -ExpectedSha256 ${quote(sha)} -Apply
`);
  const result = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { cwd: targetRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SCOPED_NPM_PROBE_OK/);
  assert.match(result.stdout, /LOCAL_INSTALL_APPLY_OK/);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'node_modules', 'sentinel'), 'utf8'), 'parent-keep');
  assert.equal(fs.readFileSync(path.join(targetPlugin, 'state', 'sentinel'), 'utf8'), 'state-keep');
  assert.equal(fs.readFileSync(path.join(targetPlugin, 'config.env'), 'utf8'), 'TELEGRAM_MODE=probe\n');
});
