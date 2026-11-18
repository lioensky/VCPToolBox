'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const pageRuntimeModule = require('../../Plugin/ChromeBridge/VCPChrome/webcore/web-agent-page-runtime-core.js');

function installLayout(window) {
    window.getComputedStyle = element => ({
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        width: '80px',
        height: '24px',
        cursor: element?.tagName === 'BUTTON' ? 'pointer' : 'auto'
    });

    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    if (!window.PointerEvent) {
        window.PointerEvent = window.MouseEvent;
    }

    window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        const ordinal = Number(this.dataset?.ordinal || 1);
        return {
            x: 20,
            y: ordinal * 40,
            left: 20,
            top: ordinal * 40,
            right: 100,
            bottom: ordinal * 40 + 24,
            width: 80,
            height: 24
        };
    };
}

function createFixture() {
    const dom = new JSDOM(
        '<!doctype html><html><body><main id="comments"></main></body></html>',
        {
            url: 'https://example.test/comments',
            pretendToBeVisual: true
        }
    );
    const { window } = dom;
    installLayout(window);

    const comments = window.document.getElementById('comments');
    const buttons = [];

    for (let index = 1; index <= 3; index++) {
        const thread = window.document.createElement('comment-thread');
        thread.dataset.ordinal = String(index);
        const shadow = thread.attachShadow({ mode: 'open' });
        const comment = window.document.createElement('p');
        comment.textContent = `第 ${index} 楼`;
        const reply = window.document.createElement('button');
        reply.textContent = '回复';
        reply.dataset.ordinal = String(index);
        shadow.append(comment, reply);
        comments.appendChild(thread);
        buttons.push(reply);
    }

    window.document.elementFromPoint = (x, y) => {
        const ordinal = Math.max(1, Math.min(3, Math.round((Number(y) - 12) / 40)));
        return buttons[ordinal - 1] || null;
    };

    return { dom, window, buttons };
}

function getStrictHandles(snapshot) {
    return snapshot.pageGraph.elements
        .filter(item => item.label === '回复')
        .map(item => item.snapshotHandleId);
}

(function run() {
    const { window, buttons } = createFixture();
    const runtime = pageRuntimeModule.createWebAgentPageRuntime(
        {
            window,
            document: window.document,
            Node: window.Node
        },
        {
            runtimeInstanceId: 'runtime-handle-test',
            documentGeneration: 1
        }
    );

    const snapshot = runtime.snapshot();
    const replyRecords = snapshot.pageGraph.elements.filter(item => item.label === '回复');
    const strictHandles = getStrictHandles(snapshot);

    assert.strictEqual(replyRecords.length, 3, '应扫描出三个回复按钮');
    assert.strictEqual(strictHandles.length, 3, '每个回复按钮应拥有完整句柄');
    assert.strictEqual(new Set(strictHandles).size, 3, '完整句柄必须各自唯一');

    const signatureHashes = replyRecords.map(item => item.signature.hash);
    assert.strictEqual(
        new Set(signatureHashes).size,
        1,
        '同构同名回复按钮允许共享语义签名 Hash；Hash 不是元素唯一 ID'
    );

    strictHandles.forEach((handle, index) => {
        const resolved = runtime.resolveTarget(handle, {
            requireClickableLike: true,
            sideEffecting: true
        });
        assert.strictEqual(
            resolved.element,
            buttons[index],
            `完整句柄 ${handle} 应解析到第 ${index + 1} 个原始按钮`
        );
        assert.strictEqual(resolved.source, 'registry-exact');
        assert.strictEqual(resolved.candidateCount, 1);
        assert.strictEqual(resolved.recoveryUsed, false);
    });

    replyRecords.forEach((record, index) => {
        const resolved = runtime.resolveTarget(record.handleId, {
            requireClickableLike: true,
            sideEffecting: true
        });
        assert.strictEqual(
            resolved.element,
            buttons[index],
            `分组 ID ${record.handleId} 应通过注册表解析到第 ${index + 1} 个原始按钮`
        );
        assert.strictEqual(resolved.source, 'registry-exact');
    });

    assert.throws(
        () => runtime.resolveTarget('vcp-h-1-999-999-deadbeef'),
        error =>
            error.code === 'ELEMENT_HANDLE_NOT_REGISTERED' &&
            /不在当前 Page Runtime 注册表/.test(error.message),
        '同代次但未注册的句柄不得误报文档代次失效'
    );

    assert.throws(
        () => runtime.resolveTarget('vcp-h-2-1-1-deadbeef'),
        error =>
            error.code === 'ELEMENT_HANDLE_EXPIRED' &&
            /文档代次已失效/.test(error.message),
        '只有句柄 generation 与当前 generation 不同时才应报告代次失效'
    );

    const clickCounts = [0, 0, 0];
    buttons.forEach((button, index) => {
        button.addEventListener('click', () => {
            clickCounts[index] += 1;
        });
    });

    return Promise.resolve()
        .then(() => runtime.execute('page_click', {
            target: replyRecords[1].handleId,
            targetContext: {
                runtimeInstanceId: snapshot.runtimeInstanceId,
                documentGeneration: snapshot.documentGeneration,
                snapshotId: snapshot.snapshotId
            },
            strict: true,
            verification: 'observe'
        }, { strict: true }))
        .then(groupClickResult => {
            assert.strictEqual(groupClickResult.status, 'success');
            assert.deepStrictEqual(
                clickCounts,
                [0, 1, 0],
                '分组 ID 必须只点击其注册表对应的第二个回复按钮'
            );
            return runtime.execute('page_click', {
                target: strictHandles[2],
                targetContext: {
                    runtimeInstanceId: snapshot.runtimeInstanceId,
                    documentGeneration: snapshot.documentGeneration,
                    snapshotId: snapshot.snapshotId
                },
                strict: true,
                verification: 'observe'
            }, { strict: true });
        })
        .then(strictClickResult => {
            assert.strictEqual(strictClickResult.status, 'success');
            assert.deepStrictEqual(
                clickCounts,
                [0, 1, 1],
                '完整句柄必须只点击其注册表对应的第三个回复按钮'
            );

            console.log('Page Runtime 同构回复按钮句柄回归测试通过');
    console.log(JSON.stringify({
        runtimeVersion: runtime.version,
        documentGeneration: snapshot.documentGeneration,
        snapshotId: snapshot.snapshotId,
        replyCount: replyRecords.length,
        uniqueHandles: new Set(strictHandles).size,
        sharedSignatureHash: signatureHashes[0],
                resolutionSource: 'registry-exact',
                clickCounts
            }, null, 2));
        });
})();