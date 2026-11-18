'use strict';

const assert = require('assert');
const {
    protocol,
    adapterContract,
    runtimeCore
} = require('../../Plugin/ChromeBridge/VCPChrome/webcore/index.js');

class MockAdapter extends adapterContract.WebAgentAdapter {
    constructor() {
        super({ id: 'mock', version: '1.0.0', backend: 'mock-backend' });
        this.attached = false;
        this.calls = [];
        this.targets = [{
            id: 'target-1',
            targetId: 'target-1',
            title: 'Fixture',
            url: 'https://example.test',
            active: true
        }];
        this.listeners = new Set();
    }

    async getCapabilities() {
        return [
            'page', 'script', 'debugger', 'runtime', 'dom', 'accessibility',
            'nativeInput', 'network', 'storage', 'emulation', 'screenshot', 'targets'
        ];
    }

    async getTargetIdentity() {
        return {
            adapter: 'mock',
            targetId: 'target-1',
            runtimeInstanceId: 'runtime-1'
        };
    }

    async getDocumentState() {
        return { documentGeneration: 3, snapshotId: 12 };
    }

    async executePageOperation(operation, payload) {
        this.calls.push({ type: 'page', operation, payload });
        if (operation === 'network_query') {
            return {
                message: 'network queried',
                code: 'NETWORK_LOGS_RETURNED',
                result: [{ requestId: 'request-1' }],
                backendUsed: this.backend
            };
        }
        return {
            message: `${operation} completed`,
            code: 'PAGE_OPERATION_COMPLETED',
            result: payload,
            backendUsed: this.backend
        };
    }

    async executeScript(options) {
        this.calls.push({ type: 'script', options });
        return {
            message: 'script completed',
            code: 'SCRIPT_RESULT_RETURNED',
            result: { value: 42 },
            details: {
                executionWorld: options.executionWorld,
                resultPresent: true
            },
            backendUsed: this.backend
        };
    }

    async attachDebugger() {
        this.attached = true;
        return {
            message: 'attached',
            code: 'DEBUGGER_ATTACHED',
            result: { attached: true },
            backendUsed: this.backend
        };
    }

    async detachDebugger() {
        this.attached = false;
        return {
            message: 'detached',
            code: 'DEBUGGER_DETACHED',
            result: { attached: false },
            backendUsed: this.backend
        };
    }

    async getDebuggerStatus() {
        return {
            message: 'status',
            code: 'DEBUGGER_STATUS_RETURNED',
            result: { attached: this.attached },
            backendUsed: this.backend
        };
    }

    async sendDebuggerCommand(method, params) {
        this.calls.push({ type: 'debugger', method, params });
        if (method === 'Network.getResponseBody') {
            return {
                result: {
                    body: 'abcdefghijklmnopqrstuvwxyz',
                    base64Encoded: false
                },
                backendUsed: this.backend
            };
        }
        if (method === 'DOM.getDocument') {
            return {
                result: { root: { nodeId: 7 } },
                backendUsed: this.backend
            };
        }
        if (method === 'Mock.fail') {
            const error = new Error('mock debugger failed');
            error.code = 'MOCK_FAILURE';
            throw error;
        }
        return {
            message: `${method} completed`,
            code: 'DEBUGGER_COMMAND_COMPLETED',
            result: { method, params },
            backendUsed: this.backend
        };
    }

    subscribeDebuggerEvents(listener) {
        this.listeners.add(listener);
    }

    unsubscribeDebuggerEvents(listener) {
        if (listener) this.listeners.delete(listener);
        else this.listeners.clear();
    }

    async dispatchNativeInput(plan) {
        this.calls.push({ type: 'input', plan });
        return {
            message: 'input dispatched',
            code: 'ACTION_DISPATCHED',
            result: { plan },
            backendUsed: this.backend
        };
    }

    async captureScreenshot(options) {
        return {
            message: 'captured',
            code: 'SCREENSHOT_CAPTURED',
            result: {
                dataUrl: 'data:image/png;base64,AA==',
                options
            },
            backendUsed: this.backend
        };
    }

    async listTargets() {
        return {
            message: 'targets',
            code: 'TARGETS_RETURNED',
            result: { targets: this.targets },
            backendUsed: this.backend
        };
    }

    async getTarget(targetId) {
        return this.targets.find(target => target.id === targetId) || null;
    }

    async getActiveTarget() {
        return this.targets.find(target => target.active) || null;
    }

    async activateTarget(targetId) {
        return {
            message: 'activated',
            code: 'TARGET_ACTIVATED',
            result: { targetId },
            backendUsed: this.backend
        };
    }

    async createTarget(options) {
        return {
            message: 'created',
            code: 'TARGET_CREATED',
            result: { id: 'target-2', ...options },
            backendUsed: this.backend
        };
    }

    async closeTarget(targetId) {
        return {
            message: 'closed',
            code: 'TARGET_CLOSED',
            result: { targetId },
            backendUsed: this.backend
        };
    }

    async navigate(action, payload) {
        return {
            message: 'navigated',
            code: 'TARGET_NAVIGATION_DISPATCHED',
            result: { action, payload },
            backendUsed: this.backend
        };
    }

    async waitForNavigation() {
        return {
            message: 'complete',
            code: 'NAVIGATION_COMPLETED',
            result: { reason: 'complete' },
            backendUsed: this.backend
        };
    }
}

function request(command, params = {}, options = {}) {
    return protocol.createRequest({
        command,
        targetContext: {
            adapter: 'mock',
            targetId: 'target-1',
            runtimeInstanceId: 'runtime-1',
            documentGeneration: 3,
            snapshotId: 12
        },
        params,
        options: {
            strict: true,
            ...options
        }
    });
}

(async function run() {
    const adapter = new MockAdapter();
    adapterContract.validateAdapter(adapter);
    const negotiated = await adapterContract.negotiateCapabilities(adapter);
    assert(negotiated.supportedCommands.includes('debugger_send_command'));
    assert(negotiated.supportedCommands.includes('runtime_execute_script'));

    const auditEvents = [];
    const runtime = runtimeCore.createWebAgentRuntime(adapter, {
        audit(event) {
            auditEvents.push(event);
        }
    });
    await runtime.initialize();

    const scriptResponse = await runtime.execute(request('execute_script', {
        text: 'return 42;',
        executionWorld: 'ISOLATED'
    }));
    assert.strictEqual(scriptResponse.status, 'success');
    assert.strictEqual(scriptResponse.code, 'SCRIPT_RESULT_RETURNED');
    assert.deepStrictEqual(scriptResponse.result.result, { value: 42 });
    assert.strictEqual(scriptResponse.runtime.runtimeInstanceId, 'runtime-1');

    const attachResponse = await runtime.execute(request('cdp_start'));
    assert.strictEqual(attachResponse.status, 'success');
    assert.strictEqual(adapter.attached, true);

    const domResponse = await runtime.execute(request('cdp_dom_query_selector', {
        selector: '#fixture'
    }));
    assert.strictEqual(domResponse.status, 'success');
    const queryCall = adapter.calls.find(call =>
        call.type === 'debugger' && call.method === 'DOM.querySelector'
    );
    assert.deepStrictEqual(queryCall.params, {
        nodeId: 7,
        selector: '#fixture'
    });

    const bodyResponse = await runtime.execute(request('cdp_get_response_body', {
        cdpRequestId: 'request-1',
        maxBodyChars: 5
    }));
    assert.strictEqual(bodyResponse.status, 'success');
    assert.strictEqual(bodyResponse.code, 'NETWORK_RESPONSE_BODY_RETURNED');
    assert.strictEqual(bodyResponse.result.result.body, 'abcde');
    assert.strictEqual(bodyResponse.result.result.bodyChars, 26);
    assert.strictEqual(bodyResponse.result.result.truncated, true);
    assert.strictEqual(bodyResponse.result.result.omittedChars, 21);
    assert.match(bodyResponse.result.result.sha256, /^[a-f0-9]{64}$/);

    const screenshotResponse = await runtime.execute(request('screenshot', {
        format: 'png'
    }));
    assert.strictEqual(screenshotResponse.status, 'success');
    assert.match(screenshotResponse.result.result.dataUrl, /^data:image\/png/);

    const targetResponse = await runtime.execute(request('list_tabs'));
    assert.strictEqual(targetResponse.status, 'success');
    assert.strictEqual(targetResponse.result.result.targets.length, 1);

    const mismatch = await runtime.execute(protocol.createRequest({
        command: 'debugger_status',
        targetContext: {
            adapter: 'mock',
            targetId: 'target-1',
            runtimeInstanceId: 'wrong-runtime',
            documentGeneration: 3,
            snapshotId: 12
        },
        options: { strict: true }
    }));
    assert.strictEqual(mismatch.status, 'error');
    assert.strictEqual(mismatch.code, 'RUNTIME_INSTANCE_MISMATCH');

    const adapterFailure = await runtime.execute(request('debugger_send_command', {
        method: 'Mock.fail',
        params: {}
    }));
    assert.strictEqual(adapterFailure.status, 'error');
    assert.strictEqual(adapterFailure.code, 'MOCK_FAILURE');
    assert.strictEqual(adapterFailure.error, 'mock debugger failed');

    assert.strictEqual(protocol.resolveCommand('click').canonical, 'page_click');
    assert.strictEqual(protocol.resolveCommand('cdp_runtime_evaluate').canonical, 'runtime_evaluate');
    assert.strictEqual(protocol.isRetryAllowed('get_page_info'), true);
    assert.strictEqual(protocol.isRetryAllowed('click'), false);
    assert.strictEqual(protocol.COMMANDS.debugger_send_command.risk, 'root');
    assert.strictEqual(protocol.COMMANDS.runtime_execute_script.risk, 'root');
    assert(auditEvents.some(event => event.phase === 'success'));
    assert(auditEvents.some(event => event.phase === 'error'));

    console.log('Web Agent Runtime Core Mock Adapter 测试通过');
    console.log(JSON.stringify({
        protocolVersion: protocol.PROTOCOL_VERSION,
        capabilityCount: protocol.getCapabilities().length,
        supportedCommandCount: negotiated.supportedCommands.length,
        scriptWorld: scriptResponse.result.details.executionWorld,
        responseBodyTruncated: bodyResponse.result.result.truncated,
        sideEffectRetryable: protocol.isRetryAllowed('click'),
        auditEventCount: auditEvents.length
    }, null, 2));
})();