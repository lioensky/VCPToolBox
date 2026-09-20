'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('enabled runtime delivers a live async completion without requiring a restart', async (t) => {
  const plugin = loadPlugin();
  const pluginRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(pluginRoot, '.async-live-test-'));
  const projectBase = path.resolve(pluginRoot, '..', '..');
  const taskId = 'test-' + require('node:crypto').randomUUID();
  const resultPath = path.join(projectBase, 'VCPAsyncResults', `AsyncTool-${taskId}.json`);
  t.after(async () => {
    await plugin.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(resultPath, { force: true });
  });
  const sends = [];
  let polls = 0;
  const pm = new EventEmitter();
  pm.getIntegrationCapabilities = () => ({ hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1, asyncCorrelationVersion: 1, approvalResponseMethod: 'handleApprovalResponse' });
  pm.handleApprovalResponse = () => true;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getUpdates' && ++polls > 1) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    if (method === 'sendMessage') sends.push(JSON.parse(options.body));
    const result = method === 'getUpdates' ? [] : method === 'getMe' ? { id: 99, is_bot: true, username: 'fixture_bot' }
      : method === 'getWebhookInfo' ? { url: '' } : { message_id: 500 };
    const response = new Response(JSON.stringify(method === 'models' ? { data: [] } : { ok: true, result }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  await plugin.initialize({ ...raw('enabled'), PROJECT_BASE_PATH: projectBase,
    TELEGRAM_STATE_DIR: path.basename(stateDir) }, { pluginManager: pm, fetchImpl })
    .catch(error => assert.fail('initialize stage=' + error.stage));
  const { createSessionStore } = require('../src/sessionStore');
  const session = createSessionStore({ pluginRoot, stateDir, defaultAgent: 'ExampleAgent', historyMaxMessages: 40, historyMaxBytes: 262144 });
  session.open();
  try {
    const scope = session.getOrCreateScope({ chatId: '42', threadId: '0' });
    const ledger = session.createUpdateLedger();
    ledger.acceptBatch([{ updateId: '900', updateType: 'message', payload: { update_id: 900 } }]);
    ledger.authorizeAndQueue('900', { requestId: 'req-live', messageId: 'msg-live', scopeKey: scope.key,
      orderingKey: 'telegram:42:0', ownerUserId: '42', replayPolicy: 'manual' });
    ledger.claimRequest('req-live', 'fixture');
  } finally { session.close(); }
  pm.emit('async_task_receipt', { type: 'async_task_receipt', data: { correlationVersion: 1,
    pluginName: 'AsyncTool', taskId, parentRequestId: 'req-live', parentMessageId: 'msg-live' } });
  fs.writeFileSync(resultPath, JSON.stringify({ result: 'live-completion' }));
  pm.emit('async_task_completed', { type: 'async_task_completed', data: { correlationVersion: 1,
    pluginName: 'AsyncTool', taskId } });
  const deadline = Date.now() + 2200;
  while (sends.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, 'live-completion');
  pm.emit('async_task_completed', { type: 'async_task_completed', data: { correlationVersion: 1,
    pluginName: 'AsyncTool', taskId } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sends.length, 1);
});

const pluginPath = path.resolve(__dirname, '..', 'TelegramBridge.js');

function loadPlugin() {
  delete require.cache[require.resolve(pluginPath)];
  return require(pluginPath);
}

function raw(mode) {
  return {
    TELEGRAM_MODE: mode,
    TELEGRAM_BOT_TOKEN: '123456789:fixture_token_material_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    TELEGRAM_ALLOWED_USER_IDS: '42',
    TELEGRAM_VCP_KEY: 'fixture-key',
    TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent',
    TELEGRAM_DEFAULT_AGENT: 'ExampleAgent',
    TELEGRAM_VCP_BASE_URL: 'http://127.0.0.1:6005/v1',
    TELEGRAM_VCP_MODEL: 'VCPModelAuto',
    PROJECT_BASE_PATH: path.resolve(__dirname, '..', '..', '..'),
  };
}

test('foreground delivery owns its segments and stop prevents recovery sending the remainder',async t=>{
  const plugin=loadPlugin(),pluginRoot=path.resolve(__dirname,'..');
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.stop-delivery-test-'));
  t.after(async()=>{await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const pm=new EventEmitter();pm.getIntegrationCapabilities=()=>({hostIntegrationVersion:1,approvalCorrelationVersion:1,asyncCorrelationVersion:1,approvalResponseMethod:'handleApprovalResponse'});pm.handleApprovalResponse=()=>true;
  let polls=0,nextPoll,releaseFirst;
  const texts=[];
  const json=(url,result,models=false)=>{const r=new Response(JSON.stringify(models?{data:[]}:{ok:true,result}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;};
  const fetchImpl=async(url,options={})=>{
    const method=String(url).split('/').at(-1);
    if(method==='getUpdates') {
      polls++;
      if(polls===1)return json(url,[{update_id:1,message:{message_id:1,from:{id:42},chat:{id:42,type:'private'},text:'long answer'}}]);
      return new Promise((resolve,reject)=>{nextPoll=updates=>resolve(json(url,updates));options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
    }
    if(String(url).endsWith('/chat/completions')){
      const body='data: '+JSON.stringify({choices:[{delta:{content:'x'.repeat(5000)},finish_reason:null}]})+'\n\n'
        +'data: '+JSON.stringify({id:'chatcmpl-VCP-final-stop-123',choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
      const r=new Response(body,{headers:{'content-type':'text/event-stream'}});Object.defineProperty(r,'url',{value:String(url)});return r;
    }
    if(method==='sendMessage'){
      const text=JSON.parse(options.body).text;texts.push(text);
      if(texts.length===1)await new Promise(resolve=>{releaseFirst=resolve;});
      return json(url,{message_id:500+texts.length});
    }
    return json(url,method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:''}:true,method==='models');
  };
  await plugin.initialize({...raw('enabled'),TELEGRAM_STATE_DIR:path.basename(stateDir)},{pluginManager:pm,fetchImpl});
  let deadline=Date.now()+2000;
  while(!releaseFirst&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(typeof releaseFirst,'function');
  await new Promise(r=>setTimeout(r,1200));
  assert.equal(texts.length,1,'recovery must not race the active foreground sender');
  nextPoll([{update_id:2,message:{message_id:2,from:{id:42},chat:{id:42,type:'private'},text:'/stop',entities:[{type:'bot_command',offset:0,length:5}]}}]);
  deadline=Date.now()+1000;
  while(texts.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.match(texts[1],/Stop requested/);
  releaseFirst();
  await new Promise(r=>setTimeout(r,1200));
  assert.equal(texts.length,2,'unsent reply segments must remain cancelled');
  const DB=require('better-sqlite3'),d=new DB(path.join(stateDir,'telegram.sqlite3'),{readonly:true});
  try{assert.equal(d.prepare("SELECT count(*) n FROM deliveries WHERE status='pending'").get().n,0);}
  finally{d.close();}
});

test('real runtime combines captionless album plus question and keeps uploaded images for follow-ups until new', async t => {
  const plugin=loadPlugin();
  const pluginRoot=path.resolve(__dirname,'..');
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.album-runtime-test-'));
  t.after(async()=>{await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const pm=new EventEmitter();
  pm.getIntegrationCapabilities=()=>({hostIntegrationVersion:1,approvalCorrelationVersion:1,asyncCorrelationVersion:1,approvalResponseMethod:'handleApprovalResponse'});
  pm.handleApprovalResponse=()=>true;
  let polls=0,nextPoll;
  const bodies=[];
  const sends=[];
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
  const fetchImpl=async(url,options={})=>{
    const method=String(url).split('/').at(-1);
    if(method==='getUpdates' && ++polls>1) return new Promise((resolve,reject)=>{
      nextPoll=updates=>{const r=new Response(JSON.stringify({ok:true,result:updates}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});resolve(r);};
      options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    });
    if(method==='chat/completions' || String(url).endsWith('/chat/completions')) {
      bodies.push(JSON.parse(options.body));
      const latest=bodies.at(-1).messages.filter(m=>m.role==='user').at(-1).content;
      const latestText=typeof latest==='string'?latest:latest.find(c=>c.type==='text')?.text;
      if(latestText?.startsWith('照着这张画一张'))throw new Error('fixture upstream disconnected');
      const chunks=[{choices:[{delta:{content:'两张图已收到'},finish_reason:null}]},{id:'chatcmpl-VCP-final-stop-123',choices:[{delta:{},finish_reason:'stop'}]}];
      const response=new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      Object.defineProperty(response,'url',{value:String(url)}); return response;
    }
    if(method==='fixture.png') { const response=new Response(png);Object.defineProperty(response,'url',{value:String(url)});return response; }
    if(method==='sendMessage') sends.push(JSON.parse(options.body));
    const result=method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}
      :method==='getWebhookInfo'?{url:''}
      :method==='getFile'?{file_path:'photos/fixture.png'}
      :method==='getUpdates'?[1,2].map(i=>({update_id:i,message:{message_id:i,from:{id:42},chat:{id:42,type:'private'},media_group_id:'album-test',
        document:{file_id:'photo'+i,file_unique_id:'unique'+i,file_name:'fixture.png',mime_type:'image/png',file_size:png.length}}}))
        .concat([{update_id:3,message:{message_id:3,from:{id:42},chat:{id:42,type:'private'},text:'分别说说这两张图'}}])
      :method==='sendMessageDraft'?true:{message_id:500};
    const response=new Response(JSON.stringify(method==='models'?{data:[]}:{ok:true,result}),{headers:{'content-type':'application/json'}});
    Object.defineProperty(response,'url',{value:String(url)});return response;
  };
  await plugin.initialize({...raw('enabled'),TELEGRAM_STATE_DIR:path.basename(stateDir)}, {pluginManager:pm,fetchImpl});
  const deadline=Date.now()+4000;
  while(sends.length===0&&Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
  assert.equal(bodies.length,1);
  assert.equal(bodies[0].messages.at(-1).content.filter(c=>c.type==='image_url').length,2);
  assert.equal(sends.length,1);
  const DB=require('better-sqlite3');const db=new DB(path.join(stateDir,'telegram.sqlite3'),{readonly:true});
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n,1);
    const history=db.prepare('SELECT content_json FROM messages').all().map(r=>r.content_json).join('');
    assert.match(history,/分别说说这两张图/);
    assert.doesNotMatch(history,/base64|data:image/);
  } finally {db.close();}
  nextPoll([{update_id:4,message:{message_id:4,from:{id:42},chat:{id:42,type:'private'},text:'这个少女有什么特征'}}]);
  let until=Date.now()+2000;while(sends.length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(bodies.length,2);
  assert.equal(bodies[1].messages.at(-1).content,'这个少女有什么特征');
  const historicalPictures=bodies[1].messages.filter(m=>m.role==='user'&&Array.isArray(m.content));
  assert.equal(historicalPictures.length,1);
  assert.equal(historicalPictures[0].content.filter(c=>c.type==='image_url').length,2);
  assert.doesNotMatch(JSON.stringify(bodies[1].messages),/不是新的生成任务|供本次追问参考/);
  nextPoll([{update_id:5,message:{message_id:5,from:{id:42},chat:{id:42,type:'private'},text:'照着这张画一张'}}]);
  until=Date.now()+2000;while(bodies.length<3&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(bodies.length,3);
  assert.equal(bodies[2].messages.at(-1).content,'照着这张画一张');
  nextPoll([{update_id:6,message:{message_id:6,from:{id:42},chat:{id:42,type:'private'},text:'还在吗'}}]);
  until=Date.now()+2000;while(bodies.length<4&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(bodies.length,4,'the failed drawing request is not replayed');
  assert.equal(bodies[3].messages.at(-1).content,'还在吗');
  assert.ok(bodies[3].messages.some(m=>m.role==='user'&&m.content==='照着这张画一张'));
  assert.ok(bodies[3].messages.some(m=>m.role==='system'&&/未确认|不确定|中断/.test(m.content)));
  const journalDb=new DB(path.join(stateDir,'telegram.sqlite3'),{readonly:true});
  try{
    assert.equal(journalDb.prepare('SELECT count(*) n FROM conversation_inputs WHERE request_id=?').get('tg-5').n,1);
    assert.equal(journalDb.prepare('SELECT count(*) n FROM messages WHERE turn_id=?').get('turn-tg-5').n,0);
  }finally{journalDb.close();}
  nextPoll([{update_id:7,message:{message_id:7,from:{id:42},chat:{id:42,type:'private'},text:'/new'}},
    {update_id:8,message:{message_id:8,from:{id:42},chat:{id:42,type:'private'},text:'新会话没有发图片'}}]);
  until=Date.now()+3000;while(bodies.length<5&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(bodies.length,5);assert.equal(typeof bodies[4].messages.at(-1).content,'string');
  assert.equal(bodies[4].messages.filter(m=>m.role==='user').length,1);
});

function fakeRuntime(events) {
  return {
    ensureDirectories() { events.push('directories'); },
    openState() { events.push('database'); },
    async probeTelegram() { events.push('getMe'); events.push('webhook'); },
    async probeVcp() { events.push('vcp'); },
    startHost() { events.push('host'); },
    async recover() { events.push('recovery'); },
    startPoller() { events.push('poller'); },
    beginDrain() {}, abort() {}, async waitForIdle() {}, markNeedsReview() {}, stopHost() {}, close() {},
    snapshot() { return { state: 'ready' }; },
  };
}

test('restart recovery edits the durable preview target for HTML and plain fallback without a second bubble',async t=>{
  const plugin=loadPlugin(),pluginRoot=path.resolve(__dirname,'..');
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.preview-recovery-test-'));
  t.after(async()=>{await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const {createSessionStore}=require('../src/sessionStore'),D=require('better-sqlite3');
  const session=createSessionStore({pluginRoot,stateDir,defaultAgent:'ExampleAgent',historyMaxMessages:40,historyMaxBytes:262144});session.open();
  const scope=session.getOrCreateScope({chatId:'42',threadId:'0'}),ledger=session.createUpdateLedger();
  ledger.acceptBatch([{updateId:'1',updateType:'message',payload:{update_id:1}}]);
  ledger.authorizeAndQueue('1',{requestId:'preview-request',messageId:'preview-msg',scopeKey:scope.key,orderingKey:'telegram:42:0',ownerUserId:'42',replayPolicy:'manual'});
  ledger.claimRequest('preview-request','fixture');ledger.markEffectStarted('preview-request');
  const db=new D(path.join(stateDir,'telegram.sqlite3'));
  require('../src/completionStore').createCompletionStore(db).commitCompletion({requestId:'preview-request',turnId:'preview-turn',userText:'input',assistantText:'done',
    segments:[{text:'<b>done</b>',plainText:'done',parseMode:'HTML'}],previewMessageId:'700'});
  db.prepare(`INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,status,attempt,created_at,updated_at,payload_json,effect_state)
    VALUES(?,?,'failure_notice','telegram_notice','older-request','pending',0,1,1,?,'not_started')`)
    .run('notice-'+'b'.repeat(64),scope.key,JSON.stringify({text:'old failure',plainText:'old failure',parseMode:null}));
  db.close();session.close();
  const pm=new EventEmitter();pm.getIntegrationCapabilities=()=>({hostIntegrationVersion:1,approvalCorrelationVersion:1,asyncCorrelationVersion:1,approvalResponseMethod:'handleApprovalResponse'});pm.handleApprovalResponse=()=>true;
  let polls=0;const sends=[],edits=[];
  const json=(url,result)=>{const r=new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;};
  const fetchImpl=async(url,options={})=>{
    const method=String(url).split('/').at(-1);
    if(method==='getUpdates'&&++polls>1)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    if(method==='sendMessage')sends.push(JSON.parse(options.body));
    if(method==='editMessageText'){
      const params=JSON.parse(options.body);edits.push(params);
      if(params.parse_mode==='HTML')return json(url,{ok:false,error_code:400,description:"Bad Request: can't parse entities"});
    }
    return json(url,method==='models'?{data:[]}:{ok:true,result:method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:''}:method==='getUpdates'?[]:{message_id:700}});
  };
  await plugin.initialize({...raw('enabled'),TELEGRAM_STATE_DIR:path.basename(stateDir)},{pluginManager:pm,fetchImpl});
  const deadline=Date.now()+2500;while(edits.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(sends.length,0);assert.deepEqual(edits.map(x=>String(x.message_id)),['700','700']);
  const checked=new D(path.join(stateDir,'telegram.sqlite3'),{readonly:true});
  try{
    assert.equal(checked.prepare("SELECT status FROM deliveries WHERE source_type='telegram_final'").get().status,'delivered');
    assert.equal(checked.prepare("SELECT status FROM deliveries WHERE source_type='telegram_notice'").get().status,'superseded');
  }finally{checked.close();}
});

test('disabled mode parses config but never constructs runtime, database, timers or network', async () => {
  const plugin = loadPlugin();
  let runtimeConstructed = 0;
  await plugin.initialize({ TELEGRAM_MODE: 'disabled' }, {
    createRuntime() { runtimeConstructed += 1; throw new Error('must not construct'); },
  });
  assert.equal(runtimeConstructed, 0);
  await assert.rejects(plugin.processToolCall({}), (error) => error.code === 'BRIDGE_NOT_READY');
  await plugin.shutdown();
});

test('probe mode follows exact preflight order and never starts getUpdates poller', async () => {
  const plugin = loadPlugin();
  const events = [];
  await plugin.initialize(raw('probe'), {
    createRuntime() { events.push('runtime'); return fakeRuntime(events); },
  });
  assert.deepEqual(events, [
    'runtime', 'directories', 'database', 'getMe', 'webhook', 'vcp', 'host', 'recovery',
  ]);
  const status = await plugin.processToolCall({ command: 'status' });
  assert.equal(status.status, 'success');
  assert.equal(status.result.mode, 'probe');
  await plugin.shutdown();
});

test('trusted host context carries the resolved image key only in memory for rich-media mapping', async () => {
  const plugin = loadPlugin();
  const events = [];
  let capturedContext;
  const pluginManager = {
    getResolvedPluginConfigValue(pluginName, key) {
      assert.equal(pluginName, 'ImageServer');
      assert.equal(key, 'Image_Key');
      return 'fixture-image-key';
    },
  };
  await plugin.initialize({
    ...raw('probe'),
    Key: 'fixture-key',
    PORT: '6005',
  }, {
    pluginManager,
    createRuntime(_config, _dependencies, _projectBasePath, hostContext) {
      capturedContext = hostContext;
      return fakeRuntime(events);
    },
  });

  assert.deepEqual(capturedContext, {
    key: 'fixture-key',
    port: '6005',
    imageKey: 'fixture-image-key',
  });
  assert.equal(Object.isFrozen(capturedContext), true);
  await plugin.shutdown();
});

test('enabled mode starts one poller only after every probe and recovery stage', async () => {
  const plugin = loadPlugin();
  const events = [];
  const runtime = fakeRuntime(events);
  let creates = 0;
  await plugin.initialize(raw('enabled'), {
    createRuntime() { creates += 1; events.push('runtime'); return runtime; },
  });
  assert.deepEqual(events, [
    'runtime', 'directories', 'database', 'getMe', 'webhook', 'vcp', 'host', 'recovery', 'poller',
  ]);
  await plugin.initialize(raw('enabled'), {
    createRuntime() { creates += 1; return runtime; },
  });
  assert.equal(creates, 1);
  await plugin.shutdown();
});

test('manifest advertises probe and enabled only after lifecycle composition exists', () => {
  const manifest = require('../plugin-manifest.json');
  assert.deepEqual(manifest.configSchema.TELEGRAM_MODE.enum, ['disabled', 'probe', 'enabled']);
});

test('default probe runtime composes a frozen Telegram client without starting getUpdates', async (t) => {
  const plugin = loadPlugin();
  const pluginRoot = path.resolve(__dirname, '..');
  const projectBase = path.resolve(pluginRoot, '..', '..');
  const stateDir = fs.mkdtempSync(path.join(pluginRoot, '.lifecycle-test-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const methods = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    const method = target.endsWith('/getMe')
      ? 'getMe'
      : target.endsWith('/getWebhookInfo')
        ? 'getWebhookInfo'
        : target.endsWith('/models')
          ? 'models'
          : 'unexpected';
    methods.push(method);
    const payload = method === 'getMe'
      ? { ok: true, result: { id: 99, is_bot: true, username: 'fixture_bot' } }
      : method === 'getWebhookInfo'
        ? { ok: true, result: { url: '' } }
        : { data: [] };
    const response = new Response(JSON.stringify(payload), {
      status: method === 'unexpected' ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: target });
    Object.defineProperty(response, 'redirected', { value: false });
    return response;
  };
  const pluginManager = new EventEmitter();
  pluginManager.getIntegrationCapabilities = () => ({
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse',
  });
  pluginManager.handleApprovalResponse = () => true;

  try {
    await plugin.initialize({
      ...raw('probe'),
      PROJECT_BASE_PATH: projectBase,
      TELEGRAM_STATE_DIR: path.basename(stateDir),
    }, {
      fetchImpl,
      pluginManager,
    });
  } catch (error) {
    assert.fail(`default runtime failed at safe stage ${error.stage ?? 'unknown'} after ${methods.join(',')}`);
  }
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo', 'models']);
  assert.equal(pluginManager.listenerCount('tool_approval_request'), 1);
  await plugin.shutdown();
  assert.equal(pluginManager.listenerCount('tool_approval_request'), 0);
});

test('in-process cold start accepts exact host VCP identity while HTTP listener is not ready', async (t) => {
  const plugin = loadPlugin();
  const pluginRoot = path.resolve(__dirname, '..');
  const projectBase = path.resolve(pluginRoot, '..', '..');
  const stateDir = fs.mkdtempSync(path.join(pluginRoot, '.cold-start-test-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let modelAttempts = 0;
  let getUpdatesCalls = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/models')) {
      modelAttempts += 1;
      throw new Error('listener not ready');
    }
    if (target.endsWith('/getUpdates')) {
      getUpdatesCalls += 1;
      throw new Error('probe must not poll');
    }
    const result = target.endsWith('/getMe')
      ? { id: 99, is_bot: true, username: 'fixture_bot' }
      : { url: '' };
    const response = new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: target });
    Object.defineProperty(response, 'redirected', { value: false });
    return response;
  };
  const pluginManager = new EventEmitter();
  pluginManager.getIntegrationCapabilities = () => ({
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse',
  });
  pluginManager.handleApprovalResponse = () => true;

  await plugin.initialize({
    ...raw('probe'),
    Key: 'fixture-key',
    PORT: '6005',
    PROJECT_BASE_PATH: projectBase,
    TELEGRAM_STATE_DIR: path.basename(stateDir),
  }, { fetchImpl, pluginManager });
  const status = await plugin.processToolCall({});
  assert.equal(status.result.mode, 'probe');
  assert.equal(status.result.state, 'probe');
  assert.equal(modelAttempts >= 1, true);
  assert.equal(getUpdatesCalls, 0);
  await plugin.shutdown();
});

test('enabled cold start survives the first readiness window and only polls once the VCP HTTP endpoint is ready', async (t) => {
  const plugin = loadPlugin();
  const pluginRoot = path.resolve(__dirname, '..');
  const projectBase = path.resolve(pluginRoot, '..', '..');
  const stateDir = fs.mkdtempSync(path.join(pluginRoot, '.cold-enabled-test-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let vcpReady = false;
  let modelAttempts = 0;
  let getUpdatesCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/models')) {
      modelAttempts += 1;
      if (!vcpReady) throw new Error('listener not ready');
      const response = new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', { value: target });
      Object.defineProperty(response, 'redirected', { value: false });
      return response;
    }
    if (target.endsWith('/getUpdates')) {
      getUpdatesCalls += 1;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const result = target.endsWith('/getMe')
      ? { id: 99, is_bot: true, username: 'fixture_bot' }
      : { url: '' };
    const response = new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: target });
    Object.defineProperty(response, 'redirected', { value: false });
    return response;
  };
  const pluginManager = new EventEmitter();
  pluginManager.getIntegrationCapabilities = () => ({
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse',
  });
  pluginManager.handleApprovalResponse = () => true;

  await plugin.initialize({
    ...raw('enabled'),
    Key: 'fixture-key',
    PORT: '6005',
    PROJECT_BASE_PATH: projectBase,
    TELEGRAM_STATE_DIR: path.basename(stateDir),
  }, { fetchImpl, pluginManager, vcpReadinessRetryMs: 5, vcpReadinessTimeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(getUpdatesCalls, 0);
  vcpReady = true;
  const deadline = Date.now() + 1_000;
  while (getUpdatesCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(modelAttempts >= 2, true);
  assert.equal(getUpdatesCalls, 1);
  await plugin.shutdown();
});

test('VCP readiness cancellation cleanup cannot hang initialization and terminal polling is not reported ready',async t=>{
  const plugin=loadPlugin(),pluginRoot=path.resolve(__dirname,'..');
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.readiness-cleanup-test-'));
  let releaseCancel;
  t.after(async()=>{releaseCancel?.();await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const pm=new EventEmitter();pm.getIntegrationCapabilities=()=>({hostIntegrationVersion:1,approvalCorrelationVersion:1,
    asyncCorrelationVersion:1,approvalResponseMethod:'handleApprovalResponse'});pm.handleApprovalResponse=()=>true;
  const records=[];
  const fetchImpl=async(url)=>{
    const method=String(url).split('/').at(-1);
    const result=method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:''}:[];
    const response=method==='models'?new Response(new ReadableStream({cancel(){return new Promise(r=>{releaseCancel=r;});}}))
      :new Response(JSON.stringify(method==='getUpdates'?{ok:false,error_code:401,description:'unauthorized fixture'}:{ok:true,result}),
        {headers:{'content-type':'application/json'}});
    Object.defineProperty(response,'url',{value:String(url)});return response;
  };
  const initializing=plugin.initialize({...raw('enabled'),TELEGRAM_STATE_DIR:path.basename(stateDir)},
    {pluginManager:pm,fetchImpl,onDiagnostic:r=>records.push(r)});
  let settled=false;initializing.finally(()=>{settled=true;}).catch(()=>{});
  const deadline=Date.now()+400;while(!settled&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(settled,true,'unbounded body.cancel must not block readiness');
  await initializing;
  const until=Date.now()+1000;while(!records.some(x=>x.event_code==='poller_stopped')&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  assert.ok(records.some(x=>x.event_code==='poller_stopped'&&x.error_code==='TELEGRAM_AUTH'));
  await assert.rejects(plugin.processToolCall({}),e=>e.code==='BRIDGE_NOT_READY');
  let rebuilt=0;
  await assert.rejects(plugin.initialize(raw('enabled'),{onDiagnostic(){},createRuntime(){
    rebuilt++;throw new Error('fixture second runtime must not be constructed');
  }}),e=>e.code==='BRIDGE_RUNTIME_REQUIRES_SHUTDOWN');
  assert.equal(rebuilt,0,'a stopped poller may still own in-flight work; explicit shutdown must fence replacement');
});

for(const status of [401,503])test(`failed VCP readiness HTTP ${status} disposes its body without waiting`,async t=>{
  const plugin=loadPlugin(),pluginRoot=path.resolve(__dirname,'..');
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.probe-body-test-'));
  let cancellations=0;
  t.after(async()=>{await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const fetchImpl=async url=>{
    const method=String(url).split('/').at(-1);
    const r=method==='models'?new Response(new ReadableStream({cancel(){cancellations++;return new Promise(()=>{});}}),{status})
      :new Response(JSON.stringify({ok:true,result:method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}:{url:''}}),
        {headers:{'content-type':'application/json'}});
    Object.defineProperty(r,'url',{value:String(url)});return r;
  };
  await assert.rejects(plugin.initialize({...raw('probe'),TELEGRAM_STATE_DIR:path.basename(stateDir)},
    {fetchImpl,onDiagnostic(){}}),e=>e.code==='BRIDGE_INITIALIZATION_FAILED'&&e.stage==='vcp');
  assert.equal(cancellations,1);
});
