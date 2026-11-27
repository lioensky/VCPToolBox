#!/usr/bin/env node
'use strict';
/**
 * vcp-memory-recall-hook — passive memory recall for hook-capable coding agents.
 *
 * Host-agnostic UserPromptSubmit hook: reads the hook JSON payload on stdin,
 * recalls relevant memories from a VCPToolBox `POST /v1/memory/search` endpoint
 * using the submitted prompt plus trailing conversation context, and prints a
 * single-line `hookSpecificOutput.additionalContext` JSON object on stdout.
 *
 * Verified contract (identical across hosts):
 *   stdin  : { session_id, transcript_path, cwd, hook_event_name, prompt }
 *   stdout : { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
 *             "additionalContext": "..." } }
 *
 * Design rules:
 *   - zero dependencies, Node.js >= 18 (global fetch)
 *   - never blocks the prompt: every failure path exits 0 with no output
 *   - the read token is only ever sent to loopback or HTTPS endpoints,
 *     and redirects are never followed (redirect: 'error')
 *   - configuration: environment variables beat ./vcp-memory-hook.config.json,
 *     which beats built-in defaults. Secrets stay out of this file.
 *
 * Environment variables:
 *   VCP_MEMORY_URL        required, e.g. http://127.0.0.1:6005  (no path needed)
 *   VCP_MEMORY_TOKEN      required, the dedicated read-only token
 *   VCP_MEMORY_DIARIES    required, comma-separated diary names
 *   VCP_MEMORY_K          main recall count (default 5)
 *   VCP_MEMORY_ASSOCIATE  '1'/'true' enables associative co-occurrence (default off)
 *   VCP_MEMORY_CORETAGS   comma-separated explicit ghost anchors (default none)
 *   VCP_MEMORY_METATHINKING  '1'/'true' or a star pool name; requires the pool in scope
 *   VCP_MEMORY_METATHINKING_GROUP  '1'/'true' enables group mode (default off)
 *   VCP_MEMORY_TIMEOUT_MS      default 8000
 *   VCP_MEMORY_MAX_CHARS       output budget in characters, default 6000
 *   VCP_MEMORY_HISTORY         trailing conversation messages to include, default 6 (0 = off)
 *   VCP_MEMORY_MESSAGE_CHARS   per-message cap, default 2000
 *   VCP_MEMORY_COOLDOWN_MS     backoff after a failure, default 30000
 *   VCP_MEMORY_SKIP_SLASH      '0' to also recall for /slash-commands (default skip)
 *   VCP_MEMORY_HOOK_CONFIG     explicit path of the JSON config file
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function silent() {
    process.exit(0);
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function loadConfig() {
    const fileConfig = readJsonFile(process.env.VCP_MEMORY_HOOK_CONFIG
        || path.join(__dirname, 'vcp-memory-hook.config.json')) || {};
    const env = process.env;
    const pick = (envValue, fileValue, fallback) => {
        if (envValue !== undefined && envValue !== '') return envValue;
        if (fileValue !== undefined && fileValue !== '') return fileValue;
        return fallback;
    };
    const bool = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
    };
    const int = (value, fallback, min, max) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    };
    const list = value => String(value || '')
        .split(/[,|]/)
        .map(s => s.trim())
        .filter(Boolean);
    const cfg = {
        url: String(pick(env.VCP_MEMORY_URL, fileConfig.url, '') || '').replace(/\/+$/, ''),
        token: pick(env.VCP_MEMORY_TOKEN, fileConfig.token, ''),
        diaries: list(pick(env.VCP_MEMORY_DIARIES, fileConfig.diaries, '')),
        k: int(pick(env.VCP_MEMORY_K, fileConfig.k, undefined), 5, 1, 50),
        associate: bool(pick(env.VCP_MEMORY_ASSOCIATE, fileConfig.associate, undefined), false),
        coreTags: list(pick(env.VCP_MEMORY_CORETAGS, fileConfig.coreTags, '')),
        timeoutMs: int(pick(env.VCP_MEMORY_TIMEOUT_MS, fileConfig.timeoutMs, undefined), 8000, 500, 55000),
        maxChars: int(pick(env.VCP_MEMORY_MAX_CHARS, fileConfig.maxChars, undefined), 6000, 500, 9500),
        historyMessages: int(pick(env.VCP_MEMORY_HISTORY, fileConfig.historyMessages, undefined), 6, 0, 40),
        messageChars: int(pick(env.VCP_MEMORY_MESSAGE_CHARS, fileConfig.messageChars, undefined), 2000, 100, 8000),
        cooldownMs: int(pick(env.VCP_MEMORY_COOLDOWN_MS, fileConfig.cooldownMs, undefined), 30000, 0, 3600000),
        skipSlash: bool(pick(env.VCP_MEMORY_SKIP_SLASH, fileConfig.skipSlashCommands, undefined), true),
        metaThinking: null
    };
    const mt = pick(env.VCP_MEMORY_METATHINKING, fileConfig.metaThinking, undefined);
    const metaDisabled = mt === undefined || mt === null || mt === false
        || ['', '0', 'false', 'no', 'off'].includes(String(mt).trim().toLowerCase());
    if (!metaDisabled) {
        cfg.metaThinking = {};
        if (typeof mt === 'string' && !['1', 'true', 'yes', 'on'].includes(mt.toLowerCase())) {
            cfg.metaThinking.pool = mt;
        } else if (typeof mt === 'object') {
            cfg.metaThinking = mt;
        }
        if (bool(pick(env.VCP_MEMORY_METATHINKING_GROUP, fileConfig.metaThinkingGroup, undefined), false)) {
            cfg.metaThinking.group = true;
        }
    }
    return cfg;
}

// The read token must never travel cleartext beyond this machine.
function endpointAllowed(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:') return true;
        if (parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.toLowerCase();
        return host === 'localhost' || host === '::1' || host === '[::1]'
            || /^127(?:\.\d{1,3}){3}$/.test(host);
    } catch {
        return false;
    }
}

function clampText(text, limit) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= limit) return clean;
    return clean.slice(0, limit - 1) + '…';
}

function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(part => part && typeof part === 'object'
            && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')
            && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
}

// Transcript shapes (structure-verified):
//   Claude Code: { type: 'user'|'assistant', message: { role, content }, isMeta?, isSidechain? }
//   Codex CLI:   { type: 'response_item', payload: { type: 'message', role, content: [...] } }
function parseTranscriptLine(line) {
    let obj;
    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    if ((obj.type === 'user' || obj.type === 'assistant') && obj.message && typeof obj.message === 'object') {
        if (obj.isMeta === true || obj.isSidechain === true) return null;
        const role = obj.message.role === 'user' ? 'user' : (obj.message.role === 'assistant' ? 'assistant' : null);
        if (!role) return null;
        const text = extractText(obj.message.content);
        return text.trim() ? { role, content: text } : null;
    }

    if (obj.type === 'response_item' && obj.payload && obj.payload.type === 'message') {
        const role = obj.payload.role === 'user' ? 'user' : (obj.payload.role === 'assistant' ? 'assistant' : null);
        if (!role) return null;
        const text = extractText(obj.payload.content);
        return text.trim() ? { role, content: text } : null;
    }

    return null;
}

function readConversationTail(transcriptPath, maxMessages, perMessageChars) {
    if (!transcriptPath || maxMessages <= 0) return [];
    let tail;
    try {
        const stat = fs.statSync(transcriptPath);
        const slice = Math.min(stat.size, 256 * 1024);
        const fd = fs.openSync(transcriptPath, 'r');
        try {
            const buffer = Buffer.alloc(slice);
            fs.readSync(fd, buffer, 0, slice, stat.size - slice);
            tail = buffer.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return [];
    }
    const lines = tail.split('\n').filter(line => line.trim());
    const collected = [];
    for (let index = lines.length - 1; index >= 0 && collected.length < maxMessages; index--) {
        const message = parseTranscriptLine(lines[index]);
        if (!message) continue;
        collected.unshift({
            role: message.role,
            content: clampText(message.content, perMessageChars)
        });
    }
    // drop consecutive duplicates (retries, host echoes)
    return collected.filter((message, index) => index === 0
        || message.content !== collected[index - 1].content
        || message.role !== collected[index - 1].role);
}

function cooldownFile(url) {
    const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), `vcp-memory-recall-hook-${key}.json`);
}

function inCooldown(file, cooldownMs) {
    if (!cooldownMs) return false;
    const state = readJsonFile(file);
    return Boolean(state && Number.isFinite(state.failedAt) && Date.now() - state.failedAt < cooldownMs);
}

function markFailure(file) {
    try {
        fs.writeFileSync(file, JSON.stringify({ failedAt: Date.now() }));
    } catch { /* best effort only */ }
}

function clearFailure(file) {
    try {
        fs.rmSync(file, { force: true });
    } catch { /* best effort only */ }
}

function formatRecall(result, maxChars) {
    const lines = [];
    const push = line => {
        const budget = maxChars - lines.join('\n').length - (lines.length ? 1 : 0);
        if (budget <= 0) return false;
        lines.push(line.length <= budget ? line : line.slice(0, Math.max(0, budget - 1)) + '…');
        return line.length <= budget;
    };
    const direct = Array.isArray(result?.direct) ? result.direct : [];
    const associated = Array.isArray(result?.associated) ? result.associated : [];
    if (!direct.length && !associated.length && !result?.metaFormula) return '';
    push('[vcp-memory-recall] Related memories retrieved for this prompt (use at your discretion; cite nothing you cannot verify):');
    for (const hit of direct) {
        const text = clampText(hit.text, 1200);
        if (!text) continue;
        if (!push(`#${hit.rank}|${hit.diary}|${hit.file} (score ${Number(hit.score || 0).toFixed(3)})\n${text}`)) break;
    }
    for (const hit of associated) {
        const text = clampText(hit.text, 900);
        if (!text) continue;
        if (!push(`#A${hit.rank}|${hit.diary}|${hit.file} (association x${hit.seedCount || 1})\n${text}`)) break;
    }
    if (typeof result?.metaFormula === 'string' && result.metaFormula.trim()) {
        push(`[meta]\n${result.metaFormula.trim()}`);
    }
    return lines.join('\n');
}

async function main() {
    // hard watchdog: never hold the prompt hostage
    const watchdog = setTimeout(() => process.exit(0), 25000);
    watchdog.unref();

    const input = await new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
        setTimeout(() => resolve(data), 3000).unref();
    });
    let payload;
    try {
        payload = JSON.parse(input);
    } catch {
        return silent();
    }
    if (!payload || payload.hook_event_name !== 'UserPromptSubmit') return silent();
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return silent();

    const cfg = loadConfig();
    if (!cfg.url || !cfg.token || !cfg.diaries.length) return silent();
    if (!endpointAllowed(cfg.url)) return silent();
    if (cfg.skipSlash && prompt.startsWith('/')) return silent();

    const cooldown = cooldownFile(cfg.url);
    if (inCooldown(cooldown, cfg.cooldownMs)) return silent();

    // conversation: trailing transcript history, current prompt as the final user
    // message (the server contract requires the last entry to echo the query).
    const history = readConversationTail(payload.transcript_path, cfg.historyMessages, cfg.messageChars);
    while (history.length && history[history.length - 1].role === 'user'
        && history[history.length - 1].content.trim() === prompt) {
        history.pop();
    }
    const body = {
        query: prompt,
        diaries: cfg.diaries,
        k: cfg.k,
        associate: cfg.associate
    };
    if (history.length) {
        body.conversation = [...history, { role: 'user', content: prompt }];
    }
    if (cfg.coreTags.length) body.coreTags = cfg.coreTags;
    if (cfg.metaThinking) body.metaThinking = cfg.metaThinking;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        const response = await fetch(`${cfg.url}/v1/memory/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${cfg.token}`
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: controller.signal
        });
        if (!response.ok) {
            // 401/403/404 are configuration problems, not transient failures:
            // back off all the same, but never surface internals to the model.
            markFailure(cooldown);
            return silent();
        }
        const result = await response.json();
        clearFailure(cooldown);
        const context = formatRecall(result, cfg.maxChars);
        if (!context) return silent();
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: context
            }
        }) + '\n');
    } catch {
        markFailure(cooldown);
        return silent();
    } finally {
        clearTimeout(timer);
    }
}

main().catch(() => silent());
