'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOneRingTrigger,
  parseOneRingTailMarker,
  stripOneRingTailMarkers,
  buildOneRingTailMarker,
  classifySenderSource,
  getVisibleMessageText,
} = require('../modules/oneringParser');

test('parseOneRingTrigger parses the first valid normal trigger', () => {
  assert.deepEqual(parseOneRingTrigger('prefix [[OneRing::Agnes::VChat]] tail'), {
    raw: '[[OneRing::Agnes::VChat]]',
    agentName: 'Agnes',
    frontendSource: 'VChat',
    mode: 'normal',
    recordOnly: false,
    index: 7,
  });
});

test('parseOneRingTrigger parses record-only trigger mode', () => {
  assert.deepEqual(parseOneRingTrigger('[[OneRing::Agnes::VChat::Only]]'), {
    raw: '[[OneRing::Agnes::VChat::Only]]',
    agentName: 'Agnes',
    frontendSource: 'VChat',
    mode: 'only',
    recordOnly: true,
    index: 0,
  });
});

test('parseOneRingTrigger skips unsupported modes and malformed triggers', () => {
  assert.equal(parseOneRingTrigger('[[OneRing::Agnes::VChat::Now]]'), null);
  assert.equal(parseOneRingTrigger('[[OneRing::::VChat]]'), null);
  assert.equal(parseOneRingTrigger('[[Other::Agnes::VChat]]'), null);
});

test('tail marker parser handles second and millisecond timestamps', () => {
  assert.deepEqual(
    parseOneRingTailMarker('[OneRing通知:Alice于2026-06-05 10:11:12发送于VChat]'),
    {
      raw: '[OneRing通知:Alice于2026-06-05 10:11:12发送于VChat]',
      senderName: 'Alice',
      timestamp: '2026-06-05 10:11:12',
      frontendSource: 'VChat',
    },
  );

  assert.equal(
    parseOneRingTailMarker('[OneRing通知:Alice于2026-06-05 10:11:12.345发送于VChat]').timestamp,
    '2026-06-05 10:11:12.345',
  );
});

test('stripOneRingTailMarkers removes only trailing markers', () => {
  const marker = '[OneRing通知:Alice于2026-06-05 10:11:12发送于VChat]';
  const result = stripOneRingTailMarkers(`middle ${marker} stays\nfinal ${marker}`);

  assert.equal(result.text, `middle ${marker} stays\nfinal`);
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].senderName, 'Alice');
});

test('stripOneRingTailMarkers removes stacked trailing markers in order', () => {
  const first = '[OneRing通知:Alice于2026-06-05 10:11:12发送于VChat]';
  const second = '[OneRing通知:Bob于2026-06-05 10:12:12发送于QQ]';
  const result = stripOneRingTailMarkers(`hello ${first} ${second}`);

  assert.equal(result.text, 'hello');
  assert.deepEqual(
    result.markers.map((marker) => marker.senderName),
    ['Alice', 'Bob'],
  );
});

test('buildOneRingTailMarker builds and validates marker fields', () => {
  assert.equal(
    buildOneRingTailMarker({
      senderName: 'Alice',
      timestamp: '2026-06-05 10:11:12',
      frontendSource: 'VChat',
    }),
    '[OneRing通知:Alice于2026-06-05 10:11:12发送于VChat]',
  );

  assert.throws(
    () => buildOneRingTailMarker({
      senderName: 'Ali]ce',
      timestamp: '2026-06-05 10:11:12',
      frontendSource: 'VChat',
    }),
    /senderName/,
  );
  assert.throws(
    () => buildOneRingTailMarker({
      senderName: 'Alice',
      timestamp: 'not-a-date',
      frontendSource: 'VChat',
    }),
    /timestamp/,
  );
});

test('classifySenderSource recognizes group-chat speaker prefix', () => {
  assert.deepEqual(classifySenderSource('[Alice的发言]：hello', 'Fallback'), {
    senderName: 'Alice',
    source: 'group-chat',
    text: 'hello',
  });

  assert.deepEqual(classifySenderSource('hello', 'Fallback'), {
    senderName: 'Fallback',
    source: 'direct',
    text: 'hello',
  });
});

test('getVisibleMessageText ignores reasoning_content fields', () => {
  assert.equal(
    getVisibleMessageText({
      content: [
        { type: 'text', text: 'visible one' },
        { reasoning_content: 'hidden reasoning' },
        { type: 'text', value: 'visible two' },
      ],
      reasoning_content: 'hidden root reasoning',
    }),
    'visible one\nvisible two',
  );
});
