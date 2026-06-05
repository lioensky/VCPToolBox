'use strict';

const TRIGGER_REGEX = /\[\[OneRing::([^\]:\[\]\r\n]+)::([^\]:\[\]\r\n]+)(?:::([^\]:\[\]\r\n]+))?\]\]/g;
const TAIL_MARKER_EXACT_REGEX = /^\[OneRing通知:([^\]\r\n]{1,80})于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)发送于([^\]\r\n]{1,80})\]$/;
const TAIL_MARKER_TRAILING_REGEX = /\s*(\[OneRing通知:[^\]\r\n]{1,80}于\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?发送于[^\]\r\n]{1,80}\])\s*$/;
const GROUP_SENDER_REGEX = /^\s*\[([^\]\r\n]{1,30})的发言\]\s*[:：]\s*/;

function parseOneRingTrigger(input) {
  const text = toStringOrEmpty(input);
  TRIGGER_REGEX.lastIndex = 0;

  for (const match of text.matchAll(TRIGGER_REGEX)) {
    const agentName = match[1].trim();
    const frontendSource = match[2].trim();
    const modeToken = match[3] ? match[3].trim() : null;

    if (!agentName || !frontendSource) {
      continue;
    }

    if (modeToken && modeToken !== 'Only') {
      continue;
    }

    return {
      raw: match[0],
      agentName,
      frontendSource,
      mode: modeToken === 'Only' ? 'only' : 'normal',
      recordOnly: modeToken === 'Only',
      index: match.index,
    };
  }

  return null;
}

function parseOneRingTailMarker(marker) {
  const text = toStringOrEmpty(marker).trim();
  const match = text.match(TAIL_MARKER_EXACT_REGEX);
  if (!match) {
    return null;
  }

  return {
    raw: text,
    senderName: match[1].trim(),
    timestamp: match[2],
    frontendSource: match[3].trim(),
  };
}

function stripOneRingTailMarkers(input) {
  let text = toStringOrEmpty(input);
  const markers = [];

  while (true) {
    const match = text.match(TAIL_MARKER_TRAILING_REGEX);
    if (!match) {
      break;
    }

    const parsed = parseOneRingTailMarker(match[1]);
    if (!parsed) {
      break;
    }

    markers.unshift(parsed);
    text = text.slice(0, match.index).replace(/\s+$/, '');
  }

  return {
    text,
    markers,
  };
}

function buildOneRingTailMarker({ senderName, timestamp, frontendSource } = {}) {
  const safeSender = normalizeMarkerField(senderName, 'senderName');
  const safeTimestamp = normalizeTimestamp(timestamp);
  const safeFrontend = normalizeMarkerField(frontendSource, 'frontendSource');

  return `[OneRing通知:${safeSender}于${safeTimestamp}发送于${safeFrontend}]`;
}

function classifySenderSource(input, fallbackSenderName = 'User') {
  const text = toStringOrEmpty(input);
  const match = text.match(GROUP_SENDER_REGEX);

  if (match) {
    return {
      senderName: match[1].trim(),
      source: 'group-chat',
      text: text.slice(match[0].length),
    };
  }

  return {
    senderName: normalizeFallbackSender(fallbackSenderName),
    source: 'direct',
    text,
  };
}

function getVisibleMessageText(messageOrContent) {
  if (typeof messageOrContent === 'string') {
    return messageOrContent;
  }

  if (Array.isArray(messageOrContent)) {
    return messageOrContent
      .map((part) => getVisibleMessageText(part))
      .filter(Boolean)
      .join('\n');
  }

  if (!messageOrContent || typeof messageOrContent !== 'object') {
    return '';
  }

  if (typeof messageOrContent.content !== 'undefined') {
    return getVisibleMessageText(messageOrContent.content);
  }

  if (typeof messageOrContent.text === 'string') {
    return messageOrContent.text;
  }

  if (messageOrContent.type === 'text' && typeof messageOrContent.value === 'string') {
    return messageOrContent.value;
  }

  return '';
}

function normalizeMarkerField(value, fieldName) {
  const text = toStringOrEmpty(value).trim();
  if (!text || text.length > 80 || /[\]\r\n]/.test(text)) {
    throw new TypeError(`Invalid OneRing marker ${fieldName}`);
  }
  return text;
}

function normalizeTimestamp(value) {
  const text = toStringOrEmpty(value).trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(text)) {
    throw new TypeError('Invalid OneRing marker timestamp');
  }
  return text;
}

function normalizeFallbackSender(value) {
  const text = toStringOrEmpty(value).trim();
  return text || 'User';
}

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

module.exports = {
  parseOneRingTrigger,
  parseOneRingTailMarker,
  stripOneRingTailMarkers,
  buildOneRingTailMarker,
  classifySenderSource,
  getVisibleMessageText,
};
