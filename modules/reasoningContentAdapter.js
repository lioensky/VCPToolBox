const REASONING_KEYS = Object.freeze([
  'reasoning_content',
  'reasoning',
  'reasoning_chunk',
  'reasoningChunk',
  'reasoning_summary',
  'reasoningSummary',
  'reasoning_details',
  'reasoningDetails',
  'reasoning_text',
  'reasoningText',
  'thinking',
  'thoughts'
]);

const TEXT_VALUE_KEYS = new Set([
  'text',
  'content',
  'summary',
  'value',
  'reasoning',
  'thinking'
]);

function normalizeReasoningTag(value) {
  return String(value || '').trim().toLowerCase() === 'thinking'
    ? 'thinking'
    : 'think';
}

function normalizeReasoningModelFilters(value) {
  const filters = Array.isArray(value)
    ? value
    : String(value || '').split(',');

  return filters
    .map(filter => String(filter || '').trim().toLowerCase())
    .filter(Boolean);
}

function shouldConvertReasoningForModel(modelName, enabled, modelFilters) {
  if (!enabled || !modelName) return false;

  const normalizedModelName = String(modelName).toLowerCase();
  const normalizedFilters = normalizeReasoningModelFilters(modelFilters);
  if (normalizedFilters.length === 0) return false;

  return normalizedFilters.some(filter => normalizedModelName.includes(filter));
}

function valueToReasoningText(value, seen = new Set()) {
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '';

  if (seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map(item => valueToReasoningText(item, seen))
      .filter(Boolean)
      .join('\n');
  }

  const preferredParts = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    if (TEXT_VALUE_KEYS.has(key) || REASONING_KEYS.includes(key)) {
      const text = valueToReasoningText(nestedValue, seen);
      if (text) preferredParts.push(text);
    }
  }
  if (preferredParts.length > 0) {
    return preferredParts.join('\n');
  }

  return '';
}

function extractReasoningText(source) {
  if (!source || typeof source !== 'object') return '';

  const parts = [];
  const seenTexts = new Set();

  for (const key of REASONING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const text = valueToReasoningText(source[key]);
    if (!text || !text.trim() || seenTexts.has(text)) continue;
    seenTexts.add(text);
    parts.push(text);
  }

  return parts.join('\n');
}

function extractReasoningTextFromSources(...sources) {
  const parts = [];
  const seenTexts = new Set();

  for (const source of sources) {
    const text = extractReasoningText(source);
    if (!text || !text.trim() || seenTexts.has(text)) continue;
    seenTexts.add(text);
    parts.push(text);
  }

  return parts.join('\n');
}

function removeReasoningFields(source) {
  if (!source || typeof source !== 'object') return source;
  for (const key of REASONING_KEYS) {
    delete source[key];
  }
  return source;
}

function wrapReasoningText(reasoningText, tagName = 'think') {
  const text = typeof reasoningText === 'string' ? reasoningText : '';
  if (!text) return '';
  const normalizedTag = normalizeReasoningTag(tagName);
  const closingPrefix = /(?:\r\n|\r|\n)$/.test(text) ? '' : '\n';
  return `<${normalizedTag}>\n${text}${closingPrefix}</${normalizedTag}>\n`;
}

function buildClientVisibleContent(message, enabled, tagName = 'think', ...additionalSources) {
  const visibleContent = typeof message?.content === 'string'
    ? message.content
    : '';
  if (!enabled) return visibleContent;

  const reasoningText = extractReasoningTextFromSources(message, ...additionalSources);
  if (!reasoningText) return visibleContent;

  return `${wrapReasoningText(reasoningText, tagName)}${visibleContent}`;
}

module.exports = {
  REASONING_KEYS,
  normalizeReasoningTag,
  normalizeReasoningModelFilters,
  shouldConvertReasoningForModel,
  extractReasoningText,
  extractReasoningTextFromSources,
  removeReasoningFields,
  wrapReasoningText,
  buildClientVisibleContent
};