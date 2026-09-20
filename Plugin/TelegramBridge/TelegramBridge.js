'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError, parseConfig } = require('./src/config');
const { formatResponseText } = require('./src/responseText');

let lifecycleState = 'stopped';
let lifecycleMode = 'disabled';
let runtime = null;
let initializationPromise = null;
let shutdownPromise = null;
let lifecycleShutdownTimeoutMs = 5_000;
let startupController = null;
let startupTask = null;
const cleanupPromises = new WeakMap();
const DIAGNOSTIC_CODES = new Set(['TELEGRAM_NETWORK','TELEGRAM_TIMEOUT','TELEGRAM_SERVER','TELEGRAM_RATE_LIMIT',
  'TELEGRAM_AUTH','TELEGRAM_FORBIDDEN','TELEGRAM_CONFLICT','TELEGRAM_ABORTED','TELEGRAM_INVALID_RESPONSE',
  'TELEGRAM_BAD_REQUEST','TELEGRAM_RESPONSE_TOO_LARGE','TELEGRAM_REDIRECT_REJECTED','TELEGRAM_DISPATCH_TIMEOUT',
  'BRIDGE_VCP_PROBE_FAILED','BRIDGE_VCP_AUTH','BRIDGE_VCP_UNAVAILABLE','BRIDGE_TELEGRAM_PROBE_FAILED',
  'BRIDGE_INITIALIZATION_FAILED','TELEGRAM_POLLER_FAILED','TELEGRAM_WEBHOOK_ACTIVE']);

function diagnostic(dependencies,event,stage,code,fields={}) {
  const record={timestamp:new Date().toISOString(),event_code:event,stage,
    ...(code?{error_code:DIAGNOSTIC_CODES.has(code)?code:'BRIDGE_INITIALIZATION_FAILED'}:{})};
  for(const key of ['attempt','next_retry_at','last_success_at','receipt_lag_ms']) {
    if(Number.isSafeInteger(fields[key])&&fields[key]>=0)record[key]=fields[key];
  }
  try {
    if(typeof dependencies.onDiagnostic==='function')Promise.resolve(dependencies.onDiagnostic(Object.freeze(record))).catch(()=>{});
    else console.error('[TelegramBridge] '+JSON.stringify(record));
  }catch { /* Diagnostic sinks cannot take the transport offline. */ }
}

function waitForStartup(ms,signal) {
  return new Promise(resolve=>{
    if(signal.aborted){resolve();return;}
    const timer=setTimeout(done,ms);
    function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}
    signal.addEventListener('abort',done,{once:true});
  });
}

function createBridgeError(code) {
  const message = code === 'BRIDGE_NOT_READY'
    ? 'TelegramBridge is not ready.'
    : 'TelegramBridge lifecycle operation failed.';
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeProjectBase(rawConfig) {
  try {
    const value = rawConfig?.PROJECT_BASE_PATH;
    return typeof value === 'string' && value !== ''
      ? path.resolve(value)
      : path.resolve(__dirname, '..', '..');
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
}

function safeHostVcpContext(rawConfig, dependencies) {
  if (!dependencies?.pluginManager || typeof dependencies.pluginManager !== 'object') return null;
  let key;
  let port;
  let imageKey;
  let fileKey;
  try {
    key = rawConfig?.Key;
    port = rawConfig?.PORT;
    imageKey = rawConfig?.Image_Key;
    fileKey = rawConfig?.File_Key;
  } catch {
    return null;
  }
  if (
    typeof key !== 'string' || key === '' || key.trim() !== key || /[\r\n]/.test(key)
    || typeof port !== 'string' || !/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/.test(port)
  ) return null;
  if (typeof imageKey !== 'string' || imageKey === '') {
    try {
      imageKey = dependencies.pluginManager.getResolvedPluginConfigValue?.('ImageServer', 'Image_Key');
    } catch { imageKey = null; }
  }
  if (
    typeof imageKey !== 'string' || imageKey === '' || imageKey.length > 256
    || imageKey.trim() !== imageKey || /[/\\\r\n\u0000-\u001f\u007f-\u009f]/.test(imageKey)
  ) imageKey = null;
  if (typeof fileKey !== 'string' || fileKey === '') {
    try { fileKey = dependencies.pluginManager.getResolvedPluginConfigValue?.('ImageServer','File_Key'); }
    catch { fileKey = null; }
  }
  if (typeof fileKey !== 'string' || !fileKey || fileKey.length>256 || fileKey.trim()!==fileKey
      || /[/\\\r\n\u0000-\u001f\u007f-\u009f]/.test(fileKey)) fileKey=null;
  return Object.freeze({ key, port, ...(imageKey === null ? {} : { imageKey }), ...(fileKey===null ? {} : {fileKey}) });
}

function createDefaultRuntime(config, dependencies, projectBasePath, hostVcpContext = null) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw createBridgeError('BRIDGE_DEPENDENCY_MISSING');
  const vcpReadinessRetryMs = Number.isSafeInteger(dependencies.vcpReadinessRetryMs)
    && dependencies.vcpReadinessRetryMs >= 1 && dependencies.vcpReadinessRetryMs <= 5_000
    ? dependencies.vcpReadinessRetryMs : 250;
  const vcpReadinessTimeoutMs = Number.isSafeInteger(dependencies.vcpReadinessTimeoutMs)
    && dependencies.vcpReadinessTimeoutMs >= 100 && dependencies.vcpReadinessTimeoutMs <= 120_000
    ? dependencies.vcpReadinessTimeoutMs : 60_000;
  const pluginRoot = __dirname;
  const asyncResultsDir = path.join(projectBasePath, 'VCPAsyncResults');
  const outboxDir = path.join(config.stateDir, 'outbox');
  const imageDir = path.join(projectBasePath, 'image');
  const fileDir = path.join(projectBasePath, 'file');
  const background = new Set();
  const activeBindings = new Map();
  const requestControllers = new Map();
  const ownerStoppedRequests = new Set();
  const peerLimiters = new Map();
  let sessionStore;
  let database;
  let ledger;
  let completionStore;
  let conversationHistory;
  let telegramClient;
  let vcpClient;
  let attachmentBridge;
  let outboundResources;
  let albumBuffer;
  let accessPolicy;
  let scopeQueue;
  let dispatcher;
  let approvalBroker;
  let asyncDelivery;
  let hostIntegration;
  let poller;
  let botIdentity;
  let webhookInfo;
  let drainPromise = null;
  let vcpHttpReady = false;
  let vcpReadinessStatus = 'pending';
  let vcpReadinessPromise = null;
  const runtimeAbortController = new AbortController();
  const deliveryAbortController = new AbortController();
  const runtimeStartedAt = Date.now();
  let deliveryTimer = null;
  let deliveryPump = null;
  let deliveryErrorCode = null;
  let pendingStartupRecovery = false;

  function canDeliverAsync() {
    const snapshot = poller?.snapshot?.();
    return config.mode === 'enabled' && !runtimeAbortController.signal.aborted
      && !deliveryAbortController.signal.aborted && vcpHttpReady
      && snapshot?.active === true && snapshot.state === 'running'
      && snapshot.lastSuccessAt >= runtimeStartedAt;
  }

  function pumpAsyncDeliveries() {
    if (!canDeliverAsync()) return;
    if (deliveryPump) return deliveryPump;
    deliveryPump = track(Promise.resolve().then(async () => {
      if (pendingStartupRecovery) {
        await resumeDurableUpdates();
        pendingStartupRecovery = false;
      }
      // A callback can arrive before its receipt: scan only registered tasks.
      asyncDelivery.recoverResults();
      await asyncDelivery.processDue(100, {
        signal: deliveryAbortController.signal, canDeliver: canDeliverAsync,
      });
      await recoverFinalDeliveries();
      await recoverRichMediaDeliveries();
      deliveryErrorCode = null;
    }).catch(() => {
      deliveryErrorCode = 'ASYNC_DELIVERY_PENDING';
    }).finally(() => { deliveryPump = null; }));
    return deliveryPump;
  }

  function track(value) {
    const promise = Promise.resolve(value);
    background.add(promise);
    promise.catch(() => {}).finally(() => background.delete(promise));
    return promise;
  }

  function ensureDirectories() {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(asyncResultsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(imageDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
  }

  function openState() {
    const Database = require('./src/sqliteRuntime').getSqliteDatabase();
    const { createSessionStore } = require('./src/sessionStore');
    const { createCompletionStore } = require('./src/completionStore');
    const { createTelegramClient } = require('./src/telegramClient');
    const { createVcpConversationClient } = require('./src/vcpConversationClient');
    const { createAttachmentBridge } = require('./src/attachmentBridge');
    const { createScopeQueue } = require('./src/scopeQueue');
    sessionStore = createSessionStore({
      pluginRoot,
      stateDir: config.stateDir,
      defaultAgent: config.defaultAgent,
      historyMaxMessages: config.historyMaxMessages,
      historyMaxBytes: config.historyMaxBytes,
    });
    sessionStore.open();
    database = new Database(path.join(config.stateDir, 'telegram.sqlite3'));
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    ledger = sessionStore.createUpdateLedger();
    completionStore = createCompletionStore(database, {
      historyMaxMessages: config.historyMaxMessages,
      historyMaxBytes: config.historyMaxBytes,
    });
    conversationHistory = require('./src/conversationHistory').createConversationHistory(database, {
      historyMaxMessages: config.historyMaxMessages,
      historyMaxBytes: config.historyMaxBytes,
    });
    telegramClient = createTelegramClient({
      token: config.botToken,
      fetchImpl,
      maxInboundBytes: config.maxInboundBytes,
      maxOutboundBytes: config.maxOutboundBytes,
    });
    vcpClient = createVcpConversationClient({
      agentModels: config.agentModels,
      temperature: config.vcpTemperature,
      maxTokens: config.vcpMaxTokens,
      vcpBaseUrl: config.vcpBaseUrl,
      vcpKey: config.vcpKey,
      vcpModel: config.vcpModel,
      allowedAgents: config.allowedAgents,
      historyMaxMessages: config.historyMaxMessages,
      historyMaxBytes: config.historyMaxBytes,
      fetchImpl,
      getAgentMediaContext: agent => require('./src/mediaCatalog').getAgentMediaContext(config.stateDir, imageDir, agent),
    });
    attachmentBridge = createAttachmentBridge({
      stateDir: config.stateDir,
      database,
      telegramClient,
      maxInboundBytes: config.maxInboundBytes,
      maxOutboundBytes: config.maxOutboundBytes,
      allowedOutputRoots: [outboxDir, imageDir, asyncResultsDir, fileDir],
      ...(hostVcpContext?.imageKey ? {
        imageRoot: imageDir,
        vcpImageKey: hostVcpContext.imageKey,
        vcpPort: hostVcpContext.port,
      } : {}),
    });
    const {createOutboundResources}=require('./src/outboundResources');
    outboundResources=createOutboundResources({stateDir:config.stateDir,imageRoot:imageDir,
      allowedOutputRoots:[outboxDir,imageDir,asyncResultsDir,fileDir],vcpFileRoot:fileDir,
      vcpPort:hostVcpContext?.port || new URL(config.vcpBaseUrl).port,
      vcpImageKey:hostVcpContext?.imageKey,vcpFileKey:hostVcpContext?.fileKey,
      telegramClient,maxBytes:config.maxOutboundBytes,
      ...(config.outboundDns === 'cloudflare'
        ? { lookup: require('./src/outboundDns').createOutboundDnsLookup() } : {}),
      ...(hostVcpContext?.imageKey ? {attachmentBridge} : {}),
    });
    scopeQueue = createScopeQueue({
      maxConcurrentScopes: config.maxConcurrentScopes,
      maxQueuedTotal: config.maxQueuedTotal,
      maxQueuedPerScope: config.maxQueuedPerScope,
    });
  }

  async function probeTelegram() {
    botIdentity = await telegramClient.getMe({signal:runtimeAbortController.signal});
    webhookInfo = await telegramClient.getWebhookInfo({signal:runtimeAbortController.signal});
    if (
      !botIdentity || botIdentity.is_bot !== true
      || !Number.isSafeInteger(botIdentity.id) || botIdentity.id < 1
      || typeof botIdentity.username !== 'string' || botIdentity.username === ''
      || !webhookInfo || webhookInfo.url !== ''
    ) throw createBridgeError('BRIDGE_TELEGRAM_PROBE_FAILED');
  }

  async function probeVcpHttp() {
    const url = `${config.vcpBaseUrl}/models`;
    const controller = new AbortController();
    const abort = () => controller.abort('shutdown');
    if (runtimeAbortController.signal.aborted) abort();
    else runtimeAbortController.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), 10_000);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${config.vcpKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response?.url !== url || response?.redirected !== false) {
        throw createBridgeError('BRIDGE_VCP_PROBE_FAILED');
      }
      if(response.status===401||response.status===403)throw createBridgeError('BRIDGE_VCP_AUTH');
      if(response.status>=500&&response.status<=599)throw createBridgeError('BRIDGE_VCP_UNAVAILABLE');
      if(response.ok!==true)throw createBridgeError('BRIDGE_VCP_PROBE_FAILED');
      vcpHttpReady = true;
      vcpReadinessStatus = 'ready';
    } catch (error) {
      if (['BRIDGE_VCP_PROBE_FAILED','BRIDGE_VCP_AUTH','BRIDGE_VCP_UNAVAILABLE'].includes(error?.code)) throw error;
      throw createBridgeError('BRIDGE_VCP_UNAVAILABLE');
    } finally {
      try { Promise.resolve(response?.body?.cancel?.()).catch(()=>{}); } catch { /* best effort; never block readiness */ }
      clearTimeout(timer);
      runtimeAbortController.signal.removeEventListener('abort', abort);
    }
  }

  function waitForRetry(delay=vcpReadinessRetryMs) {
    return new Promise((resolve) => {
      if(runtimeAbortController.signal.aborted){resolve();return;}
      const timer = setTimeout(done, delay);
      function done() {
        clearTimeout(timer);
        runtimeAbortController.signal.removeEventListener('abort', done);
        resolve();
      }
      runtimeAbortController.signal.addEventListener('abort', done, { once: true });
    });
  }

  async function waitForVcpHttp() {
    const deadline = Date.now() + vcpReadinessTimeoutMs;
    let delayedAttempts=0;
    while (!runtimeAbortController.signal.aborted) {
      try {
        await probeVcpHttp();
        if(delayedAttempts)diagnostic(dependencies,'vcp_recovered','vcp',null);
        return true;
      } catch(error) {
        if(runtimeAbortController.signal.aborted)return false;
        if(error?.code!=='BRIDGE_VCP_UNAVAILABLE'){
          vcpReadinessStatus = 'failed';
          lifecycleState = 'failed';
          diagnostic(dependencies,'vcp_failed','vcp',error?.code);
          throw error;
        }
        if(Date.now()>=deadline){
          vcpReadinessStatus='recovering';
          const delay=Math.min(30_000,vcpReadinessRetryMs*(2**Math.min(++delayedAttempts,10)));
          diagnostic(dependencies,'vcp_backoff','vcp',error.code,{attempt:delayedAttempts,next_retry_at:Date.now()+delay});
          await waitForRetry(delay);
          continue;
        }
        await waitForRetry();
      }
    }
    return false;
  }

  async function probeVcp() {
    if (typeof dependencies.probeVcp === 'function') {
      await dependencies.probeVcp(config);
      vcpHttpReady = true;
      vcpReadinessStatus = 'ready';
      return;
    }
    try {
      await probeVcpHttp();
    } catch (error) {
      const hostOrigins = hostVcpContext === null ? [] : [
        `http://127.0.0.1:${hostVcpContext.port}/v1`,
        `http://[::1]:${hostVcpContext.port}/v1`,
      ];
      if (error?.code!=='BRIDGE_VCP_UNAVAILABLE'||hostVcpContext?.key !== config.vcpKey
          || !hostOrigins.includes(config.vcpBaseUrl)) throw error;
      vcpReadinessStatus = 'waiting';
      vcpReadinessPromise = track(waitForVcpHttp());
    }
  }

  function peerLimiter(chatId) {
    const { createTelegramPeerLimiter } = require('./src/streamRenderer');
    if (!peerLimiters.has(chatId)) peerLimiters.set(chatId, createTelegramPeerLimiter());
    return peerLimiters.get(chatId);
  }

  async function respond(payload) {
    return telegramClient.sendMessage({
      chat_id: payload.chatId,
      message_thread_id: payload.threadId,
      text: formatResponseText(payload),
    });
  }

  function followAdmission(admission) {
    if (!admission.completion) return;
    track(admission.completion.catch(() => {
      const controller=requestControllers.get(admission.requestId);
      const ownerStopped=ownerStoppedRequests.has(admission.requestId) || (controller?.signal.aborted && controller.signal.reason==='owner_stop');
      ownerStoppedRequests.delete(admission.requestId);
      endRequest(admission.requestId);
      if(ownerStopped || runtimeAbortController.signal.aborted || !database?.open) return;
      const row=database.prepare(`SELECT r.scope_key,r.owner_user_id,s.chat_id FROM requests r
        JOIN scopes s ON s.scope_key=r.scope_key WHERE r.request_id=?`).get(admission.requestId);
      if(!row || row.chat_id!==row.owner_user_id || !config.allowedUserIds.includes(row.owner_user_id)) return;
      const text='这次请求未完整完成，已保留状态。可用 /retry 查看记录；若工具可能已经执行，请先核对结果。';
      const payload=JSON.stringify({text,plainText:text,parseMode:null});
      const stamp=Date.now();
      database.prepare(`INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,status,
        attempt,created_at,updated_at,payload_json,payload_sha256,effect_state)
        VALUES(?,?,'failure_notice','telegram_notice',?,'pending',0,?,?,?,?,'not_started')
        ON CONFLICT(idempotency_key) DO NOTHING`).run('notice-'+crypto.createHash('sha256').update(admission.requestId).digest('hex'),
          row.scope_key,admission.requestId,stamp,stamp,payload,crypto.createHash('sha256').update(payload).digest('hex'));
    }));
  }

  function getActiveStopBinding(query) {
    const key = `telegram:${query.chatId}:${query.threadId}`;
    const binding = activeBindings.get(key);
    if (!binding || binding.ownerUserId !== query.ownerUserId) return null;
    if (query.draftId !== undefined && binding.draftId !== query.draftId) return null;
    return Object.freeze({ ...binding });
  }

  function beginRequest(input) {
    let controller = requestControllers.get(input.requestId);
    if (!controller) { controller = new AbortController(); requestControllers.set(input.requestId,controller); }
    const key=`telegram:${input.chatId}:${input.threadId}`;
    if(activeBindings.get(key)?.requestId !== input.requestId) activeBindings.set(key,Object.freeze({
      requestId:input.requestId,ownerUserId:input.ownerUserId,chatId:input.chatId,threadId:input.threadId,draftId:null,
    }));
    return controller;
  }
  function endRequest(requestId) {
    requestControllers.delete(requestId);
    for(const [key,binding] of activeBindings) if(binding.requestId===requestId) activeBindings.delete(key);
  }
  async function stopRequest(input) {
    const controller=requestControllers.get(input.requestId);
    if(!controller || controller.signal.aborted) return {stopped:false,requestId:input.requestId};
    const stopPromise=vcpClient.stop({requestId:input.requestId});
    ownerStoppedRequests.add(input.requestId);
    controller.abort('owner_stop');
    database.prepare(`UPDATE deliveries SET status='cancelled',updated_at=?
      WHERE source_key=? AND source_type IN ('telegram_final','telegram_rich_media')
      AND status IN ('pending','retrying') AND effect_state='not_started'`).run(Date.now(),input.requestId);
    database.prepare(`UPDATE deliveries SET status='needs_review',effect_state='unknown',
      last_error_code='OWNER_STOP_DURING_SEND',updated_at=?
      WHERE source_key=? AND source_type IN ('telegram_final','telegram_rich_media') AND status='sending'`)
      .run(Date.now(),input.requestId);
    approvalBroker?.cancelRequest(input.requestId);
    track(stopPromise);
    return {stopped:true,requestId:input.requestId};
  }

  async function conversation(context) {
    const { createStreamRenderer } = require('./src/streamRenderer');
    const { prepareVcpInput } = require('./src/inboundContent');
    const controller=beginRequest(context);
    const signal=AbortSignal.any([controller.signal,runtimeAbortController.signal]);
    const prepared=prepareVcpInput(context.attachments,config.stateDir);
    const images=[...prepared.images],media=prepared.media,textAttachments=prepared.textAttachments;
    const imageContext=require('./src/inboundImageContext');
    const imageIdentity={requestId:context.requestId,scopeKey:context.scope.key,
      conversationId:context.scope.conversationId,ownerUserId:context.ownerUserId};
    if(images.length) imageContext.rememberInboundImages(database,imageIdentity);
    const request = ledger.getRequest(context.requestId);
    const albumMessages = albumBuffer?.messagesFor(request?.updateId) ?? [];
    const userText = albumMessages.length > 0
      ? albumMessages.map(m => m.caption || m.text || '').filter(Boolean).join('\n') || `[相册：${albumMessages.length} 项附件]`
      : context.text || `[收到 ${context.attachments.length} 项附件]`;
    let previousImageContext='';
    const asksForBotImage=require('./src/sentImageContext').asksForSentImage(userText);
    if(images.length===0 && asksForBotImage && outboundResources) {
      const previous=require('./src/sentImageContext').findLastSentImage(database,context.scope.key);
      if(previous) {
        const data=outboundResources.readForModel(previous);
        if(data) { images.push(data);previousImageContext='\n附图是此 Agent 当前会话最近发送的图片，供本次追问参考。'; }
      }
    }
    const attachmentText = textAttachments ? '\n\n'+textAttachments : '';
    const sourceRow=database.prepare(`SELECT u.payload_json FROM requests r JOIN updates u ON u.update_id=r.update_id
      WHERE r.request_id=?`).get(context.requestId);
    const quoted=sourceRow ? JSON.parse(sourceRow.payload_json)?.message?.reply_to_message : null;
    const quotedText=typeof quoted?.text==='string' ? quoted.text : typeof quoted?.caption==='string' ? quoted.caption : '';
    const replyContext=quotedText ? '\n\n引用消息（仅作上下文）：\n'+quotedText.slice(0,4000) : '';
    const userMessage=userText+previousImageContext+replyContext+attachmentText;
    const history=imageContext.attachHistoryImages(database,imageIdentity,
      conversationHistory.getHistory({...imageIdentity,userText:userMessage}),config.stateDir,
      {currentImages:images,currentMedia:media}).map(({requestId,...message})=>message);
    const renderer = createStreamRenderer({
      telegramClient,
      completionStore,
      requestId: context.requestId,
      chatId: context.chatId,
      threadId: context.threadId,
      privateChat: !context.chatId.startsWith('-'),
      mode: config.streamMode,
      signal,
      peerLimiter: peerLimiter(context.chatId),
      mediaBridge: outboundResources ? {
        resolveVcpImageCandidate: candidate => outboundResources.resolve(candidate, { signal }),
        sendRichMedia: input => outboundResources.send({ ...input, signal }),
      } : attachmentBridge,
    });
    const draftId = !context.chatId.startsWith('-')
      ? completionStore.getOrCreateDraftId(context.requestId)
      : null;
    const orderingKey = `telegram:${context.chatId}:${context.threadId}`;
    activeBindings.set(orderingKey, Object.freeze({
      requestId: context.requestId,
      ownerUserId: context.ownerUserId,
      chatId: context.chatId,
      threadId: context.threadId,
      draftId,
    }));
    try {
      await vcpClient.complete({
        requestId: context.requestId,
        messageId: context.messageId,
        scopeKey: context.scope.key,
        agent: context.scope.currentAgent,
        history,
        userMessage,
        images,
        media,
        signal,
        onDelta(event) { renderer.pushDelta(event.delta); },
      });
      await renderer.finish({
        turnId: `turn-${context.requestId}`,
        userText,
        userTelegramMessageId: context.telegramMessageId,
      });
      return Object.freeze({ accepted: true, completionPersisted: true });
    } finally {
      endRequest(context.requestId);
    }
  }

  async function retry(input) {
    const original = ledger.getRequest(input.targetRequestId);
    if (!original || original.ownerUserId !== input.ownerUserId || original.scopeKey !== input.scopeKey) {
      return { accepted: false };
    }
    const requestId = `retry-${crypto.randomUUID()}`;
    const messageId = `retrymsg-${crypto.randomUUID()}`;
    const created = ledger.createManualRetry(input.targetRequestId, { requestId, messageId });
    if (created.changed !== true) return { accepted: false };
    const row = database.prepare(`
      SELECT r.update_id, u.payload_json FROM requests AS r
      JOIN updates AS u ON u.update_id = r.update_id WHERE r.request_id = ?
    `).get(requestId);
    const admission = await dispatcher.resume({
      requestId, messageId, updateId: row.update_id, update: JSON.parse(row.payload_json),
    });
    followAdmission(admission);
    return { accepted: admission.status === 'queued' };
  }

  function listTasks(input) {
    return database.prepare(`
      SELECT a.task_id AS taskId, a.status
      FROM async_tasks AS a JOIN requests AS r ON r.request_id = a.request_id
      WHERE r.owner_user_id = ? AND a.scope_key = ?
      ORDER BY a.updated_at DESC LIMIT 50
    `).all(input.ownerUserId, input.scopeKey);
  }

  function status() {
    let queueState = null;
    let pollerState = null;
    let deadLetters = 0;
    try { queueState = scopeQueue?.snapshot?.() ?? null; } catch { /* use safe defaults */ }
    try { pollerState = poller?.snapshot?.() ?? null; } catch { /* use safe defaults */ }
    try {
      deadLetters = database?.prepare?.(`
        SELECT COUNT(*) AS count FROM dead_letters
        WHERE source_type <> 'poller_state'
      `).get()?.count ?? 0;
    } catch { deadLetters = 0; }
    return {
      mode: config.mode,
      state: config.mode==='enabled'&&lifecycleState==='ready'
        &&(!vcpHttpReady||pollerState?.stale||!(pollerState?.lastSuccessAt>=runtimeStartedAt))?'recovering':lifecycleState,
      vcpReadiness: vcpReadinessStatus,
      pollerState: pollerState?.state ?? 'unavailable',
      lastPollSuccessAt: pollerState?.lastSuccessAt ?? null,
      latestBatchReceiptLagMs: pollerState?.latestBatchReceiptLagMs ?? null,
      activeRequests: activeBindings.size,
      queuedRequests: queueState?.queued ?? 0,
      deadLetters,
    };
  }

  async function recoverFinalDeliveries() {
    if (!canDeliverAsync()) return;
    const notices=database.prepare("SELECT * FROM deliveries WHERE source_type='telegram_notice' AND status='pending' LIMIT 20").all()
      .map(row=>({idempotencyKey:row.idempotency_key,scopeKey:row.scope_key,payload:JSON.parse(row.payload_json)}));
    for (const item of [...completionStore.listPendingDeliveries(100),...notices]) {
      if (!canDeliverAsync()) break;
      const persisted=database.prepare('SELECT source_type,source_key,segment_index FROM deliveries WHERE idempotency_key=?').get(item.idempotencyKey);
      if(requestControllers.has(persisted?.source_key)) continue;
      if(persisted?.source_type==='telegram_notice') {
        const stale=database.prepare(`UPDATE deliveries AS notice SET status='superseded',
          last_error_code='NOTICE_SUPERSEDED',updated_at=? WHERE idempotency_key=?
          AND status='pending' AND effect_state='not_started' AND EXISTS(
            SELECT 1 FROM deliveries newer WHERE newer.scope_key=notice.scope_key
              AND newer.source_type='telegram_final' AND newer.source_key<>notice.source_key
              AND newer.status='delivered' AND newer.delivered_at>notice.created_at)`)
          .run(Date.now(),item.idempotencyKey);
        if(stale.changes)continue;
      }
      if(persisted?.source_type==='telegram_final' && database.prepare(`SELECT COUNT(*) n FROM deliveries
        WHERE source_type='telegram_final' AND source_key=? AND segment_index < ? AND status <> 'delivered'`)
        .get(persisted.source_key,persisted.segment_index).n > 0) continue;
      const claim = completionStore.claimDelivery(item.idempotencyKey);
      if (claim.changed !== true) continue;
      try {
        const target = database.prepare(`SELECT chat_id, thread_id FROM scopes WHERE scope_key = ?`).get(item.scopeKey);
        const previewMessageId = item.payload.previewMessageId;
        const send = previewMessageId ? telegramClient.editMessageText : telegramClient.sendMessage;
        const targetFields = {chat_id:target.chat_id,message_thread_id:target.thread_id,
          ...(previewMessageId ? {message_id:previewMessageId} : {})};
        let response;
        try {
          response = await send({
            ...targetFields,
            text: item.payload.text,
            ...(item.payload.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
          }, { signal: deliveryAbortController.signal });
        } catch (error) {
          if (!canDeliverAsync()) throw error;
          if (error?.code !== 'TELEGRAM_BAD_REQUEST' || item.payload.parseMode !== 'HTML') throw error;
          response = await send({
            ...targetFields,
            text: item.payload.plainText,
          }, { signal: deliveryAbortController.signal });
        }
        const messageId = typeof response?.message_id === 'number'
          ? String(response.message_id) : response?.message_id;
        if (database.open) completionStore.markDeliveryDelivered(item.idempotencyKey, messageId);
      } catch {
        if (database.open) completionStore.markDeliveryUnknown(item.idempotencyKey, 'TELEGRAM_NETWORK_UNKNOWN');
      }
    }
  }

  async function recoverRichMediaDeliveries() {
    if (!canDeliverAsync()) return;
    for (const item of completionStore.listPendingMediaDeliveries(100)) {
      if (!canDeliverAsync()) break;
      if(requestControllers.has(item.requestId)) continue;
      const outstandingText = database.prepare(`
        SELECT COUNT(*) AS count FROM deliveries
        WHERE source_type = 'telegram_final' AND source_key = ? AND status <> 'delivered'
      `).get(item.requestId).count;
      if (outstandingText !== 0) continue;
      const target = database.prepare(`
        SELECT chat_id, thread_id FROM scopes WHERE scope_key = ?
      `).get(item.scopeKey);
      if (!target) continue;
      const claim = completionStore.claimDelivery(item.idempotencyKey);
      if (claim.changed !== true) continue;
      try {
        const sender = outboundResources ? outboundResources.send : attachmentBridge.sendRichMedia;
        const response = await sender({
          chatId: target.chat_id,
          threadId: target.thread_id,
          media: item.payload,
          signal: deliveryAbortController.signal,
        });
        if (database.open) completionStore.markDeliveryDelivered(item.idempotencyKey, response.messageId);
      } catch {
        if (database.open) completionStore.markDeliveryUnknown(item.idempotencyKey, 'TELEGRAM_MEDIA_NETWORK_UNKNOWN');
      }
    }
  }

  async function onBatch(items,control={}) {
    for (const item of items) {
      if(runtimeAbortController.signal.aborted||control.signal?.aborted)return;
      if (item.rejectErrorCode) continue;
      try {
        if (item.updateType === 'callback_query') {
          await approvalBroker.handleCallback(item.payload.callback_query);
          ledger.rejectUpdate(item.updateId, 'CALLBACK_HANDLED');
          continue;
        }
        const access = accessPolicy.evaluate(item.payload);
        const cancelsBufferedInput=access.authorization==='authorized' && (access.kind==='native_stop'
          || (access.kind==='message' && /^\/(?:stop|new)(?:@\w+)?\s*$/.test(item.payload.message?.text || '')));
        if(cancelsBufferedInput) await albumBuffer?.cancelLane(access.chatId,access.threadId,access.userId);
        if(runtimeAbortController.signal.aborted||control.signal?.aborted)return;
        if (albumBuffer && await albumBuffer.add(item)) continue;
        if (access.authorization === 'authorized' && access.kind === 'message'
            && !cancelsBufferedInput) {
          await albumBuffer?.flushLane(access.chatId, access.threadId);
        }
        if(runtimeAbortController.signal.aborted||control.signal?.aborted)return;
        const admission = await dispatcher.dispatch({ updateId: item.updateId, update: item.payload });
        followAdmission(admission);
      } catch {
        // The update remains durable for recovery or manual review.
      }
    }
  }

  function startHost() {
    const { createAccessPolicy } = require('./src/accessPolicy');
    const { createUpdateDispatcher } = require('./src/updateDispatcher');
    const { createApprovalBroker } = require('./src/approvalBroker');
    const { createAsyncDelivery } = require('./src/asyncDelivery');
    const { createHostIntegration } = require('./src/hostIntegration');
    const { createTelegramPoller } = require('./src/telegramPoller');
    accessPolicy = createAccessPolicy({
      allowedUserIds: config.allowedUserIds,
      allowedChatIds: config.allowedChatIds,
      groupsEnabled: config.groupsEnabled,
      botUserId: String(botIdentity.id),
      botUsername: botIdentity.username,
    });
    const capabilities = {
      respond,
      async prepareAttachments(input) {
        const controller=beginRequest(input);
        const signal=AbortSignal.any([controller.signal,runtimeAbortController.signal]);
        try {
        const request = ledger.getRequest(input.requestId);
        const messages = albumBuffer?.messagesFor(request?.updateId) ?? [];
        const scope=sessionStore.getActiveScope({chatId:input.chatId,threadId:input.threadId});
        conversationHistory.rememberInput({requestId:input.requestId,scopeKey:input.scopeKey,
          conversationId:scope.conversationId,ownerUserId:input.ownerUserId,
          telegramMessageId:input.telegramMessageId,
          userText:require('./src/conversationHistory').inputText(messages.length?messages:[input.message])});
        if (messages.length > 0) {
          const attachments = [];
          for (const message of messages) {
            attachments.push(...await attachmentBridge.ingestMessage({
            scopeKey: input.scopeKey, requestId: input.requestId,
            telegramMessageId: String(message.message_id), message,
            signal,
          }));
            require('./src/inboundImageContext').rememberInboundImages(database,{requestId:input.requestId,
              scopeKey:input.scopeKey,conversationId:scope.conversationId,ownerUserId:input.ownerUserId});
          }
          return attachments;
        }
        const ownReply=input.message?.reply_to_message;
        const message=(!input.message.photo&&!input.message.document&&!input.message.video&&!input.message.voice&&!input.message.audio&&!input.message.animation
          && String(ownReply?.from?.id)===String(botIdentity.id)) ? ownReply : input.message;
        const attachments=await attachmentBridge.ingestMessage({
          scopeKey: input.scopeKey,
          requestId: input.requestId,
          telegramMessageId: input.telegramMessageId,
          message,
          signal,
        });
        require('./src/inboundImageContext').rememberInboundImages(database,{requestId:input.requestId,
          scopeKey:input.scopeKey,conversationId:scope.conversationId,ownerUserId:input.ownerUserId});
        return attachments;
        } catch(error) { endRequest(input.requestId); throw error; }
      },
      conversation,
      getActiveStopBinding,
      stop: stopRequest,
      retry,
      retryCandidates(input) { return database.prepare(`SELECT request_id requestId,status FROM requests
        WHERE owner_user_id=? AND scope_key=? AND status IN ('retryable_failed','needs_review')
        ORDER BY updated_at DESC LIMIT 10`).all(input.ownerUserId,input.scopeKey); },
      tasks: listTasks,
      status,
    };
    dispatcher = createUpdateDispatcher({
      accessPolicy,
      sessionStore,
      scopeQueue,
      updateLedger: ledger,
      allowedAgents: config.allowedAgents,
      defaultAgent: config.defaultAgent,
      capabilities,
      createRequestId: ({ updateId }) => `tg-${updateId}`,
      createMessageId: ({ updateId, telegramMessageId }) => `tgm-${telegramMessageId}-${updateId}`,
    });
    const { createAlbumBuffer } = require('./src/albumBuffer');
    albumBuffer = createAlbumBuffer({ database, evaluateAccess: accessPolicy.evaluate,
      onReady: async item => {
        const admission = await dispatcher.dispatch({ updateId: item.updateId, update: item.payload });
        followAdmission(admission);
      },
      onError: (_code,id) => { if(!runtimeAbortController.signal.aborted) track(respond({type:'album_incomplete',chatId:id.chat,threadId:id.thread})); },
    });
    const hostHolder = { current: null };
    approvalBroker = createApprovalBroker({
      database, ledger, telegramClient,
      hostIntegration: { respondApproval(...args) { return hostHolder.current.respondApproval(...args); } },
    });
    asyncDelivery = createAsyncDelivery({
      database, ledger, telegramClient, asyncResultsDir,
      mediaBridge: outboundResources,
      proactiveEnabled: config.proactiveEnabled,
      maxResultBytes: 16 * 1024 * 1024,
    });
    hostIntegration = createHostIntegration({
      pluginManager: dependencies.pluginManager,
      onApproval: (event) => approvalBroker.handleApprovalEvent(event),
      onAsyncReceipt: (event) => asyncDelivery.handleReceipt(event),
      onAsyncCompleted: (event) => {
        const outcome = asyncDelivery.handleCompleted(event);
        pumpAsyncDeliveries();
        return outcome;
      },
    });
    hostHolder.current = hostIntegration;
    hostIntegration.start();
    const cachedProbeClient = Object.freeze({
      getMe: async () => botIdentity,
      getWebhookInfo: async () => webhookInfo,
      getUpdates: (...args) => telegramClient.getUpdates(...args),
    });
    poller = createTelegramPoller({
      client: cachedProbeClient,
      ledger,
      timeoutSec: config.pollTimeoutSec,
      limit: config.updateLimit,
      onBatch,
      onStateChange(snapshot){
        const event={ready:'poller_ready',backoff:'poller_backoff',polling:'poller_retry',
          dispatching:'batch_dispatch',fatal:'poller_failed',duplicate_poller:'duplicate_poller'}[snapshot.phase];
        if(event)diagnostic(dependencies,event,'poller',snapshot.lastErrorCode,{
          attempt:snapshot.failureCount,next_retry_at:snapshot.nextRetryAt,
          last_success_at:snapshot.lastSuccessAt,receipt_lag_ms:snapshot.latestBatchReceiptLagMs});
      },
    });
  }

  async function recover() {
    ledger.recoverInterruptedRequests();
    asyncDelivery.recoverResults();
    pendingStartupRecovery = true;
  }

  async function resumeDurableUpdates() {
    const received = database.prepare(`
      SELECT update_id, update_type, payload_json FROM updates
      WHERE status IN ('received','authorized') ORDER BY received_at, update_id
    `).all();
    for (const row of received) await onBatch([{
      updateId: row.update_id,
      updateType: row.update_type,
      payload: JSON.parse(row.payload_json),
      rejectErrorCode: null,
    }]);
    const ready = database.prepare(`
      SELECT r.request_id, r.message_id, r.update_id, u.payload_json
      FROM requests AS r JOIN updates AS u ON u.update_id = r.update_id
      WHERE r.status = 'queued' AND r.effect_state = 'not_started'
      ORDER BY r.updated_at, r.request_id
    `).all();
    for (const row of ready) {
      try {
        const admission = await dispatcher.resume({
          requestId: row.request_id,
          messageId: row.message_id,
          updateId: row.update_id,
          update: JSON.parse(row.payload_json),
        });
        followAdmission(admission);
      } catch { /* remains durable */ }
    }
  }

  function startPoller() {
    track((async () => {
      const ready = vcpReadinessPromise === null
        ? vcpHttpReady
        : await vcpReadinessPromise;
      if (ready && !runtimeAbortController.signal.aborted) {
        deliveryTimer = setInterval(pumpAsyncDeliveries, 1000);
        deliveryTimer.unref?.();
        pumpAsyncDeliveries();
        try { await poller.start(); }
        finally {
          clearInterval(deliveryTimer);
          deliveryTimer = null;
          deliveryAbortController.abort('poller_stopped');
          if(!runtimeAbortController.signal.aborted){
            lifecycleState='failed';
            diagnostic(dependencies,'poller_stopped','poller',poller.snapshot().lastErrorCode||'TELEGRAM_POLLER_FAILED');
          }
        }
      }
    })());
  }

  function beginDrain() {
    if (!drainPromise) drainPromise = scopeQueue?.beginDrain?.() ?? Promise.resolve();
  }

  function abort() {
    albumBuffer?.stop();
    if (deliveryTimer !== null) { clearInterval(deliveryTimer); deliveryTimer = null; }
    deliveryAbortController.abort('shutdown');
    runtimeAbortController.abort('shutdown');
    for (const controller of requestControllers.values()) controller.abort('shutdown');
    if (poller) track(poller.stop());
    for (const binding of activeBindings.values()) track(vcpClient.stop({ requestId: binding.requestId }));
  }

  async function waitForIdle() {
    if (drainPromise) await drainPromise;
    await Promise.allSettled([...background]);
  }

  function markNeedsReview() {
    try { ledger?.recoverInterruptedRequests?.(); } catch { /* close remains mandatory */ }
    if (database) {
      const now = Date.now();
      database.prepare(`
        UPDATE approvals SET status = 'invalidated_shutdown', updated_at = ?
        WHERE status IN ('pending','acting')
      `).run(now);
      database.prepare(`
        UPDATE deliveries SET status = 'needs_review', effect_state = 'unknown',
          last_error_code = COALESCE(last_error_code, 'INTERRUPTED_SHUTDOWN'), updated_at = ?
        WHERE status = 'sending' AND effect_state = 'started'
      `).run(now);
    }
  }

  function stopHost() {
    hostIntegration?.stop?.();
  }

  function close() {
    if (database?.open) database.close();
    sessionStore?.close?.();
  }

  function snapshot() {
    return Object.freeze({
      state: status().state,
      database: sessionStore?.getStatus?.() ?? null,
      poller: poller?.snapshot?.() ?? null,
      queue: scopeQueue?.snapshot?.() ?? null,
      vcpHttpReady,
      vcpReadinessStatus,
      deliveryErrorCode,
      activeRequests: activeBindings.size,
    });
  }

  return Object.freeze({
    abort, beginDrain, close, ensureDirectories, markNeedsReview, openState,
    probeTelegram, probeVcp, recover, snapshot, startHost, startPoller,
    stopHost, waitForIdle,
  });
}

function cleanupRuntime(target, timeoutMs) {
  if(target&&typeof target==='object'&&cleanupPromises.has(target))return cleanupPromises.get(target);
  const pending=(async () => {
    try { target?.beginDrain?.(); } catch { /* continue */ }
    try { target?.abort?.(); } catch { /* continue */ }
    let timeout;
    try {
      await Promise.race([
        Promise.resolve().then(() => target?.waitForIdle?.()),
        new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
      ]);
    } catch { /* continue */ }
    finally { clearTimeout(timeout); }
    try { target?.markNeedsReview?.(); } catch { /* continue */ }
    try { target?.stopHost?.(); } catch { /* continue */ }
    try { target?.close?.(); } catch { /* continue */ }
  })();
  if(target&&typeof target==='object')cleanupPromises.set(target,pending);
  return pending;
}

async function initialize(rawConfig = {}, dependencies = {}) {
  if(shutdownPromise)await shutdownPromise;
  if (initializationPromise) return initializationPromise;
  if (startupTask) return;
  if (['ready', 'probe', 'disabled'].includes(lifecycleState)) return;
  if (runtime) throw createBridgeError('BRIDGE_RUNTIME_REQUIRES_SHUTDOWN');
  const startup=new AbortController();
  startupController=startup;
  const currentInitialization = (async () => {
    lifecycleState = 'initializing';
    let parsed;
    const projectBasePath = safeProjectBase(rawConfig);
    try {
      const nodeEnvironment = process.env.NODE_ENV;
      parsed = parseConfig(rawConfig, {
        projectBasePath,
        production: nodeEnvironment !== 'development' && nodeEnvironment !== 'test',
      });
    } catch (error) {
      lifecycleState = 'failed';
      if (error instanceof ConfigError) throw error;
      throw new ConfigError('CONFIG_INVALID', 'CONFIG');
    }
    lifecycleMode = parsed.mode;
    if (parsed.mode === 'disabled') {
      lifecycleState = 'disabled';
      return;
    }
    const hostVcpContext = safeHostVcpContext(rawConfig, dependencies);
    const timeoutMs = Number.isSafeInteger(dependencies.shutdownTimeoutMs)
      && dependencies.shutdownTimeoutMs > 0 && dependencies.shutdownTimeoutMs <= 60_000
      ? dependencies.shutdownTimeoutMs : 5_000;
    lifecycleShutdownTimeoutMs = timeoutMs;
    const retryBase=Number.isSafeInteger(dependencies.startupRetryMs)&&dependencies.startupRetryMs>=1
      &&dependencies.startupRetryMs<=30_000?dependencies.startupRetryMs:1000;
    function ensureStarting(){if(startup.signal.aborted||startupController!==startup)throw createBridgeError('BRIDGE_STARTUP_ABORTED');}
    async function attempt(){
      let built;
      let stage='runtime';
      try {
      ensureStarting();
      const factory = dependencies.createRuntime ?? createDefaultRuntime;
      built = factory(parsed, dependencies, projectBasePath, hostVcpContext);
      runtime = built;
      stage = 'directories';
      built.ensureDirectories();
      stage = 'database';
      built.openState();
      stage = 'telegram';
      await built.probeTelegram();
      ensureStarting();
      stage = 'vcp';
      await built.probeVcp();
      ensureStarting();
      stage = 'host';
      built.startHost();
      stage = 'recovery';
      await built.recover();
      ensureStarting();
      if (parsed.mode === 'enabled') {
        stage = 'poller';
        built.startPoller();
      }
      lifecycleState = parsed.mode === 'probe' ? 'probe' : 'ready';
      } catch(cause) {
      await cleanupRuntime(built, timeoutMs);
      if(runtime===built)runtime=null;
      if(!startup.signal.aborted&&startupController===startup)lifecycleState='failed';
      const error = createBridgeError('BRIDGE_INITIALIZATION_FAILED');
      error.stage = stage;
      const {TelegramApiError}=require('./src/telegramClient');
      if((cause instanceof TelegramApiError || ['BRIDGE_VCP_PROBE_FAILED','BRIDGE_VCP_AUTH','BRIDGE_VCP_UNAVAILABLE'].includes(cause?.code))
        && DIAGNOSTIC_CODES.has(cause.code)) {
        error.safeCause=cause.code;
        error.retryAfterSec=cause.retryAfterSec;
      }
      if(!startup.signal.aborted)diagnostic(dependencies,'initialization_failed',stage,error.safeCause||error.code);
      throw error;
      }
    }
    function retryDelay(error,attemptNumber){
      if(parsed.mode!=='enabled'||error.stage!=='telegram'||startup.signal.aborted)return null;
      if(['TELEGRAM_NETWORK','TELEGRAM_TIMEOUT','TELEGRAM_SERVER'].includes(error.safeCause)) {
        return Math.min(30_000,retryBase*(2**Math.min(attemptNumber-1,10)));
      }
      if(error.safeCause==='TELEGRAM_RATE_LIMIT'&&Number.isSafeInteger(error.retryAfterSec)
        &&error.retryAfterSec>=0&&error.retryAfterSec<=86400)return Math.max(retryBase,error.retryAfterSec*1000);
      return null;
    }
    try{await attempt();}
    catch(firstError){
      if(retryDelay(firstError,1)===null)throw firstError;
      lifecycleState='recovering';
      const background=(async()=>{
        let error=firstError,number=0;
        while(!startup.signal.aborted){
          const delay=retryDelay(error,++number);
          if(delay===null){lifecycleState='failed';return;}
          lifecycleState='recovering';
          diagnostic(dependencies,'startup_backoff','telegram',error.safeCause,{attempt:number,next_retry_at:Date.now()+delay});
          await waitForStartup(delay,startup.signal);
          if(startup.signal.aborted)return;
          try{await attempt();diagnostic(dependencies,'startup_recovered','telegram',null,{attempt:number});return;}
          catch(next){error=next;}
        }
      })();
      startupTask=background;
      background.catch(()=>{if(!startup.signal.aborted)lifecycleState='failed';})
        .finally(()=>{if(startupTask===background)startupTask=null;});
    }
  })();
  initializationPromise=currentInitialization;
  try { await currentInitialization; }
  finally { if(initializationPromise===currentInitialization)initializationPromise=null; }
}

async function processToolCall() {
  if (!['ready', 'probe'].includes(lifecycleState) || !runtime) {
    throw createBridgeError('BRIDGE_NOT_READY');
  }
  const current=runtime.snapshot?.()??null;
  return Object.freeze({
    status: 'success',
    result: Object.freeze({
      mode: lifecycleMode,
      state: current?.state??lifecycleState,
      runtime: current,
    }),
  });
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  startupController?.abort('shutdown');
  // Detach the stopped generation. Late probes are fenced by ensureStarting;
  // they cannot own/clear a later initialize() or start another Host/poller.
  startupController=null;
  initializationPromise=null;
  startupTask=null;
  if (!runtime) {
    if (lifecycleState !== 'disabled') lifecycleState = 'stopped';
    return;
  }
  const target = runtime;
  runtime = null;
  lifecycleState = 'stopping';
  shutdownPromise = cleanupRuntime(target, lifecycleShutdownTimeoutMs).finally(() => {
    lifecycleState = 'stopped';
    shutdownPromise = null;
  });
  return shutdownPromise;
}

module.exports = { initialize, processToolCall, shutdown };
