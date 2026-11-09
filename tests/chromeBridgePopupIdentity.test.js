'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
    const source = fs.readFileSync(path.join(__dirname,
        '../Plugin/ChromeBridge/VCPChrome/popup.js'), 'utf8');
    const start = source.indexOf('    let pageIdentityRequest = 0;');
    const end = source.indexOf('    // 初始化：加载设置和状态', start);
    assert.ok(start >= 0 && end > start);
    const pending = [];
    const shown = [];
    const events = {};
    const event = name => ({ addListener(fn) { events[name] = fn; } });
    const chrome = {
        tabs: {
            query(options) {
                assert.equal(options.active, true);
                assert.equal(options.currentWindow, true);
                return new Promise(resolve => pending.push(resolve));
            },
            onActivated: event('activated'),
            onUpdated: event('updated')
        },
        windows: { onFocusChanged: event('focus') }
    };
    const context = vm.createContext({
        chrome, updatePageInfo: data => shown.push(data), console
    });
    const load = vm.runInContext(source.slice(start, end) +
        '\nloadLastPageInfo;', context);
    return { load, pending, shown, events };
}

test('popup reads live identity and ignores a late old-tab response', async () => {
    const f = fixture();
    const old = f.load();
    const fresh = f.load();
    f.pending[1]([{ id: 2, title: 'NEW', url: 'https://new.test/' }]);
    await fresh;
    f.pending[0]([{ id: 1, title: 'OLD', url: 'https://old.test/' }]);
    await old;
    assert.equal(f.shown.length, 1);
    assert.equal(f.shown[0].title, 'NEW');
});

test('activation, navigation and window focus query metadata; inactive updates do not', async () => {
    const f = fixture();
    f.events.activated({});
    f.events.updated(2, { title: 'changed' }, { active: true });
    f.events.updated(3, { url: 'https://other.test/' }, { active: false });
    f.events.focus(1);
    assert.equal(f.pending.length, 3);
    f.pending.forEach(resolve => resolve([]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.shown.length, 1);
    assert.equal(f.shown[0], null);
});