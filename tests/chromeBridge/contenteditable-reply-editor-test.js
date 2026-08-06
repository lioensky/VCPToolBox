'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const pageRuntimeModule = require('../../Plugin/ChromeBridge/VCPChrome/webcore/web-agent-page-runtime-core.js');

function installLayout(window) {
    window.getComputedStyle = element => ({
        display: element.hidden ? 'none' : 'block',
        visibility: 'visible',
        opacity: '1',
        width: '240px',
        height: '36px',
        cursor: element?.tagName === 'BUTTON' ? 'pointer' : 'text'
    });

    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        const ordinal = Number(this.dataset?.ordinal || 1);
        return {
            x: 20,
            y: ordinal * 50,
            left: 20,
            top: ordinal * 50,
            right: 260,
            bottom: ordinal * 50 + 36,
            width: 240,
            height: 36
        };
    };
}

(async function run() {
    const dom = new JSDOM(
        '<!doctype html><html><head><title>动态回复编辑器</title></head><body>' +
        '<main id="thread"><button id="reply">回复</button></main>' +
        '</body></html>',
        {
            url: 'https://example.test/thread',
            pretendToBeVisual: true
        }
    );
    const { window } = dom;
    installLayout(window);

    const runtime = pageRuntimeModule.createWebAgentPageRuntime(
        {
            window,
            document: window.document,
            Node: window.Node
        },
        {
            runtimeInstanceId: 'runtime-contenteditable-test',
            documentGeneration: 1
        }
    );

    const initialSnapshot = runtime.snapshot();
    assert.strictEqual(
        initialSnapshot.pageGraph.elements.filter(item => item.elementKind === 'input').length,
        0,
        '回复编辑器弹出前不应存在输入框'
    );

    const thread = window.document.getElementById('thread');

    const emptyAttributeEditor = window.document.createElement('div');
    emptyAttributeEditor.setAttribute('contenteditable', '');
    emptyAttributeEditor.setAttribute('aria-label', '回复内容');
    emptyAttributeEditor.dataset.ordinal = '2';

    const plaintextEditor = window.document.createElement('div');
    plaintextEditor.setAttribute('contenteditable', 'plaintext-only');
    plaintextEditor.setAttribute('data-placeholder', '补充回复');
    plaintextEditor.setAttribute('aria-label', '补充回复');
    plaintextEditor.dataset.ordinal = '3';

    const disabledEditor = window.document.createElement('div');
    disabledEditor.setAttribute('contenteditable', 'false');
    disabledEditor.textContent = '只读引用';
    disabledEditor.dataset.ordinal = '4';

    thread.append(emptyAttributeEditor, plaintextEditor, disabledEditor);

    const snapshot = runtime.snapshot();
    const inputRecords = snapshot.pageGraph.elements.filter(item => item.elementKind === 'input');

    assert.strictEqual(inputRecords.length, 2, '应识别空属性和 plaintext-only 两种动态编辑器');
    assert.deepStrictEqual(
        inputRecords.map(item => item.label),
        ['回复内容', '补充回复'],
        '动态回复编辑器应使用无障碍名称而不是“无标题元素”'
    );
    assert.ok(
        snapshot.markdown.includes('【回复内容 A') &&
        snapshot.markdown.includes('｜vcp-input-1｜'),
        'Grounded Markdown 应暴露可操作的回复输入框句柄'
    );
    assert.ok(
        !snapshot.pageGraph.elements.some(item => item.label === '只读引用'),
        'contenteditable=false 不应被误识别为输入框'
    );

    const firstEditorRecord = inputRecords[0];
    const inputResult = await runtime.execute('page_type', {
        target: firstEditorRecord.snapshotHandleId,
        text: '这是一条自动化回复',
        targetContext: {
            runtimeInstanceId: snapshot.runtimeInstanceId,
            documentGeneration: snapshot.documentGeneration,
            snapshotId: snapshot.snapshotId
        },
        verification: 'auto'
    });

    assert.strictEqual(inputResult.status, 'success', '动态 contenteditable 输入应执行成功');
    assert.strictEqual(inputResult.code, 'ACTION_VERIFIED', '动态编辑器输入应通过值读回验证');
    assert.strictEqual(emptyAttributeEditor.textContent, '这是一条自动化回复');
    assert.strictEqual(
        inputResult.result.targetResolution.source,
        'registry-exact',
        '输入动作必须解析到快照注册的原始编辑器'
    );

    console.log('动态 contenteditable 回复编辑器回归测试通过');
    console.log(JSON.stringify({
        runtimeVersion: runtime.version,
        initialInputCount: 0,
        dynamicInputCount: inputRecords.length,
        labels: inputRecords.map(item => item.label),
        inputCode: inputResult.code,
        resolutionSource: inputResult.result.targetResolution.source
    }, null, 2));
})();