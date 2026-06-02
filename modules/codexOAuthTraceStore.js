'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TRACES = 20;
const DEFAULT_TRACE_FILE = path.join('state', 'oauth-auth', 'codex-oauth-traces.json');

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function createTraceId() {
  return `codex_oauth_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeMetadata(metadata = {}) {
  const result = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === undefined) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = value;
    }
  }
  return result;
}

class CodexOAuthTraceStore {
  constructor(options = {}) {
    this.maxTraces = Number.isInteger(options.maxTraces) && options.maxTraces > 0
      ? options.maxTraces
      : DEFAULT_MAX_TRACES;
    this.filePath = options.filePath || null;
    this.traces = [];
    this.loadFromDisk();
  }

  startTrace(metadata = {}) {
    this.loadFromDisk();
    const trace = {
      traceId: metadata.traceId || createTraceId(),
      provider: 'codex_oauth',
      startedAt: nowIso(),
      finishedAt: null,
      durationMs: null,
      ok: null,
      status: null,
      errorCode: null,
      message: '',
      metadata: sanitizeMetadata(metadata),
      events: [],
      _startedMs: nowMs(),
    };
    this.traces.unshift(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.length = this.maxTraces;
    }
    this.saveToDisk();
    return trace.traceId;
  }

  addEvent(traceId, stage, metadata = {}) {
    this.loadFromDisk();
    const trace = this.findMutable(traceId);
    if (!trace) return null;
    trace.events.push({
      at: nowIso(),
      stage,
      ...sanitizeMetadata(metadata),
    });
    this.saveToDisk();
    return trace;
  }

  finishTrace(traceId, result = {}) {
    this.loadFromDisk();
    const trace = this.findMutable(traceId);
    if (!trace) return null;
    trace.finishedAt = nowIso();
    trace.durationMs = Math.max(0, nowMs() - trace._startedMs);
    trace.ok = Boolean(result.ok);
    trace.status = Number.isInteger(result.status) ? result.status : trace.status;
    trace.errorCode = result.errorCode || null;
    trace.message = result.message || '';
    this.saveToDisk();
    return trace;
  }

  listRecent(limit = this.maxTraces) {
    this.loadFromDisk();
    return this.traces.slice(0, limit).map(trace => {
      const { _startedMs, ...publicTrace } = trace;
      return {
        ...publicTrace,
        metadata: { ...publicTrace.metadata },
        events: publicTrace.events.map(event => ({ ...event })),
      };
    });
  }

  getLatest() {
    return this.listRecent(1)[0] || null;
  }

  findMutable(traceId) {
    if (!traceId) return null;
    return this.traces.find(trace => trace.traceId === traceId) || null;
  }

  loadFromDisk() {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '[]');
      if (!Array.isArray(parsed)) return;
      this.traces = parsed
        .filter(trace => trace && typeof trace.traceId === 'string')
        .slice(0, this.maxTraces)
        .map(trace => ({
          traceId: trace.traceId,
          provider: 'codex_oauth',
          startedAt: trace.startedAt || '',
          finishedAt: trace.finishedAt || null,
          durationMs: Number.isInteger(trace.durationMs) ? trace.durationMs : null,
          ok: typeof trace.ok === 'boolean' ? trace.ok : null,
          status: Number.isInteger(trace.status) ? trace.status : null,
          errorCode: trace.errorCode || null,
          message: typeof trace.message === 'string' ? trace.message : '',
          metadata: sanitizeMetadata(trace.metadata),
          events: Array.isArray(trace.events)
            ? trace.events.map(event => ({
              at: event.at || '',
              stage: typeof event.stage === 'string' ? event.stage : '',
              ...sanitizeMetadata(event),
            })).filter(event => event.stage)
            : [],
          _startedMs: Date.parse(trace.startedAt) || nowMs(),
        }));
    } catch (_error) {}
  }

  saveToDisk() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const serializable = this.traces.slice(0, this.maxTraces).map(trace => {
        const { _startedMs, ...publicTrace } = trace;
        return {
          ...publicTrace,
          metadata: { ...publicTrace.metadata },
          events: publicTrace.events.map(event => ({ ...event })),
        };
      });
      fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
    } catch (_error) {}
  }
}

function resolveTraceStorePath(projectBasePath = path.resolve(__dirname, '..')) {
  return path.join(projectBasePath, DEFAULT_TRACE_FILE);
}

function createCodexOAuthTraceStore(options = {}) {
  const projectBasePath = options.projectBasePath || path.resolve(__dirname, '..');
  return new CodexOAuthTraceStore({
    maxTraces: options.maxTraces,
    filePath: options.filePath || (options.projectBasePath ? resolveTraceStorePath(projectBasePath) : null),
  });
}

const defaultCodexOAuthTraceStore = createCodexOAuthTraceStore();

module.exports = {
  CodexOAuthTraceStore,
  createCodexOAuthTraceStore,
  createTraceId,
  defaultCodexOAuthTraceStore,
  resolveTraceStorePath,
};
