'use strict';

const API_ORIGIN = 'https://api.telegram.org';
const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_BYTES = 19 * 1024 * 1024;
const DEFAULT_MAX_OUTBOUND_BYTES = 45 * 1024 * 1024;
const TELEGRAM_DOWNLOAD_CEILING = 20_000_000;
const TELEGRAM_UPLOAD_CEILING = 50_000_000;
const TOKEN_PATTERN = /^[1-9]\d{4,19}:[A-Za-z0-9_-]{20,200}$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const OFFSET_PATTERN = /^[1-9]\d{0,128}$/;
const PRIVATE_CHAT_ID_PATTERN = /^[1-9]\d{0,127}$/;
const FILE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const BLOB_PROTOTYPE = Blob.prototype;
const BLOB_SIZE_GETTER = Object.getOwnPropertyDescriptor(BLOB_PROTOTYPE, 'size')?.get;
const BLOB_TYPE_GETTER = Object.getOwnPropertyDescriptor(BLOB_PROTOTYPE, 'type')?.get;
const BLOB_SLICE = BLOB_PROTOTYPE.slice;

const ALLOWED_UPDATES = Object.freeze([
  'message',
  'callback_query',
  'my_chat_member',
  'stopped_message_generation',
]);

const SAFE_ERROR_FIELDS = Object.freeze([
  'method',
  'httpStatus',
  'apiErrorCode',
  'retryAfterSec',
  'retryable',
  'conflictKind',
]);

class TelegramApiError extends Error {
  constructor(code, fields = {}) {
    super('Telegram API operation failed.');
    Object.defineProperty(this, 'name', { value: 'TelegramApiError' });
    this.code = typeof code === 'string' ? code : 'TELEGRAM_INVALID_RESPONSE';
    for (const field of SAFE_ERROR_FIELDS) {
      const value = fields[field];
      if (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
      ) {
        this[field] = value;
      }
    }
    if (Error.captureStackTrace) Error.captureStackTrace(this, TelegramApiError);
  }
}

function fail(code, fields) {
  throw new TelegramApiError(code, fields);
}

function isPositiveBound(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function snapshotJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') fail('TELEGRAM_INVALID_REQUEST');
    const parsed = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    return parsed;
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    fail('TELEGRAM_INVALID_REQUEST');
  }
}

function snapshotControlOptions(value, includeMaxBytes = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  let signal;
  let timeoutMs;
  let maxBytes;
  try {
    signal = value.signal;
    timeoutMs = value.timeoutMs;
    if (includeMaxBytes) maxBytes = value.maxBytes;
  } catch {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  if (timeoutMs !== undefined && !isPositiveBound(timeoutMs)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  return includeMaxBytes
    ? { signal, timeoutMs, maxBytes }
    : { signal, timeoutMs };
}

function snapshotNativeBlob(blob) {
  if (!(blob instanceof Blob)) fail('TELEGRAM_INVALID_REQUEST');
  try {
    const size = BLOB_SIZE_GETTER.call(blob);
    const type = BLOB_TYPE_GETTER.call(blob);
    if (!Number.isSafeInteger(size) || size < 0 || typeof type !== 'string') {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    return { size, type };
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    fail('TELEGRAM_INVALID_REQUEST');
  }
}

function normalizeNativeBlob(blob, size, type) {
  try {
    const normalized = BLOB_SLICE.call(blob, 0, size, type);
    Object.setPrototypeOf(normalized, BLOB_PROTOTYPE);
    return normalized;
  } catch {
    fail('TELEGRAM_INVALID_REQUEST');
  }
}

function createAbortContext(externalSignal, timeoutMs) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  if (!isPositiveBound(timeoutMs)) fail('TELEGRAM_INVALID_REQUEST');
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    if (!controller.signal.aborted) controller.abort('external');
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort('timeout');
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get externallyAborted() { return externallyAborted; },
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function readStreamChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) {
    cancelReadable(reader);
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      cancelReadable(reader);
      finish(reject, new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function cancelReadable(readable) {
  try {
    const cancel = readable?.cancel;
    if (typeof cancel === 'function') {
      Promise.resolve(cancel.call(readable)).catch(() => {});
    }
  } catch {
    // Best effort only. Public errors must remain sanitized.
  }
}

function cancelResponseBody(response) {
  try {
    cancelReadable(response?.body);
  } catch {
    // A hostile body getter must not replace the public error either.
  }
}

async function readBoundedBytes(response, maxBytes, signal) {
  const lengthHeader = response.headers?.get?.('content-length');
  if (lengthHeader !== null && lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader)) {
      cancelResponseBody(response);
      fail('TELEGRAM_INVALID_RESPONSE');
    }
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared)) {
      cancelResponseBody(response);
      fail('TELEGRAM_INVALID_RESPONSE');
    }
    if (declared > maxBytes) {
      cancelResponseBody(response);
      fail('TELEGRAM_RESPONSE_TOO_LARGE');
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await withSignal(response.arrayBuffer(), signal));
    if (bytes.byteLength > maxBytes) fail('TELEGRAM_RESPONSE_TOO_LARGE');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('TELEGRAM_INVALID_RESPONSE');
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancellation is best effort: it may never settle, even after abort.
        cancelReadable(reader);
        fail('TELEGRAM_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* pending cancellation owns the lock */ }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function decodeJson(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail('TELEGRAM_INVALID_RESPONSE');
  }
}

async function readJsonEnvelope(response, maxBytes, method, signal) {
  const bytes = await readBoundedBytes(response, maxBytes, signal);
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    if (response.status >= 500) classifyApiError(method, response, null);
    fail('TELEGRAM_INVALID_RESPONSE', { method, httpStatus: response.status });
  }
  try {
    return decodeJson(bytes);
  } catch (error) {
    if (response.status >= 500) classifyApiError(method, response, null);
    throw error;
  }
}

function classifyApiError(method, response, envelope) {
  const apiErrorCode = Number.isInteger(envelope?.error_code)
    ? envelope.error_code
    : response.status;
  const httpStatus = Number.isInteger(response.status) ? response.status : null;
  let code = 'TELEGRAM_INVALID_RESPONSE';
  if (apiErrorCode === 401 || httpStatus === 401) code = 'TELEGRAM_AUTH';
  else if (apiErrorCode === 403 || httpStatus === 403) code = 'TELEGRAM_FORBIDDEN';
  else if (apiErrorCode === 400 || httpStatus === 400) code = 'TELEGRAM_BAD_REQUEST';
  else if (apiErrorCode === 409 || httpStatus === 409) code = 'TELEGRAM_CONFLICT';
  else if (apiErrorCode === 429 || httpStatus === 429) code = 'TELEGRAM_RATE_LIMIT';
  else if (apiErrorCode >= 500 || httpStatus >= 500) code = 'TELEGRAM_SERVER';

  let retryAfterSec = null;
  const rawRetry = envelope?.parameters?.retry_after;
  if (Number.isFinite(rawRetry) && rawRetry >= 0) retryAfterSec = Math.ceil(rawRetry);
  throw new TelegramApiError(code, {
    method,
    httpStatus,
    apiErrorCode: Number.isInteger(apiErrorCode) ? apiErrorCode : null,
    retryAfterSec,
    retryable: ['TELEGRAM_RATE_LIMIT', 'TELEGRAM_SERVER'].includes(code),
    conflictKind: code === 'TELEGRAM_CONFLICT' && method === 'getUpdates'
      ? 'duplicate_poller'
      : null,
  });
}

function validateResponseLocation(response, expectedUrl, method) {
  if (
    response?.redirected !== false
    || typeof response?.url !== 'string'
    || response.url !== expectedUrl
  ) {
    cancelResponseBody(response);
    fail('TELEGRAM_REDIRECT_REJECTED', { method });
  }
}

function validateAllowedUpdates(value) {
  if (
    !Array.isArray(value)
    || value.length !== ALLOWED_UPDATES.length
    || !ALLOWED_UPDATES.every((item, index) => value[index] === item)
  ) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  return [...ALLOWED_UPDATES];
}

function buildGetUpdatesBody({ offset, limit, timeout, allowedUpdates }) {
  if (offset !== undefined && offset !== null && (
    typeof offset !== 'string' || !OFFSET_PATTERN.test(offset)
  )) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('TELEGRAM_INVALID_REQUEST');
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50) fail('TELEGRAM_INVALID_REQUEST');
  const tail = JSON.stringify({
    limit,
    timeout,
    allowed_updates: validateAllowedUpdates(allowedUpdates),
  });
  if (offset === undefined || offset === null) return tail;
  return `{"offset":${offset},${tail.slice(1)}`;
}

function validateFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 1024) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  if (filePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(filePath)) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  const segments = filePath.split('/');
  if (
    segments.length < 2
    || segments.some((segment) => segment === '.' || segment === '..' || !FILE_SEGMENT_PATTERN.test(segment))
  ) {
    fail('TELEGRAM_INVALID_REQUEST');
  }
  return segments.map(encodeURIComponent).join('/');
}

function createTelegramClient(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('TELEGRAM_CONFIG_INVALID');
  }
  const {
    token,
    fetchImpl = globalThis.fetch,
    maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
    maxInboundBytes = DEFAULT_MAX_INBOUND_BYTES,
    maxOutboundBytes = DEFAULT_MAX_OUTBOUND_BYTES,
    requestTimeoutMs = 40_000,
    requestGraceMs = 10_000,
  } = options;
  if (
    typeof token !== 'string' || !TOKEN_PATTERN.test(token)
    || typeof fetchImpl !== 'function'
    || !isPositiveBound(maxJsonBytes)
    || !isPositiveBound(maxInboundBytes) || maxInboundBytes > TELEGRAM_DOWNLOAD_CEILING
    || !isPositiveBound(maxOutboundBytes) || maxOutboundBytes > TELEGRAM_UPLOAD_CEILING
    || !isPositiveBound(requestTimeoutMs)
    || !Number.isSafeInteger(requestGraceMs) || requestGraceMs < 0
  ) {
    fail('TELEGRAM_CONFIG_INVALID');
  }

  async function performResponse(method, url, fetchOptions, controlOptions, handleResponse) {
    const timeoutMs = controlOptions.timeoutMs ?? requestTimeoutMs;
    const abort = createAbortContext(controlOptions.signal, timeoutMs);
    try {
      if (abort.signal.aborted) fail('TELEGRAM_ABORTED', { method, retryable: false });
      const pending = Promise.resolve(fetchImpl(url, {
        ...fetchOptions,
        signal: abort.signal,
        redirect: 'error',
      }));
      // Fetch implementations may ignore cancellation. Bound the await too,
      // and dispose any response that arrives after we stopped waiting.
      void pending.then(response => {
        if (abort.signal.aborted) cancelResponseBody(response);
      }, () => {});
      const response = await withSignal(pending, abort.signal);
      if (response === null || typeof response !== 'object') {
        fail('TELEGRAM_INVALID_RESPONSE', { method });
      }
      return await handleResponse(response, abort.signal);
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (abort.timedOut) fail('TELEGRAM_TIMEOUT', { method, retryable: true });
      if (abort.externallyAborted || controlOptions.signal?.aborted) {
        fail('TELEGRAM_ABORTED', { method, retryable: false });
      }
      fail('TELEGRAM_NETWORK', { method, retryable: true });
    } finally {
      abort.cleanup();
    }
  }

  async function requestJson(method, body, controlOptions = {}) {
    if (!METHOD_PATTERN.test(method)) fail('TELEGRAM_INVALID_REQUEST');
    const control = snapshotControlOptions(controlOptions);
    const url = `${API_ORIGIN}/bot${token}/${method}`;
    return performResponse(method, url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(snapshotJsonObject(body)),
    }, control, async (response, signal) => {
      validateResponseLocation(response, url, method);
      if (response.status >= 500) {
        cancelResponseBody(response);
        classifyApiError(method, response, null);
      }
      const envelope = await readJsonEnvelope(response, maxJsonBytes, method, signal);
      if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
        fail('TELEGRAM_INVALID_RESPONSE', { method, httpStatus: response.status });
      }
      if (envelope.ok !== true || !Object.hasOwn(envelope, 'result') || !response.ok) {
        // Editing an already-matching placeholder is a successful idempotent
        // finalization, but never infer delivery from any other 400 response.
        if (method === 'editMessageText' && response.status === 400 && envelope.error_code === 400
          && /^Bad Request: message is not modified(?::|$)/.test(envelope.description)
          && typeof body?.message_id === 'string' && /^[1-9]\d*$/.test(body.message_id)
          && typeof body?.chat_id === 'string' && /^-?[1-9]\d*$/.test(body.chat_id)) {
          return { message_id: body.message_id };
        }
        classifyApiError(method, response, envelope);
      }
      return envelope.result;
    });
  }

  async function request(method, params = {}, controlOptions = {}) {
    return requestJson(method, snapshotJsonObject(params), controlOptions);
  }

  async function getMe(controlOptions = {}) {
    return request('getMe', {}, controlOptions);
  }

  async function getWebhookInfo(controlOptions = {}) {
    return request('getWebhookInfo', {}, controlOptions);
  }

  async function getUpdates(params = {}) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    let snapshot;
    try {
      snapshot = {
        offset: params.offset,
        limit: params.limit,
        timeout: params.timeout,
        allowedUpdates: params.allowedUpdates,
        signal: params.signal,
      };
    } catch {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    const timeoutMs = (snapshot.timeout * 1000) + requestGraceMs;
    return requestJson('getUpdates', buildGetUpdatesBody(snapshot), {
      signal: snapshot.signal,
      timeoutMs,
    });
  }

  async function sendMessage(params, controlOptions = {}) {
    return request('sendMessage', params, controlOptions);
  }

  async function sendMessageDraft(params, controlOptions = {}) {
    const snapshot = snapshotJsonObject(params);
    if (
      typeof snapshot.chat_id !== 'string'
      || !PRIVATE_CHAT_ID_PATTERN.test(snapshot.chat_id)
      || !Number.isSafeInteger(snapshot.draft_id)
      || snapshot.draft_id === 0
    ) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    snapshot.can_stop = true;
    snapshot.keep_on_stop = false;
    return request('sendMessageDraft', snapshot, controlOptions);
  }

  async function editMessageText(params, controlOptions = {}) {
    return request('editMessageText', params, controlOptions);
  }

  async function answerCallbackQuery(params, controlOptions = {}) {
    return request('answerCallbackQuery', params, controlOptions);
  }

  async function getFile(fileId, controlOptions = {}) {
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    return request('getFile', { file_id: fileId }, controlOptions);
  }

  async function sendChatAction(params, controlOptions = {}) {
    return request('sendChatAction', params, controlOptions);
  }

  async function sendMultipart(method, fieldName, fields, blob, filename, controlOptions = {}) {
    const allowed = Object.freeze({
      sendAnimation: 'animation',
      sendAudio: 'audio',
      sendDocument: 'document',
      sendPhoto: 'photo',
      sendVideo: 'video',
    });
    if (allowed[method] !== fieldName) fail('TELEGRAM_INVALID_REQUEST');
    const snapshot = snapshotJsonObject(fields);
    const control = snapshotControlOptions(controlOptions);
    const blobSnapshot = snapshotNativeBlob(blob);
    if (blobSnapshot.size > maxOutboundBytes) fail('TELEGRAM_INVALID_REQUEST');
    if (blobSnapshot.type !== '' && !MIME_TYPE_PATTERN.test(blobSnapshot.type)) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    if (typeof filename !== 'string' || !FILE_SEGMENT_PATTERN.test(filename)) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    if (Object.hasOwn(snapshot, fieldName)) fail('TELEGRAM_INVALID_REQUEST');
    const form = new FormData();
    let estimatedRequestBytes = blobSnapshot.size
      + Buffer.byteLength(filename, 'utf8')
      + Buffer.byteLength(blobSnapshot.type, 'utf8')
      + 65_536;
    for (const [key, value] of Object.entries(snapshot)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) fail('TELEGRAM_INVALID_REQUEST');
      const encoded = value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
      estimatedRequestBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(encoded, 'utf8') + 256;
      form.append(key, encoded);
    }
    if (estimatedRequestBytes > TELEGRAM_UPLOAD_CEILING) fail('TELEGRAM_INVALID_REQUEST');
    const normalizedBlob = normalizeNativeBlob(blob, blobSnapshot.size, blobSnapshot.type);
    form.append(fieldName, normalizedBlob, filename);
    const url = `${API_ORIGIN}/bot${token}/${method}`;
    return performResponse(method, url, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: form,
    }, control, async (response, signal) => {
      validateResponseLocation(response, url, method);
      if (response.status >= 500) {
        cancelResponseBody(response);
        classifyApiError(method, response, null);
      }
      const envelope = await readJsonEnvelope(response, maxJsonBytes, method, signal);
      if (
        envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
        || envelope.ok !== true || !Object.hasOwn(envelope, 'result') || !response.ok
      ) {
        classifyApiError(method, response, envelope);
      }
      return envelope.result;
    });
  }

  async function sendDocument(fields, blob, filename, controlOptions = {}) {
    return sendMultipart('sendDocument', 'document', fields, blob, filename, controlOptions);
  }

  async function sendPhoto(fields, blob, filename, controlOptions = {}) {
    return sendMultipart('sendPhoto', 'photo', fields, blob, filename, controlOptions);
  }

  async function sendAnimation(fields, blob, filename, controlOptions = {}) {
    return sendMultipart('sendAnimation', 'animation', fields, blob, filename, controlOptions);
  }

  async function sendAudio(fields, blob, filename, controlOptions = {}) {
    return sendMultipart('sendAudio', 'audio', fields, blob, filename, controlOptions);
  }

  async function sendVideo(fields, blob, filename, controlOptions = {}) {
    return sendMultipart('sendVideo', 'video', fields, blob, filename, controlOptions);
  }

  async function downloadFile(filePath, controlOptions = {}) {
    const safePath = validateFilePath(filePath);
    const control = snapshotControlOptions(controlOptions, true);
    const maxBytes = control.maxBytes ?? maxInboundBytes;
    if (!isPositiveBound(maxBytes) || maxBytes > TELEGRAM_DOWNLOAD_CEILING) {
      fail('TELEGRAM_INVALID_REQUEST');
    }
    const method = 'downloadFile';
    const url = `${API_ORIGIN}/file/bot${token}/${safePath}`;
    return performResponse(method, url, {
      method: 'GET',
      headers: { accept: 'application/octet-stream' },
    }, control, async (response, signal) => {
      validateResponseLocation(response, url, method);
      if (!response.ok) {
        cancelResponseBody(response);
        classifyApiError(method, response, null);
      }
      return readBoundedBytes(response, maxBytes, signal);
    });
  }

  return Object.freeze({
    answerCallbackQuery,
    downloadFile,
    editMessageText,
    getFile,
    getMe,
    getUpdates,
    getWebhookInfo,
    sendChatAction,
    sendAnimation,
    sendAudio,
    sendDocument,
    sendMessage,
    sendMessageDraft,
    sendPhoto,
    sendVideo,
  });
}

module.exports = {
  ALLOWED_UPDATES,
  TelegramApiError,
  createTelegramClient,
};
