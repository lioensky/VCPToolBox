'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const version = '0.1.0-rc.1';
const archiveName = `VCP-TelegramBridge-v${version}.tar.gz`;

function listTarGz(archivePath) {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readText = (start, length) => header.subarray(start, start + length)
      .toString('utf8').replace(/\0.*$/s, '');
    const name = readText(0, 100);
    const prefix = readText(345, 155);
    const sizeText = readText(124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    assert.equal(Number.isSafeInteger(size) && size >= 0, true);
    entries.push({ name: prefix ? `${prefix}/${name}` : name, size });
    offset += 512 + (Math.ceil(size / 512) * 512);
  }
  return entries;
}

function packageInto(outDir) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'package-release.js'),
    '--version', version,
    '--out-dir', outDir,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return path.join(outDir, archiveName);
}

test('release archive is deterministic, safe, complete and contains no runtime state', (t) => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-release-a-'));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-release-b-'));
  t.after(() => fs.rmSync(firstDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondDir, { recursive: true, force: true }));

  const first = packageInto(firstDir);
  const second = packageInto(secondDir);
  const firstBytes = fs.readFileSync(first);
  const secondBytes = fs.readFileSync(second);
  assert.deepEqual(firstBytes, secondBytes);

  const entries = listTarGz(first);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
  for (const required of [
    'TelegramBridge/TelegramBridge.js',
    'TelegramBridge/plugin-manifest.json',
    'TelegramBridge/config.env.example',
    'TelegramBridge/package.json',
    'TelegramBridge/package-lock.json',
    'TelegramBridge/README.md',
    'TelegramBridge/CHANGELOG.md',
    'TelegramBridge/src/config.js',
    'TelegramBridge/migrations/001_initial.sql',
    'TelegramBridge/scripts/package-release.js',
    'TelegramBridge/scripts/install-local.ps1',
    'TelegramBridge/docs/ACCEPTANCE.md',
    'TelegramBridge/docs/OPERATIONS.md',
  ]) assert.equal(names.includes(required), true, `missing ${required}`);

  for (const name of names) {
    assert.equal(path.posix.isAbsolute(name), false);
    assert.equal(name.split('/').includes('..'), false);
    assert.doesNotMatch(name, /(?:^|\/)(?:config\.env|state|node_modules|\.git|logs?|media|fixtures?)(?:\/|$)/i);
    assert.doesNotMatch(name, /(?:\.sqlite(?:3)?(?:-(?:wal|shm))?|\.log)$/i);
  }
  assert.equal(names.some((name) => name.includes('/tests/')), false);

  const expectedHash = crypto.createHash('sha256').update(firstBytes).digest('hex');
  const checksum = fs.readFileSync(`${first}.sha256`, 'utf8');
  assert.equal(checksum, `${expectedHash}  ${archiveName}\n`);
});

test('release metadata, CI and user documentation are present', () => {
  for (const relative of [
    'README.md',
    'CHANGELOG.md',
    'scripts/package-release.js',
  ]) assert.equal(fs.existsSync(path.join(root, relative)), true, `missing ${relative}`);

  const workflow = fs.readFileSync(path.resolve(root, '../../.github/workflows/telegram-bridge.yml'), 'utf8');
  assert.match(workflow, /ubuntu-latest[\s\S]*20\.20\.2/);
  assert.match(workflow, /ubuntu-latest[\s\S]*22\.21\.1/);
  assert.match(workflow, /windows-latest[\s\S]*22\.21\.1/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /npm run scan:secrets/);
});

test('release path validator rejects traversal and absolute archive names', () => {
  const { safeArchivePath } = require('../scripts/package-release');
  for (const unsafe of ['../secret', 'src/../../secret', '/absolute', 'C:\\absolute', 'src//file']) {
    assert.throws(
      () => safeArchivePath(unsafe),
      (error) => error.code === 'RELEASE_PATH_UNSAFE'
        && error.message === 'TelegramBridge release packaging failed.',
    );
  }
});
