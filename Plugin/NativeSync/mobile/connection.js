'use strict';
const { timingSafeEqual, createHash } = require('node:crypto');
const { error } = require('./execution');

// The displayed HTTP backend is an identity, never a browser-controlled proxy.
// Authentication stays inside the already authenticated, co-located ToolBox.
function backendAddress(value) {
    if (typeof value !== 'string' || value.length > 2048) throw error('INVALID_SERVER_ADDRESS');
    let url; try { url = new URL(value); } catch { throw error('INVALID_SERVER_ADDRESS'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error('INVALID_SERVER_ADDRESS');
    return url.origin;
}
class MobileConnection {
    constructor(config, hostKey) {
        this.address = config.NativeMobileBackendUrl ? backendAddress(config.NativeMobileBackendUrl) : null;
        this.enabled = config.NativeMobileKeyExchangeEnabled === true;
        this.hostKey = hostKey;
        this.failures = new Map();
    }
    information() {
        return { service: 'VCPToolBox', plugin: 'NativeSync', mobileProtocol: 1,
            serverUrl: this.address, suggestedServerUrl: this.address || '',
            credentialExchangeAllowed: Boolean(this.enabled && this.address && (this.hostKey() || this.verifyKey)),
            transport: 'same-host', scope: 'explicitly selected Agent/Topic only' };
    }
    test(value) {
        const address = backendAddress(value);
        if (!this.address || address !== this.address) throw error('SERVER_NOT_APPROVED', 403);
        if (!this.information().credentialExchangeAllowed) throw error('PROTECTED_HOST_NOT_READY', 503);
        return this.information();
    }
    authenticate(body, peer) {
        if (!body || Object.keys(body).some(k => !['serverUrl', 'apiKey'].includes(k))) throw error('INVALID_CONNECTION');
        this.test(body.serverUrl);
        const now = Date.now();
        for (const [ip, row] of this.failures) if (row.until <= now) this.failures.delete(ip);
        const row = this.failures.get(peer) || { count: 0, until: now + 60000 };
        if (row.count >= 5 || this.failures.size > 4096) throw error('AUTH_RATE_LIMIT', 429);
        row.count++; this.failures.set(peer, row);
        const supplied = body.apiKey;
        // Remove the submitted key from the request immediately; never reflect it.
        delete body.apiKey;
        if (typeof supplied !== 'string' || !supplied || supplied.length > 8192) throw error('AUTH_FAILED', 401);
        const hash = x => createHash('sha256').update(x).digest();
        if(this.verifyKey)return Promise.resolve(this.verifyKey(supplied)).then(valid=>{if(!valid)throw error('AUTH_FAILED',401);this.failures.delete(peer);return this.information();});
        if (!timingSafeEqual(hash(supplied), hash(this.hostKey()))) throw error('AUTH_FAILED', 401);
        this.failures.delete(peer);
        return this.information();
    }
}
module.exports = { MobileConnection, backendAddress };
