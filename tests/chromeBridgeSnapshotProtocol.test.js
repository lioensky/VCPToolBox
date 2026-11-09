'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture() {
    const filename = path.resolve(__dirname, '../Plugin/ChromeBridge/ChromeBridge.js');
    const nativeRequire = createRequire(filename);
    const placeholders = new Map([['{{VCPChromePageInfo}}', 'stale']]);
    const module = { exports: {} };
    const localRequire = id => {
        if (id === '../../Plugin.js') return { staticPlaceholderValues: placeholders };
        if (id === '../../modules/browserRuntimeManager.js') return {};
        if (id === './jevEntityService') return { createJevEntityService: () => () => {} };
        if (id === '../../modules/jevClient') return {};
        return nativeRequire(id);
    };
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
        { filename })(localRequire, module, module.exports);
    const bridge = module.exports;
    bridge.initialize({});
    function socket(id) {
        const ws = new EventEmitter();
        ws.clientId = id;
        ws.readyState = 1;
        bridge.handleNewClient(ws);
        bridge.handleClientMessage(id, { type: 'clientHello', data: {
            clientKind: 'user', featureSettings: { isMonitoringEnabled: true }
        } });
        return ws;
    }
    return { bridge, placeholders, socket };
}

test('real bridge: synchronous response works, wrong client cannot satisfy request, no static cache', async () => {
    const f = fixture();
    const a = f.socket('a');
    f.socket('b');
    let calls = 0;
    a.send = raw => {
        calls++;
        const message = JSON.parse(raw);
        assert.equal(message.type, 'pageSnapshotRequest');
        f.bridge.handleClientMessage('b', { type: 'pageSnapshotResult',
            data: { requestId: message.data.requestId, markdown: 'WRONG' } });
        f.bridge.handleClientMessage('a', { type: 'pageSnapshotResult',
            data: { requestId: message.data.requestId, markdown: 'RIGHT' } });
    };
    try {
        const messages = [{ role: 'system', content: '{{VCPChromePageInfo}}' }];
        await f.bridge.processMessages(messages);
        assert.equal(messages[0].content, 'RIGHT');
        assert.equal(calls, 1);
        assert.equal(f.placeholders.has('{{VCPChromePageInfo}}'), false);
    } finally { f.bridge.shutdown(); }
});

test('real bridge: disconnect rejects pending snapshot immediately', async () => {
    const f = fixture();
    const a = f.socket('a');
    a.send = () => queueMicrotask(() => a.emit('close'));
    try {
        const messages = [{ role: 'system', content: '{{VCPChromePageInfo}}' }];
        await f.bridge.processMessages(messages);
        assert.match(messages[0].content, /浏览器连接已断开/);
    } finally { f.bridge.shutdown(); }
});