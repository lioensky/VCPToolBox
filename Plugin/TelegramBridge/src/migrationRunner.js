'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
  ) STRICT
`;

class MigrationError extends Error {
  constructor(code) {
    super('Telegram state migration failed.');
    Object.defineProperty(this, 'name', { value: 'MigrationError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, MigrationError);
  }
}

function fail(code) {
  throw new MigrationError(code);
}

function firstStatementKeywords(sql) {
  const keywords = [];
  let index = 0;
  let statementStart = true;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !['\r', '\n'].includes(sql[index])) index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (["'", '"', '`'].includes(character)) {
      const quote = character;
      statementStart = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === '[') {
      statementStart = false;
      index += 1;
      while (index < sql.length && sql[index] !== ']') index += 1;
      index = Math.min(index + 1, sql.length);
      continue;
    }
    if (character === ';') {
      statementStart = true;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (statementStart && /[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1;
      keywords.push(sql.slice(start, index).toUpperCase());
      statementStart = false;
      continue;
    }
    statementStart = false;
    index += 1;
  }
  return keywords;
}

function assertMigrationSqlSafe(sql) {
  if (
    typeof sql !== 'string'
    || firstStatementKeywords(sql).some((keyword) => (
      ['BEGIN', 'COMMIT', 'ROLLBACK', 'END'].includes(keyword)
    ))
  ) {
    fail('STATE_MIGRATION_INVALID');
  }
}

function snapshotMigrationDescriptors(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    fail('STATE_MIGRATION_INVALID');
  }
  const snapshots = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === null || typeof descriptor !== 'object') fail('STATE_MIGRATION_INVALID');
    let version;
    let name;
    let sql;
    let checksum;
    try {
      version = descriptor.version;
      name = descriptor.name;
      sql = descriptor.sql;
      checksum = descriptor.checksum;
    } catch {
      fail('STATE_MIGRATION_INVALID');
    }
    if (!Number.isSafeInteger(version) || version !== index + 1 || version > 999) {
      fail('STATE_MIGRATION_INVALID');
    }
    const nameMatch = typeof name === 'string'
      ? /^(\d{3})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/.exec(name)
      : null;
    if (!nameMatch || Number(nameMatch[1]) !== version) fail('STATE_MIGRATION_INVALID');
    assertMigrationSqlSafe(sql);
    const expectedChecksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    if (typeof checksum !== 'string' || checksum !== expectedChecksum) {
      fail('STATE_MIGRATION_INVALID');
    }
    snapshots.push(Object.freeze({ version, name, sql, checksum }));
  }
  return Object.freeze(snapshots);
}

function loadMigrations(migrationsDir) {
  let entries;
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    fail('STATE_MIGRATION_INVALID');
  }

  const descriptors = [];
  const versions = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(\d{3})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/.exec(entry.name);
    if (!match) fail('STATE_MIGRATION_INVALID');
    const version = Number(match[1]);
    if (version < 1 || versions.has(version)) fail('STATE_MIGRATION_INVALID');
    versions.add(version);

    let sql;
    try {
      sql = fs.readFileSync(path.join(migrationsDir, entry.name), 'utf8');
    } catch {
      fail('STATE_MIGRATION_INVALID');
    }
    assertMigrationSqlSafe(sql);
    descriptors.push(Object.freeze({
      version,
      name: entry.name,
      sql,
      checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex'),
    }));
  }

  descriptors.sort((left, right) => left.version - right.version);
  return snapshotMigrationDescriptors(descriptors);
}

function validateApplied(applied, descriptors) {
  if (applied.length > descriptors.length) fail('STATE_MIGRATION_INVALID');
  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index];
    const descriptor = descriptors[index];
    if (
      row.version !== descriptor.version
      || row.name !== descriptor.name
      || row.checksum !== descriptor.checksum
    ) {
      fail('STATE_MIGRATION_INVALID');
    }
  }
}

function runMigrations(database, descriptors, options = {}) {
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') fail('STATE_MIGRATION_INVALID');
  const snapshots = snapshotMigrationDescriptors(descriptors);

  try {
    const migrate = database.transaction(() => {
      database.exec(MIGRATION_TABLE_SQL);
      const applied = database.prepare(`
        SELECT version, name, checksum
        FROM schema_migrations
        ORDER BY version
      `).all();
      validateApplied(applied, snapshots);

      const insert = database.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const descriptor of snapshots.slice(applied.length)) {
        const appliedAt = now();
        if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) {
          fail('STATE_MIGRATION_INVALID');
        }
        database.exec(descriptor.sql);
        insert.run(descriptor.version, descriptor.name, descriptor.checksum, appliedAt);
      }
    });
    migrate.immediate();
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('STATE_MIGRATION_FAILED');
  }
}

module.exports = {
  MigrationError,
  loadMigrations,
  runMigrations,
};
