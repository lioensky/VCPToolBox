'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setImmediate: immediate } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { loadMigrations, runMigrations } = require('../src/migrationRunner');
const { createUpdateLedgerForDatabase } = require('../src/updateLedger');
const { createAccessPolicy } = require('../src/accessPolicy');
const { createAlbumBuffer } = require('../src/albumBuffer');

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const db = new Database(':memory:');
  runMigrations(db, loadMigrations(path.join(__dirname, '../migrations')));
  const ledger = createUpdateLedgerForDatabase(db, { clock: () => Date.now() });
  const policy = createAccessPolicy({ allowedUserIds: ['42', '43'], allowedChatIds: ['-100'],
    groupsEnabled: true, botUserId: '99', botUsername: 'fixture_bot' });
  const calls = [];
  const errors = [];
  const buffers = [];
  const create = () => {
    const buffer = createAlbumBuffer({ database: db, evaluateAccess: policy.evaluate,
      onReady: async item => { calls.push(item); }, onError: code => errors.push(code), ...options });
    buffers.push(buffer);
    return buffer;
  };
  const buffer = create();
  t.after(() => { for (const b of buffers) b.stop(); db.close(); });
  function item(id, content = {}, lane = {}) {
    const owner = lane.owner ?? '42';
    const payload = { message: { message_id: Number(id), from: { id: owner },
      chat: { id: lane.chat ?? owner, type: lane.chat?.startsWith('-') ? 'supergroup' : 'private' },
      ...(lane.thread ? { message_thread_id: lane.thread } : {}), ...content } };
    ledger.acceptBatch([{ updateId: String(id), updateType: 'message', payload }]);
    return { updateId: String(id), payload };
  }
  const photo = (id, content = {}, lane) => item(id, { photo: [{ file_id: `file-${id}`,
    file_unique_id: `unique-${id}`, width: 10, height: 10 }], ...content }, lane);
  const text = (id, value = 'What is in this picture?', lane) => item(id, { text: value }, lane);
  const row = id => db.prepare('SELECT * FROM updates WHERE update_id=?').get(String(id));
  const tick = async ms => { t.mock.timers.tick(ms); await immediate(); };
  const replay = async target => {
    const rows = db.prepare("SELECT update_id,payload_json FROM updates WHERE status='received' ORDER BY length(update_id),update_id").all();
    for (const r of rows) await target.add({ updateId: r.update_id, payload: JSON.parse(r.payload_json) });
  };
  return { db, buffer, create, calls, errors, photo, text, item, row, tick, replay };
}

for (const delay of [4300, 5000, 5700]) test(`photo then question at ${delay}ms dispatches one immutable bundle`, async t => {
  const f = fixture(t);
  const photo = f.photo(1);
  const source = f.row(1);
  assert.equal(await f.buffer.add(photo), true, 'captionless photo must be held');
  await f.tick(delay);
  assert.equal(f.calls.length, 0);
  const question = f.text(2);
  const questionSource = f.row(2);
  assert.equal(await f.buffer.add(question), true);
  assert.deepEqual(f.calls, [photo], 'the photo remains the request anchor');
  assert.deepEqual(f.buffer.messagesFor('1'), [photo.payload.message, question.payload.message]);
  assert.ok(f.row(1).input_bundle_key);
  assert.equal(f.row(2).input_bundle_key, f.row(1).input_bundle_key);
  assert.equal(f.row(2).album_parent_update_id, '1');
  assert.equal(f.row(2).status, 'album_member');
  for (const [id, original] of [[1, source], [2, questionSource]]) {
    assert.equal(f.row(id).payload_json, original.payload_json);
    assert.equal(f.row(id).payload_sha256, original.payload_sha256);
  }
  await f.buffer.add(photo);
  await f.buffer.add(question);
  await f.tick(10000);
  assert.equal(f.calls.length, 1, 'repeated delivery and old timers cannot dispatch twice');
  assert.equal(await f.buffer.add(f.text(3, 'another question')), false);
});

test('captionless image times out once at the default 7500ms', async t => {
  const f = fixture(t);
  const photo = f.photo(1);
  assert.equal(await f.buffer.add(photo), true);
  await f.tick(7499);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.deepEqual(f.calls, [photo]);
  assert.deepEqual(f.buffer.messagesFor('1'), [photo.payload.message]);
  await f.tick(15000);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.buffer.add(f.text(2)), false, 'late text takes the normal route');
});

test('image documents use the injectable media settle window', async t => {
  const f = fixture(t, { mediaSettleMs: 75 });
  const document = f.item(1, { document: { file_id: 'image-file', mime_type: 'image/png', file_name: 'diagram.png' } });
  assert.equal(await f.buffer.add(document), true);
  await f.tick(50);
  const question = f.text(2);
  assert.equal(await f.buffer.add(question), true);
  assert.deepEqual(f.calls, [document]);
  assert.deepEqual(f.buffer.messagesFor('1'), [document.payload.message, question.payload.message]);
});

test('captionless albums wait for text and retain all media after the 900ms album settle', async t => {
  const f = fixture(t);
  const first = f.photo(1, { media_group_id: 'album' });
  await f.buffer.add(first);
  await f.tick(100);
  const second = f.photo(2, { media_group_id: 'album' });
  await f.buffer.add(second);
  await f.tick(4900);
  assert.equal(f.calls.length, 0);
  const question = f.text(3);
  await f.buffer.add(question);
  assert.deepEqual(f.calls, [first]);
  assert.deepEqual(f.buffer.messagesFor('1'), [first, second, question].map(i => i.payload.message));
  const late = f.photo(4, { media_group_id: 'album' });
  await f.buffer.add(late);
  assert.equal(f.row(4).error_code, 'ALBUM_LATE_MEMBER');
});

test('captioned albums keep the 900ms quiet settle', async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1, { media_group_id: 'album' }));
  await f.tick(100);
  await f.buffer.add(f.photo(2, { media_group_id: 'album', caption: 'Describe these' }));
  await f.tick(899);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].updateId, '1');
});

test('captioned single images, voice and non-image documents use the normal route', async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1));
  for (const item of [f.photo(2, { caption: 'Separate question' }),
    f.item(3, { voice: { file_id: 'voice', mime_type: 'audio/ogg' } }),
    f.item(4, { document: { file_id: 'pdf', mime_type: 'application/pdf' } }),
    f.item(5, { document: { file_id: 'image', mime_type: 'image/png' }, caption: 'Separate document' })]) {
    assert.equal(await f.buffer.add(item), false);
    assert.equal(f.row(item.updateId).input_bundle_key, null);
  }
  assert.equal(f.calls.length, 0);
  await f.buffer.flushLane('42', '0');
  assert.equal(f.calls.length, 1, 'agent switch still flushes pending media');
});

test('owner, chat, thread and authorization isolate companions', async t => {
  const f = fixture(t);
  const reply = { reply_to_message: { from: { id: '99' } } };
  await f.buffer.add(f.photo(1, reply, { chat: '-100', thread: '7' }));
  for (const lane of [{ owner: '43', chat: '-100', thread: '7' },
    { chat: '-100', thread: '8' }, { owner: '42' }, { owner: '7', chat: '-100', thread: '7' }]) {
    const i = f.item(10 + Number(lane.owner ?? lane.thread), { text: 'Question', ...reply }, lane);
    assert.equal(await f.buffer.add(i), false);
    assert.equal(f.row(i.updateId).input_bundle_key, null);
  }
  const untriggered = f.text(90, 'Question', { chat: '-100', thread: '7' });
  assert.equal(await f.buffer.add(untriggered), false, 'group trigger is still required');
  const own = f.item(99, { text: 'Question', ...reply }, { chat: '-100', thread: '7' });
  assert.equal(await f.buffer.add(own), true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.buffer.messagesFor('1').map(m => m.message_id), [1, 99]);
});

for (const command of ['/new', '/stop', '/stop@fixture_bot']) test(`${command} cancels the lane before normal command dispatch`, async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1));
  await f.buffer.add(f.photo(2, { media_group_id: 'pending-album' }));
  await f.buffer.add(f.photo(3, {}, { thread: '8' }));
  const cmd = f.text(4, command);
  assert.equal(await f.buffer.add(cmd), false, 'commands must never become companions');
  assert.equal(typeof f.buffer.cancelLane, 'function');
  await f.buffer.cancelLane('42', '0');
  assert.equal(f.row(1).status, 'cancelled');
  assert.equal(f.row(2).status, 'cancelled');
  assert.equal(f.row(3).status, 'received');
  assert.equal(f.row(4).status, 'received', 'main owns command dispatch');
  f.buffer.stop();
  const resumed = f.create();
  await f.replay(resumed);
  await f.tick(7500);
  assert.deepEqual(f.calls.map(i => i.updateId), ['3']);
  await resumed.add(f.photo(5, { media_group_id: 'pending-album' }));
  assert.equal(f.row(5).error_code, 'ALBUM_LATE_MEMBER');
});

test('commands for another bot and leading command entities never become questions', async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1));
  assert.equal(await f.buffer.add(f.text(2, '/stop@other_bot')), false);
  assert.equal(await f.buffer.add(f.item(3, { text: '/unknown', entities: [{ type: 'bot_command', offset: 0, length: 8 }] })), false);
  assert.equal(f.calls.length, 0);
});

test('restart uses the original media deadline and handles a persisted received bundle once', async t => {
  const f = fixture(t);
  const photo = f.photo(1);
  await f.buffer.add(photo);
  assert.ok(f.row(1).input_bundle_key, 'membership must be durable before the timer');
  await f.tick(5000);
  const question = f.text(2);
  // Simulate death after committing membership but before sealing or calling onReady.
  f.db.prepare('UPDATE updates SET input_bundle_key=? WHERE update_id=?').run(f.row(1).input_bundle_key, '2');
  f.buffer.stop();
  const resumed = f.create();
  await f.replay(resumed);
  await f.replay(resumed);
  await f.tick(10000);
  assert.deepEqual(f.calls, [photo]);
  assert.deepEqual(resumed.messagesFor('1'), [photo.payload.message, question.payload.message]);
  assert.equal(f.row(2).status, 'album_member');
});

test('restart without a companion waits only the remaining media window', async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1));
  await f.tick(5000);
  f.buffer.stop();
  const resumed = f.create();
  await f.replay(resumed);
  await f.tick(2499);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.equal(f.calls.length, 1);
});

test('restart recovers a sealed anchor and suppresses replayed companions', async t => {
  const f = fixture(t, { onReady: async () => { throw new Error('crash before admission'); } });
  const photo = f.photo(1);
  await f.buffer.add(photo);
  await assert.rejects(f.buffer.add(f.text(2)), /crash before admission/);
  assert.equal(f.row(1).status, 'received');
  assert.equal(f.row(2).status, 'album_member');
  f.buffer.stop();
  const recovered = createAlbumBuffer({ database: f.db, evaluateAccess: createAccessPolicy({
    allowedUserIds: ['42'], allowedChatIds: [], groupsEnabled: false, botUserId: '99', botUsername: 'fixture_bot' }).evaluate,
    onReady: async item => f.calls.push(item) });
  t.after(() => recovered.stop());
  await f.replay(recovered);
  await f.replay(recovered);
  assert.deepEqual(f.calls, [photo]);
  assert.equal(recovered.messagesFor('1').length, 2);
});

test('100 pending bundles cap timers while an overflow photo and question remain durable', async t => {
  const f = fixture(t, { mediaSettleMs: 75 });
  for (let i = 1; i <= 101; i++) await f.buffer.add(f.photo(i, {}, { thread: String(i) }));
  const timers = t.mock.method(globalThis, 'setTimeout');
  await f.buffer.add(f.photo(102, {}, { thread: '102' }));
  assert.equal(timers.mock.callCount(), 0, 'overflow must not allocate a timer');
  await f.tick(50);
  const question = f.text(103, 'Question for overflow', { thread: '102' });
  assert.equal(await f.buffer.add(question), true);
  assert.ok(f.row(102).input_bundle_key);
  assert.equal(f.row(103).input_bundle_key, f.row(102).input_bundle_key);
  assert.equal(f.row(103).status, 'received');
  assert.equal(f.calls.length, 0);
  await f.buffer.flushLane('42', '1');
  await f.tick(25);
  assert.equal(f.calls.length, 102);
  assert.equal(new Set(f.calls.map(i => i.updateId)).size, 102);
  assert.deepEqual(f.buffer.messagesFor('102').map(m => m.message_id), [102, 103]);
});

test('cancelLane cancels overflow bundles and their persisted companions without admission', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 101; i++) await f.buffer.add(f.photo(i, { media_group_id: `album-${i}` }));
  await f.buffer.add(f.text(102));
  assert.equal(f.calls.length, 0, 'the latest bundle is durably deferred');
  await f.buffer.cancelLane('42', '0');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM updates WHERE status='received'").get().n, 0);
  await f.tick(20000);
  assert.equal(f.calls.length, 0);
});

test('standalone image bursts are bounded to ten media plus one following text', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 11; i++) await f.buffer.add(f.photo(i));
  await f.buffer.add(f.text(12));
  assert.equal(f.calls.length, 1);
  assert.equal(f.buffer.messagesFor('1').length, 11);
  assert.deepEqual(f.buffer.messagesFor('1').map(m => m.message_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
  assert.equal(f.row(11).status, 'rejected');
  assert.equal(await f.buffer.add(f.text(13)), false);
});

test('captionless actual albums also hold non-photo media while single voice stays immediate', async t => {
  const f = fixture(t);
  const video = f.item(1, { media_group_id: 'video-album', video: { file_id: 'video-1' } });
  await f.buffer.add(video);
  await f.tick(5000);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.buffer.add(f.text(2, 'Describe the clip')), true);
  assert.deepEqual(f.calls, [video]);
  assert.equal(f.buffer.messagesFor('1').length, 2);
});

test('failed admission remains cancellable in the same process', async t => {
  const f = fixture(t, { onReady: async () => { throw new Error('admission failed'); } });
  await f.buffer.add(f.photo(1));
  await assert.rejects(f.buffer.add(f.text(2)), /admission failed/);
  await f.buffer.cancelLane('42', '0');
  assert.equal(f.row(1).status, 'cancelled');
  assert.equal(f.row(2).status, 'cancelled');
  f.buffer.stop();
  await f.replay(f.create());
});

test('cancelLane leaves an in-flight admission for the dispatcher to cancel', async t => {
  let release;
  const f = fixture(t, { onReady: () => new Promise(resolve => { release = resolve; }) });
  const photo = f.photo(1);
  await f.buffer.add(photo);
  const dispatch = f.buffer.add(f.text(2));
  assert.equal(typeof release, 'function');
  await f.buffer.add(photo);
  await f.buffer.cancelLane('42', '0');
  assert.equal(f.row(1).status, 'received');
  assert.equal(f.row(2).status, 'album_member');
  release();
  await dispatch;
});

test('companion-first replay reads the whole durable bundle and the immutable anchor payload', async t => {
  const f = fixture(t);
  const photo = f.photo(1);
  await f.buffer.add(photo);
  await f.tick(5000);
  const question = f.text(2);
  f.db.prepare('UPDATE updates SET input_bundle_key=? WHERE update_id=?').run(f.row(1).input_bundle_key, '2');
  f.buffer.stop();
  const resumed = f.create();
  await resumed.add(question);
  await resumed.add({ updateId: '1', payload: { message: { text: 'mutated caller object' } } });
  assert.deepEqual(f.calls, [photo]);
  assert.deepEqual(resumed.messagesFor('1'), [photo.payload.message, question.payload.message]);
});

test('additional media and repeated add do not extend the original 7500ms deadline', async t => {
  const f = fixture(t);
  const photo = f.photo(1);
  await f.buffer.add(photo);
  await f.tick(5000);
  await f.buffer.add(f.photo(2));
  await f.buffer.add(photo);
  await f.tick(2499);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.deepEqual(f.calls, [photo]);
  assert.equal(f.buffer.messagesFor('1').length, 2);
});

test('owner-scoped cancelLane preserves another authorized owner in the same chat and thread', async t => {
  const f = fixture(t);
  const content = { media_group_id: 'same-group', reply_to_message: { from: { id: '99' } } };
  const first = f.photo(1, content, { owner: '42', chat: '-100', thread: '7' });
  const other = f.photo(2, content, { owner: '43', chat: '-100', thread: '7' });
  await f.buffer.add(first);
  await f.buffer.add(other);
  assert.notEqual(f.row(1).input_bundle_key, f.row(2).input_bundle_key);
  await f.buffer.cancelLane('-100', '7', '42');
  assert.equal(f.row(1).status, 'cancelled');
  assert.equal(f.row(2).status, 'received');
  await f.tick(7500);
  assert.deepEqual(f.calls, [other], 'the other owner retains their timer');
  assert.deepEqual(f.buffer.messagesFor('2'), [other.payload.message]);
});

test('cancelLane preserves later, unbuffered media already persisted in the same Telegram batch', async t => {
  const f = fixture(t);
  await f.buffer.add(f.photo(1));
  const command = f.text(2, '/new');
  const nextPhoto = f.photo(3);
  assert.equal(await f.buffer.add(command), false);
  await f.buffer.cancelLane('42', '0', '42');
  assert.equal(f.row(1).status, 'cancelled');
  assert.equal(f.row(3).status, 'received');
  await f.buffer.add(nextPhoto);
  await f.buffer.add(f.text(4, 'Question in the new conversation'));
  assert.deepEqual(f.calls, [nextPhoto]);
  assert.deepEqual(f.buffer.messagesFor('3').map(m => m.message_id), [3, 4]);
});
