'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const contextBudget = require('./contextBudget.js');

const DEFAULT_LIMIT = 64000;
const HEADER = 'x-vcp-agent-delegation';
// AgentAssistant is a direct service in the same process. Do not use the public API key as a source marker.
const proof = randomBytes(32).toString('hex');
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function delegationHeaders() {
    return { [HEADER]: proof };
}

function isAgentDelegation(req) {
    const candidate = req.headers?.[HEADER];
    return loopback.has(req.socket?.remoteAddress)
        && typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
        && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(proof, 'hex'));
}

function delegationLimit(requestLimit) {
    const configured = contextBudget.normalizeLimit(process.env.AgentDelegationContextTokenLimit) || DEFAULT_LIMIT;
    return contextBudget.effectiveLimit(Math.min(configured, contextBudget.normalizeLimit(requestLimit) || configured));
}

/** Input shape: [system, task, ...assistant/heartbeat pairs]. Preserve the last pair verbatim. */
function fitDelegationWindow(messages, limit) {
    const weights = messages.map(contextBudget.estimateMessageTokens);
    let estimated = weights.reduce((total, weight) => total + weight, 0);
    let keepFrom = 2;
    while (estimated > limit && keepFrom < messages.length - 2) {
        estimated -= weights[keepFrom] + weights[keepFrom + 1];
        keepFrom += 2;
    }
    if (keepFrom > 2) messages.splice(2, keepFrom - 2);
    return { estimated, limit, over: estimated > limit };
}

function delegationBudgetReport(details, fallbackMessage) {
    if (!details || !Number.isFinite(details.estimated) || !Number.isFinite(details.limit)) return null;
    return `委托上下文超限（${details.stage}）：估算 ${details.estimated} token，上限 ${details.limit}。`
        + (typeof fallbackMessage === 'string' ? ` ${fallbackMessage}` : '');
}

module.exports = { delegationHeaders, isAgentDelegation, delegationLimit, fitDelegationWindow, delegationBudgetReport };
