'use strict';
const { createHash } = require('node:crypto');
const { messageKey } = require('../sync/protocol');
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (code, status = 400) => Object.assign(new Error(code), { code, status });
function historyReady(db,topic){
    if(topic.requiredMessageIds===undefined)return true;
    if(!Array.isArray(topic.requiredMessageIds)||topic.requiredMessageIds.length>10000||topic.requiredMessageIds.some(id=>typeof id!=='string'||!id)||new Set(topic.requiredMessageIds).size!==topic.requiredMessageIds.length)throw error('INVALID_REQUIRED_HISTORY');
    return db.prepare('SELECT count(*) AS n FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id IN (SELECT value FROM json_each(?))').get(topic.ownerType,topic.ownerId,topic.topicId,JSON.stringify(topic.requiredMessageIds)).n===topic.requiredMessageIds.length;
}

// The existing central journal remains authoritative. Preparing/publishing are
// durable write-ahead intents, replayed through CentralStore.apply after a crash.
// No second history database or separate model/tool/Agent implementation exists.
class ConversationExecution {
    constructor({ store, topics, agentManager, startDelayMs = 0, maxConcurrency = 4, executionTimeoutMs = 120000, fault = () => {} }) {
        if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) throw error('INVALID_EXECUTION_CONCURRENCY');
        if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1000 || executionTimeoutMs > 300000) throw error('INVALID_EXECUTION_TIMEOUT');
        this.store = store; this.db = store.db; this.topics = new Map(topics.map(t => [t.key, t]));
        this.agentManager = agentManager; this.startDelayMs = startDelayMs; this.fault = fault;
        this.active = new Map(); this.draining = false; this.endpoint = null;
        this.maxConcurrency = maxConcurrency; this.runningTopics = new Set(); this.inFlight = new Set();
        this.executionTimeoutMs = executionTimeoutMs;
        this.scheduling = false; this.wakePending = false;
        this.db.exec(`PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS mobile_executions (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
                topic_key TEXT NOT NULL, request_hash TEXT NOT NULL, user_message_id TEXT NOT NULL,
                user_seq INTEGER, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0, pending_operation TEXT,
                reply_message_id TEXT, error_code TEXT, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, not_before INTEGER NOT NULL,
                UNIQUE(session_id,request_id));`);
        this.recover();
        this.timer = setInterval(() => this.tick(), 100); this.timer.unref();
    }
    recover() {
        for (const row of this.db.prepare("SELECT * FROM mobile_executions WHERE state IN ('preparing','publishing') ORDER BY created_at").all()) this.completeIntent(row);
        // A lost in-flight result may already have executed external tools.
        // Resume queued work, but never automatically repeat uncertain execution.
        this.db.prepare("UPDATE mobile_executions SET state=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,error_code=CASE WHEN cancel_requested=1 THEN NULL ELSE 'EXECUTION_INTERRUPTED_REVIEW_REQUIRED' END,updated_at=? WHERE state IN ('running','cancelling')").run(Date.now());
    }
    get(id) { return this.db.prepare('SELECT * FROM mobile_executions WHERE id=?').get(id); }
    public(row, sessionId) {
        return { id: row.id, topicKey: row.topic_key, requestId: row.request_id, userMessageId: row.user_message_id, state: row.state, attempts: row.attempts, replyMessageId: row.reply_message_id, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, own: row.session_id === sessionId };
    }
    list(topicKey, sessionId) { return this.db.prepare('SELECT * FROM mobile_executions WHERE topic_key=? ORDER BY created_at').all(topicKey).map(r => this.public(r, sessionId)); }
    accept(sessionId, { topicKey, requestId, text }) {
        const topic = this.topics.get(topicKey);
        if (!topic) throw error('TOPIC_NOT_ALLOWED', 403);
        if (!topic.agentAlias || !topic.model || !this.agentManager.isAgent(topic.agentAlias)) throw error('AGENT_NOT_EXECUTABLE', 409);
        if(!historyReady(this.db,topic))throw error('HISTORY_IMPORT_PENDING',409);
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId) || typeof text !== 'string' || !text.trim() || text.length > 12000) throw error('INVALID_TEXT_SUBMISSION');
        const id = 'job_' + digest(sessionId + '\0' + requestId).slice(0, 32);
        const requestHash = digest(JSON.stringify([topicKey, text]));
        const prior = this.get(id);
        if (prior) {
            if (prior.request_hash !== requestHash) throw error('REQUEST_ID_REUSED', 409);
            if (['preparing', 'publishing'].includes(prior.state)) this.completeIntent(prior);
            return { ...this.public(this.get(id), sessionId), replayed: true };
        }
        if (this.db.prepare('SELECT count(*) AS n FROM mobile_executions WHERE session_id=? AND created_at>?').get(sessionId, Date.now() - 60000).n >= 20) throw error('SUBMISSION_RATE_LIMIT', 429);
        const now = Date.now(), msgId = 'mobile_' + id;
        const op = { ownerType: topic.ownerType, ownerId: topic.ownerId, topicId: topic.topicId, msgId, deviceId: 'mobile:' + sessionId, opId: 'submit:' + id, action: 'upsert', baseHash: null, message: { id: msgId, role: 'user', content: text, timestamp: now } };
        this.db.prepare("INSERT INTO mobile_executions(id,session_id,request_id,topic_key,request_hash,user_message_id,state,pending_operation,created_at,updated_at,not_before) VALUES(?,?,?,?,?,?,'preparing',?,?,?,?)").run(id, sessionId, requestId, topicKey, requestHash, msgId, JSON.stringify(op), now, now, now + this.startDelayMs);
        this.fault('accepted-intent'); this.completeIntent(this.get(id));
        return { ...this.public(this.get(id), sessionId), replayed: false };
    }
    completeIntent(row) {
        const op = JSON.parse(row.pending_operation);
        const result = this.store.apply(op);
        this.fault(row.state === 'preparing' ? 'user-applied' : 'reply-applied');
        if (row.state === 'preparing') this.db.prepare("UPDATE mobile_executions SET state='queued',user_seq=?,pending_operation=NULL,updated_at=? WHERE id=?").run(result.seq, Date.now(), row.id);
        else this.db.prepare("UPDATE mobile_executions SET state='completed',reply_message_id=?,pending_operation=NULL,updated_at=? WHERE id=?").run(op.msgId, Date.now(), row.id);
        this.wake();
    }
    setEndpoint({ url, key }) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/v1/chat/completions' || !key) throw error('INVALID_EXECUTION_ENDPOINT');
        this.endpoint = { url: parsed.href, key }; this.tick();
    }
    wake() {
        if (this.draining || this.wakePending) return;
        this.wakePending = true;
        queueMicrotask(() => { this.wakePending = false; this.tick(); });
    }
    tick() {
        if (this.draining || !this.endpoint || this.scheduling) return;
        this.scheduling = true;
        try {
            while (!this.draining && this.inFlight.size < this.maxConcurrency) {
                const row = this.db.prepare("SELECT * FROM mobile_executions WHERE state='queued' AND not_before<=? AND topic_key NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at,rowid LIMIT 1").get(Date.now(), JSON.stringify([...this.runningTopics]));
                if (!row) break;
                // Reserve before run() reaches its first await or a reentrant tick.
                this.runningTopics.add(row.topic_key);
                const task = this.run(row).finally(() => {
                    this.inFlight.delete(task); this.runningTopics.delete(row.topic_key);
                    this.wake();
                });
                this.inFlight.add(task);
                // run() persists expected failures. Retain the original promise
                // for close() while suppressing unhandled-rejection reporting.
                task.catch(() => {});
            }
        } finally { this.scheduling = false; }
    }
    async run(row) {
        if (!this.db.prepare("UPDATE mobile_executions SET state='running',attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'").run(Date.now(), row.id).changes) return;
        const controller = new AbortController(); this.active.set(row.id, controller); let deadline;
        try {
            const topic = this.topics.get(row.topic_key);
            if (!topic || !this.agentManager.isAgent(topic.agentAlias)) throw error('AGENT_NOT_CONFIGURED');
            const prompt = await this.agentManager.getAgentPrompt(topic.agentAlias);
            // Keep later submissions outside this task's snapshot, but include
            // replies from completed predecessor jobs even if they published
            // after this user message was accepted. No new state/schema needed.
            const predecessors = this.db.prepare("SELECT user_message_id,reply_message_id FROM mobile_executions WHERE topic_key=? AND user_seq<? AND state='completed' AND reply_message_id IS NOT NULL ORDER BY user_seq").all(row.topic_key,row.user_seq);
            const records = this.db.prepare(`SELECT * FROM (
                SELECT *,row_number() OVER(PARTITION BY msg_id ORDER BY seq DESC) AS r
                FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=? AND
                (seq<=? OR msg_id IN (SELECT value FROM json_each(?))))
                WHERE r=1 AND action='upsert' ORDER BY seq`).all(topic.ownerType, topic.ownerId, topic.topicId, row.user_seq,JSON.stringify(predecessors.map(p=>p.reply_message_id)));
            const history=records.map(r=>JSON.parse(r.message_json)).sort((a,b)=>a.timestamp-b.timestamp);
            const byId=new Map(history.map(m=>[m.id,m])),replyAfter=new Map(),relocated=new Set();
            for(const p of predecessors)if(byId.has(p.user_message_id)&&byId.has(p.reply_message_id)){
                replyAfter.set(p.user_message_id,byId.get(p.reply_message_id));relocated.add(p.reply_message_id);
            }
            const ordered=[];
            for(const m of history)if(m.id!==row.user_message_id&&!relocated.has(m.id)){
                ordered.push(m);if(replyAfter.has(m.id))ordered.push(replyAfter.get(m.id));
            }
            if(byId.has(row.user_message_id))ordered.push(byId.get(row.user_message_id));
            const messages = ordered.filter(m => ['user', 'assistant'].includes(m.role)).map(m => {
                if (typeof m.content !== 'string') throw error('TEXT_MESSAGES_REQUIRED');
                return { role: m.role, content: m.content };
            });
            // Context budgeting remains in the existing ToolBox handler. The
            // complete central history is retained, including histories >200 rows.
            deadline = AbortSignal.timeout(this.executionTimeoutMs);
            const response = await fetch(this.endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${this.endpoint.key}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any([controller.signal, deadline]), body: JSON.stringify({ model: topic.model, contextTokenLimit: Number(topic.contextTokenLimit)||32000, ...(Number.isFinite(topic.temperature)?{temperature:topic.temperature}:{}), ...(Number.isFinite(topic.maxOutputTokens)?{max_tokens:topic.maxOutputTokens}:{}), stream: false, requestId: row.id, messages: [{ role: 'system', content: prompt }, ...messages] }) });
            if (!response.ok) throw error('MODEL_EXECUTION_FAILED');
            const result = await response.json(); const content = result.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content) throw error('INVALID_MODEL_RESULT');
            const latest = this.get(row.id);
            if (this.draining) throw error('HOST_DRAINING');
            if (latest.cancel_requested) throw error('EXECUTION_CANCELLED');
            const msgId = 'reply_' + row.id;
            const op = { ownerType: topic.ownerType, ownerId: topic.ownerId, topicId: topic.topicId, msgId, deviceId: 'server:native-execution', opId: 'reply:' + row.id, action: 'upsert', baseHash: null, message: { id: msgId, role: 'assistant', content, timestamp: Date.now(), agentId: topic.ownerId, name: topic.agentName } };
            this.db.prepare("UPDATE mobile_executions SET state='publishing',pending_operation=?,updated_at=? WHERE id=?").run(JSON.stringify(op), Date.now(), row.id);
            this.fault('reply-intent'); this.completeIntent(this.get(row.id));
        } catch (failure) {
            const latest = this.get(row.id);
            if (!latest || latest.state === 'publishing') return; // durable result intent recovers on restart
            const state = latest.cancel_requested ? 'cancelled' : 'failed';
            this.db.prepare('UPDATE mobile_executions SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, state === 'failed' ? (this.draining ? 'EXECUTION_INTERRUPTED_REVIEW_REQUIRED' : deadline?.aborted ? 'EXECUTION_TIMEOUT_REVIEW_REQUIRED' : 'MODEL_EXECUTION_FAILED') : null, Date.now(), row.id);
        } finally { this.active.delete(row.id); }
    }
    cancel(id, sessionId) {
        const row = this.get(id);
        if (!row || row.session_id !== sessionId) throw error('EXECUTION_NOT_FOUND', 404);
        if (['completed','publishing','failed'].includes(row.state)) throw error('EXECUTION_ALREADY_TERMINAL', 409);
        this.db.prepare("UPDATE mobile_executions SET cancel_requested=1,state=CASE WHEN state='running' THEN 'cancelling' ELSE 'cancelled' END,updated_at=? WHERE id=?").run(Date.now(), id);
        this.active.get(id)?.abort(); return this.public(this.get(id), sessionId);
    }
    beginDrain() { this.draining = true; clearInterval(this.timer); for (const controller of this.active.values()) controller.abort(); }
    async close() {
        this.beginDrain();
        const settled = await Promise.allSettled([...this.inFlight]);
        const failed = settled.find(row => row.status === 'rejected');
        if (failed) throw failed.reason;
    }
    snapshot() { return this.db.prepare('SELECT id,topic_key AS topicKey,state,attempts,cancel_requested AS cancelRequested,reply_message_id AS replyMessageId FROM mobile_executions ORDER BY created_at').all(); }
}
module.exports = { ConversationExecution, error, digest, historyReady };
