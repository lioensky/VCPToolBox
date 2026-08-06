(function initWebAgentRuntimeCore(globalScope, factory) {
    const protocol = globalScope?.VCPWebAgentProtocol ||
        (typeof require === 'function' ? require('./web-agent-protocol.js') : null);
    const contract = globalScope?.VCPWebAgentAdapterContract ||
        (typeof require === 'function' ? require('./adapter-contract.js') : null);
    const api = factory(protocol, contract, globalScope);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPWebAgentRuntimeCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeCoreModule(protocol, contract, globalScope) {
    'use strict';

    if (!protocol || !contract) {
        throw new Error('VCP Web Agent Runtime Core 需要先加载 Protocol 与 Adapter Contract');
    }

    const VERSION = '0.1.0';
    const MODIFIER_BITS = Object.freeze({
        alt: 1,
        ctrl: 2,
        control: 2,
        meta: 4,
        cmd: 4,
        command: 4,
        shift: 8
    });

    function parseJsonParam(value, fallback = {}) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'object') return value;
        if (typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch (error) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.INVALID_REQUEST,
                    `JSON 参数解析失败: ${error.message}`
                );
            }
        }
        throw new protocol.WebAgentError(
            protocol.ErrorCode.INVALID_REQUEST,
            'JSON 参数必须是对象或 JSON 字符串'
        );
    }

    function parseBooleanParam(value, defaultValue = false) {
        if (value === undefined || value === null || value === '') return defaultValue;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
        return Boolean(value);
    }

    function parseNumberParam(value, defaultValue, minValue, maxValue) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return defaultValue;
        return Math.min(Math.max(parsed, minValue), maxValue);
    }

    function estimateBodyBytes(body, base64Encoded) {
        const text = String(body || '');
        if (!base64Encoded) return new TextEncoder().encode(text).byteLength;
        const normalized = text.replace(/\s+/g, '');
        const padding = normalized.endsWith('==') ? 2 : (normalized.endsWith('=') ? 1 : 0);
        return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
    }

    async function sha256Text(text) {
        const bytes = new TextEncoder().encode(String(text || ''));
        const cryptoObject = globalScope?.crypto;
        if (!cryptoObject?.subtle) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                '当前运行时不支持 crypto.subtle SHA-256'
            );
        }
        const digest = await cryptoObject.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function buildResponseBodyResult(response, params = {}) {
        const body = String(response?.body || '');
        const base64Encoded = response?.base64Encoded === true;
        const bodyChars = body.length;
        const bodyBytes = estimateBodyBytes(body, base64Encoded);
        const metadataOnly = parseBooleanParam(params.metadataOnly, false);
        const maxBodyChars = Math.round(parseNumberParam(params.maxBodyChars, 16384, 0, 1000000));
        const truncated = !metadataOnly && bodyChars > maxBodyChars;
        const exposedBody = metadataOnly ? undefined : (truncated ? body.slice(0, maxBodyChars) : body);
        return {
            ...(exposedBody === undefined ? {} : { body: exposedBody }),
            base64Encoded,
            bodyBytes,
            bodyChars,
            sha256: await sha256Text(body),
            metadataOnly,
            maxBodyChars,
            truncated,
            omittedChars: metadataOnly ? bodyChars : Math.max(0, bodyChars - maxBodyChars)
        };
    }

    function normalizeKeys(keys) {
        if (Array.isArray(keys)) return keys.map(String);
        return String(keys || '').split(/\s*\+\s*|\s*,\s*/).filter(Boolean);
    }

    function getKeyDescriptor(rawKey) {
        const aliases = {
            esc: 'Escape',
            return: 'Enter',
            space: ' ',
            arrowup: 'ArrowUp',
            arrowdown: 'ArrowDown',
            arrowleft: 'ArrowLeft',
            arrowright: 'ArrowRight',
            pageup: 'PageUp',
            pagedown: 'PageDown'
        };
        const key = aliases[String(rawKey || '').toLowerCase()] || String(rawKey || '');
        const specialKeys = {
            Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
            Tab: { code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t' },
            Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
            Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
            Delete: { code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
            ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
            ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
            ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
            ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
            PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
            PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
            Home: { code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
            End: { code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
            ' ': { code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' }
        };
        if (specialKeys[key]) return { key, location: 0, ...specialKeys[key] };
        const character = key.slice(0, 1);
        const upper = character.toUpperCase();
        return {
            key: character,
            code: /^[a-z]$/i.test(character)
                ? `Key${upper}`
                : (/^\d$/.test(character) ? `Digit${character}` : character),
            windowsVirtualKeyCode: upper.charCodeAt(0) || 0,
            nativeVirtualKeyCode: upper.charCodeAt(0) || 0,
            location: 0,
            text: character
        };
    }

    function createKeyboardPlan(keys) {
        const tokens = normalizeKeys(keys);
        if (!tokens.length) {
            throw new protocol.WebAgentError(protocol.ErrorCode.INVALID_REQUEST, '键盘操作缺少 keys');
        }
        let modifiers = 0;
        const actionKeys = [];
        for (const token of tokens) {
            const lower = token.toLowerCase();
            if (MODIFIER_BITS[lower]) modifiers |= MODIFIER_BITS[lower];
            else actionKeys.push(token);
        }
        return {
            type: 'keyboard-sequence',
            modifiers,
            keys: actionKeys.map(getKeyDescriptor)
        };
    }

    function createMousePlan(action, point = {}, params = {}) {
        const x = Math.round(Number(point.x) || 0);
        const y = Math.round(Number(point.y) || 0);
        if (action === 'click') {
            return {
                type: 'mouse-sequence',
                events: [
                    { type: 'move', x, y },
                    { type: 'down', x, y, button: 'left', clickCount: 1 },
                    { type: 'up', x, y, button: 'left', clickCount: 1 }
                ]
            };
        }
        if (action === 'hover') {
            return { type: 'mouse-sequence', events: [{ type: 'move', x, y }] };
        }
        if (action === 'scroll') {
            const amount = parseNumberParam(params.amount, 600, 1, 100000);
            const direction = String(params.direction || 'down').toLowerCase();
            return {
                type: 'mouse-sequence',
                events: [{
                    type: 'wheel',
                    x,
                    y,
                    deltaX: ['left', 'page_left'].includes(direction)
                        ? -amount
                        : (['right', 'page_right'].includes(direction) ? amount : 0),
                    deltaY: ['up', 'page_up'].includes(direction)
                        ? -amount
                        : (['down', 'page_down'].includes(direction) ? amount : 0)
                }]
            };
        }
        throw new protocol.WebAgentError(
            protocol.ErrorCode.INVALID_REQUEST,
            `不支持的鼠标计划: ${action}`
        );
    }

    function summarizeTargetState(targets) {
        return (Array.isArray(targets) ? targets : []).map(target => ({
            id: target.id,
            url: target.url || '',
            title: target.title || '',
            active: target.active === true
        }));
    }

    function detectTargetTransition(beforeTargets, afterTargets, sourceTargetId) {
        const beforeById = new Map(beforeTargets.map(target => [String(target.id), target]));
        const afterSource = afterTargets.find(target => String(target.id) === String(sourceTargetId)) || null;
        const beforeSource = beforeById.get(String(sourceTargetId)) || null;
        const createdTargets = afterTargets.filter(target => !beforeById.has(String(target.id)));
        const sourceNavigated = Boolean(beforeSource && afterSource && beforeSource.url !== afterSource.url);
        return {
            observed: sourceNavigated || createdTargets.length > 0,
            sourceNavigated,
            createdTargets,
            beforeSource,
            afterSource,
            targetCountBefore: beforeTargets.length,
            targetCountAfter: afterTargets.length
        };
    }

    function normalizeLegacyChromeCommand(commandData = {}, targetContext = {}) {
        const resolved = protocol.resolveCommand(commandData.command);
        const params = { ...commandData };
        delete params.command;
        delete params.requestId;
        return protocol.createRequest({
            requestId: commandData.requestId,
            command: resolved.canonical,
            targetContext: {
                ...targetContext,
                documentGeneration: commandData.documentGeneration ?? targetContext.documentGeneration,
                snapshotId: commandData.snapshotId ?? targetContext.snapshotId
            },
            params,
            options: {
                strict: commandData.strict === true,
                verification: commandData.verification || 'auto',
                backend: commandData.actionBackend || 'auto',
                allowFallback: commandData.allowFallback !== false
            },
            metadata: {
                sourceClientId: commandData.sourceClientId || null,
                chromeBridgeProtocolVersion: protocol.CHROME_BRIDGE_PROTOCOL_VERSION,
                originalCommand: commandData.command
            }
        });
    }

    function formatLegacyChromeResult(response) {
        if (response.status === protocol.Status.ERROR) {
            return {
                status: 'error',
                code: response.code,
                error: response.error || response.message,
                details: response.details || null
            };
        }
        const normalized = response.result && typeof response.result === 'object' &&
            ('message' in response.result || 'result' in response.result || 'code' in response.result)
            ? response.result
            : { result: response.result };
        return {
            status: 'success',
            message: normalized.message || response.message || '命令执行成功',
            code: normalized.code || response.code || null,
            result: normalized.result === undefined ? normalized : normalized.result,
            ...(normalized.details ? { details: normalized.details } : {})
        };
    }

    class WebAgentRuntime {
        constructor(adapter, options = {}) {
            this.adapter = contract.validateAdapter(adapter);
            this.options = options;
            this.capabilities = new Set();
            this.initialized = false;
            this.eventListeners = new Set();
            this.auditListener = typeof options.audit === 'function' ? options.audit : null;
        }

        async initialize() {
            this.capabilities = contract.normalizeCapabilitySet(await this.adapter.getCapabilities());
            this.initialized = true;
            return this.getRuntimeInfo();
        }

        async getRuntimeInfo() {
            const identity = await this.adapter.getTargetIdentity().catch(() => ({}));
            const documentState = await this.adapter.getDocumentState(identity).catch(() => ({}));
            return {
                runtimeCoreVersion: VERSION,
                protocolVersion: protocol.PROTOCOL_VERSION,
                adapter: this.adapter.id,
                adapterVersion: this.adapter.version || null,
                backend: this.adapter.backend || this.adapter.id,
                capabilities: [...this.capabilities],
                identity,
                documentState
            };
        }

        async execute(input) {
            const startedAt = Date.now();
            let request;
            try {
                request = input?.protocolVersion
                    ? { ...input }
                    : protocol.createRequest(input);
                const definition = protocol.validateRequest(request);
                if (!this.initialized) await this.initialize();
                contract.assertCommandSupported(definition, this.capabilities, this.adapter);
                const identity = await this.adapter.getTargetIdentity(request.targetContext);
                const documentState = await this.adapter.getDocumentState(identity);
                protocol.assertIdentity(request.targetContext, {
                    ...identity,
                    ...documentState
                }, request.options);
                this.audit('start', request, definition);
                const routed = await this.route(request, definition, identity, documentState);
                const response = protocol.createResponse(request, {
                    status: protocol.Status.SUCCESS,
                    code: routed?.code || 'COMMAND_COMPLETED',
                    message: routed?.message || '命令执行成功',
                    result: routed,
                    runtime: this.buildRuntimeMetadata(identity, documentState),
                    execution: {
                        backendUsed: routed?.backendUsed || this.adapter.backend,
                        fallbackUsed: routed?.fallbackUsed === true,
                        durationMs: Date.now() - startedAt
                    }
                });
                this.audit('success', request, definition, response);
                return response;
            } catch (error) {
                const response = protocol.createErrorResponse(request, error, {
                    backendUsed: this.adapter.backend,
                    durationMs: Date.now() - startedAt
                });
                this.audit('error', request, null, response);
                return response;
            }
        }

        buildRuntimeMetadata(identity, documentState) {
            return {
                adapter: this.adapter.id,
                targetId: identity?.targetId ?? identity?.id ?? null,
                appId: identity?.appId ?? null,
                runtimeInstanceId: identity?.runtimeInstanceId ?? null,
                documentGeneration: documentState?.documentGeneration ?? null,
                snapshotIdBefore: documentState?.snapshotId ?? null,
                snapshotIdAfter: documentState?.snapshotId ?? null
            };
        }

        audit(phase, request, definition, response = null) {
            if (!this.auditListener) return;
            try {
                this.auditListener({
                    phase,
                    at: new Date().toISOString(),
                    requestId: request?.requestId || null,
                    command: request?.command || null,
                    risk: definition?.risk || null,
                    sideEffecting: definition?.sideEffecting ?? null,
                    response
                });
            } catch {
                // 审计消费者不得破坏命令执行。
            }
        }

        async route(request, definition, identity) {
            const command = request.command;
            const params = request.params || {};
            if (definition.domain === 'page' && command.startsWith('page_')) {
                return this.adapter.executePageOperation(command, params, request);
            }

            switch (command) {
                case 'runtime_execute_script':
                    return this.adapter.executeScript({
                        code: params.text || params.code || '',
                        executionWorld: params.executionWorld || params.world || 'MAIN',
                        awaitPromise: true
                    }, request.targetContext);
                case 'runtime_execute_operation':
                    return this.adapter.executeScript({
                        operation: params.operation,
                        args: params.args || [],
                        executionWorld: params.executionWorld || 'ISOLATED'
                    }, request.targetContext);
                case 'runtime_evaluate':
                    return this.sendDebugger('Runtime.evaluate', {
                        expression: String(params.expression || ''),
                        awaitPromise: true,
                        returnByValue: true,
                        ...parseJsonParam(params.cdpParams, {})
                    }, request);
                case 'debugger_attach':
                case 'network_start':
                    return this.adapter.attachDebugger(request.targetContext, { network: true });
                case 'debugger_detach':
                case 'network_stop':
                    return this.adapter.detachDebugger(request.targetContext);
                case 'debugger_status':
                    return this.adapter.getDebuggerStatus(request.targetContext);
                case 'debugger_send_command':
                    return this.sendDebugger(params.method, parseJsonParam(params.cdpParams || params.params, {}), request);
                case 'debugger_subscribe':
                    return this.subscribeDebugger(params, request);
                case 'debugger_unsubscribe':
                    return this.unsubscribeDebugger(params, request);
                case 'dom_get_document':
                    return this.sendDebugger('DOM.getDocument', {
                        depth: parseNumberParam(params.depth, 1, -1, 100),
                        pierce: parseBooleanParam(params.pierce, false),
                        ...parseJsonParam(params.cdpParams, {})
                    }, request);
                case 'dom_query_selector':
                    return this.querySelector(params, request, false);
                case 'dom_query_selector_all':
                    return this.querySelector(params, request, true);
                case 'dom_describe_node':
                    return this.sendDebugger('DOM.describeNode', parseJsonParam(params.cdpParams || params, {}), request);
                case 'dom_resolve_node':
                    return this.sendDebugger('DOM.resolveNode', parseJsonParam(params.cdpParams || params, {}), request);
                case 'dom_get_outer_html':
                    return this.sendDebugger('DOM.getOuterHTML', parseJsonParam(params.cdpParams || params, {}), request);
                case 'dom_request_node':
                    return this.sendDebugger('DOM.requestNode', parseJsonParam(params.cdpParams || params, {}), request);
                case 'dom_get_box_model':
                    return this.sendDebugger('DOM.getBoxModel', parseJsonParam(params.cdpParams || params, {}), request);
                case 'dom_focus':
                    return this.sendDebugger('DOM.focus', parseJsonParam(params.cdpParams || params, {}), request);
                case 'accessibility_get_full_tree':
                    return this.sendDebugger('Accessibility.getFullAXTree', parseJsonParam(params.cdpParams, {}), request);
                case 'accessibility_query_tree':
                    return this.sendDebugger('Accessibility.queryAXTree', parseJsonParam(params.cdpParams || params, {}), request);
                case 'runtime_call_function':
                    return this.sendDebugger('Runtime.callFunctionOn', parseJsonParam(params.cdpParams || params, {}), request);
                case 'page_get_frame_tree':
                    return this.sendDebugger('Page.getFrameTree', parseJsonParam(params.cdpParams, {}), request);
                case 'page_get_layout_metrics':
                    return this.sendDebugger('Page.getLayoutMetrics', parseJsonParam(params.cdpParams, {}), request);
                case 'native_mouse':
                    return this.adapter.dispatchNativeInput(
                        createMousePlan(params.action, params.point || params, params),
                        request.targetContext
                    );
                case 'native_keyboard':
                    return this.adapter.dispatchNativeInput(createKeyboardPlan(params.keys), request.targetContext);
                case 'native_insert_text':
                    return this.adapter.dispatchNativeInput({
                        type: 'insert-text',
                        text: String(params.text || '')
                    }, request.targetContext);
                case 'network_query':
                    return this.adapter.executePageOperation('network_query', params, request);
                case 'network_get_response_body': {
                    const raw = await this.sendDebugger('Network.getResponseBody', {
                        requestId: params.cdpRequestId || params.requestId
                    }, request);
                    const response = raw?.result || raw;
                    return {
                        message: 'Response Body 读取成功；大正文按 maxBodyChars 自动截断',
                        code: 'NETWORK_RESPONSE_BODY_RETURNED',
                        result: await buildResponseBodyResult(response, params),
                        backendUsed: raw?.backendUsed || this.adapter.backend
                    };
                }
                case 'network_clear':
                    return this.adapter.executePageOperation('network_clear', params, request);
                case 'network_set_extra_headers':
                    return this.sendDebugger('Network.setExtraHTTPHeaders', {
                        headers: parseJsonParam(params.headers || params.cdpParams, {})
                    }, request);
                case 'network_set_user_agent':
                case 'emulation_set_user_agent':
                    return this.sendDebugger('Network.setUserAgentOverride', {
                        userAgent: String(params.userAgent || ''),
                        ...(params.acceptLanguage ? { acceptLanguage: String(params.acceptLanguage) } : {}),
                        ...(params.platform ? { platform: String(params.platform) } : {}),
                        ...parseJsonParam(params.cdpParams, {})
                    }, request);
                case 'storage_get_cookies':
                    return this.sendDebugger('Storage.getCookies', parseJsonParam(params.cdpParams, {}), request);
                case 'storage_set_cookie':
                    return this.sendDebugger('Storage.setCookies', parseJsonParam(params.cdpParams || params, {}), request);
                case 'storage_delete_cookies':
                    return this.sendDebugger('Storage.deleteCookies', parseJsonParam(params.cdpParams || params, {}), request);
                case 'storage_clear_origin':
                    return this.sendDebugger('Storage.clearDataForOrigin', {
                        origin: String(params.origin || ''),
                        storageTypes: String(params.storageTypes || 'cookies,local_storage,session_storage,cache_storage,indexeddb')
                    }, request);
                case 'storage_get_usage':
                    return this.sendDebugger('Storage.getUsageAndQuota', {
                        origin: String(params.origin || '')
                    }, request);
                case 'storage_get_local':
                case 'storage_set_local':
                case 'storage_get_session':
                case 'storage_set_session':
                    return this.adapter.executePageOperation(command, params, request);
                case 'emulation_set_timezone':
                    return this.sendDebugger('Emulation.setTimezoneOverride', {
                        timezoneId: String(params.timezoneId || '')
                    }, request);
                case 'emulation_set_locale':
                    return this.sendDebugger('Emulation.setLocaleOverride', {
                        locale: String(params.locale || '')
                    }, request);
                case 'emulation_set_device_metrics':
                    return this.sendDebugger('Emulation.setDeviceMetricsOverride', {
                        width: parseNumberParam(params.width, 1280, 1, 10000),
                        height: parseNumberParam(params.height, 720, 1, 10000),
                        deviceScaleFactor: parseNumberParam(params.deviceScaleFactor, 1, 0, 10),
                        mobile: parseBooleanParam(params.mobile, false),
                        ...parseJsonParam(params.cdpParams, {})
                    }, request);
                case 'emulation_clear_device_metrics':
                    return this.sendDebugger('Emulation.clearDeviceMetricsOverride', {}, request);
                case 'screenshot_capture':
                    return this.adapter.captureScreenshot(params, request.targetContext);
                case 'target_list':
                    return this.adapter.listTargets(params);
                case 'target_get_active':
                    return this.adapter.getActiveTarget();
                case 'target_open':
                    return this.adapter.createTarget(params);
                case 'target_close':
                    return this.adapter.closeTarget(params.target || params.targetId || identity?.targetId);
                case 'target_activate':
                    return this.adapter.activateTarget(params.target || params.targetId);
                case 'target_navigate':
                case 'target_reload':
                case 'target_back':
                case 'target_forward':
                    return this.adapter.navigate(command.replace('target_', ''), params, request.targetContext);
                case 'target_wait_navigation':
                    return this.adapter.waitForNavigation({
                        ...request.targetContext,
                        ...params
                    });
                default:
                    throw new protocol.WebAgentError(
                        protocol.ErrorCode.UNKNOWN_COMMAND,
                        `Runtime Core 尚未路由命令: ${command}`
                    );
            }
        }

        async sendDebugger(method, params, request) {
            if (!method) {
                throw new protocol.WebAgentError(protocol.ErrorCode.INVALID_REQUEST, 'Debugger 命令缺少 method');
            }
            return this.adapter.sendDebuggerCommand(method, params || {}, request.targetContext);
        }

        async querySelector(params, request, all) {
            if (!params.selector || !String(params.selector).trim()) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.INVALID_REQUEST,
                    `${all ? 'DOM.querySelectorAll' : 'DOM.querySelector'} 缺少 selector`
                );
            }
            let nodeId = Number(params.nodeId);
            if (!Number.isFinite(nodeId) || nodeId <= 0) {
                const documentResult = await this.sendDebugger(
                    'DOM.getDocument',
                    { depth: 1, pierce: true },
                    request
                );
                nodeId = documentResult?.result?.root?.nodeId ||
                    documentResult?.root?.nodeId;
            }
            if (!nodeId) {
                throw new protocol.WebAgentError(
                    protocol.ErrorCode.ADAPTER_EXECUTION_ERROR,
                    '无法获取 DOM 根节点 nodeId'
                );
            }
            return this.sendDebugger(all ? 'DOM.querySelectorAll' : 'DOM.querySelector', {
                nodeId,
                selector: String(params.selector),
                ...parseJsonParam(params.cdpParams, {})
            }, request);
        }

        subscribeDebugger(params, request) {
            const listener = event => {
                if (!params.methods || params.methods.includes(event.method)) {
                    for (const consumer of this.eventListeners) consumer(event);
                }
            };
            this.adapter.subscribeDebuggerEvents(listener, request.targetContext);
            return { subscribed: true, methods: params.methods || null };
        }

        unsubscribeDebugger(params, request) {
            this.adapter.unsubscribeDebuggerEvents(params.listener || null, request.targetContext);
            return { unsubscribed: true };
        }

        addEventListener(listener) {
            if (typeof listener !== 'function') {
                throw new TypeError('listener 必须是函数');
            }
            this.eventListeners.add(listener);
            return () => this.eventListeners.delete(listener);
        }
    }

    function createWebAgentRuntime(adapter, options) {
        return new WebAgentRuntime(adapter, options);
    }

    return Object.freeze({
        VERSION,
        MODIFIER_BITS,
        WebAgentRuntime,
        createWebAgentRuntime,
        parseJsonParam,
        parseBooleanParam,
        parseNumberParam,
        estimateBodyBytes,
        sha256Text,
        buildResponseBodyResult,
        normalizeKeys,
        getKeyDescriptor,
        createKeyboardPlan,
        createMousePlan,
        summarizeTargetState,
        detectTargetTransition,
        normalizeLegacyChromeCommand,
        formatLegacyChromeResult
    });
});