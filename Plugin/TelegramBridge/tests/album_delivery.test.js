'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSessionStore } = require('../src/sessionStore');
const { createAccessPolicy } = require('../src/accessPolicy');
const { createAlbumBuffer } = require('../src/albumBuffer');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-album-'));
  const store = createSessionStore({ pluginRoot: root, stateDir: path.join(root, 'state'), defaultAgent: 'ExampleAgent', historyMaxMessages: 40, historyMaxBytes: 262144 });
  store.open();
  const db = new Database(path.join(root, 'state', 'telegram.sqlite3'));
  const ledger = store.createUpdateLedger();
  const policy = createAccessPolicy({ allowedUserIds: ['42'], allowedChatIds: [], groupsEnabled: false, botUserId: '99', botUsername: 'fixture_bot' });
  const calls = [];
  const create = () => createAlbumBuffer({ database: db, evaluateAccess: policy.evaluate,
    onReady: async item => calls.push(item), settleMs: 5000 });
  const buffer = create();
  t.after(() => { buffer.stop(); db.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id, owner = '42', group = 'group-1') => {
    const payload = { message: { message_id: Number(id), from: { id: owner }, chat: { id: owner, type: 'private' },
      media_group_id: group, photo: [{ file_id: 'fixture'+id, file_unique_id: 'unique'+id, width: 10, height: 10 }], caption: id === '1' ? 'describe album' : undefined } };
    ledger.acceptBatch([{ updateId: id, updateType: 'message', payload }]);
    return { updateId: id, payload };
  };
  return { buffer, db, calls, create, add };
}

test('album updates seal into one durable parent and ordered media across restart', async t => {
  const f = fixture(t);
  await f.buffer.add(f.add('2'));
  await f.buffer.add(f.add('1'));
  await f.buffer.flushLane('42', '0');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].updateId, '1');
  assert.deepEqual(f.buffer.messagesFor('1').map(m => m.message_id), [1, 2]);
  assert.equal(f.db.prepare('SELECT status FROM updates WHERE update_id=?').get('2').status, 'album_member');
  const restarted = f.create();
  t.after(() => restarted.stop());
  assert.deepEqual(restarted.messagesFor('1').map(m => m.message_id), [1, 2]);
  await restarted.add(f.add('3', '7'));
  assert.equal(f.calls.length, 1);
});

test('pending albums survive shutdown without consuming source updates', async t => {
  const f = fixture(t);
  const item = f.add('1');
  await f.buffer.add(item);
  f.buffer.stop();
  assert.equal(f.db.prepare('SELECT status FROM updates').get().status, 'received');
  const resumed = f.create();
  t.after(() => resumed.stop());
  await resumed.add(item);
  await resumed.flushLane('42', '0');
  assert.equal(f.calls.length, 1);
});

test('saturated album buffers keep overflow durable instead of standalone dispatch',async t=>{
  const f=fixture(t);
  for(let i=1;i<=101;i++) assert.equal(await f.buffer.add(f.add(String(i),'42','group-'+i)),true);
  assert.equal(f.db.prepare("SELECT status FROM updates WHERE update_id='101'").get().status,'received');
  await f.buffer.flushLane('42','0');
  assert.equal(f.calls.length,101);
});

test('actual albums cap at ten media and reject late arrivals after sealing', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 11; i++) await f.buffer.add(f.add(String(i)));
  await f.buffer.flushLane('42', '0');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.buffer.messagesFor('1').map(m => m.message_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(f.db.prepare("SELECT error_code FROM updates WHERE update_id='11'").get().error_code, 'ALBUM_LIMIT');
  await f.buffer.add(f.add('12'));
  assert.equal(f.db.prepare("SELECT error_code FROM updates WHERE update_id='12'").get().error_code, 'ALBUM_LATE_MEMBER');
  assert.equal(f.calls.length, 1);
});

test('legacy sealed albums without an input bundle key still replay and expose members', async t => {
  const f = fixture(t);
  const first = f.add('1');
  f.add('2');
  f.db.prepare("UPDATE updates SET album_parent_update_id='1',status=CASE update_id WHEN '1' THEN 'received' ELSE 'album_member' END").run();
  const resumed = f.create();
  t.after(() => resumed.stop());
  await resumed.add(first);
  assert.deepEqual(f.calls, [first]);
  assert.deepEqual(resumed.messagesFor('1').map(m => m.message_id), [1, 2]);
});
