'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const entryPointPath = path.resolve(process.argv[2]);
const statePath = path.join(path.dirname(entryPointPath), 'state');

function snapshotPath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { exists: false, entries: [] };
  }

  const entries = [];

  function visit(currentPath, relativePath) {
    const stats = fs.lstatSync(currentPath);
    const entry = {
      path: relativePath || '.',
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };

    if (stats.isDirectory()) {
      entry.type = 'directory';
      entries.push(entry);
      const children = fs.readdirSync(currentPath).sort();
      for (const child of children) {
        visit(
          path.join(currentPath, child),
          relativePath ? path.join(relativePath, child) : child,
        );
      }
      return;
    }

    if (stats.isSymbolicLink()) {
      entry.type = 'symlink';
      entry.target = fs.readlinkSync(currentPath);
      entries.push(entry);
      return;
    }

    entry.type = 'file';
    entry.sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(currentPath))
      .digest('hex');
    entries.push(entry);
  }

  visit(targetPath, '');
  return { exists: true, entries };
}

async function main() {
  const beforeRequire = snapshotPath(statePath);
  const originalGlobals = {
    fetch: global.fetch,
    queueMicrotask: global.queueMicrotask,
    setImmediate: global.setImmediate,
    setInterval: global.setInterval,
    setTimeout: global.setTimeout,
  };
  const forbidden = (name) => () => {
    throw new Error(`FORBIDDEN_BOOTSTRAP_SIDE_EFFECT:${name}`);
  };

  global.fetch = forbidden('fetch');
  global.queueMicrotask = forbidden('queueMicrotask');
  global.setImmediate = forbidden('setImmediate');
  global.setInterval = forbidden('setInterval');
  global.setTimeout = forbidden('setTimeout');

  try {
    delete require.cache[require.resolve(entryPointPath)];
    const plugin = require(entryPointPath);
    const afterRequire = snapshotPath(statePath);
    assert.deepEqual(afterRequire, beforeRequire);

    const dependencies = new Proxy({}, {
      get(_target, property) {
        throw new Error(`FORBIDDEN_BOOTSTRAP_DEPENDENCY:${String(property)}`);
      },
    });

    await plugin.initialize({ TELEGRAM_MODE: 'disabled' }, dependencies);
    await plugin.shutdown();
    await plugin.shutdown();

    const afterLifecycle = snapshotPath(statePath);
    assert.deepEqual(afterLifecycle, beforeRequire);
  } finally {
    Object.assign(global, originalGlobals);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
