'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function nativeUnavailable(error) {
  if (!error || /^SQLITE(?:_|$)/.test(error.code)) return false;
  if (error.code === 'ERR_DLOPEN_FAILED') return true;
  if (error.code === 'MODULE_NOT_FOUND') {
    return /Cannot find module ['"](?:better-sqlite3(?:\/package\.json)?|[^'"]*better_sqlite3\.node)['"]/i.test(error.message);
  }
  return /NODE_MODULE_VERSION|not a valid Win32|invalid ELF|Could not locate the bindings file/i.test(error.message);
}

function selectSqlite(loadLocal, loadProject) {
  let Database;
  let probe;
  try {
    Database = loadLocal();
    probe = new Database(':memory:');
  } catch (error) {
    if (!nativeUnavailable(error)) throw error;
    Database = loadProject();
    probe = new Database(':memory:');
  }
  // Closing is outside the fallback boundary: an opened database already loaded
  // its native module. Preserve a close failure and retry cleanup if still open.
  try {
    probe.close();
  } catch (error) {
    try { if (probe.open !== false) probe.close(); } catch { /* Keep the first error. */ }
    throw error;
  }
  return Database;
}

function loadSqlite(runtimeRequire, requiredVersion) {
  const manifest = runtimeRequire.resolve('better-sqlite3/package.json');
  const sqlitePackage = runtimeRequire(manifest);
  if (sqlitePackage.name !== 'better-sqlite3') {
    throw Object.assign(new Error('SQLite runtime source must be the better-sqlite3 package'), {
      code: 'SQLITE_RUNTIME_PACKAGE_INVALID',
    });
  }
  if (sqlitePackage.version !== requiredVersion) {
    throw Object.assign(new Error(`SQLite runtime requires better-sqlite3@${requiredVersion}; found ${sqlitePackage.version}`), {
      code: 'SQLITE_RUNTIME_VERSION_MISMATCH',
    });
  }
  const packageRoot = path.dirname(fs.realpathSync(manifest));
  const entry = fs.realpathSync(runtimeRequire.resolve('better-sqlite3'));
  const relative = path.relative(packageRoot, entry);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('SQLite runtime entry must be inside its validated package root'), {
      code: 'SQLITE_RUNTIME_PACKAGE_INVALID',
    });
  }
  return runtimeRequire(entry);
}

let cached;
function getSqliteDatabase() {
  if (!cached) {
    const requiredVersion = require('../package.json').dependencies?.['better-sqlite3'];
    if (typeof requiredVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(requiredVersion)) {
      throw Object.assign(new Error('TelegramBridge must pin an exact better-sqlite3 version'), {
        code: 'SQLITE_RUNTIME_VERSION_MISMATCH',
      });
    }
    cached = selectSqlite(() => loadSqlite(require, requiredVersion), () => {
      const projectManifest = path.resolve(__dirname, '../../../package.json');
      const projectRequire = createRequire(projectManifest);
      if (projectRequire(projectManifest).name !== 'vcptoolbox') {
        throw Object.assign(new Error('SQLite fallback requires the VCPToolBox project root'), {
          code: 'SQLITE_RUNTIME_PROJECT_INVALID',
        });
      }
      return loadSqlite(projectRequire, requiredVersion);
    });
  }
  return cached;
}

module.exports = { getSqliteDatabase, selectSqlite };
