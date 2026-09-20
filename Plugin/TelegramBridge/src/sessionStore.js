'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('./sqliteRuntime').getSqliteDatabase();

const { MigrationError, loadMigrations, runMigrations } = require('./migrationRunner');
const { createUpdateLedgerForDatabase } = require('./updateLedger');

const DATABASE_FILENAME = 'telegram.sqlite3';
const STORAGE_SUFFIXES = Object.freeze(['', '-wal', '-shm', '-journal']);
const AGENT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CHAT_ID_PATTERN = /^-?[1-9]\d*$/;
const THREAD_ID_PATTERN = /^(?:0|[1-9]\d*)$/;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MESSAGE_ID_PATTERN = /^[1-9]\d*$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const SENSITIVE_KINDS = new Set(['auth_code', 'approval_callback', 'approval_payload']);

class SessionStoreError extends Error {
  constructor(code) {
    super('Telegram state operation failed.');
    Object.defineProperty(this, 'name', { value: 'SessionStoreError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SessionStoreError);
  }
}

function fail(code) {
  throw new SessionStoreError(code);
}

function ensurePositiveBound(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isContained(root, target, allowEqual = false) {
  const relative = path.relative(root, target);
  if (relative === '') return allowEqual;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function nearestExistingAncestor(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function samePhysicalPath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function verifyStorageObject(context, suffix, required = false) {
  const target = `${context.databasePath}${suffix}`;
  const metadata = lstatIfPresent(target);
  if (!metadata) {
    if (required) fail('STATE_PATH_INVALID');
    return false;
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
  ) {
    fail('STATE_PATH_INVALID');
  }
  const physicalTarget = fs.realpathSync.native(target);
  if (!isContained(context.physicalRoot, physicalTarget, false)) fail('STATE_PATH_INVALID');
  return true;
}

function hardenStoragePermissions(context) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(context.lexicalState, 0o700);
    for (const suffix of STORAGE_SUFFIXES) {
      const target = `${context.databasePath}${suffix}`;
      if (verifyStorageObject(context, suffix, false)) fs.chmodSync(target, 0o600);
    }
  } catch {
    fail('STATE_PATH_INVALID');
  }
}

function revalidateSafeStatePath(context, requireDatabase = false) {
  // Node exposes no openat-style directory handle that better-sqlite3 can reuse.
  // Pre-open, immediate post-open, and post-migration checks narrow the practical
  // same-user TOCTOU window without deleting or following unexpected sidecars.
  try {
    const currentRoot = fs.realpathSync.native(context.lexicalRoot);
    const currentState = fs.realpathSync.native(context.lexicalState);
    if (
      !samePhysicalPath(currentRoot, context.physicalRoot)
      || !samePhysicalPath(currentState, context.physicalState)
      || !isContained(currentRoot, currentState, false)
      || !fs.statSync(context.lexicalState).isDirectory()
    ) {
      fail('STATE_PATH_INVALID');
    }
    for (const suffix of STORAGE_SUFFIXES) {
      verifyStorageObject(context, suffix, requireDatabase && suffix === '');
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    fail('STATE_PATH_INVALID');
  }
}

function resolveSafeStatePath(pluginRootInput, stateDirInput) {
  if (typeof pluginRootInput !== 'string' || typeof stateDirInput !== 'string') {
    fail('STATE_PATH_INVALID');
  }

  const lexicalRoot = path.resolve(pluginRootInput);
  const lexicalState = path.isAbsolute(stateDirInput)
    ? path.resolve(stateDirInput)
    : path.resolve(lexicalRoot, stateDirInput);
  if (!isContained(lexicalRoot, lexicalState, false)) fail('STATE_PATH_INVALID');

  let physicalRoot;
  try {
    if (!fs.statSync(lexicalRoot).isDirectory()) fail('STATE_PATH_INVALID');
    physicalRoot = fs.realpathSync.native(lexicalRoot);
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    fail('STATE_PATH_INVALID');
  }

  const ancestor = nearestExistingAncestor(lexicalState);
  if (ancestor === null) fail('STATE_PATH_INVALID');
  try {
    const physicalAncestor = fs.realpathSync.native(ancestor);
    if (!isContained(physicalRoot, physicalAncestor, true)) fail('STATE_PATH_INVALID');
    fs.mkdirSync(lexicalState, { recursive: true, mode: 0o700 });
    const physicalState = fs.realpathSync.native(lexicalState);
    if (
      !isContained(physicalRoot, physicalState, false)
      || !fs.statSync(lexicalState).isDirectory()
    ) {
      fail('STATE_PATH_INVALID');
    }
    const databasePath = path.join(lexicalState, DATABASE_FILENAME);
    const context = {
      lexicalRoot,
      lexicalState,
      physicalRoot,
      physicalState,
      databasePath,
      mainExisted: Boolean(lstatIfPresent(databasePath)),
    };
    revalidateSafeStatePath(context, false);
    hardenStoragePermissions(context);
    return Object.freeze(context);
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    fail('STATE_PATH_INVALID');
  }
}

function validateClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('STATE_WRITE_FAILED');
  return value;
}

function validateUuid(randomUUID) {
  const value = randomUUID();
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    fail('STATE_WRITE_FAILED');
  }
  return value;
}

function validateScopeInput(chatId, threadId, agent) {
  if (typeof chatId !== 'string' || !CHAT_ID_PATTERN.test(chatId)) fail('SCOPE_INVALID');
  if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) fail('SCOPE_INVALID');
  if (typeof agent !== 'string' || !AGENT_PATTERN.test(agent)) fail('SCOPE_INVALID');
}

function scopeKeyFor(chatId, threadId, agent) {
  return `telegram:${chatId}:${threadId}:${agent}`;
}

function mapScope(row) {
  if (!row) return null;
  return {
    key: row.scope_key,
    chatId: row.chat_id,
    threadId: row.thread_id,
    currentAgent: row.current_agent,
    conversationId: row.conversation_id,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertNoSensitiveKind(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (typeof value.kind === 'string' && SENSITIVE_KINDS.has(value.kind)) {
    fail('HISTORY_SENSITIVE');
  }
  for (const child of Object.values(value)) assertNoSensitiveKind(child, seen);
}

function prepareTurn(turnId, messages, limits) {
  if (typeof turnId !== 'string' || !TURN_ID_PATTERN.test(turnId)) fail('HISTORY_INVALID');
  if (!Array.isArray(messages) || messages.length === 0) fail('HISTORY_INVALID');
  if (messages.length > limits.maxMessages) fail('HISTORY_TURN_TOO_LARGE');

  const prepared = [];
  let totalBytes = 0;
  for (let position = 0; position < messages.length; position += 1) {
    const message = messages[position];
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      fail('HISTORY_INVALID');
    }
    let transformedMessage;
    try {
      const serializedMessage = JSON.stringify(message);
      if (typeof serializedMessage !== 'string') fail('HISTORY_INVALID');
      transformedMessage = JSON.parse(serializedMessage);
      if (
        transformedMessage === null
        || typeof transformedMessage !== 'object'
        || Array.isArray(transformedMessage)
      ) {
        fail('HISTORY_INVALID');
      }
      assertNoSensitiveKind(transformedMessage);
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('HISTORY_INVALID');
    }
    const {
      role,
      content: transformedContent,
      telegramMessageId = null,
    } = transformedMessage;
    if (!ROLES.has(role)) fail('HISTORY_INVALID');
    if (
      telegramMessageId !== null
      && (typeof telegramMessageId !== 'string' || !MESSAGE_ID_PATTERN.test(telegramMessageId))
    ) {
      fail('HISTORY_INVALID');
    }
    const contentJson = JSON.stringify(transformedContent);
    if (typeof contentJson !== 'string') fail('HISTORY_INVALID');
    const envelopeJson = JSON.stringify({
      role,
      content: transformedContent,
      telegramMessageId,
    });
    const contentBytes = Buffer.byteLength(envelopeJson, 'utf8');
    totalBytes += contentBytes;
    prepared.push({
      role,
      contentJson,
      contentBytes,
      telegramMessageId,
      position,
    });
  }
  if (totalBytes > limits.maxBytes) fail('HISTORY_TURN_TOO_LARGE');
  return prepared;
}

function checkIntegrity(database) {
  try {
    const quickRows = database.prepare('PRAGMA quick_check(1)').all();
    if (
      quickRows.length !== 1
      || Object.values(quickRows[0]).length !== 1
      || Object.values(quickRows[0])[0] !== 'ok'
    ) {
      fail('STATE_INTEGRITY_FAILED');
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      fail('STATE_INTEGRITY_FAILED');
    }
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    fail('STATE_INTEGRITY_FAILED');
  }
}

function configureDatabase(database) {
  try {
    const journalMode = database.pragma('journal_mode = WAL', { simple: true });
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (
      String(journalMode).toLowerCase() !== 'wal'
      || database.pragma('synchronous', { simple: true }) !== 2
      || database.pragma('foreign_keys', { simple: true }) !== 1
      || database.pragma('busy_timeout', { simple: true }) !== 5000
    ) {
      fail('STATE_INTEGRITY_FAILED');
    }
    return 'wal';
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    fail('STATE_INTEGRITY_FAILED');
  }
}

function createSessionStore(options) {
  if (options === null || typeof options !== 'object') fail('STATE_CONFIG_INVALID');
  const {
    stateDir,
    pluginRoot,
    defaultAgent,
    historyMaxMessages,
    historyMaxBytes,
    DatabaseImpl = Database,
    clock = Date.now,
    randomUUID = crypto.randomUUID,
  } = options;
  if (
    typeof defaultAgent !== 'string'
    || !AGENT_PATTERN.test(defaultAgent)
    || !ensurePositiveBound(historyMaxMessages)
    || !ensurePositiveBound(historyMaxBytes)
    || typeof DatabaseImpl !== 'function'
    || typeof clock !== 'function'
    || typeof randomUUID !== 'function'
  ) {
    fail('STATE_CONFIG_INVALID');
  }

  let database = null;
  let healthy = false;
  let schemaVersion = null;
  let journalMode = null;
  let storageContext = null;

  function requireOpen() {
    if (!database || !database.open || !healthy) fail('STATE_NOT_OPEN');
    return database;
  }

  function close() {
    if (database && database.open) {
      try {
        database.close();
      } catch {
        if (database.open) fail('STATE_CLOSE_FAILED');
        database = null;
        storageContext = null;
        healthy = false;
        schemaVersion = null;
        journalMode = null;
        fail('STATE_CLOSE_FAILED');
      }
    }
    database = null;
    storageContext = null;
    healthy = false;
    schemaVersion = null;
    journalMode = null;
  }

  function open() {
    if (database && database.open && healthy) return;
    if (database && database.open) fail('STATE_CLOSE_FAILED');
    const context = resolveSafeStatePath(pluginRoot, stateDir);
    const existed = context.mainExisted;
    let candidate;
    try {
      candidate = new DatabaseImpl(context.databasePath);
      database = candidate;
      storageContext = context;
      revalidateSafeStatePath(context, true);
      hardenStoragePermissions(context);
      if (existed) checkIntegrity(candidate);
      journalMode = configureDatabase(candidate);
      revalidateSafeStatePath(context, true);
      hardenStoragePermissions(context);
      const migrations = loadMigrations(path.resolve(__dirname, '..', 'migrations'));
      runMigrations(candidate, migrations, { now: clock });
      checkIntegrity(candidate);
      revalidateSafeStatePath(context, true);
      hardenStoragePermissions(context);
      schemaVersion = candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
      healthy = true;
    } catch (error) {
      healthy = false;
      schemaVersion = null;
      journalMode = null;
      if (candidate && candidate.open) {
        try {
          candidate.close();
        } catch {
          if (candidate.open) {
            database = candidate;
            storageContext = context;
            fail('STATE_CLOSE_FAILED');
          }
        }
      }
      database = null;
      storageContext = null;
      if (error instanceof SessionStoreError || error instanceof MigrationError) throw error;
      fail('STATE_OPEN_FAILED');
    }
  }

  function getStatus() {
    return {
      open: Boolean(database && database.open),
      healthy,
      schemaVersion,
      journalMode,
    };
  }

  function createUpdateLedger() {
    return createUpdateLedgerForDatabase(requireOpen(), { clock });
  }

  function getActiveScope({ chatId, threadId = '0' } = {}) {
    validateScopeInput(chatId, threadId, defaultAgent);
    const db = requireOpen();
    try {
      return mapScope(db.prepare(`
        SELECT * FROM scopes
        WHERE chat_id = ? AND thread_id = ? AND is_active = 1
      `).get(chatId, threadId));
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_READ_FAILED');
    }
  }

  function getOrCreateScope(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('SCOPE_INVALID');
    const { chatId, threadId = '0' } = input;
    const hasExplicitAgent = Object.prototype.hasOwnProperty.call(input, 'agent');
    const agent = hasExplicitAgent ? input.agent : defaultAgent;
    validateScopeInput(chatId, threadId, agent);
    const db = requireOpen();
    const key = scopeKeyFor(chatId, threadId, agent);
    try {
      const transaction = db.transaction(() => {
        if (!hasExplicitAgent) {
          const active = db.prepare(`
            SELECT * FROM scopes
            WHERE chat_id = ? AND thread_id = ? AND is_active = 1
          `).get(chatId, threadId);
          if (active) return active;
        }
        let row = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(key);
        if (!row) {
          const active = db.prepare(`
            SELECT scope_key FROM scopes
            WHERE chat_id = ? AND thread_id = ? AND is_active = 1
          `).get(chatId, threadId);
          const now = validateClock(clock);
          db.prepare(`
            INSERT INTO scopes (
              scope_key, chat_id, thread_id, current_agent, conversation_id,
              is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(key, chatId, threadId, agent, validateUuid(randomUUID), active ? 0 : 1, now, now);
          row = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(key);
        }
        return row;
      });
      return mapScope(transaction.immediate());
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }

  function switchAgent(scopeKey, agent) {
    if (typeof scopeKey !== 'string' || !AGENT_PATTERN.test(agent)) fail('SCOPE_INVALID');
    const db = requireOpen();
    try {
      const transaction = db.transaction(() => {
        const source = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(scopeKey);
        if (!source) fail('SCOPE_NOT_FOUND');
        const targetKey = scopeKeyFor(source.chat_id, source.thread_id, agent);
        let target = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(targetKey);
        const now = validateClock(clock);
        db.prepare(`
          UPDATE scopes SET is_active = 0, updated_at = ?
          WHERE chat_id = ? AND thread_id = ? AND is_active = 1
        `).run(now, source.chat_id, source.thread_id);
        if (!target) {
          db.prepare(`
            INSERT INTO scopes (
              scope_key, chat_id, thread_id, current_agent, conversation_id,
              is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            targetKey,
            source.chat_id,
            source.thread_id,
            agent,
            validateUuid(randomUUID),
            now,
            now,
          );
        } else {
          db.prepare('UPDATE scopes SET is_active = 1, updated_at = ? WHERE scope_key = ?')
            .run(now, targetKey);
        }
        target = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(targetKey);
        return target;
      });
      return mapScope(transaction.immediate());
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }

  function startNewConversation(scopeKey) {
    if (typeof scopeKey !== 'string') fail('SCOPE_INVALID');
    const db = requireOpen();
    try {
      const transaction = db.transaction(() => {
        const scope = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(scopeKey);
        if (!scope) fail('SCOPE_NOT_FOUND');
        const conversationId = validateUuid(randomUUID);
        const now = validateClock(clock);
        db.prepare('DELETE FROM messages WHERE scope_key = ?').run(scopeKey);
        db.prepare(`
          UPDATE scopes SET conversation_id = ?, updated_at = ? WHERE scope_key = ?
        `).run(conversationId, now, scopeKey);
        return db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(scopeKey);
      });
      return mapScope(transaction.immediate());
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }

  function appendTurn({ scopeKey, turnId, messages } = {}) {
    if (typeof scopeKey !== 'string') fail('SCOPE_INVALID');
    const prepared = prepareTurn(turnId, messages, {
      maxMessages: historyMaxMessages,
      maxBytes: historyMaxBytes,
    });
    const db = requireOpen();
    try {
      const transaction = db.transaction(() => {
        const scope = db.prepare('SELECT * FROM scopes WHERE scope_key = ?').get(scopeKey);
        if (!scope) fail('SCOPE_NOT_FOUND');
        const next = db.prepare(`
          SELECT COALESCE(MAX(turn_seq), -1) + 1 AS next_turn
          FROM messages WHERE scope_key = ? AND conversation_id = ?
        `).get(scopeKey, scope.conversation_id).next_turn;
        const insert = db.prepare(`
          INSERT INTO messages (
            message_id, scope_key, conversation_id, turn_id, turn_seq, position,
            role, content_json, content_bytes, telegram_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const message of prepared) {
          insert.run(
            validateUuid(randomUUID),
            scopeKey,
            scope.conversation_id,
            turnId,
            next,
            message.position,
            message.role,
            message.contentJson,
            message.contentBytes,
            message.telegramMessageId,
            validateClock(clock),
          );
        }

        const turns = db.prepare(`
          SELECT turn_seq, COUNT(*) AS message_count, SUM(content_bytes) AS byte_count
          FROM messages
          WHERE scope_key = ? AND conversation_id = ?
          GROUP BY turn_seq
          ORDER BY turn_seq DESC
        `).all(scopeKey, scope.conversation_id);
        let keptMessages = 0;
        let keptBytes = 0;
        const remove = [];
        let overflowed = false;
        for (const turn of turns) {
          if (
            overflowed
            || keptMessages + turn.message_count > historyMaxMessages
            || keptBytes + turn.byte_count > historyMaxBytes
          ) {
            overflowed = true;
            remove.push(turn.turn_seq);
          } else {
            keptMessages += turn.message_count;
            keptBytes += turn.byte_count;
          }
        }
        if (remove.length > 0) {
          const placeholders = remove.map(() => '?').join(', ');
          db.prepare(`
            DELETE FROM messages
            WHERE scope_key = ? AND conversation_id = ? AND turn_seq IN (${placeholders})
          `).run(scopeKey, scope.conversation_id, ...remove);
        }
        db.prepare('UPDATE scopes SET updated_at = ? WHERE scope_key = ?')
          .run(validateClock(clock), scopeKey);
      });
      transaction.immediate();
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }

  function getHistory(scopeKey) {
    if (typeof scopeKey !== 'string') fail('SCOPE_INVALID');
    const db = requireOpen();
    try {
      const scope = db.prepare('SELECT conversation_id FROM scopes WHERE scope_key = ?').get(scopeKey);
      if (!scope) fail('SCOPE_NOT_FOUND');
      return db.prepare(`
        SELECT message_id, turn_id, turn_seq, position, role, content_json,
               content_bytes, telegram_message_id, created_at
        FROM messages
        WHERE scope_key = ? AND conversation_id = ?
        ORDER BY turn_seq, position
      `).all(scopeKey, scope.conversation_id).map((row) => ({
        messageId: row.message_id,
        turnId: row.turn_id,
        turnSeq: row.turn_seq,
        position: row.position,
        role: row.role,
        content: JSON.parse(row.content_json),
        contentBytes: row.content_bytes,
        telegramMessageId: row.telegram_message_id,
        createdAt: row.created_at,
      }));
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      fail('STATE_READ_FAILED');
    }
  }

  return Object.freeze({
    open,
    close,
    getStatus,
    getOrCreateScope,
    switchAgent,
    startNewConversation,
    appendTurn,
    getHistory,
    getActiveScope,
    createUpdateLedger,
  });
}

module.exports = {
  SessionStoreError,
  createSessionStore,
};
