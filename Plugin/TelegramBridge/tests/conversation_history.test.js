'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSessionStore } = require('../src/sessionStore');
const { createCompletionStore } = require('../src/completionStore');

function api() {
  let value;
  try { value = require('../src/conversationHistory'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof value?.createConversationHistory, 'function', 'independent conversation input journal is required');
  return value.createConversationHistory;
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-conversation-history-'));
  const stateDir = path.join(root, 'state');
  let now = 1000;
  const clock = () => ++now;
  const session = createSessionStore({ pluginRoot: root, stateDir, defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40, historyMaxBytes: 262144, clock });
  session.open();
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  db.pragma('foreign_keys=ON');
  const ledger = session.createUpdateLedger();
  const scope = session.getOrCreateScope({ chatId: '42' });
  const identity = { scopeKey: scope.key, conversationId: scope.conversationId, ownerUserId: '42' };
  const history = api()(db, { historyMaxMessages: 40, historyMaxBytes: 262144, clock, ...options });
  const completion = createCompletionStore(db, { clock });
  let nextId = 0;
  function input(text, { owner = '42', status, remember = true, updateId, retryOf } = {}) {
    const number = String(++nextId), requestId = `request-${number}`;
    if (!updateId) {
      updateId = number;
      ledger.acceptBatch([{ updateId, updateType: 'message', payload: {
        message: { message_id: Number(number), from: { id: Number(owner) },
          chat: { id: 42, type: 'private' }, text },
      } }]);
      ledger.authorizeAndQueue(updateId, { requestId, messageId: `msg-${number}`, scopeKey: scope.key,
        orderingKey: 'telegram:42:0', ownerUserId: owner, replayPolicy: 'manual' });
    } else {
      ledger.createManualRetry(retryOf, { requestId, messageId: `msg-${number}` });
    }
    ledger.claimRequest(requestId, 'fixture-worker');
    const current = { ...identity, requestId, userText: text, telegramMessageId: number, ownerUserId: owner };
    if (remember) history.rememberInput(current);
    if (status === 'completed') {
      ledger.markEffectStarted(requestId);
      completion.commitCompletion({ requestId, turnId: `turn-${requestId}`, userText: text,
        assistantText: `answer:${text}`, userTelegramMessageId: number,
        segments: [{ text: `answer:${text}`, plainText: `answer:${text}`, parseMode: null }] });
    } else if (status === 'interrupted') {
      ledger.markEffectStarted(requestId);
      ledger.recoverInterruptedRequests();
    } else if (status === 'failed') {
      ledger.failBeforeEffect(requestId, 'DISPATCH_ATTACHMENT_FAILED');
    }
    return current;
  }
  t.after(() => { db.close(); session.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, session, ledger, history, identity, input, clock,
    advance(ms) { now += ms; } };
}

test('accepted drawing input survives interrupted completion and a day gap without replay', t => {
  const f = fixture(t);
  f.input('这个少女是谁', { status: 'completed' });
  const drawing = f.input('照这张画一张', { status: 'interrupted' });
  f.advance(24 * 60 * 60 * 1000);
  const current = f.input('还在吗');
  const before = f.db.prepare('SELECT count(*) n FROM requests').get().n;
  const reopened = api()(f.db, { historyMaxMessages: 40, historyMaxBytes: 262144 });
  const rows = reopened.getHistory(current);
  assert.deepEqual(rows.map(x => [x.role, x.content, x.requestState]), [
    ['user', '这个少女是谁', undefined], ['assistant', 'answer:这个少女是谁', undefined],
    ['user', '照这张画一张', 'interrupted'],
  ]);
  assert.equal(rows.at(-1).requestId, drawing.requestId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get().n, before);
  assert.equal(f.ledger.getRequest(drawing.requestId).status, 'needs_review');
});

test('failed attachment preparation preserves human input but no invented assistant answer', t => {
  const f = fixture(t);
  f.input('看看这个附件', { status: 'failed' });
  const current = f.input('刚才怎么了');
  assert.deepEqual(f.history.getHistory(current).map(x => [x.role, x.content, x.requestState]), [
    ['user', '看看这个附件', 'failed'],
  ]);
});

test('successful turns are merged once and rememberInput is immutable and idempotent', t => {
  const f = fixture(t);
  const first = f.input('hello', { status: 'completed' });
  assert.equal(f.history.rememberInput(first).changed, false);
  assert.throws(() => f.history.rememberInput({ ...first, userText: 'overwritten' }), /Telegram conversation history/);
  const current = f.input('next');
  assert.deepEqual(f.history.getHistory(current).map(x => x.content), ['hello', 'answer:hello']);
  assert.equal(f.db.prepare('SELECT count(*) n FROM conversation_inputs').get().n, 2);
});

test('new conversation, foreign owner and wrong committed scope never receive previous inputs', t => {
  const f = fixture(t);
  const old = f.input('private old request', { status: 'interrupted' });
  assert.throws(() => f.history.rememberInput({ ...old, ownerUserId: '43' }));
  const foreign = f.input('other owner', { owner: '43', status: 'interrupted' });
  const current = f.input('my question');
  assert.deepEqual(f.history.getHistory(current).map(x => x.content), ['private old request']);
  assert.throws(() => f.history.getHistory({ ...current, scopeKey: 'telegram:43:0:ExampleAgent' }));
  const next = f.session.startNewConversation(f.identity.scopeKey);
  assert.deepEqual(f.history.getHistory({ ...f.identity, conversationId: next.conversationId }), []);
  assert.throws(() => f.history.rememberInput({ ...old, conversationId: next.conversationId }));
  assert.equal(f.ledger.getRequest(foreign.requestId).ownerUserId, '43');
});

test('legacy interrupted input is inferred only after a retained current-conversation anchor', t => {
  const f = fixture(t);
  f.input('before current anchor', { status: 'interrupted', remember: false });
  f.input('current conversation anchor', { status: 'completed', remember: false });
  f.input('legacy drawing request', { status: 'interrupted', remember: false });
  const current = f.input('还在吗');
  assert.deepEqual(f.history.getHistory(current).map(x => x.content), [
    'current conversation anchor', 'answer:current conversation anchor', 'legacy drawing request',
  ]);
  const next = f.session.startNewConversation(f.identity.scopeKey);
  assert.deepEqual(f.history.getHistory({ ...f.identity, conversationId: next.conversationId }), []);
});

test('manual retry contributes one human input and its confirmed answer, not a duplicate failed turn', t => {
  const f = fixture(t);
  const first = f.input('draw request', { status: 'interrupted' });
  f.input('draw request', { updateId: '1', retryOf: first.requestId, status: 'completed' });
  const current = f.input('next');
  assert.deepEqual(f.history.getHistory(current).map(x => [x.role, x.content, x.requestState]), [
    ['user', 'draw request', undefined], ['assistant', 'answer:draw request', undefined],
  ]);
});

test('bounds keep newest whole turns and reserve space for the current message', t => {
  const f = fixture(t, { historyMaxMessages: 4, historyMaxBytes: 4096 });
  f.input('old', { status: 'completed' });
  f.input('recent', { status: 'completed' });
  const current = f.input('current');
  assert.deepEqual(f.history.getHistory(current).map(x => x.content), ['recent', 'answer:recent']);
  assert.deepEqual(f.history.getHistory({ ...current, userText: 'x'.repeat(4096) }), []);
});

test('pruned successful inputs are not resurrected from the journal or exposed across Agent scopes', t => {
  const f = fixture(t);
  f.input('obsolete successful question', { status: 'completed' });
  f.db.prepare('DELETE FROM messages').run();
  const current = f.input('current');
  assert.deepEqual(f.history.getHistory(current), []);
  assert.throws(() => f.history.getHistory({ ...current, scopeKey: 'telegram:42:0:SecondAgent' }));
});

test('during an explicit manual retry the same human update is not repeated in historical context',t=>{
  const f=fixture(t),first=f.input('draw',{status:'interrupted'});
  const retry=f.input('draw',{updateId:'1',retryOf:first.requestId});
  assert.deepEqual(f.history.getHistory(retry),[]);
});

test('a pruned successful retry cannot resurrect its earlier interrupted attempt',t=>{
  const f=fixture(t),first=f.input('draw',{status:'interrupted'});
  f.input('draw',{updateId:'1',retryOf:first.requestId,status:'completed'});
  f.db.prepare('DELETE FROM messages').run();
  const current=f.input('next');
  assert.deepEqual(f.history.getHistory(current),[]);
});

test('legacy timestamps equal to the current-conversation anchor cannot establish an after-reset boundary',t=>{
  const f=fixture(t),old=f.input('old conversation unknown',{status:'interrupted',remember:false});
  const anchor=f.input('retained current anchor',{status:'completed',remember:false});
  const at=f.db.prepare('SELECT started_at FROM requests WHERE request_id=?').get(anchor.requestId).started_at;
  f.db.prepare('UPDATE requests SET started_at=? WHERE request_id=?').run(at,old.requestId);
  const current=f.input('next');
  assert.deepEqual(f.history.getHistory(current).map(x=>x.content),['retained current anchor','answer:retained current anchor']);
});

test('same-millisecond updates keep numeric Telegram order and retain the newest at the history boundary',t=>{
  const f=fixture(t);
  for(let i=0;i<8;i++)f.input('earlier '+i,{status:'completed'});
  f.input('ninth',{status:'interrupted'});f.input('tenth',{status:'interrupted'});
  f.db.prepare("UPDATE requests SET started_at=2000 WHERE update_id IN ('9','10')").run();
  f.db.prepare("UPDATE conversation_inputs SET created_at=2000 WHERE request_id IN ('request-9','request-10')").run();
  f.advance(60000);const current=f.input('now');
  assert.deepEqual(f.history.getHistory(current).slice(-2).map(x=>x.content),['ninth','tenth']);
  const bounded=api()(f.db,{historyMaxMessages:2,historyMaxBytes:4096});
  assert.deepEqual(bounded.getHistory(current).map(x=>x.content),['tenth']);
});

for(const remember of [true,false])test(`numeric order precedes the candidate LIMIT for ${remember?'journal':'legacy'} inputs`,t=>{
  const f=fixture(t,{historyMaxMessages:2,historyMaxBytes:4096});
  f.input('anchor',{status:'completed',remember:false});
  for(let id=2;id<=10;id++)f.input('input '+id,{status:'interrupted',remember});
  f.db.prepare("UPDATE requests SET started_at=2000 WHERE update_id<>'1'").run();
  f.db.prepare('UPDATE conversation_inputs SET created_at=2000').run();
  f.advance(60000);const current=f.input('now');
  assert.deepEqual(f.history.getHistory(current).map(x=>x.content),['input 10']);
});

test('rejected Agent selectors remain raw in the journal without poisoning later valid conversation',async t=>{
  const f=fixture(t),rejected=f.input('show {{agent:ExampleAgent}} literally',{status:'interrupted'});
  const current=f.input('hello');let calls=0;
  const client=require('../src/vcpConversationClient').createVcpConversationClient({
    vcpBaseUrl:'http://127.0.0.1:6005/v1',vcpKey:'fixture-key',vcpModel:'fixture-model',allowedAgents:['ExampleAgent'],
    historyMaxMessages:40,historyMaxBytes:262144,fetchImpl:async url=>{calls++;
      const chunks=[{choices:[{delta:{content:'hello'},finish_reason:null}]},
        {id:'chatcmpl-VCP-final-stop-123',choices:[{delta:{},finish_reason:'stop'}]}];
      const r=new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});Object.defineProperty(r,'url',{value:String(url)});return r;
    }});
  const base={requestId:current.requestId,messageId:'fixture-message',scopeKey:current.scopeKey,agent:'ExampleAgent'};
  await assert.rejects(client.complete({...base,history:[],userMessage:rejected.userText}),e=>e.code==='VCP_INPUT_INVALID');
  const history=f.history.getHistory(current).map(({requestId,...m})=>m);
  await client.complete({...base,history,userMessage:'hello'});
  assert.equal(calls,1);
  assert.doesNotMatch(history[0].content,/\{\{\s*agent\s*:/i);
  assert.equal(f.db.prepare('SELECT user_text FROM conversation_inputs WHERE request_id=?').get(rejected.requestId).user_text,rejected.userText);
});

test('historical selector normalization is counted before retention pruning',t=>{
  const f=fixture(t),raw='{{agent:ExampleAgent}}'.repeat(500);
  const first=f.input(raw,{status:'completed'}),current=f.input('hello');
  const rawBytes=[{role:'user',content:raw},{role:'assistant',content:'answer:'+raw},{role:'user',content:'hello'}]
    .reduce((n,m)=>n+Buffer.byteLength(JSON.stringify(m)),0);
  const bounded=api()(f.db,{historyMaxMessages:40,historyMaxBytes:rawBytes+350});
  assert.deepEqual(bounded.getHistory(current),[],'a normalized oversized turn must not poison a valid follow-up');
  assert.equal(f.db.prepare('SELECT user_text FROM conversation_inputs WHERE request_id=?').get(first.requestId).user_text,raw);
});
