'use strict';

const { createVcpVisibleTextFilter } = require('./vcpVisibleTextFilter');
const { normalizeVcpRichText } = require('./richTextNormalizer');

const PLACEHOLDER_OPEN = '\uE000';
const PLACEHOLDER_CLOSE = '\uE001';
const LANGUAGE_PATTERN = /^[A-Za-z0-9_+-]{1,32}$/;

function escapeTelegramHtml(value) {
  if (typeof value !== 'string') throw new TypeError('Text must be a string.');
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeSource(value) {
  return value.replace(/[\uE000\uE001]/g, '\uFFFD');
}

function safeLink(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username !== ''
    || parsed.password !== ''
  ) return null;
  return parsed.href;
}

function renderTelegramHtml(value) {
  if (typeof value !== 'string') throw new TypeError('Text must be a string.');
  let source = sanitizeSource(value);
  const tokens = [];
  const protect = (html) => {
    const token = `${PLACEHOLDER_OPEN}${tokens.length}${PLACEHOLDER_CLOSE}`;
    tokens.push(html);
    return token;
  };

  source = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, rawLanguage, content) => {
    const language = rawLanguage.trim();
    const className = language !== '' && LANGUAGE_PATTERN.test(language)
      ? ` class="language-${language}"`
      : '';
    return protect(`<pre><code${className}>${escapeTelegramHtml(content)}</code></pre>`);
  });
  source = source.replace(/`([^`\n]+)`/g, (_match, content) => (
    protect(`<code>${escapeTelegramHtml(content)}</code>`)
  ));
  source = source.replace(
    /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+?)\)/g,
    (_match, label, target) => {
    const url = safeLink(target);
    if (!url) return protect(escapeTelegramHtml(label));
    return protect(`<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`);
    },
  );

  let rendered = escapeTelegramHtml(source);
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  rendered = rendered.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  rendered = rendered.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
    (_match, index) => tokens[Number(index)] ?? '',
  );
  return rendered;
}

function graphemes(value) {
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
      .map((entry) => entry.segment);
  }
  return Array.from(value);
}

function splitPlainText(value, maxChars) {
  const units = graphemes(value);
  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (unit.length > maxChars) throw new TypeError('A grapheme exceeds the Telegram segment limit.');
    if (current !== '' && current.length + unit.length > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += unit;
  }
  if (current !== '') chunks.push(current);
  if (chunks.length === 0) chunks.push('');
  return chunks;
}

function sanitizePlainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 1024 * 1024)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF]/g, '\uFFFD')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeVisibleDocument(value) {
  try {
    return normalizeVcpRichText(value);
  } catch {
    return Object.freeze({
      text: '回复格式暂时无法解析，请换一种格式重试。',
      media: Object.freeze([]),
      detectedRichText: false,
    });
  }
}

function buildTelegramSegments(value, options = {}) {
  if (typeof value !== 'string') throw new TypeError('Text must be a string.');
  const maxChars = options.maxChars ?? 4096;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 4096) {
    throw new TypeError('Invalid Telegram segment limit.');
  }
  if (value.length <= maxChars) {
    return Object.freeze([Object.freeze({
      text: renderTelegramHtml(value),
      plainText: value,
      parseMode: 'HTML',
    })]);
  }
  return Object.freeze(splitPlainText(value, maxChars).map((text) => Object.freeze({
    text,
    plainText: text,
    parseMode: null,
  })));
}

const STREAM_ERROR_MESSAGE = 'Telegram stream rendering failed.';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHAT_ID_PATTERN = /^-?[1-9]\d*$/;
const THREAD_ID_PATTERN = /^(?:0|[1-9]\d*)$/;

class StreamRendererError extends Error {
  constructor(code) {
    super(STREAM_ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'StreamRendererError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, StreamRendererError);
  }
}

function streamFail(code) {
  throw new StreamRendererError(code);
}

function requireMethod(record, key) {
  let value;
  try { value = record?.[key]; } catch { streamFail('STREAM_CONFIG_INVALID'); }
  if (typeof value !== 'function') streamFail('STREAM_CONFIG_INVALID');
  return value.bind(record);
}

function waitWithSignal(promise, signal) {
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new StreamRendererError('STREAM_PREVIEW_ABORTED'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

function createTelegramPeerLimiter({ clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof clock !== 'function' || typeof sleep !== 'function') streamFail('STREAM_CONFIG_INVALID');
  const timestamps = [];
  let cooldownUntil = 0;

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) streamFail('STREAM_CLOCK_INVALID');
    return value;
  }

  async function acquire({ bestEffort = false, signal } = {}) {
    while (true) {
      if (signal?.aborted) streamFail('STREAM_PREVIEW_ABORTED');
      const current = now();
      while (timestamps.length > 0 && current - timestamps[0] >= 30_000) timestamps.shift();
      const fiveSecond = timestamps.filter((value) => current - value < 5_000);
      let waitMs = Math.max(0, cooldownUntil - current);
      // Preview traffic must leave room for final text and media, and never queue.
      if (fiveSecond.length >= (bestEffort ? 18 : 20)) waitMs = Math.max(waitMs, fiveSecond[0] + 5_000 - current);
      if (timestamps.length >= (bestEffort ? 36 : 40)) waitMs = Math.max(waitMs, timestamps[0] + 30_000 - current);
      if (waitMs <= 0) {
        timestamps.push(current);
        return;
      }
      if (bestEffort) streamFail('STREAM_PREVIEW_RATE_LIMITED');
      if (signal) await waitWithSignal(sleep(waitMs), signal);
      else await sleep(waitMs);
    }
  }

  async function run(operation, control = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await acquire(control);
      if (control.signal?.aborted) streamFail('STREAM_PREVIEW_ABORTED');
      try {
        return await operation();
      } catch (error) {
        if (
          control.bestEffort
          || error?.code !== 'TELEGRAM_RATE_LIMIT'
          || !Number.isSafeInteger(error.retryAfterSec)
          || error.retryAfterSec < 0
          || attempt === 1
        ) throw error;
        cooldownUntil = Math.max(cooldownUntil, now() + (error.retryAfterSec * 1000));
      }
    }
    streamFail('STREAM_RATE_LIMIT_FAILED');
  }

  return Object.freeze({ run });
}

function normalizeTelegramMessageId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) streamFail('STREAM_TELEGRAM_RESPONSE_INVALID');
    return String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    streamFail('STREAM_TELEGRAM_RESPONSE_INVALID');
  }
  return value;
}

function createStreamRenderer(options = {}) {
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) streamFail('STREAM_CONFIG_INVALID');
  const checkActive = () => { if (signal?.aborted) streamFail('STREAM_ABORTED'); };
  let requestId;
  let chatId;
  let threadId;
  let privateChat;
  let mode;
  let clock;
  let sleep;
  let minPreviewIntervalMs;
  let minPreviewChars;
  let previewTimeoutMs;
  try {
    requestId = options.requestId;
    chatId = options.chatId;
    threadId = options.threadId ?? '0';
    privateChat = options.privateChat;
    mode = options.mode;
    clock = options.clock ?? Date.now;
    sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    minPreviewIntervalMs = options.minPreviewIntervalMs ?? 1000;
    minPreviewChars = options.minPreviewChars ?? 12;
    previewTimeoutMs = options.previewTimeoutMs ?? 1000;
  } catch {
    streamFail('STREAM_CONFIG_INVALID');
  }
  if (
    typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)
    || typeof chatId !== 'string' || !CHAT_ID_PATTERN.test(chatId)
    || typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)
    || typeof privateChat !== 'boolean'
    || !['draft', 'edit'].includes(mode)
    || typeof clock !== 'function' || typeof sleep !== 'function'
    || !Number.isSafeInteger(minPreviewIntervalMs) || minPreviewIntervalMs < 0
    || !Number.isSafeInteger(minPreviewChars) || minPreviewChars < 1
    || !Number.isSafeInteger(previewTimeoutMs) || previewTimeoutMs < 1 || previewTimeoutMs > 2000
  ) streamFail('STREAM_CONFIG_INVALID');
  minPreviewIntervalMs = Math.max(1000, minPreviewIntervalMs);

  const telegram = options.telegramClient;
  const store = options.completionStore;
  const mediaBridge = options.mediaBridge ?? null;
  const sendMessageDraft = requireMethod(telegram, 'sendMessageDraft');
  const sendMessage = requireMethod(telegram, 'sendMessage');
  const editMessageText = requireMethod(telegram, 'editMessageText');
  const sendChatAction = requireMethod(telegram, 'sendChatAction');
  const getOrCreateDraftId = requireMethod(store, 'getOrCreateDraftId');
  const commitCompletion = requireMethod(store, 'commitCompletion');
  const claimDelivery = requireMethod(store, 'claimDelivery');
  const markDeliveryDelivered = requireMethod(store, 'markDeliveryDelivered');
  const markDeliveryUnknown = requireMethod(store, 'markDeliveryUnknown');
  let resolveVcpImageCandidate = null;
  let sendRichMedia = null;
  if (mediaBridge !== null) {
    resolveVcpImageCandidate = requireMethod(mediaBridge, 'resolveVcpImageCandidate');
    sendRichMedia = requireMethod(mediaBridge, 'sendRichMedia');
  }
  const limiter = options.peerLimiter ?? createTelegramPeerLimiter({ clock, sleep });
  if (!limiter || typeof limiter.run !== 'function') streamFail('STREAM_CONFIG_INVALID');
  const filter = createVcpVisibleTextFilter();

  let visibleText = '';
  let lastPreview = '';
  let lastPreviewAt = -Infinity;
  const previewStrategy = privateChat && mode === 'draft' ? 'draft' : 'edit';
  let placeholderMessageId = null;
  let placeholderUncertain = false;
  let drainPromise = null;
  let previewTimer = null;
  let previewController = null;
  let previewsDisabled = false;
  let finalized = false;

  function stopPreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    previewController?.abort();
    signal?.removeEventListener('abort', stopPreview);
  }
  signal?.addEventListener('abort', stopPreview, { once: true });

  function checkPreview(control) {
    checkActive();
    if (finalized || control.signal.aborted) streamFail('STREAM_PREVIEW_ABORTED');
  }

  function previewCall(operation, control) {
    checkPreview(control);
    return limiter.run(() => {
      checkPreview(control);
      return operation();
    }, { signal: control.signal, bestEffort: true });
  }

  function currentTime() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) streamFail('STREAM_CLOCK_INVALID');
    return value;
  }

  function telegramTarget() {
    return { chat_id: chatId, message_thread_id: threadId };
  }

  function previewText(value) {
    const normalized = normalizeVisibleDocument(value).text;
    if (normalized === '') return '';
    const segments = buildTelegramSegments(normalized, { maxChars: 4096 });
    return segments[0].plainText;
  }

  async function ensurePlaceholder(control) {
    checkPreview(control);
    if (placeholderMessageId !== null) return;
    if (!privateChat) {
      await previewCall(() => sendChatAction({ ...telegramTarget(), action: 'typing' }, control), control);
    }
    try {
      const response = await previewCall(() => {
        placeholderUncertain = true;
        return sendMessage({ ...telegramTarget(), text: '…' }, control);
      }, control);
      checkPreview(control);
      placeholderMessageId = normalizeTelegramMessageId(response?.message_id);
      placeholderUncertain = false;
    } catch (error) {
      // Only a definite rejection proves that no persistent bubble was created.
      if (!control.signal.aborted && ['TELEGRAM_BAD_REQUEST', 'TELEGRAM_AUTH', 'TELEGRAM_FORBIDDEN',
        'TELEGRAM_RATE_LIMIT', 'TELEGRAM_INVALID_REQUEST'].includes(error?.code)) placeholderUncertain = false;
      throw error;
    }
  }

  async function sendEditPreview(control) {
    await ensurePlaceholder(control);
    let sentValue = '';
    await previewCall(() => {
      sentValue = visibleText;
      return editMessageText({
        ...telegramTarget(),
        message_id: placeholderMessageId,
        text: previewText(sentValue),
      }, control);
    }, control);
    return sentValue;
  }

  async function sendPreview(control) {
    checkPreview(control);
    if (previewStrategy === 'draft') {
      let draftId;
      try { draftId = getOrCreateDraftId(requestId); } catch { streamFail('STREAM_STATE_FAILED'); }
      if (!Number.isSafeInteger(draftId) || draftId === 0) streamFail('STREAM_STATE_FAILED');
      let sentValue = '';
      await previewCall(() => {
        sentValue = visibleText;
        return sendMessageDraft({
          ...telegramTarget(),
          draft_id: draftId,
          text: previewText(sentValue),
          can_stop: true,
          keep_on_stop: false,
        }, control);
      }, control);
      return sentValue;
    }
    return sendEditPreview(control);
  }

  function schedulePreview() {
    if (finalized || signal?.aborted || previewsDisabled || drainPromise || previewTimer !== null) return;
    if (visibleText === lastPreview) return;
    const growth = graphemes(visibleText).length - graphemes(lastPreview).length;
    if (growth < minPreviewChars) return;
    const waitMs = minPreviewIntervalMs - (currentTime() - lastPreviewAt);
    if (waitMs > 0) {
      previewTimer = setTimeout(() => { previewTimer = null; schedulePreview(); }, waitMs);
      previewTimer.unref?.();
      return;
    }
    drainPromise = Promise.resolve()
      .then(async () => {
        if (finalized || signal?.aborted) return;
        if (previewText(visibleText) === '') { lastPreview = visibleText; return; }
        const controller = new AbortController();
        previewController = controller;
        const timer = setTimeout(() => controller.abort(), previewTimeoutMs);
        lastPreviewAt = currentTime();
        try {
          const sentValue = await waitWithSignal(sendPreview({ signal: controller.signal, timeoutMs: previewTimeoutMs }), controller.signal);
          if (!finalized && !controller.signal.aborted) {
            lastPreview = sentValue;
            lastPreviewAt = currentTime();
          }
        } finally {
          clearTimeout(timer);
          previewController = null;
        }
      })
      .catch(() => { previewsDisabled = true; })
      .finally(() => { drainPromise = null; schedulePreview(); });
  }

  function pushDelta(input) {
    checkActive();
    if (finalized) streamFail('STREAM_ALREADY_FINALIZED');
    let visible;
    try { visible = filter.push(input); } catch { streamFail('STREAM_FILTER_FAILED'); }
    if (visible !== '') {
      visibleText += visible;
      schedulePreview();
    }
    return Object.freeze({ visibleLength: graphemes(visibleText).length });
  }

  async function flushPreview() {
    schedulePreview();
    if (drainPromise) await drainPromise;
  }

  async function sendFinalSegment(segment, previewMessageId) {
    checkActive();
    const deliver = previewMessageId ? editMessageText : sendMessage;
    const target = { ...telegramTarget(), ...(previewMessageId ? { message_id: previewMessageId } : {}) };
    const htmlParams = {
      ...target,
      text: segment.text,
      ...(segment.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
    };
    try {
      return await limiter.run(() => { checkActive(); return deliver(htmlParams,{signal}); });
    } catch (error) {
      if (segment.parseMode === 'HTML' && error?.code === 'TELEGRAM_BAD_REQUEST') {
        return limiter.run(() => { checkActive(); return deliver({ ...target, text: segment.plainText },{signal}); });
      }
      throw error;
    }
  }

  async function finish(input = {}) {
    checkActive();
    if (finalized) streamFail('STREAM_ALREADY_FINALIZED');
    finalized = true;
    stopPreview();
    try {
      visibleText += filter.finish({ toolLoopExhausted: input.toolLoopExhausted ?? false });
    } catch {
      streamFail('STREAM_FILTER_FAILED');
    }
    const normalized = normalizeVisibleDocument(visibleText);
    checkActive();
    if (normalized.text === '') streamFail('STREAM_EMPTY_COMPLETION');
    const media = [];
    if (resolveVcpImageCandidate !== null) {
      for (const candidate of normalized.media) {
        checkActive();
        try { media.push(await resolveVcpImageCandidate(candidate)); }
        catch { /* the normalized text already carries a safe unavailable-image placeholder */ }
      }
    }
    checkActive();
    const unavailableCount = normalized.media.length - media.length;
    const assistantText = normalized.text + (unavailableCount > 0
      ? `\n\n（有 ${unavailableCount} 张图片暂时无法发送。）` : '');
    const segments = buildTelegramSegments(assistantText, { maxChars: 4096 });
    let committed;
    try {
      committed = commitCompletion({
        requestId,
        turnId: input.turnId,
        userText: input.userText,
        assistantText,
        ...(input.userTelegramMessageId === undefined
          ? {} : { userTelegramMessageId: input.userTelegramMessageId }),
        segments,
        ...(placeholderMessageId === null ? {} : { previewMessageId: placeholderMessageId }),
        ...(placeholderUncertain ? { previewDeliveryUnknown: true } : {}),
        ...(media.length === 0 ? {} : { media }),
      });
    } catch {
      streamFail('STREAM_STATE_FAILED');
    }
    if (!Array.isArray(committed?.deliveryKeys) || committed.deliveryKeys.length !== segments.length) {
      streamFail('STREAM_STATE_FAILED');
    }
    const mediaDeliveryKeys = committed.mediaDeliveryKeys ?? [];
    if (!Array.isArray(mediaDeliveryKeys) || mediaDeliveryKeys.length !== media.length) {
      streamFail('STREAM_STATE_FAILED');
    }
    for (let index = 0; index < segments.length; index += 1) {
      checkActive();
      const key = committed.deliveryKeys[index];
      let claim;
      try { claim = claimDelivery(key); } catch { streamFail('STREAM_STATE_FAILED'); }
      if (claim?.changed !== true) {
        if (claim?.status === 'delivered') continue;
        streamFail(claim?.status === 'needs_review'
          ? 'STREAM_FINAL_DELIVERY_UNKNOWN'
          : 'STREAM_STATE_FAILED');
      }
      let response;
      try {
        response = await sendFinalSegment(segments[index], index === 0 ? placeholderMessageId : null);
      } catch {
        try { markDeliveryUnknown(key, 'TELEGRAM_NETWORK_UNKNOWN'); } catch { /* already unsafe */ }
        streamFail('STREAM_FINAL_DELIVERY_UNKNOWN');
      }
      let messageId;
      try {
        messageId = normalizeTelegramMessageId(response?.message_id);
        if (index === 0 && placeholderMessageId !== null && messageId !== placeholderMessageId) {
          throw new Error('preview target mismatch');
        }
        const delivered = markDeliveryDelivered(key, messageId);
        if (delivered?.status !== 'delivered') throw new Error('delivery not confirmed');
      } catch {
        try { markDeliveryUnknown(key, 'TELEGRAM_DELIVERY_CONFIRM_UNKNOWN'); } catch { /* best effort */ }
        streamFail('STREAM_FINAL_DELIVERY_UNKNOWN');
      }
    }
    for (let index = 0; index < media.length; index += 1) {
      checkActive();
      const key = mediaDeliveryKeys[index];
      let claim;
      try { claim = claimDelivery(key); } catch { streamFail('STREAM_STATE_FAILED'); }
      if (claim?.changed !== true) {
        if (claim?.status === 'delivered') continue;
        streamFail(claim?.status === 'needs_review'
          ? 'STREAM_MEDIA_DELIVERY_UNKNOWN'
          : 'STREAM_STATE_FAILED');
      }
      let response;
      try {
        response = await limiter.run(() => { checkActive(); return sendRichMedia({ chatId, threadId, media: media[index], signal }); });
      } catch {
        try { markDeliveryUnknown(key, 'TELEGRAM_MEDIA_NETWORK_UNKNOWN'); } catch { /* already unsafe */ }
        streamFail('STREAM_MEDIA_DELIVERY_UNKNOWN');
      }
      try {
        const messageId = normalizeTelegramMessageId(response?.messageId);
        const delivered = markDeliveryDelivered(key, messageId);
        if (delivered?.status !== 'delivered') throw new Error('media delivery not confirmed');
      } catch {
        try { markDeliveryUnknown(key, 'TELEGRAM_MEDIA_CONFIRM_UNKNOWN'); } catch { /* best effort */ }
        streamFail('STREAM_MEDIA_DELIVERY_UNKNOWN');
      }
    }
    return Object.freeze({
      status: 'delivered',
      segmentCount: segments.length,
      ...(media.length === 0 ? {} : { mediaCount: media.length }),
    });
  }

  function snapshot() {
    return Object.freeze({
      finalized,
      previewStrategy,
      visibleLength: graphemes(visibleText).length,
    });
  }

  return Object.freeze({ finish, flushPreview, pushDelta, snapshot });
}

module.exports = Object.freeze({
  StreamRendererError,
  buildTelegramSegments,
  createStreamRenderer,
  createTelegramPeerLimiter,
  escapeTelegramHtml,
  renderTelegramHtml,
});
