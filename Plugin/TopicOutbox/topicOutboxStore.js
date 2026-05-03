const fs = require('fs').promises;
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

class TopicOutboxStore {
  constructor(options = {}) {
    this.storePath = options.storePath;
    this.backupOnWrite = options.backupOnWrite !== false;
    this.data = null;
    this._queue = Promise.resolve();
  }

  async initialize() {
    if (!this.storePath || typeof this.storePath !== 'string') {
      throw new Error('TopicOutbox storePath is required.');
    }

    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    this.data = await this._loadData();
    return this;
  }

  async transaction(mutator, options = {}) {
    const persist = options.persist !== false;

    const run = this._queue.then(async () => {
      if (!this.data) {
        await this.initialize();
      }

      const result = await mutator(this.data);

      if (persist) {
        await this._persist(this.data);
      }

      return cloneJson(result);
    });

    this._queue = run.catch(() => undefined);
    return run;
  }

  async getRequest(topicRequestId) {
    return this.transaction(data => {
      return data.requests.find(item => item.topicRequestId === topicRequestId) || null;
    }, { persist: false });
  }

  async listRequests(filter = {}) {
    return this.transaction(data => {
      const limit = normalizeLimit(filter.limit, 50, 500);
      let rows = data.requests.slice();

      if (filter.status) {
        rows = rows.filter(item => item.status === filter.status);
      }
      if (filter.maid) {
        rows = rows.filter(item => item.maid === filter.maid);
      }
      if (filter.operation) {
        rows = rows.filter(item => item.operation === filter.operation);
      }

      rows.sort((a, b) => {
        const aTime = Date.parse(a.createdAt || 0) || 0;
        const bTime = Date.parse(b.createdAt || 0) || 0;
        return bTime - aTime;
      });

      return rows.slice(0, limit);
    }, { persist: false });
  }

  async getStats() {
    return this.transaction(data => {
      const byStatus = {};
      for (const item of data.requests) {
        byStatus[item.status] = (byStatus[item.status] || 0) + 1;
      }
      return {
        total: data.requests.length,
        byStatus
      };
    }, { persist: false });
  }

  async _loadData() {
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      return normalizeData(JSON.parse(content));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return normalizeData(null);
      }
      throw new Error(`Failed to load TopicOutbox store: ${error.message}`);
    }
  }

  async _persist(data) {
    const normalized = normalizeData(data);
    normalized.updatedAt = nowIso();

    const targetDir = path.dirname(this.storePath);
    await fs.mkdir(targetDir, { recursive: true });

    if (this.backupOnWrite) {
      try {
        await fs.copyFile(this.storePath, `${this.storePath}.bak`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    const tempPath = path.join(targetDir, `.${path.basename(this.storePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
    await fs.rename(tempPath, this.storePath);
    this.data = normalized;
  }
}

function normalizeData(input) {
  const data = Array.isArray(input)
    ? { version: 1, requests: input }
    : (input && typeof input === 'object' ? input : {});

  return {
    version: Number.isInteger(data.version) ? data.version : 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : nowIso(),
    requests: Array.isArray(data.requests) ? data.requests : []
  };
}

function normalizeLimit(value, defaultValue, maxValue) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

module.exports = {
  TopicOutboxStore,
  cloneJson,
  nowIso
};
