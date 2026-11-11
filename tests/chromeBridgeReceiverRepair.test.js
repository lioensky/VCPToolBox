'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture({ ready = false, denied = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../Plugin/ChromeBridge/VCPChrome/background.js'), 'utf8');
    const code = source.slice(source.indexOf('const pageReceiverRepairs = new Map();'),
        source.indexOf('function isExpectedNavigationChannelClose'));
    let injections = 0;
    const scripts = [
        { world: 'MAIN', js: ['main.js'] },
        { world: 'ISOLATED', js: ['core.js', 'content_script.js'] }
    ];
    const chrome = {
        runtime: { getManifest: () => ({ content_scripts: scripts }) },
        tabs: { async sendMessage(tabId, message, options) {
            assert.equal(options.frameId, 0);
            if (!ready) throw new Error('Could not establish connection. Receiving end does not exist.');
            return { success: true, markdown: 'PAGE' };
        } },
        scripting: { async executeScript(options) {
            injections++;
            if (denied) throw new Error('Cannot access contents of url');
            assert.deepEqual(Array.from(options.target.frameIds), [0]);
            if (options.world === 'ISOLATED') ready = true;
        } }
    };
    const context = vm.createContext({ chrome });
    const read = vm.runInContext(`${code}\nrequestGroundedSnapshot`, context);
    return { read, get injections() { return injections; } };
}
test('existing receiver does not inject', async () => {
    const f = fixture({ ready: true });
    assert.equal((await f.read(1)).markdown, 'PAGE');
    assert.equal(f.injections, 0);
});
test('missing receiver repairs once for parallel requests', async () => {
    const f = fixture();
    const results = await Promise.all([f.read(1), f.read(1), f.read(1)]);
    assert.ok(results.every(result => result.markdown === 'PAGE'));
    assert.equal(f.injections, 2);
});
test('host permission failure is explicit and not retried', async () => {
    const f = fixture({ denied: true });
    await assert.rejects(f.read(1), /页面接收端恢复失败.*Cannot access/);
    assert.equal(f.injections, 1);
});