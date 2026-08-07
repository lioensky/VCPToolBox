(function initWebAgentProtocol(globalScope, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPWebAgentProtocol = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProtocolModule() {
    'use strict';

    const PROTOCOL_VERSION = 1;
    const CHROME_BRIDGE_PROTOCOL_VERSION = 3;
    const VERSION = '0.1.0';

    const Risk = Object.freeze({
        READ: 'read',
        INTERACT: 'interact',
        ELEVATED: 'elevated',
        ROOT: 'root'
    });

    const Status = Object.freeze({
        SUCCESS: 'success',
        ERROR: 'error'
    });

    const commandDefinitions = [
        ['page_get_info', 'page', Risk.READ, false, true, false, ['page']],
        ['page_get_image', 'page', Risk.READ, false, true, false, ['page', 'screenshot']],
        ['page_query_html', 'page', Risk.READ, false, true, true, ['page']],
        ['page_query_scripts', 'page', Risk.ELEVATED, false, true, true, ['page']],
        ['page_code_search', 'page', Risk.ELEVATED, false, true, true, ['page']],
        ['page_wait_for', 'page', Risk.READ, false, true, false, ['page']],
        ['page_click', 'page', Risk.INTERACT, true, false, false, ['page']],
        ['page_type', 'page', Risk.INTERACT, true, false, true, ['page']],
        ['page_set_value', 'page', Risk.INTERACT, true, false, true, ['page']],
        ['page_send_keys', 'page', Risk.INTERACT, true, false, true, ['page']],
        ['page_select_option', 'page', Risk.INTERACT, true, false, false, ['page']],
        ['page_check', 'page', Risk.INTERACT, true, false, false, ['page']],
        ['page_hover', 'page', Risk.INTERACT, true, false, false, ['page']],
        ['page_scroll', 'page', Risk.INTERACT, true, false, false, ['page']],
        ['runtime_execute_script', 'script', Risk.ROOT, true, false, true, ['script']],
        ['runtime_execute_operation', 'script', Risk.ELEVATED, true, false, true, ['script']],
        ['runtime_evaluate', 'script', Risk.ROOT, true, false, true, ['debugger', 'runtime']],
        ['debugger_attach', 'debugger', Risk.ROOT, true, false, false, ['debugger']],
        ['debugger_detach', 'debugger', Risk.ROOT, true, false, false, ['debugger']],
        ['debugger_status', 'debugger', Risk.READ, false, true, false, ['debugger']],
        ['debugger_send_command', 'debugger', Risk.ROOT, true, false, true, ['debugger']],
        ['debugger_subscribe', 'debugger', Risk.ROOT, true, false, true, ['debugger']],
        ['debugger_unsubscribe', 'debugger', Risk.ROOT, true, false, false, ['debugger']],
        ['dom_get_document', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_query_selector', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_query_selector_all', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_describe_node', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_resolve_node', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_get_outer_html', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_request_node', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_get_box_model', 'dom', Risk.ELEVATED, false, true, true, ['debugger', 'dom']],
        ['dom_focus', 'dom', Risk.INTERACT, true, false, false, ['debugger', 'dom']],
        ['accessibility_get_full_tree', 'accessibility', Risk.ELEVATED, false, true, true, ['debugger', 'accessibility']],
        ['accessibility_query_tree', 'accessibility', Risk.ELEVATED, false, true, true, ['debugger', 'accessibility']],
        ['runtime_call_function', 'script', Risk.ROOT, true, false, true, ['debugger', 'runtime']],
        ['page_get_frame_tree', 'page', Risk.ELEVATED, false, true, true, ['debugger', 'page']],
        ['page_get_layout_metrics', 'page', Risk.ELEVATED, false, true, true, ['debugger', 'page']],
        ['native_mouse', 'input', Risk.INTERACT, true, false, false, ['nativeInput']],
        ['native_keyboard', 'input', Risk.INTERACT, true, false, true, ['nativeInput']],
        ['native_insert_text', 'input', Risk.INTERACT, true, false, true, ['nativeInput']],
        ['network_start', 'network', Risk.ROOT, true, false, false, ['debugger', 'network']],
        ['network_stop', 'network', Risk.ROOT, true, false, false, ['debugger', 'network']],
        ['network_query', 'network', Risk.ROOT, false, true, true, ['debugger', 'network']],
        ['network_get_response_body', 'network', Risk.ROOT, false, true, true, ['debugger', 'network']],
        ['network_clear', 'network', Risk.ROOT, true, false, false, ['debugger', 'network']],
        ['network_set_extra_headers', 'network', Risk.ROOT, true, false, true, ['debugger', 'network']],
        ['network_set_user_agent', 'network', Risk.ROOT, true, false, false, ['debugger', 'network']],
        ['storage_get_cookies', 'storage', Risk.ROOT, false, true, true, ['debugger', 'storage']],
        ['storage_set_cookie', 'storage', Risk.ROOT, true, false, true, ['debugger', 'storage']],
        ['storage_delete_cookies', 'storage', Risk.ROOT, true, false, true, ['debugger', 'storage']],
        ['storage_get_local', 'storage', Risk.ROOT, false, true, true, ['storage']],
        ['storage_set_local', 'storage', Risk.ROOT, true, false, true, ['storage']],
        ['storage_get_session', 'storage', Risk.ROOT, false, true, true, ['storage']],
        ['storage_set_session', 'storage', Risk.ROOT, true, false, true, ['storage']],
        ['storage_clear_origin', 'storage', Risk.ROOT, true, false, true, ['debugger', 'storage']],
        ['storage_get_usage', 'storage', Risk.ROOT, false, true, true, ['debugger', 'storage']],
        ['emulation_set_timezone', 'emulation', Risk.ROOT, true, false, false, ['debugger', 'emulation']],
        ['emulation_set_locale', 'emulation', Risk.ROOT, true, false, false, ['debugger', 'emulation']],
        ['emulation_set_device_metrics', 'emulation', Risk.ROOT, true, false, false, ['debugger', 'emulation']],
        ['emulation_set_user_agent', 'emulation', Risk.ROOT, true, false, false, ['debugger', 'emulation']],
        ['emulation_clear_device_metrics', 'emulation', Risk.ROOT, true, false, false, ['debugger', 'emulation']],
        ['screenshot_capture', 'screenshot', Risk.ELEVATED, false, true, true, ['screenshot']],
        ['target_list', 'target', Risk.READ, false, true, false, ['targets']],
        ['target_get_active', 'target', Risk.READ, false, true, false, ['targets']],
        ['target_open', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_navigate', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_reload', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_back', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_forward', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_close', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_activate', 'target', Risk.INTERACT, true, false, false, ['targets']],
        ['target_wait_navigation', 'target', Risk.READ, false, true, false, ['targets']]
    ];

    const COMMANDS = Object.freeze(Object.fromEntries(commandDefinitions.map(definition => {
        const [id, domain, risk, sideEffecting, retryable, sensitiveResult, requires] = definition;
        return [id, Object.freeze({
            id,
            command: id,
            domain,
            risk,
            sideEffecting,
            retryable,
            sensitiveResult,
            requires: Object.freeze(requires.slice())
        })];
    })));

    const LEGACY_COMMAND_MAP = Object.freeze({
        get_page_info: 'page_get_info',
        get_page_image: 'page_get_image',
        query_html: 'page_query_html',
        query_js: 'page_query_scripts',
        page_code_search: 'page_code_search',
        wait_for: 'page_wait_for',
        click: 'page_click',
        type: 'page_type',
        set_value: 'page_set_value',
        send_keys: 'page_send_keys',
        select_option: 'page_select_option',
        check: 'page_check',
        hover: 'page_hover',
        scroll: 'page_scroll',
        execute_script: 'runtime_execute_script',
        cdp_start: 'debugger_attach',
        cdp_stop: 'debugger_detach',
        cdp_runtime_evaluate: 'runtime_evaluate',
        cdp_dom_get_document: 'dom_get_document',
        cdp_dom_query_selector: 'dom_query_selector',
        cdp_network_query: 'network_query',
        cdp_get_response_body: 'network_get_response_body',
        cdp_clear_network: 'network_clear',
        cdp_network_set_extra_http_headers: 'network_set_extra_headers',
        cdp_network_set_user_agent_override: 'network_set_user_agent',
        cdp_emulation_set_timezone_override: 'emulation_set_timezone',
        cdp_emulation_set_locale_override: 'emulation_set_locale',
        cdp_emulation_set_device_metrics_override: 'emulation_set_device_metrics',
        cdp_storage_get_cookies: 'storage_get_cookies',
        cdp_storage_clear_data_for_origin: 'storage_clear_origin',
        capture_screenshot: 'screenshot_capture',
        get_screenshot: 'screenshot_capture',
        screenshot: 'screenshot_capture',
        list_tabs: 'target_list',
        switch_tab: 'target_activate',
        close_tab: 'target_close',
        open_url: 'target_open'
    });

    const ErrorCode = Object.freeze({
        INVALID_REQUEST: 'INVALID_REQUEST',
        INVALID_PROTOCOL_VERSION: 'INVALID_PROTOCOL_VERSION',
        INVALID_TARGET_CONTEXT: 'INVALID_TARGET_CONTEXT',
        UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
        CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
        ADAPTER_CONTRACT_VIOLATION: 'ADAPTER_CONTRACT_VIOLATION',
        ADAPTER_EXECUTION_ERROR: 'ADAPTER_EXECUTION_ERROR',
        RUNTIME_INSTANCE_MISMATCH: 'RUNTIME_INSTANCE_MISMATCH',
        DOCUMENT_GENERATION_MISMATCH: 'DOCUMENT_GENERATION_MISMATCH',
        SNAPSHOT_MISMATCH: 'SNAPSHOT_MISMATCH',
        TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
        TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
        ELEMENT_HANDLE_EXPIRED: 'ELEMENT_HANDLE_EXPIRED',
        COMMAND_NOT_RETRYABLE: 'COMMAND_NOT_RETRYABLE',
        SCRIPT_RESULT_MISSING: 'SCRIPT_RESULT_MISSING',
        DEBUGGER_NOT_ATTACHED: 'DEBUGGER_NOT_ATTACHED',
        NO_ACTIVE_TARGET: 'NO_ACTIVE_TARGET'
    });

    class WebAgentError extends Error {
        constructor(code, message, details = {}, options = {}) {
            super(message || code);
            this.name = 'WebAgentError';
            this.code = code || ErrorCode.ADAPTER_EXECUTION_ERROR;
            this.details = details || {};
            this.retryable = options.retryable === true;
            this.cause = options.cause;
        }
    }

    function createRequestId(prefix = 'wa-req') {
        const random = Math.random().toString(36).slice(2, 10);
        return `${prefix}-${Date.now()}-${random}`;
    }

    function resolveCommand(command) {
        const input = String(command || '').trim();
        const canonical = LEGACY_COMMAND_MAP[input] || input;
        return {
            input,
            canonical,
            legacy: canonical !== input,
            definition: COMMANDS[canonical] || null
        };
    }

    function normalizeTargetContext(context = {}) {
        return {
            adapter: context.adapter || null,
            targetId: context.targetId ?? null,
            appId: context.appId ?? null,
            runtimeInstanceId: context.runtimeInstanceId ?? null,
            documentGeneration: Number.isFinite(Number(context.documentGeneration))
                ? Number(context.documentGeneration)
                : null,
            snapshotId: Number.isFinite(Number(context.snapshotId))
                ? Number(context.snapshotId)
                : null
        };
    }

    function normalizeOptions(options = {}) {
        return {
            strict: options.strict === true,
            verification: options.verification || 'auto',
            backend: options.backend || 'auto',
            allowFallback: options.allowFallback !== false
        };
    }

    function createRequest(input = {}) {
        const resolved = resolveCommand(input.command);
        if (!resolved.definition) {
            throw new WebAgentError(
                ErrorCode.UNKNOWN_COMMAND,
                `未知 Web Agent Core 命令: ${resolved.input || '(empty)'}`,
                { command: resolved.input }
            );
        }
        return {
            protocolVersion: PROTOCOL_VERSION,
            requestId: input.requestId || createRequestId(),
            command: resolved.canonical,
            originalCommand: resolved.legacy ? resolved.input : null,
            targetContext: normalizeTargetContext(input.targetContext),
            params: input.params && typeof input.params === 'object' ? { ...input.params } : {},
            options: normalizeOptions(input.options),
            metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {}
        };
    }

    function validateRequest(request) {
        if (!request || typeof request !== 'object') {
            throw new WebAgentError(ErrorCode.INVALID_REQUEST, '请求必须是对象');
        }
        if (Number(request.protocolVersion) !== PROTOCOL_VERSION) {
            throw new WebAgentError(
                ErrorCode.INVALID_PROTOCOL_VERSION,
                `不支持的协议版本: ${request.protocolVersion}`,
                { expected: PROTOCOL_VERSION, actual: request.protocolVersion }
            );
        }
        const resolved = resolveCommand(request.command);
        if (!resolved.definition) {
            throw new WebAgentError(ErrorCode.UNKNOWN_COMMAND, `未知命令: ${request.command}`);
        }
        if (!request.requestId) {
            throw new WebAgentError(ErrorCode.INVALID_REQUEST, '请求缺少 requestId');
        }
        return resolved.definition;
    }

    function assertIdentity(expected = {}, actual = {}, options = {}) {
        const strict = options.strict === true;
        const checks = [
            ['runtimeInstanceId', ErrorCode.RUNTIME_INSTANCE_MISMATCH],
            ['documentGeneration', ErrorCode.DOCUMENT_GENERATION_MISMATCH],
            ['snapshotId', ErrorCode.SNAPSHOT_MISMATCH]
        ];
        for (const [key, code] of checks) {
            if (expected[key] === null || expected[key] === undefined) continue;
            if (actual[key] === null || actual[key] === undefined) {
                if (!strict) continue;
            }
            if (String(expected[key]) !== String(actual[key])) {
                throw new WebAgentError(code, `${key} 不匹配`, {
                    field: key,
                    expected: expected[key],
                    actual: actual[key]
                });
            }
        }
        return true;
    }

    function normalizeError(error, fallbackCode = ErrorCode.ADAPTER_EXECUTION_ERROR) {
        if (error instanceof WebAgentError) return error;
        return new WebAgentError(
            error?.code || fallbackCode,
            error?.message || String(error || '未知错误'),
            error?.details || {},
            { cause: error, retryable: error?.retryable === true }
        );
    }

    function createResponse(request, payload = {}) {
        const status = payload.status === Status.ERROR ? Status.ERROR : Status.SUCCESS;
        return {
            protocolVersion: PROTOCOL_VERSION,
            requestId: request?.requestId || payload.requestId || null,
            status,
            code: payload.code || (status === Status.SUCCESS ? 'COMMAND_COMPLETED' : ErrorCode.ADAPTER_EXECUTION_ERROR),
            message: payload.message || '',
            result: payload.result === undefined ? null : payload.result,
            error: status === Status.ERROR ? (payload.error || payload.message || '命令执行失败') : undefined,
            details: payload.details || null,
            runtime: payload.runtime || null,
            execution: {
                backendUsed: payload.execution?.backendUsed || null,
                fallbackUsed: payload.execution?.fallbackUsed === true,
                durationMs: Number(payload.execution?.durationMs) || 0,
                retryApplied: payload.execution?.retryApplied === true
            }
        };
    }

    function createErrorResponse(request, error, execution = {}) {
        const normalized = normalizeError(error);
        return createResponse(request, {
            status: Status.ERROR,
            code: normalized.code,
            message: normalized.message,
            error: normalized.message,
            details: normalized.details,
            execution
        });
    }

    function isRetryAllowed(command) {
        const definition = resolveCommand(command).definition;
        return Boolean(definition && definition.retryable && !definition.sideEffecting);
    }

    function getCapabilities() {
        return Object.values(COMMANDS).map(definition => ({ ...definition, requires: [...definition.requires] }));
    }

    return Object.freeze({
        VERSION,
        PROTOCOL_VERSION,
        CHROME_BRIDGE_PROTOCOL_VERSION,
        Risk,
        Status,
        ErrorCode,
        COMMANDS,
        LEGACY_COMMAND_MAP,
        WebAgentError,
        createRequestId,
        resolveCommand,
        normalizeTargetContext,
        normalizeOptions,
        createRequest,
        validateRequest,
        assertIdentity,
        normalizeError,
        createResponse,
        createErrorResponse,
        isRetryAllowed,
        getCapabilities
    });
});