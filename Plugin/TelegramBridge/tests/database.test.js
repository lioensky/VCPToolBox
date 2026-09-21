const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const projectPackage = require('../package.json');
const sqlitePackage = require('better-sqlite3/package.json');

function parseVersion(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `invalid semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const wildcard = comparator.match(/^(\d+)\.x$/);
  if (wildcard) {
    return version[0] === Number(wildcard[1]);
  }

  const bounded = comparator.match(/^(>=|>|<=|<)(\d+(?:\.\d+){0,2})$/);
  assert.ok(bounded, `unsupported engine comparator: ${comparator}`);
  const targetParts = bounded[2].split('.').map(Number);
  while (targetParts.length < 3) targetParts.push(0);
  const comparison = compareVersions(version, targetParts);
  return {
    '>=': comparison >= 0,
    '>': comparison > 0,
    '<=': comparison <= 0,
    '<': comparison < 0,
  }[bounded[1]];
}

function satisfiesEngineRange(versionText, range) {
  const version = parseVersion(versionText);
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.every((comparator) => satisfiesComparator(version, comparator));
  });
}

test('better-sqlite3 opens an in-memory database and executes SELECT 1', () => {
  const database = new Database(':memory:');

  try {
    const row = database.prepare('SELECT 1 AS value').get();
    assert.deepEqual(row, { value: 1 });
  } finally {
    database.close();
  }

  assert.equal(database.open, false);
});

test('WAL-safe SQLite runtime is pinned and reports a fixed SQLite core', () => {
  assert.equal(sqlitePackage.version, '12.9.0');

  const database = new Database(':memory:');
  try {
    const { sqliteVersion } = database
      .prepare('SELECT sqlite_version() AS sqliteVersion')
      .get();
    assert.ok(
      compareVersions(parseVersion(sqliteVersion), [3, 51, 3]) >= 0,
      `SQLite ${sqliteVersion} must be at least 3.51.3`,
    );
  } finally {
    database.close();
  }
});

test('Node 20.20.2 and 22.21.1 satisfy project and native package engines', () => {
  for (const version of ['20.20.2', '22.21.1']) {
    assert.equal(
      satisfiesEngineRange(version, projectPackage.engines.node),
      true,
      `Node ${version} is outside the validated project range`,
    );
    assert.equal(
      satisfiesEngineRange(version, sqlitePackage.engines.node),
      true,
      `Node ${version} is outside better-sqlite3 engines`,
    );
  }

  assert.equal(
    satisfiesEngineRange(process.version, projectPackage.engines.node),
    true,
    `Executing Node ${process.version} is outside the validated project range`,
  );
});
