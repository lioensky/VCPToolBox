// modules/toolCallRecordStore.js
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const Database = require('better-sqlite3');
const { isInternalToolCall } = require('./toolCallRecordInternalFilter');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'tool-call-records.config.json');
const DB_PATH = path.join(CONFIG_DIR, 'tool-call-records.sqlite3');

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  retentionDays: 30,
  autoCleanupEnabled: true,
  cleanupIntervalMinutes: 1440,
  maxQueryLimit: 100,
  defaultQueryLimit: 20,
  captureMultimodal: true,
  summarizeLargePayloadsInList: true,
  listPayloadPreviewChars: 1200,
  excludeTools: ['ToolCallRecordQuery'],
  __description: {
    enabled: '工具调用记录总开关。开启后会记录工具名、调用者署名、发起/返回时间、调用内容、返回内容、成功失败与记录ID。',
    retentionDays: '记录保留天数。<=0 表示不按时间过期。',
    autoCleanupEnabled: '是否按 cleanupIntervalMinutes 自动清理过期记录。',
    cleanupIntervalMinutes: '自动清理周期，单位分钟。',
    maxQueryLimit: '查询接口允许的最大返回条数。',
    defaultQueryLimit: '查询未指定 limit 时的默认返回条数。',
    captureMultimodal: '是否保存包含 image_url/data URI 等多模态返回内容。关闭后会保存脱敏摘要。',
    summarizeLargePayloadsInList: '列表查询时是否对调用内容/返回内容做预览截断，详情查询不截断。',
    listPayloadPreviewChars: '列表查询预览截断字符数。',
    excludeTools: '不记录的工具名列表，默认避免查询器自查询污染记录。'
  }
});

let db = null;
let config = { ...DEFAULT_CONFIG };
let watcher = null;
let cleanupTimer = null;
let initialized = false;
let lastLoadError = null;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function writeDefaultConfigIfMissing() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  }
}

function normalizeInteger(value, fallback, min = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.floor(parsed);
  return min === null ? integer : Math.max(min, integer);
}

function normalizeConfig(raw) {
  const next = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return next;

  next.enabled = raw.enabled === true;
  next.retentionDays = normalizeInteger(raw.retentionDays, DEFAULT_CONFIG.retentionDays);
  next.autoCleanupEnabled = raw.autoCleanupEnabled !== false;
  next.cleanupIntervalMinutes = normalizeInteger(raw.cleanupIntervalMinutes, DEFAULT_CONFIG.cleanupIntervalMinutes, 1);
  next.maxQueryLimit = normalizeInteger(raw.maxQueryLimit, DEFAULT_CONFIG.maxQueryLimit, 1);
  next.defaultQueryLimit = normalizeInteger(raw.defaultQueryLimit, DEFAULT_CONFIG.defaultQueryLimit, 1);
  next.defaultQueryLimit = Math.min(next.defaultQueryLimit, next.maxQueryLimit);
  next.captureMultimodal = raw.captureMultimodal !== false;
  next.summarizeLargePayloadsInList = raw.summarizeLargePayloadsInList !== false;
  next.listPayloadPreviewChars = normalizeInteger(raw.listPayloadPreviewChars, DEFAULT_CONFIG.listPayloadPreviewChars, 100);
  next.excludeTools = Array.isArray(raw.excludeTools)
    ? raw.excludeTools.map(item => String(item || '').trim()).filter(Boolean)
    : [...DEFAULT_CONFIG.excludeTools];
  next.__description = DEFAULT_CONFIG.__description;

  return next;
}

function loadConfig() {
  writeDefaultConfigIfMissing();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = normalizeConfig(raw);
    lastLoadError = null;
    scheduleCleanup();
    return getConfig();
  } catch (error) {
    lastLoadError = error;
    console.error('[ToolCallRecordStore] Failed to load config:', error.message);
    config = { ...DEFAULT_CONFIG };
    scheduleCleanup();
    return getConfig();
  }
}

function saveConfig(patchOrFullConfig) {
  const merged = normalizeConfig({ ...config, ...(patchOrFullConfig || {}) });
  config = merged;
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  scheduleCleanup();
  return getConfig();
}

function getConfig() {
  return JSON.parse(JSON.stringify(config));
}

function getStatus() {
  return {
    initialized,
    enabled: config.enabled === true,
    configPath: CONFIG_PATH,
    dbPath: DB_PATH,
    watcherActive: !!watcher,
    autoCleanupEnabled: config.autoCleanupEnabled === true,
    retentionDays: config.retentionDays,
    cleanupIntervalMinutes: config.cleanupIntervalMinutes,
    lastLoadError: lastLoadError ? lastLoadError.message : null
  };
}

function initDb() {
  ensureConfigDir();
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_records (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      caller_signature TEXT,
      caller_type TEXT,
      request_ip TEXT,
      source_node TEXT,
      started_at TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at TEXT,
      finished_at_ms INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      call_content_json TEXT NOT NULL,
      return_content_json TEXT,
      error_text TEXT,
      has_multimodal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_call_records_started_at_ms ON tool_call_records(started_at_ms);
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_tool_name ON tool_call_records(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_caller_signature ON tool_call_records(caller_signature);
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_status ON tool_call_records(status);
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_success ON tool_call_records(success);
  `);

  return db;
}

function startWatcher() {
  if (watcher) return;
  watcher = chokidar.watch(CONFIG_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });
  watcher.on('add', () => {
    console.log('[ToolCallRecordStore] Config file added, reloading.');
    loadConfig();
  });
  watcher.on('change', () => {
    console.log('[ToolCallRecordStore] Config file changed, reloading.');
    loadConfig();
  });
  watcher.on('unlink', () => {
    console.warn('[ToolCallRecordStore] Config file removed, recreating defaults.');
    writeDefaultConfigIfMissing();
    loadConfig();
  });
  watcher.on('error', error => console.error('[ToolCallRecordStore] watcher error:', error.message));
}

function initialize() {
  if (initialized) return getStatus();
  writeDefaultConfigIfMissing();
  loadConfig();
  initDb();
  startWatcher();
  initialized = true;
  if (config.autoCleanupEnabled) {
    cleanupExpired().catch(error => console.error('[ToolCallRecordStore] Initial cleanup failed:', error.message));
  }
  console.log(`[ToolCallRecordStore] Initialized. db=${DB_PATH}, config=${CONFIG_PATH}, enabled=${config.enabled}`);
  return getStatus();
}

function shutdown() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  initialized = false;
}

function scheduleCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (!config.autoCleanupEnabled) return;
  const intervalMs = Math.max(1, config.cleanupIntervalMinutes) * 60 * 1000;
  cleanupTimer = setInterval(() => {
    cleanupExpired().catch(error => console.error('[ToolCallRecordStore] Scheduled cleanup failed:', error.message));
  }, intervalMs);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function nowIso(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const timezoneOffsetMinutes = date.getTimezoneOffset();
  const offsetSign = timezoneOffsetMinutes > 0 ? '-' : '+';
  const offsetHours = pad(Math.floor(Math.abs(timezoneOffsetMinutes) / 60));
  const offsetMinutes = pad(Math.abs(timezoneOffsetMinutes) % 60);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

function createId() {
  const crypto = require('crypto');
  return `tcr-${Date.now()}-${crypto.randomUUID()}`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      __serialization_error: error.message,
      valuePreview: String(value).slice(0, 2000)
    });
  }
}

function containsMultimodal(value) {
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return typeof node === 'string' && /^data:image\//i.test(node);
    }
    if (seen.has(node)) return false;
    seen.add(node);

    if (node.type === 'image_url' || node.image_url) return true;
    if (typeof node.url === 'string' && /^data:image\//i.test(node.url)) return true;

    if (Array.isArray(node)) return node.some(visit);
    return Object.values(node).some(visit);
  };
  return visit(value);
}

function redactMultimodal(value) {
  const seen = new WeakSet();
  const redact = (node) => {
    if (typeof node === 'string') {
      if (/^data:image\//i.test(node)) return '[Multimodal data URI omitted by tool-call-records config]';
      return node;
    }
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return '[Circular]';
    seen.add(node);

    if (Array.isArray(node)) return node.map(redact);
    const next = {};
    for (const [key, child] of Object.entries(node)) {
      if ((key === 'url' || key === 'image_url') && typeof child === 'string' && /^data:image\//i.test(child)) {
        next[key] = '[Multimodal data URI omitted by tool-call-records config]';
      } else {
        next[key] = redact(child);
      }
    }
    return next;
  };
  return redact(value);
}

function shouldRecord(toolName, args = {}) {
  initialize();
  if (!config.enabled) return false;
  if (config.excludeTools.includes(toolName)) return false;
  if (isInternalToolCall({ toolName, args })) return false;
  return true;
}

function detectCaller(args = {}) {
  const maid = typeof args.maid === 'string' && args.maid.trim() ? args.maid.trim() : null;
  const valet = typeof args.valet === 'string' && args.valet.trim() ? args.valet.trim() : null;
  if (maid) return { callerSignature: maid, callerType: 'maid' };
  if (valet) return { callerSignature: valet, callerType: 'valet' };
  return { callerSignature: null, callerType: null };
}

function beginRecord({ toolName, args, requestIp = null, sourceNode = null }) {
  if (!shouldRecord(toolName, args)) return null;

  const startedDate = new Date();
  const id = createId();
  const { callerSignature, callerType } = detectCaller(args);
  const callContent = {
    tool_name: toolName,
    arguments: args || {}
  };

  const database = initDb();
  database.prepare(`
    INSERT INTO tool_call_records (
      id, tool_name, caller_signature, caller_type, request_ip, source_node,
      started_at, started_at_ms, status, success, call_content_json, has_multimodal, created_at, updated_at
    ) VALUES (
      @id, @toolName, @callerSignature, @callerType, @requestIp, @sourceNode,
      @startedAt, @startedAtMs, 'running', 0, @callContentJson, @hasMultimodal, @startedAt, @startedAt
    )
  `).run({
    id,
    toolName,
    callerSignature,
    callerType,
    requestIp,
    sourceNode,
    startedAt: nowIso(startedDate),
    startedAtMs: startedDate.getTime(),
    callContentJson: safeJsonStringify(callContent),
    hasMultimodal: containsMultimodal(callContent) ? 1 : 0
  });

  return {
    id,
    toolName,
    startedAt: nowIso(startedDate),
    startedAtMs: startedDate.getTime()
  };
}

function finishRecord(recordHandle, { success, result = null, error = null }) {
  if (!recordHandle || !recordHandle.id) return null;

  const finishedDate = new Date();
  let returnContent = result;
  const hasReturnMultimodal = containsMultimodal(returnContent);
  if (hasReturnMultimodal && !config.captureMultimodal) {
    returnContent = redactMultimodal(returnContent);
  }

  const status = success ? 'success' : 'failure';
  const errorText = error ? (error instanceof Error ? error.message : String(error)) : null;
  const durationMs = finishedDate.getTime() - recordHandle.startedAtMs;

  const database = initDb();
  database.prepare(`
    UPDATE tool_call_records
    SET finished_at = @finishedAt,
        finished_at_ms = @finishedAtMs,
        duration_ms = @durationMs,
        status = @status,
        success = @success,
        return_content_json = @returnContentJson,
        error_text = @errorText,
        has_multimodal = CASE WHEN has_multimodal = 1 OR @hasMultimodal = 1 THEN 1 ELSE 0 END,
        updated_at = @finishedAt
    WHERE id = @id
  `).run({
    id: recordHandle.id,
    finishedAt: nowIso(finishedDate),
    finishedAtMs: finishedDate.getTime(),
    durationMs,
    status,
    success: success ? 1 : 0,
    returnContentJson: safeJsonStringify(returnContent),
    errorText,
    hasMultimodal: hasReturnMultimodal ? 1 : 0
  });

  return recordHandle.id;
}

function parseJsonField(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    return { __parse_error: error.message, raw: value };
  }
}

function preview(value, maxChars) {
  if (!config.summarizeLargePayloadsInList) return value;
  const text = typeof value === 'string' ? value : safeJsonStringify(value);
  if (text.length <= maxChars) return value;
  return {
    __preview: true,
    truncated: true,
    chars: text.length,
    preview: text.slice(0, maxChars)
  };
}

function normalizeQueryOptions(options = {}) {
  const limit = Math.min(
    normalizeInteger(options.limit, config.defaultQueryLimit, 1),
    config.maxQueryLimit
  );
  const offset = normalizeInteger(options.offset, 0, 0);
  return { ...options, limit, offset };
}

function buildWhere(options = {}) {
  const clauses = [];
  const params = {};

  if (options.id) {
    clauses.push('id = @id');
    params.id = String(options.id);
  }
  if (options.toolName) {
    clauses.push('tool_name LIKE @toolName');
    params.toolName = `%${String(options.toolName)}%`;
  }
  if (options.callerSignature) {
    clauses.push('caller_signature LIKE @callerSignature');
    params.callerSignature = `%${String(options.callerSignature)}%`;
  }
  if (options.callerType) {
    clauses.push('caller_type = @callerType');
    params.callerType = String(options.callerType);
  }
  if (options.status) {
    clauses.push('status = @status');
    params.status = String(options.status);
  }
  if (options.success !== undefined && options.success !== null && options.success !== '') {
    clauses.push('success = @success');
    params.success = options.success === true || options.success === 'true' || options.success === 1 || options.success === '1' ? 1 : 0;
  }
  if (options.from) {
    const fromMs = new Date(options.from).getTime();
    if (Number.isFinite(fromMs)) {
      clauses.push('started_at_ms >= @fromMs');
      params.fromMs = fromMs;
    }
  }
  if (options.to) {
    const toMs = new Date(options.to).getTime();
    if (Number.isFinite(toMs)) {
      clauses.push('started_at_ms <= @toMs');
      params.toMs = toMs;
    }
  }
  if (options.search) {
    clauses.push(`(
      id LIKE @search OR
      tool_name LIKE @search OR
      caller_signature LIKE @search OR
      call_content_json LIKE @search OR
      return_content_json LIKE @search OR
      error_text LIKE @search
    )`);
    params.search = `%${String(options.search)}%`;
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function rowToRecord(row, { detail = false } = {}) {
  const callContent = parseJsonField(row.call_content_json);
  const returnContent = parseJsonField(row.return_content_json);
  const maxChars = config.listPayloadPreviewChars;

  return {
    id: row.id,
    toolName: row.tool_name,
    callerSignature: row.caller_signature,
    callerType: row.caller_type,
    requestIp: row.request_ip,
    sourceNode: row.source_node,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status,
    success: row.success === 1,
    callContent: detail ? callContent : preview(callContent, maxChars),
    returnContent: detail ? returnContent : preview(returnContent, maxChars),
    errorText: row.error_text,
    hasMultimodal: row.has_multimodal === 1
  };
}

function queryRecords(options = {}) {
  initialize();
  const normalized = normalizeQueryOptions(options);
  const { whereSql, params } = buildWhere(normalized);
  const order = String(normalized.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const database = initDb();

  const total = database.prepare(`SELECT COUNT(*) AS count FROM tool_call_records ${whereSql}`).get(params).count;
  const rows = database.prepare(`
    SELECT * FROM tool_call_records
    ${whereSql}
    ORDER BY started_at_ms ${order}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: normalized.limit, offset: normalized.offset });

  return {
    status: 'success',
    total,
    limit: normalized.limit,
    offset: normalized.offset,
    records: rows.map(row => rowToRecord(row, { detail: normalized.detail === true || normalized.detail === 'true' }))
  };
}

function getRecordById(id) {
  initialize();
  const row = initDb().prepare('SELECT * FROM tool_call_records WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  return rowToRecord(row, { detail: true });
}

async function cleanupExpired() {
  initialize();
  const retentionDays = Number(config.retentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { status: 'success', deleted: 0, skipped: true, reason: 'retentionDays<=0' };
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const info = initDb().prepare('DELETE FROM tool_call_records WHERE started_at_ms < ?').run(cutoffMs);
  return {
    status: 'success',
    deleted: info.changes || 0,
    cutoff: new Date(cutoffMs).toISOString(),
    retentionDays
  };
}

async function clearAll() {
  initialize();
  const info = initDb().prepare('DELETE FROM tool_call_records').run();
  return { status: 'success', deleted: info.changes || 0 };
}

module.exports = {
  initialize,
  shutdown,
  getConfig,
  saveConfig,
  getStatus,
  beginRecord,
  finishRecord,
  queryRecords,
  getRecordById,
  cleanupExpired,
  clearAll,
  CONFIG_PATH,
  DB_PATH
};