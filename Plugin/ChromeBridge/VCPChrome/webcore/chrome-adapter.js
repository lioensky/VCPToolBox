(function initChromeWebAgentAdapter(globalScope, factory) {
    const protocol = globalScope?.VCPWebAgentProtocol ||
        (typeof require === 'function' ? require('./web-agent-protocol.js') : null);
    const contract = globalScope?.VCPWebAgentAdapterContract ||
        (typeof require === 'function' ? require('./adapter-contract.js') : null);
    const api = factory(protocol, contract);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPChromeWebAgentAdapter = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChromeAdapterModule(protocol, contract) {
    'use strict';

    if (!protocol || !contract) {
        throw new Error('Chrome Adapter 需要先加载 Web Agent Protocol 与 Adapter Contract');
    }

    const VERSION = '0.1.0';
    const CAPABILITIES = Object.freeze([
        'page',
        'script',
        'debugger',
        'runtime',
        'dom',
        'accessibility',
        'nativeInput',
        'network',
        'storage',
        'emulation',
        'screenshot',
        'targets'
    ]);

    function chromeCall(chromeObject, method, args = [], options = {}) {
        return new Promise((resolve, reject) => {
            if (!chromeObject || typeof chromeObject[method] !== 'function') {
                reject(new protocol.WebAgentError(
                    protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                    `Chrome API 不可用: ${options.apiName || method}`
                ));
                return;
            }
            try {
                chromeObject[method](...args, result => {
                    const runtimeError = globalThis.chrome?.runtime?.lastError;
                    if (runtimeError) {
                        reject(new protocol.WebAgentError(
                            options.errorCode || protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                            runtimeError.message,
                            { api: options.apiName || method }
                        ));
                        return;
                    }
                    resolve(result);
                });
            } catch (error) {
                reject(protocol.normalizeError(error));
            }
        });
    }

    function normalizeTarget(tab) {
        if (!tab) return null;
        return {
            id: tab.id,
            targetId: tab.id,
            windowId: tab.windowId,
            title: tab.title || '',
            url: tab.url || '',
            active: tab.active === true,
            status: tab.status || null,
            width: tab.width || null,
            height: tab.height || null
        };
    }

    class ChromeWebAgentAdapter extends contract.WebAgentAdapter {
        constructor(chromeApi, options = {}) {
            super({
                id: 'chrome',
                version: VERSION,
                backend: 'chrome-extension'
            });
            if (!chromeApi) throw new Error('Chrome Adapter 缺少 chrome API');
            this.chrome = chromeApi;
            this.options = options;
            this.attachedTabId = null;
            this.networkLogs = new Map();
            this.debuggerListeners = new Set();
            this.documentStates = new Map();
            this.runtimeInstanceId = options.runtimeInstanceId ||
                `chrome-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            this.currentActiveTabId = options.currentActiveTabId || null;
            this.bindDebuggerEvents();
        }

        async getCapabilities() {
            return CAPABILITIES.slice();
        }

        setActiveTargetId(targetId) {
            this.currentActiveTabId = targetId ?? null;
        }

        setRuntimeInstanceId(runtimeInstanceId) {
            this.runtimeInstanceId = runtimeInstanceId || this.runtimeInstanceId;
        }

        noteDocumentGeneration(targetId, reason = 'unknown') {
            const key = String(targetId);
            const previous = this.documentStates.get(key) || {
                documentGeneration: 0,
                snapshotId: null
            };
            const next = {
                ...previous,
                documentGeneration: previous.documentGeneration + 1,
                snapshotId: null,
                changedAt: Date.now(),
                reason
            };
            this.documentStates.set(key, next);
            return next;
        }

        updateDocumentState(targetId, state = {}) {
            const key = String(targetId);
            const previous = this.documentStates.get(key) || {
                documentGeneration: 1,
                snapshotId: null
            };
            const next = {
                ...previous,
                ...state,
                documentGeneration: Number(state.documentGeneration ?? previous.documentGeneration) || 1
            };
            this.documentStates.set(key, next);
            return next;
        }

        async resolveTargetId(targetContext = {}) {
            if (targetContext.targetId !== null && targetContext.targetId !== undefined) {
                const raw = String(targetContext.targetId);
                const suffix = raw.includes(':') ? raw.split(':').pop() : raw;
                const parsed = Number(suffix);
                if (Number.isFinite(parsed)) return parsed;
            }
            if (this.currentActiveTabId !== null) return this.currentActiveTabId;
            const active = await this.getActiveTarget();
            if (!active?.id) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.NO_ACTIVE_TARGET,
                    '没有活动的 Chrome 标签页'
                );
            }
            this.currentActiveTabId = active.id;
            return active.id;
        }

        async getTargetIdentity(targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            return {
                adapter: this.id,
                targetId,
                appId: null,
                runtimeInstanceId: this.runtimeInstanceId
            };
        }

        async getDocumentState(targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            return this.documentStates.get(String(targetId)) || {
                documentGeneration: 1,
                snapshotId: null
            };
        }

        async executePageOperation(operation, payload = {}, request = {}) {
            const targetId = await this.resolveTargetId(request.targetContext || {});
            if (operation === 'network_query') {
                const logs = Array.from(this.networkLogs.values()).filter(log =>
                    !payload.urlIncludes || log.request?.url?.includes(payload.urlIncludes)
                );
                return {
                    message: '网络日志查询成功',
                    code: 'NETWORK_LOGS_RETURNED',
                    result: logs,
                    backendUsed: 'chrome-debugger'
                };
            }
            if (operation === 'network_clear') {
                this.networkLogs.clear();
                return {
                    message: '网络日志已清空',
                    code: 'NETWORK_LOGS_CLEARED',
                    result: { cleared: true },
                    backendUsed: 'chrome-debugger'
                };
            }
            if (operation.startsWith('storage_')) {
                return this.executeStorageOperation(targetId, operation, payload);
            }
            const legacyOperation = operation.replace(/^page_/, '');
            const response = await this.chrome.tabs.sendMessage(targetId, {
                type: 'EXECUTE_CORE_COMMAND',
                data: {
                    ...payload,
                    command: legacyOperation,
                    requestId: request.requestId,
                    targetContext: request.targetContext,
                    options: request.options
                }
            });
            if (!response) {
                return {
                    message: '页面操作已分派，结果将通过页面通道异步返回',
                    code: 'ACTION_DISPATCHED',
                    result: null,
                    backendUsed: 'content-script'
                };
            }
            if (response.status === 'error') {
                throw new protocol.WebAgentError(
                    response.code || protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                    response.error || '页面操作失败',
                    response.details || {}
                );
            }
            return {
                ...response,
                backendUsed: response.backendUsed || 'content-script'
            };
        }

        async executeStorageOperation(targetId, operation, payload) {
            const area = operation.includes('_session') ? 'sessionStorage' : 'localStorage';
            const mode = operation.includes('_set_') ? 'set' : 'get';
            const results = await this.executeInjected(targetId, 'ISOLATED', async (storageArea, action, data) => {
                const storage = globalThis[storageArea];
                if (action === 'get') {
                    if (data.key !== undefined) return { [data.key]: storage.getItem(String(data.key)) };
                    return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
                        const key = storage.key(index);
                        return [key, storage.getItem(key)];
                    }));
                }
                const entries = data.entries && typeof data.entries === 'object'
                    ? Object.entries(data.entries)
                    : [[data.key, data.value]];
                for (const [key, value] of entries) {
                    storage.setItem(String(key), String(value ?? ''));
                }
                return { written: entries.map(([key]) => String(key)) };
            }, [area, mode, payload]);
            return {
                message: `${area} ${mode} 成功`,
                code: mode === 'get' ? 'STORAGE_VALUES_RETURNED' : 'STORAGE_VALUES_WRITTEN',
                result: results?.[0]?.result ?? null,
                backendUsed: 'chrome-scripting'
            };
        }

        async executeInjected(targetId, world, func, args = []) {
            return this.chrome.scripting.executeScript({
                target: { tabId: targetId },
                world,
                func,
                args
            });
        }

        async executeScript(options = {}, targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            const executionWorld = String(options.executionWorld || 'MAIN').toUpperCase() === 'ISOLATED'
                ? 'ISOLATED'
                : 'MAIN';
            if (options.operation) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                    `Chrome Adapter 未注册固定 operation: ${options.operation}`
                );
            }
            const code = String(options.code || '');
            if (!code.trim()) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.INVALID_REQUEST,
                    '脚本执行缺少代码'
                );
            }
            const injectionResults = await this.executeInjected(
                targetId,
                executionWorld,
                async userCode => {
                    const runner = new Function(`return (async () => {\n${userCode}\n})()`);
                    return await runner();
                },
                [code]
            );
            const firstFrame = Array.isArray(injectionResults) ? injectionResults[0] : null;
            const scriptResult = firstFrame?.result;
            const resultPresent = Boolean(firstFrame) &&
                Object.prototype.hasOwnProperty.call(firstFrame, 'result') &&
                scriptResult !== undefined;
            return {
                message: resultPresent
                    ? `脚本执行成功 (${executionWorld})`
                    : `脚本执行完成，但未返回可序列化结果 (${executionWorld})`,
                code: resultPresent ? 'SCRIPT_RESULT_RETURNED' : 'SCRIPT_RESULT_MISSING',
                result: scriptResult === undefined ? null : scriptResult,
                details: {
                    executionWorld,
                    frameCount: Array.isArray(injectionResults) ? injectionResults.length : 0,
                    frameId: firstFrame?.frameId ?? null,
                    documentId: firstFrame?.documentId ?? null,
                    resultPresent,
                    resultType: scriptResult === null ? 'null' : typeof scriptResult
                },
                backendUsed: 'chrome-scripting'
            };
        }

        async attachDebugger(targetContext = {}, options = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            if (this.attachedTabId === targetId) {
                return {
                    message: 'Debugger 已连接',
                    code: 'DEBUGGER_ALREADY_ATTACHED',
                    result: { targetId, attached: true },
                    backendUsed: 'chrome-debugger'
                };
            }
            if (this.attachedTabId !== null) await this.detachDebugger({ targetId: this.attachedTabId });
            await chromeCall(this.chrome.debugger, 'attach', [{ tabId: targetId }, '1.3'], {
                apiName: 'chrome.debugger.attach'
            });
            this.attachedTabId = targetId;
            if (options.network !== false) {
                await this.sendDebuggerCommand('Network.enable', {}, { targetId });
            }
            return {
                message: 'Debugger 连接成功',
                code: 'DEBUGGER_ATTACHED',
                result: { targetId, attached: true },
                backendUsed: 'chrome-debugger'
            };
        }

        async detachDebugger(targetContext = {}) {
            const targetId = targetContext.targetId ?? this.attachedTabId;
            if (targetId === null || targetId === undefined) {
                return {
                    message: 'Debugger 当前未连接',
                    code: 'DEBUGGER_ALREADY_DETACHED',
                    result: { attached: false },
                    backendUsed: 'chrome-debugger'
                };
            }
            await chromeCall(this.chrome.debugger, 'detach', [{ tabId: Number(targetId) }], {
                apiName: 'chrome.debugger.detach'
            }).catch(error => {
                if (!/not attached/i.test(error.message)) throw error;
            });
            if (Number(targetId) === this.attachedTabId) this.attachedTabId = null;
            this.networkLogs.clear();
            return {
                message: 'Debugger 已断开',
                code: 'DEBUGGER_DETACHED',
                result: { targetId: Number(targetId), attached: false },
                backendUsed: 'chrome-debugger'
            };
        }

        async getDebuggerStatus() {
            return {
                message: 'Debugger 状态已返回',
                code: 'DEBUGGER_STATUS_RETURNED',
                result: {
                    attached: this.attachedTabId !== null,
                    targetId: this.attachedTabId
                },
                backendUsed: 'chrome-debugger'
            };
        }

        async ensureDebugger(targetId) {
            if (this.attachedTabId !== targetId) {
                await this.attachDebugger({ targetId }, { network: true });
            }
        }

        async sendDebuggerCommand(method, params = {}, targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            await this.ensureDebugger(targetId);
            const result = await chromeCall(
                this.chrome.debugger,
                'sendCommand',
                [{ tabId: targetId }, method, params],
                { apiName: `chrome.debugger.sendCommand:${method}` }
            );
            return {
                message: `${method} 执行成功`,
                code: 'DEBUGGER_COMMAND_COMPLETED',
                result: result || {},
                backendUsed: 'chrome-debugger'
            };
        }

        subscribeDebuggerEvents(listener) {
            this.debuggerListeners.add(listener);
            return () => this.debuggerListeners.delete(listener);
        }

        unsubscribeDebuggerEvents(listener) {
            if (listener) this.debuggerListeners.delete(listener);
            else this.debuggerListeners.clear();
        }

        bindDebuggerEvents() {
            if (this.chrome.debugger?.onEvent?.addListener) {
                this.chrome.debugger.onEvent.addListener((source, method, params) => {
                    if (method === 'Network.requestWillBeSent') {
                        this.networkLogs.set(params.requestId, {
                            requestId: params.requestId,
                            request: params.request,
                            timestamp: params.timestamp,
                            resourceType: params.type
                        });
                    } else if (method === 'Network.responseReceived') {
                        const log = this.networkLogs.get(params.requestId);
                        if (log) log.response = params.response;
                    }
                    const event = {
                        adapter: this.id,
                        targetId: source.tabId,
                        method,
                        params,
                        timestamp: Date.now()
                    };
                    for (const listener of this.debuggerListeners) listener(event);
                });
            }
            if (this.chrome.debugger?.onDetach?.addListener) {
                this.chrome.debugger.onDetach.addListener(source => {
                    if (source.tabId === this.attachedTabId) {
                        this.attachedTabId = null;
                        this.networkLogs.clear();
                    }
                });
            }
        }

        async dispatchNativeInput(plan, targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            await this.ensureDebugger(targetId);
            if (plan.type === 'insert-text') {
                await this.sendDebuggerCommand('Input.insertText', { text: plan.text }, { targetId });
            } else if (plan.type === 'keyboard-sequence') {
                for (const descriptor of plan.keys) {
                    const common = {
                        key: descriptor.key,
                        code: descriptor.code,
                        modifiers: plan.modifiers,
                        location: descriptor.location,
                        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
                        nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode
                    };
                    await this.sendDebuggerCommand('Input.dispatchKeyEvent', {
                        type: descriptor.text && plan.modifiers === 0 ? 'keyDown' : 'rawKeyDown',
                        ...common
                    }, { targetId });
                    if (descriptor.text && plan.modifiers === 0) {
                        await this.sendDebuggerCommand('Input.dispatchKeyEvent', {
                            type: 'char',
                            ...common,
                            text: descriptor.text,
                            unmodifiedText: descriptor.text
                        }, { targetId });
                    }
                    await this.sendDebuggerCommand('Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        ...common
                    }, { targetId });
                }
            } else if (plan.type === 'mouse-sequence') {
                const typeMap = {
                    move: 'mouseMoved',
                    down: 'mousePressed',
                    up: 'mouseReleased',
                    wheel: 'mouseWheel'
                };
                for (const event of plan.events) {
                    await this.sendDebuggerCommand('Input.dispatchMouseEvent', {
                        ...event,
                        type: typeMap[event.type] || event.type
                    }, { targetId });
                }
            } else {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.INVALID_REQUEST,
                    `未知原生输入计划: ${plan.type}`
                );
            }
            return {
                message: '原生输入计划执行成功',
                code: 'ACTION_DISPATCHED',
                result: { attempted: true, verified: null, plan },
                backendUsed: 'chrome-debugger'
            };
        }

        async captureScreenshot(options = {}, targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            const tab = await this.getTarget(targetId);
            const format = ['jpeg', 'jpg'].includes(String(options.imageFormat || options.format || '').toLowerCase())
                ? 'jpeg'
                : 'png';
            const quality = Math.min(Math.max(Number(options.quality) || 90, 1), 100);
            const captureOptions = format === 'jpeg' ? { format, quality } : { format };
            const dataUrl = await chromeCall(
                this.chrome.tabs,
                'captureVisibleTab',
                [tab.windowId, captureOptions],
                { apiName: 'chrome.tabs.captureVisibleTab' }
            );
            if (!dataUrl) throw new Error('截图失败：Chrome 未返回图像数据');
            return {
                message: `当前活动标签页截图获取成功 (${format})`,
                code: 'SCREENSHOT_CAPTURED',
                result: {
                    dataUrl,
                    mimeType: `image/${format}`,
                    format,
                    byteLength: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
                    capturedAt: new Date().toISOString(),
                    tab
                },
                backendUsed: 'chrome-tabs-capture'
            };
        }

        async listTargets() {
            const tabs = await this.chrome.tabs.query({});
            return {
                message: `获取标签页列表成功，当前 ${tabs.length} 个标签页`,
                code: 'TARGETS_RETURNED',
                result: {
                    targets: tabs.map(normalizeTarget),
                    tabs: tabs.map(normalizeTarget),
                    count: tabs.length
                },
                backendUsed: 'chrome-tabs'
            };
        }

        async getTarget(targetId) {
            const tab = await this.chrome.tabs.get(Number(targetId));
            return normalizeTarget(tab);
        }

        async getActiveTarget() {
            const tabs = await this.chrome.tabs.query({ active: true, currentWindow: true });
            return normalizeTarget(tabs[0]);
        }

        async activateTarget(target) {
            const targetTab = await this.resolveTarget(target);
            const tab = await this.chrome.tabs.update(targetTab.id, { active: true });
            this.currentActiveTabId = tab.id;
            return {
                message: `成功切换到标签页: ${tab.title || tab.url}`,
                code: 'TARGET_ACTIVATED',
                result: normalizeTarget(tab),
                backendUsed: 'chrome-tabs'
            };
        }

        async createTarget(options = {}) {
            let url = String(options.url || '');
            if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
            const tab = await this.chrome.tabs.create({
                ...(url ? { url } : {}),
                active: options.active !== false
            });
            if (tab.active) this.currentActiveTabId = tab.id;
            this.updateDocumentState(tab.id, { documentGeneration: 1, snapshotId: null });
            return {
                message: url ? `成功打开URL: ${url}` : '成功创建标签页',
                code: 'TARGET_CREATED',
                result: normalizeTarget(tab),
                backendUsed: 'chrome-tabs'
            };
        }

        async closeTarget(target) {
            const targetTab = await this.resolveTarget(target);
            await this.chrome.tabs.remove(targetTab.id);
            this.documentStates.delete(String(targetTab.id));
            if (this.currentActiveTabId === targetTab.id) this.currentActiveTabId = null;
            return {
                message: `成功关闭标签页: ${targetTab.title || targetTab.url}`,
                code: 'TARGET_CLOSED',
                result: targetTab,
                backendUsed: 'chrome-tabs'
            };
        }

        async resolveTarget(target) {
            const tabs = await this.chrome.tabs.query({});
            if (target === undefined || target === null || target === '') {
                const active = tabs.find(tab => tab.active);
                if (active) return normalizeTarget(active);
            }
            const numeric = Number(target);
            let found = Number.isFinite(numeric) ? tabs.find(tab => tab.id === numeric) : null;
            if (!found) {
                const normalized = String(target || '').toLowerCase();
                found = tabs.find(tab =>
                    tab.title?.toLowerCase().includes(normalized) ||
                    tab.url?.toLowerCase().includes(normalized)
                );
            }
            if (!found) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.TARGET_NOT_FOUND,
                    `未找到匹配的标签页: ${target}`
                );
            }
            return normalizeTarget(found);
        }

        async navigate(action, payload = {}, targetContext = {}) {
            const targetId = await this.resolveTargetId(targetContext);
            let tab;
            if (action === 'navigate') {
                let url = String(payload.url || '');
                if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
                tab = await this.chrome.tabs.update(targetId, { url });
            } else if (action === 'reload') {
                await this.chrome.tabs.reload(targetId, { bypassCache: payload.bypassCache === true });
                tab = await this.getTarget(targetId);
            } else {
                const method = action === 'back' ? 'goBack' : 'goForward';
                await chromeCall(this.chrome.tabs, method, [targetId], {
                    apiName: `chrome.tabs.${method}`
                });
                tab = await this.getTarget(targetId);
            }
            this.noteDocumentGeneration(targetId, `navigate:${action}`);
            return {
                message: `目标导航操作完成: ${action}`,
                code: 'TARGET_NAVIGATION_DISPATCHED',
                result: tab,
                backendUsed: 'chrome-tabs'
            };
        }

        async waitForNavigation(context = {}) {
            const targetId = await this.resolveTargetId(context);
            const timeoutMs = Math.min(Math.max(Number(context.timeoutMs) || 10000, 100), 120000);
            return new Promise(resolve => {
                let settled = false;
                const finish = (reason, tab = null) => {
                    if (settled) return;
                    settled = true;
                    this.chrome.tabs.onUpdated.removeListener(listener);
                    resolve({
                        message: `导航等待结束: ${reason}`,
                        code: reason === 'complete' ? 'NAVIGATION_COMPLETED' : 'NAVIGATION_WAIT_TIMEOUT',
                        result: { reason, target: normalizeTarget(tab) },
                        backendUsed: 'chrome-tabs'
                    });
                };
                const listener = (updatedTabId, changeInfo, tab) => {
                    if (updatedTabId === targetId && changeInfo.status === 'complete') {
                        finish('complete', tab);
                    }
                };
                this.chrome.tabs.onUpdated.addListener(listener);
                setTimeout(() => finish('timeout'), timeoutMs);
            });
        }
    }

    function createChromeWebAgentAdapter(chromeApi, options) {
        return new ChromeWebAgentAdapter(chromeApi, options);
    }

    return Object.freeze({
        VERSION,
        CAPABILITIES,
        ChromeWebAgentAdapter,
        createChromeWebAgentAdapter,
        chromeCall,
        normalizeTarget
    });
});