'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ROOT_FILES = Object.freeze([
  'CHANGELOG.md',
  'README.md',
  'TelegramBridge.js',
  'config.env.example',
  'package-lock.json',
  'package.json',
  'plugin-manifest.json',
]);
const SOURCE_DIRECTORIES = Object.freeze(['docs', 'migrations', 'scripts', 'src']);
const BLOCKED_COMPONENTS = new Set([
  '.git', 'fixtures', 'fixture', 'logs', 'log', 'media', 'node_modules', 'state', 'tests',
]);

class ReleaseError extends Error {
  constructor(code) {
    super('TelegramBridge release packaging failed.');
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseError(code);
}

function safeArchivePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') fail('RELEASE_PATH_UNSAFE');
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) fail('RELEASE_PATH_UNSAFE');
  return normalized;
}

function isBlocked(relativePath) {
  const normalized = safeArchivePath(relativePath);
  const components = normalized.toLowerCase().split('/');
  const basename = components.at(-1);
  return components.some((component) => BLOCKED_COMPONENTS.has(component))
    || basename === 'config.env'
    || basename.startsWith('config.env.')
    || basename.startsWith('.env')
    || /\.sqlite(?:3)?(?:-(?:wal|shm|journal))?$/.test(basename)
    || /\.(?:log|bak|backup|tmp|tar|tgz|zip|gz)$/.test(basename);
}

function collectDirectory(root, relativeDirectory, files) {
  const directory = path.resolve(root, relativeDirectory);
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RELEASE_SOURCE_UNSAFE');
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const relativePath = safeArchivePath(path.posix.join(
      relativeDirectory.replace(/\\/g, '/'),
      entry.name,
    ));
    if (isBlocked(relativePath)) continue;
    const candidate = path.resolve(root, ...relativePath.split('/'));
    const relativeToRoot = path.relative(root, candidate);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) fail('RELEASE_PATH_UNSAFE');
    const candidateStat = fs.lstatSync(candidate);
    if (candidateStat.isSymbolicLink()) fail('RELEASE_SOURCE_UNSAFE');
    if (candidateStat.isDirectory()) collectDirectory(root, relativePath, files);
    else if (candidateStat.isFile()) files.push(relativePath);
    else fail('RELEASE_SOURCE_UNSAFE');
  }
}

function collectReleaseFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  for (const relativePath of ROOT_FILES) {
    const candidate = path.join(resolvedRoot, relativePath);
    if (!fs.existsSync(candidate)) fail('RELEASE_REQUIRED_FILE_MISSING');
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('RELEASE_SOURCE_UNSAFE');
    files.push(safeArchivePath(relativePath));
  }
  for (const directory of SOURCE_DIRECTORIES) collectDirectory(resolvedRoot, directory, files);
  return Object.freeze([...new Set(files)].sort());
}

function writeText(buffer, offset, length, value) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) fail('RELEASE_PATH_TOO_LONG');
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) fail('RELEASE_FILE_TOO_LARGE');
  writeText(buffer, offset, length, `${encoded}\0`);
}

function splitTarPath(archivePath) {
  const safe = safeArchivePath(archivePath);
  if (Buffer.byteLength(safe) <= 100) return { name: safe, prefix: '' };
  for (let index = safe.lastIndexOf('/'); index > 0; index = safe.lastIndexOf('/', index - 1)) {
    const prefix = safe.slice(0, index);
    const name = safe.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail('RELEASE_PATH_TOO_LONG');
}

function tarHeader(archivePath, size) {
  if (!Number.isSafeInteger(size) || size < 0) fail('RELEASE_FILE_TOO_LARGE');
  const { name, prefix } = splitTarPath(archivePath);
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function buildTar(root, files) {
  const chunks = [];
  for (const relativePath of files) {
    const archivePath = safeArchivePath(`TelegramBridge/${relativePath}`);
    const data = fs.readFileSync(path.resolve(root, ...relativePath.split('/')));
    chunks.push(tarHeader(archivePath, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createRelease({ root, outDir, version }) {
  if (!VERSION_PATTERN.test(version)) fail('RELEASE_VERSION_INVALID');
  const resolvedRoot = path.resolve(root);
  const resolvedOutDir = path.resolve(outDir);
  const files = collectReleaseFiles(resolvedRoot);
  const archiveName = `VCP-TelegramBridge-v${version}.tar.gz`;
  const archive = zlib.gzipSync(buildTar(resolvedRoot, files), { level: 9, mtime: 0 });
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  fs.mkdirSync(resolvedOutDir, { recursive: true });
  fs.writeFileSync(path.join(resolvedOutDir, archiveName), archive, { mode: 0o600 });
  fs.writeFileSync(
    path.join(resolvedOutDir, `${archiveName}.sha256`),
    `${digest}  ${archiveName}\n`,
    { mode: 0o600 },
  );
  return Object.freeze({ archiveName, checksumName: `${archiveName}.sha256`, digest, files });
}

function parseArguments(argv) {
  let version;
  let outDir = path.resolve(__dirname, '..', 'dist');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--version' && version === undefined) version = argv[++index];
    else if (argument === '--out-dir') outDir = argv[++index];
    else fail('RELEASE_ARGUMENT_INVALID');
  }
  if (typeof version !== 'string' || typeof outDir !== 'string') fail('RELEASE_ARGUMENT_INVALID');
  return { version, outDir };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = createRelease({ root: path.resolve(__dirname, '..'), ...options });
    process.stdout.write(`Created ${result.archiveName}\nCreated ${result.checksumName}\n`);
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : 'RELEASE_UNEXPECTED_FAILURE';
    process.stderr.write(`TelegramBridge release packaging failed (${code}).\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ ReleaseError, collectReleaseFiles, createRelease, safeArchivePath });
