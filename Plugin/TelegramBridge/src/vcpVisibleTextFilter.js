'use strict';

const ERROR_MESSAGE = 'VCP visible text filtering failed.';

class VcpVisibleTextFilterError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'VcpVisibleTextFilterError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, VcpVisibleTextFilterError);
  }
}

function fail(code) {
  throw new VcpVisibleTextFilterError(code);
}

const HIDDEN_MARKERS = Object.freeze([
  {
    starts: ['<<<[TOOL_REQUEST]>>>', '<<<TOOL_REQUEST>>>', '[TOOL_REQUEST]'],
    ends: ['<<<[END_TOOL_REQUEST]>>>', '<<<END_TOOL_REQUEST>>>', '[END_TOOL_REQUEST]'],
  },
  {
    starts: ['<<<[TOOL_REQUEST_EXP]>>>', '<<<TOOL_REQUEST_EXP>>>', '[TOOL_REQUEST_EXP]'],
    ends: ['<<<[END_TOOL_REQUEST_EXP]>>>', '<<<END_TOOL_REQUEST_EXP>>>', '[END_TOOL_REQUEST_EXP]'],
  },
  {
    starts: ['<<<[TOOL_REQUEST_ESCAPE]>>>'],
    ends: ['<<<[END_TOOL_REQUEST_ESCAPE]>>>'],
  },
  {
    starts: ['<<<[TOOL_RESULT]>>>', '<<<TOOL_RESULT>>>', '[TOOL_RESULT]'],
    ends: ['<<<[END_TOOL_RESULT]>>>', '<<<END_TOOL_RESULT>>>', '[END_TOOL_RESULT]'],
  },
  { starts: ['<<<DAILYNOTESTART>>>'], ends: ['<<<DAILYNOTEEND>>>'] },
  {
    starts: ['<<<[ROLE_DIVIDE_SYSTEM]>>>'],
    ends: ['<<<[END_ROLE_DIVIDE_SYSTEM]>>>'],
  },
  {
    starts: ['<<<[ROLE_DIVIDE_USER]>>>'],
    ends: ['<<<[END_ROLE_DIVIDE_USER]>>>'],
  },
  {
    starts: ['[本轮工具调用摘要:]'],
    ends: ['[本轮工具调用摘要结束]'],
  },
  {
    starts: ['<!-- VCP_TOOL_PAYLOAD -->'],
    ends: ['<!-- END_VCP_TOOL_PAYLOAD -->'],
  },
]);

const CONTROL_MARKERS = Object.freeze([
  '<<<[ROLE_DIVIDE_ASSISTANT]>>>',
  '<<<[END_ROLE_DIVIDE_ASSISTANT]>>>',
]);
const THINK_STARTS = Object.freeze(['<THINK>', '<THINKING>', '<REASONING>']);
const THINK_ENDS = Object.freeze(['</THINK>', '</THINKING>', '</REASONING>']);
const SYNTHETIC_MARKERS = Object.freeze([
  '[ERROR]',
  '[UPSTREAM_ERROR]',
  '[上游响应超时，流已中断]',
]);

const VISIBLE_MARKERS = Object.freeze([
  ...HIDDEN_MARKERS.flatMap((entry, groupIndex) => entry.starts.map((text) => ({
    text,
    type: 'hidden',
    groupIndex,
  }))),
  ...CONTROL_MARKERS.map((text) => ({ text, type: 'control' })),
  ...THINK_STARTS.map((text) => ({ text, type: 'think' })),
  ...THINK_ENDS.map((text) => ({ text, type: 'control' })),
  ...SYNTHETIC_MARKERS.map((text) => ({ text, type: 'synthetic' })),
]);

function lower(value) {
  return value.toLocaleUpperCase('en-US');
}

function longestSuffixPrefix(value, markers) {
  const upper = lower(value);
  let keep = 0;
  for (const marker of markers) {
    const candidate = lower(marker.text ?? marker);
    const maximum = Math.min(upper.length, candidate.length - 1);
    for (let length = maximum; length > keep; length -= 1) {
      if (upper.endsWith(candidate.slice(0, length))) {
        keep = length;
        break;
      }
    }
  }
  return keep;
}

function findFirstMarker(value, markers) {
  const upper = lower(value);
  let selected = null;
  for (const marker of markers) {
    const text = marker.text ?? marker;
    const markerUpper = lower(text);
    let index = upper.indexOf(markerUpper);
    while (index !== -1 && text.startsWith('[') && index > 0 && value[index - 1] === '<') {
      index = upper.indexOf(markerUpper, index + 1);
    }
    if (index === -1) continue;
    if (!selected || index < selected.index || (index === selected.index && text.length > selected.text.length)) {
      selected = { marker, text, index };
    }
  }
  return selected;
}

function snapshotPushInput(input) {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('VISIBLE_FILTER_INPUT_INVALID');
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    fail('VISIBLE_FILTER_INPUT_INVALID');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !['content', 'reasoning', 'syntheticError'].includes(key))) {
    fail('VISIBLE_FILTER_INPUT_INVALID');
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      fail('VISIBLE_FILTER_INPUT_INVALID');
    }
  }
  const content = descriptors.content?.value ?? '';
  const reasoning = descriptors.reasoning?.value;
  const syntheticError = descriptors.syntheticError?.value ?? false;
  if (
    typeof content !== 'string'
    || (reasoning !== undefined && typeof reasoning !== 'string')
    || typeof syntheticError !== 'boolean'
  ) {
    fail('VISIBLE_FILTER_INPUT_INVALID');
  }
  if (syntheticError) fail('VISIBLE_FILTER_SYNTHETIC_ERROR');
  return content;
}

function createVcpVisibleTextFilter() {
  let mode = 'visible';
  let visiblePending = '';
  let hiddenPending = '';
  let hiddenEnds = null;
  let thinkStack = [];
  let closed = false;
  let emittedMeaningful = false;

  function noteVisible(value) {
    if (/\S/.test(value)) emittedMeaningful = true;
    return value;
  }

  function enterHidden(groupIndex) {
    mode = 'hidden';
    hiddenEnds = HIDDEN_MARKERS[groupIndex].ends;
    hiddenPending = '';
  }

  function processVisible() {
    let output = '';
    while (visiblePending !== '') {
      const found = findFirstMarker(visiblePending, VISIBLE_MARKERS);
      if (found) {
        const before = visiblePending.slice(0, found.index);
        output += noteVisible(before);
        visiblePending = visiblePending.slice(found.index + found.text.length);
        if (found.marker.type === 'synthetic') {
          fail('VISIBLE_FILTER_SYNTHETIC_ERROR');
        } else if (found.marker.type === 'hidden') {
          enterHidden(found.marker.groupIndex);
          const remainder = visiblePending;
          visiblePending = '';
          output += processHiddenGeneric(remainder);
          return output;
        } else if (found.marker.type === 'think') {
          mode = 'think';
          thinkStack = [lower(found.text).slice(1, -1)];
          hiddenPending = '';
          const remainder = visiblePending;
          visiblePending = '';
          output += processThink(remainder);
          return output;
        }
        continue;
      }
      const keep = longestSuffixPrefix(visiblePending, VISIBLE_MARKERS);
      const safeLength = visiblePending.length - keep;
      output += noteVisible(visiblePending.slice(0, safeLength));
      visiblePending = visiblePending.slice(safeLength);
      break;
    }
    return output;
  }

  function processHiddenGeneric(value) {
    hiddenPending += value;
    const found = findFirstMarker(hiddenPending, hiddenEnds);
    if (found) {
      const remainder = hiddenPending.slice(found.index + found.text.length);
      mode = 'visible';
      hiddenPending = '';
      hiddenEnds = null;
      visiblePending += remainder;
      return processVisible();
    }
    const keep = longestSuffixPrefix(hiddenPending, hiddenEnds);
    hiddenPending = keep === 0 ? '' : hiddenPending.slice(-keep);
    return '';
  }

  function processThink(value) {
    hiddenPending += value;
    const markers = [
      ...THINK_STARTS.map((text) => ({ text, open: true })),
      ...THINK_ENDS.map((text) => ({ text, open: false })),
    ];
    while (hiddenPending !== '') {
      const found = findFirstMarker(hiddenPending, markers);
      if (!found) {
        const keep = longestSuffixPrefix(hiddenPending, markers);
        hiddenPending = keep === 0 ? '' : hiddenPending.slice(-keep);
        return '';
      }
      hiddenPending = hiddenPending.slice(found.index + found.text.length);
      const tag = lower(found.text).replace(/[<>/]/g, '');
      if (found.marker.open) {
        thinkStack.push(tag);
      } else if (thinkStack.length > 0 && thinkStack.at(-1) === tag) {
        thinkStack.pop();
        if (thinkStack.length === 0) {
          const remainder = hiddenPending;
          mode = 'visible';
          hiddenPending = '';
          visiblePending += remainder;
          return processVisible();
        }
      }
    }
    return '';
  }

  function push(input) {
    if (closed) fail('VISIBLE_FILTER_CLOSED');
    const content = snapshotPushInput(input);
    if (content === '') return '';
    if (mode === 'visible') {
      visiblePending += content;
      return processVisible();
    }
    if (mode === 'hidden') return processHiddenGeneric(content);
    return processThink(content);
  }

  function finish(options = {}) {
    if (closed) fail('VISIBLE_FILTER_CLOSED');
    closed = true;
    let toolLoopExhausted;
    try {
      toolLoopExhausted = options.toolLoopExhausted ?? false;
    } catch {
      fail('VISIBLE_FILTER_INPUT_INVALID');
    }
    if (typeof toolLoopExhausted !== 'boolean') fail('VISIBLE_FILTER_INPUT_INVALID');
    if (toolLoopExhausted) fail('VISIBLE_FILTER_TOOL_LOOP_EXHAUSTED');
    if (mode !== 'visible' || visiblePending !== '') fail('VISIBLE_FILTER_INCOMPLETE');
    return '';
  }

  function snapshot() {
    return Object.freeze({
      mode,
      bufferedBytes: Buffer.byteLength(visiblePending || hiddenPending, 'utf8'),
    });
  }

  return Object.freeze({ finish, push, snapshot });
}

module.exports = Object.freeze({
  VcpVisibleTextFilterError,
  createVcpVisibleTextFilter,
});
