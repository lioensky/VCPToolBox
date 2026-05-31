'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const PROTOCOL = 'codex-imagegen-relay/v1';
const DEFAULT_PROMPT_MAX_LENGTH = 8000;
const MAX_ATTEMPT = 3;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const QUEUE_DIRS = Object.freeze([
  'pending',
  'claimed',
  'artifact_ready',
  'done',
  'failed',
  'cancelled',
  'receipts',
  'assets',
  'tmp',
]);
const REQUEST_STATUSES = Object.freeze([
  'pending',
  'claimed',
  'artifact_ready',
  'done',
  'failed',
  'cancelled',
]);
const IDEMPOTENCY_ACTIVE_STATUSES = Object.freeze([
  'pending',
  'claimed',
  'artifact_ready',
  'done',
]);
const FIXED_ASSET_RETURN_DIR = 'state/codex-imagegen/assets';
const ALLOWED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SECRET_LIKE_KEYS = new Set([
  'key',
  'token',
  'password',
  'secret',
  'cookie',
  'authorization',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
]);
const SECRET_KEY_ALLOWLIST = new Set(['idempotency_key']);

class CodexImagegenRelayError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = 'CodexImagegenRelayError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

class CodexImagegenRelayQueue {
  constructor(options = {}) {
    const projectBasePath = options.projectBasePath
      ? path.resolve(options.projectBasePath)
      : path.resolve(__dirname, '..');

    this.queueRoot = path.resolve(
      options.queueRoot || path.join(projectBasePath, 'state', 'codex-imagegen')
    );
    this.promptMaxLength = Number.isInteger(options.promptMaxLength)
      ? options.promptMaxLength
      : DEFAULT_PROMPT_MAX_LENGTH;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  async initialize() {
    await Promise.all(
      QUEUE_DIRS.map((dirName) => fs.mkdir(this.getDirPath(dirName), { recursive: true }))
    );
  }

  getDirPath(dirName) {
    return path.join(this.queueRoot, dirName);
  }

  getStatusFilePath(status, requestId) {
    assertKnownStatus(status);
    assertRequestId(requestId);
    return path.join(this.getDirPath(status), `${requestId}.json`);
  }

  async createRequest(input = {}) {
    await this.initialize();
    validateNoSecretLikeKeys(input);

    const requestId = normalizeRequestId(input.request_id || createRequestId(this.now()));
    const idempotencyKey = normalizeRequestId(input.idempotency_key || requestId, 'idempotency_key');
    const mode = input.mode || 'generate';
    if (mode !== 'generate') {
      throw new CodexImagegenRelayError('unsupported_mode', 'Only mode "generate" is supported in v1.');
    }
    if (Object.prototype.hasOwnProperty.call(input, 'reference_images')) {
      throw new CodexImagegenRelayError(
        'reference_images_disabled',
        'reference_images is disabled in v1.'
      );
    }

    const prompt = normalizePrompt(input.prompt, this.promptMaxLength);
    const options = normalizeOptions(input.options || {});
    const returnSpec = normalizeReturnSpec(input.return || {});
    const request = stripUndefined({
      protocol: PROTOCOL,
      request_id: requestId,
      created_at: normalizeIsoString(input.created_at) || this.now().toISOString(),
      status: 'pending',
      source: 'vcptoolbox',
      mode,
      prompt,
      options,
      return: returnSpec,
      attempt: normalizeAttempt(input.attempt, 0),
      idempotency_key: idempotencyKey,
      negative_prompt: normalizeOptionalText(input.negative_prompt, 2000),
      user_note: normalizeOptionalText(input.user_note, 2000),
    });

    return this.withIdempotencyLock(idempotencyKey, async () => {
      const existingLocation = await this.findRequestLocation(requestId);
      if (existingLocation) {
        throw new CodexImagegenRelayError(
          'request_id_conflict',
          `Request ${requestId} already exists in ${existingLocation.status}.`,
          409,
          { request_id: requestId, status: existingLocation.status }
        );
      }

      const existing = await this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        throw new CodexImagegenRelayError(
          'idempotency_conflict',
          `Active request already exists for idempotency_key ${idempotencyKey}.`,
          409,
          { request_id: existing.request_id, status: existing.status }
        );
      }

      const targetPath = this.getStatusFilePath('pending', requestId);
      await this.atomicWriteJson(targetPath, request);
      return this.readStatusFile('pending', requestId);
    });
  }

  async listRequests(options = {}) {
    await this.initialize();
    const statuses = normalizeStatusFilter(options.status);
    const limit = normalizeLimit(options.limit, 100, 500);
    const requests = [];

    for (const status of statuses) {
      const dirPath = this.getDirPath(status);
      const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const requestId = entry.name.slice(0, -5);
        if (!REQUEST_ID_PATTERN.test(requestId)) continue;
        try {
          requests.push(await this.readStatusFile(status, requestId));
        } catch (error) {
          requests.push({
            request_id: requestId,
            status,
            directory_status: status,
            parse_error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return requests
      .sort(compareRequests)
      .slice(0, limit);
  }

  async getRequest(requestId) {
    await this.initialize();
    const location = await this.findRequestLocation(requestId);
    if (!location) {
      throw new CodexImagegenRelayError(
        'request_not_found',
        `Request ${requestId} was not found.`,
        404
      );
    }
    return this.readStatusFile(location.status, requestId);
  }

  async cancelRequest(requestId, options = {}) {
    return this.moveRequest(requestId, 'pending', 'cancelled', (record) => ({
      ...record,
      status: 'cancelled',
      cancelled_at: this.now().toISOString(),
      cancelled_by: normalizeOptionalText(options.cancelled_by, 120),
      cancel_reason: normalizeOptionalText(options.reason, 500),
    }));
  }

  async retryRequest(requestId) {
    await this.initialize();
    const failed = await this.readStatusFile('failed', requestId);
    const idempotencyKey = normalizeRequestId(
      failed.idempotency_key || requestId,
      'idempotency_key'
    );
    const retryChain = await this.findRequestsByIdempotencyKey(idempotencyKey);
    const supersedingRetry = retryChain.find(
      (request) => request.parent_request_id === failed.request_id
    );
    if (supersedingRetry) {
      throw new CodexImagegenRelayError(
        'retry_superseded',
        `Request ${requestId} already has retry ${supersedingRetry.request_id}.`,
        409,
        { request_id: supersedingRetry.request_id, status: supersedingRetry.status }
      );
    }

    const maxAttempt = retryChain.reduce(
      (highest, request) => Math.max(highest, normalizeAttempt(request.attempt, 0)),
      normalizeAttempt(failed.attempt, 0)
    );
    const nextAttempt = maxAttempt + 1;
    if (nextAttempt > MAX_ATTEMPT) {
      throw new CodexImagegenRelayError(
        'max_attempts_exceeded',
        `Request ${requestId} already reached the max attempt count.`,
        409
      );
    }

    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      throw new CodexImagegenRelayError(
        'idempotency_conflict',
        `Active request already exists for idempotency_key ${idempotencyKey}.`,
        409,
        { request_id: existing.request_id, status: existing.status }
      );
    }

    const retryId = createRequestId(this.now());
    const retryRecord = stripUndefined({
      protocol: PROTOCOL,
      request_id: retryId,
      parent_request_id: failed.request_id,
      created_at: this.now().toISOString(),
      status: 'pending',
      source: 'vcptoolbox',
      mode: 'generate',
      prompt: normalizePrompt(failed.prompt, this.promptMaxLength),
      options: normalizeOptions(failed.options || {}),
      return: normalizeReturnSpec(failed.return || {}),
      attempt: nextAttempt,
      idempotency_key: idempotencyKey,
      negative_prompt: normalizeOptionalText(failed.negative_prompt, 2000),
      user_note: normalizeOptionalText(failed.user_note, 2000),
    });

    await this.atomicWriteJson(this.getStatusFilePath('pending', retryId), retryRecord);
    return this.readStatusFile('pending', retryId);
  }

  async markSaved(requestId, options = {}) {
    const localFiles = normalizeLocalFilesInput(options.local_files || options.localFiles || options.local_file || options.localFile);
    const validatedFiles = [];
    for (const localFile of localFiles) {
      validatedFiles.push(await this.validateAssetFile(localFile));
    }

    return this.moveRequest(requestId, 'artifact_ready', 'done', (record) => ({
      ...record,
      status: 'done',
      completed_at: this.now().toISOString(),
      result: {
        ...(record.result && typeof record.result === 'object' ? record.result : {}),
        generated_by: 'codex_builtin_image_gen',
        local_files: validatedFiles,
        manual_save_required: false,
        registered_by: 'vcptoolbox',
      },
    }));
  }

  async failStaleClaim(requestId, options = {}) {
    const claimed = await this.readStatusFile('claimed', requestId);
    const expiresAt = Date.parse(claimed.claim_expires_at || '');
    const nowMs = this.now().getTime();
    if (!Number.isFinite(expiresAt) || expiresAt > nowMs) {
      throw new CodexImagegenRelayError(
        'claim_not_stale',
        `Request ${requestId} claim has not expired.`,
        409,
        { claim_expires_at: claimed.claim_expires_at || null }
      );
    }

    return this.moveRequest(requestId, 'claimed', 'failed', (record) => ({
      ...record,
      status: 'failed',
      failed_at: this.now().toISOString(),
      error: {
        code: 'STALE_CLAIM_EXPIRED',
        message: normalizeOptionalText(options.message, 500)
          || 'Claim lease expired and was manually failed by VCPToolBox.',
        retryable: true,
      },
    }));
  }

  async readStatusFile(status, requestId) {
    const filePath = this.getStatusFilePath(status, requestId);
    let record;
    try {
      record = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new CodexImagegenRelayError(
          'request_not_found',
          `Request ${requestId} was not found in ${status}.`,
          404
        );
      }
      throw error;
    }

    const fileStatus = record && typeof record.status === 'string' ? record.status : null;
    const normalized = {
      ...record,
      status,
      directory_status: status,
    };
    if (fileStatus && fileStatus !== status) {
      normalized.status_mismatch = {
        directory_status: status,
        file_status: fileStatus,
      };
    }
    return normalized;
  }

  async findRequestLocation(requestId) {
    assertRequestId(requestId);
    for (const status of REQUEST_STATUSES) {
      const filePath = this.getStatusFilePath(status, requestId);
      if (await pathExists(filePath)) {
        return { status, filePath };
      }
    }
    return null;
  }

  async findByIdempotencyKey(idempotencyKey) {
    const matches = await this.findRequestsByIdempotencyKey(
      idempotencyKey,
      IDEMPOTENCY_ACTIVE_STATUSES
    );
    return matches[0] || null;
  }

  async findRequestsByIdempotencyKey(idempotencyKey, statuses = REQUEST_STATUSES) {
    const matches = [];
    for (const status of statuses) {
      const entries = await fs.readdir(this.getDirPath(status), { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const request = await this.readStatusFile(status, entry.name.slice(0, -5));
          if (request.idempotency_key === idempotencyKey) {
            matches.push(request);
          }
        } catch {
          // A damaged active file should not crash listing; it is surfaced by listRequests.
        }
      }
    }
    return matches.sort(compareRequests);
  }

  async moveRequest(requestId, fromStatus, toStatus, mutateRecord) {
    await this.initialize();
    assertRequestId(requestId);
    const srcPath = this.getStatusFilePath(fromStatus, requestId);
    const dstPath = this.getStatusFilePath(toStatus, requestId);
    if (!(await pathExists(srcPath))) {
      throw new CodexImagegenRelayError(
        'invalid_request_state',
        `Request ${requestId} is not in ${fromStatus}.`,
        409
      );
    }
    if (await pathExists(dstPath)) {
      throw new CodexImagegenRelayError(
        'target_status_conflict',
        `Request ${requestId} already exists in ${toStatus}.`,
        409
      );
    }

    await fs.rename(srcPath, dstPath);
    const record = JSON.parse(await fs.readFile(dstPath, 'utf-8'));
    const nextRecord = mutateRecord(record);
    await fs.writeFile(dstPath, `${JSON.stringify(nextRecord, null, 2)}\n`, 'utf-8');
    return this.readStatusFile(toStatus, requestId);
  }

  async atomicWriteJson(targetPath, payload) {
    const tmpName = `${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const tmpPath = path.join(this.getDirPath('tmp'), tmpName);
    const lockPath = `${targetPath}.lock`;
    let lockHandle = null;
    let tmpCreated = false;

    try {
      lockHandle = await fs.open(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new CodexImagegenRelayError(
          'request_id_conflict',
          `Request file ${path.basename(targetPath)} is already being created.`,
          409
        );
      }
      throw error;
    }

    try {
      if (await pathExists(targetPath)) {
        throw new CodexImagegenRelayError(
          'request_id_conflict',
          `Request ${path.basename(targetPath, '.json')} already exists.`,
          409
        );
      }

      await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf-8',
        flag: 'wx',
      });
      tmpCreated = true;
      await fs.rename(tmpPath, targetPath);
      tmpCreated = false;
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
      }
      if (tmpCreated) {
        await fs.unlink(tmpPath).catch(() => {});
      }
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async withIdempotencyLock(idempotencyKey, action) {
    const lockPath = path.join(this.getDirPath('tmp'), `idempotency.${idempotencyKey}.lock`);
    let lockHandle = null;

    try {
      lockHandle = await fs.open(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new CodexImagegenRelayError(
          'idempotency_conflict',
          `Request with idempotency_key ${idempotencyKey} is already being created.`,
          409
        );
      }
      throw error;
    }

    try {
      return await action();
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => {});
      }
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async validateAssetFile(rawPath) {
    await this.initialize();
    const relativePath = normalizeAssetRelativePath(rawPath);
    const assetRoot = this.getDirPath('assets');
    const candidatePath = path.resolve(assetRoot, relativePath);
    if (!isPathInside(assetRoot, candidatePath) || candidatePath === path.resolve(assetRoot)) {
      throw new CodexImagegenRelayError(
        'unsafe_asset_path',
        'Saved file path must stay inside state/codex-imagegen/assets.',
        400
      );
    }

    const extension = path.extname(candidatePath).toLowerCase();
    if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
      throw new CodexImagegenRelayError(
        'unsupported_asset_extension',
        'Saved file extension must be .png, .jpg, .jpeg, or .webp.',
        400
      );
    }

    let realRoot;
    let realCandidate;
    try {
      realRoot = await fs.realpath(assetRoot);
      realCandidate = await fs.realpath(candidatePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new CodexImagegenRelayError(
          'asset_file_not_found',
          `Saved file does not exist: ${rawPath}`,
          400
        );
      }
      throw error;
    }

    if (!isPathInside(realRoot, realCandidate)) {
      throw new CodexImagegenRelayError(
        'unsafe_asset_symlink',
        'Saved file resolves outside state/codex-imagegen/assets.',
        400
      );
    }

    const storedRelative = toPosix(path.relative(assetRoot, candidatePath));
    return `${FIXED_ASSET_RETURN_DIR}/${storedRelative}`;
  }
}

function createCodexImagegenRelayQueue(options = {}) {
  return new CodexImagegenRelayQueue(options);
}

function createRequestId(now) {
  const date = now instanceof Date ? now : new Date();
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace('Z', '');
  return `img_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeRequestId(value, fieldName = 'request_id') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexImagegenRelayError('invalid_request_id', `${fieldName} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    throw new CodexImagegenRelayError(
      'invalid_request_id',
      `${fieldName} may contain only letters, numbers, underscore, and dash.`
    );
  }
  return trimmed;
}

function assertRequestId(value) {
  normalizeRequestId(value);
}

function assertKnownStatus(status) {
  if (!REQUEST_STATUSES.includes(status)) {
    throw new CodexImagegenRelayError('invalid_status', `Unknown request status: ${status}`);
  }
}

function normalizePrompt(value, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexImagegenRelayError('invalid_prompt', 'prompt must be a non-empty string.');
  }
  const prompt = value.trim();
  if (prompt.length > maxLength) {
    throw new CodexImagegenRelayError(
      'prompt_too_long',
      `prompt must be at most ${maxLength} characters.`
    );
  }
  return prompt;
}

function normalizeOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output = {};
  for (const key of ['size', 'quality', 'output_format']) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue;
    if (typeof value[key] !== 'string') {
      throw new CodexImagegenRelayError('invalid_options', `options.${key} must be a string.`);
    }
    output[key] = value[key].trim().slice(0, 100);
  }
  return output;
}

function normalizeReturnSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { preferred: 'file', target_dir: FIXED_ASSET_RETURN_DIR };
  }
  const targetDir = value.target_dir || value.targetDir;
  if (targetDir && toPosix(String(targetDir).trim()) !== FIXED_ASSET_RETURN_DIR) {
    throw new CodexImagegenRelayError(
      'unsupported_target_dir',
      `target_dir is fixed to ${FIXED_ASSET_RETURN_DIR} in v1.`
    );
  }
  return { preferred: 'file', target_dir: FIXED_ASSET_RETURN_DIR };
}

function normalizeAttempt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new CodexImagegenRelayError('invalid_attempt', 'attempt must be a non-negative integer.');
  }
  return number;
}

function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CodexImagegenRelayError('invalid_text_field', 'optional text fields must be strings.');
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function normalizeIsoString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CodexImagegenRelayError('invalid_created_at', 'created_at must be an ISO timestamp.');
  }
  return value;
}

function normalizeLocalFilesInput(value) {
  const files = Array.isArray(value) ? value : [value];
  const normalized = files.filter((item) => item !== undefined && item !== null && item !== '');
  if (normalized.length === 0) {
    throw new CodexImagegenRelayError('missing_local_files', 'local_files must include at least one file.');
  }
  if (normalized.length > 20) {
    throw new CodexImagegenRelayError('too_many_local_files', 'local_files may include at most 20 files.');
  }
  return normalized;
}

function normalizeAssetRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexImagegenRelayError('invalid_asset_path', 'Saved file path must be a non-empty string.');
  }

  const raw = value.trim();
  if (raw.includes('\0') || raw.startsWith('\\\\') || raw.startsWith('//') || /^[a-zA-Z]:[\\/]/.test(raw) || path.isAbsolute(raw)) {
    throw new CodexImagegenRelayError('unsafe_asset_path', 'Saved file path must be relative.');
  }

  let normalized = toPosix(raw).replace(/^\/+/, '');
  const prefix = `${FIXED_ASSET_RETURN_DIR}/`;
  if (normalized === FIXED_ASSET_RETURN_DIR) {
    throw new CodexImagegenRelayError('invalid_asset_path', 'Saved file path must reference a file.');
  }
  if (normalized.startsWith(prefix)) {
    normalized = normalized.slice(prefix.length);
  }

  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new CodexImagegenRelayError('unsafe_asset_path', 'Saved file path must not traverse directories.');
  }

  return segments.join(path.sep);
}

function normalizeStatusFilter(value) {
  if (!value) return REQUEST_STATUSES;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const statuses = items.map((item) => String(item).trim()).filter(Boolean);
  for (const status of statuses) {
    assertKnownStatus(status);
  }
  return statuses;
}

function normalizeLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new CodexImagegenRelayError('invalid_limit', 'limit must be a positive integer.');
  }
  return Math.min(number, max);
}

function validateNoSecretLikeKeys(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNoSecretLikeKeys(item, pathParts.concat(String(index))));
    return;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!SECRET_KEY_ALLOWLIST.has(lower) && SECRET_LIKE_KEYS.has(lower)) {
      throw new CodexImagegenRelayError(
        'secret_like_field_rejected',
        `Request field "${pathParts.concat(key).join('.')}" is not allowed.`
      );
    }
    validateNoSecretLikeKeys(childValue, pathParts.concat(key));
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(basePath, candidatePath) {
  const base = normalizePathCase(path.resolve(basePath));
  const candidate = normalizePathCase(path.resolve(candidatePath));
  return candidate === base || candidate.startsWith(base + path.sep);
}

function normalizePathCase(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function stripUndefined(value) {
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) {
      output[key] = item;
    }
  }
  return output;
}

function compareRequests(a, b) {
  const aTime = Date.parse(a.created_at || a.completed_at || a.failed_at || a.cancelled_at || '') || 0;
  const bTime = Date.parse(b.created_at || b.completed_at || b.failed_at || b.cancelled_at || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(a.request_id || '').localeCompare(String(b.request_id || ''));
}

module.exports = {
  PROTOCOL,
  FIXED_ASSET_RETURN_DIR,
  REQUEST_STATUSES,
  CodexImagegenRelayError,
  CodexImagegenRelayQueue,
  createCodexImagegenRelayQueue,
  createRequestId,
  normalizeAssetRelativePath,
  validateNoSecretLikeKeys,
};
