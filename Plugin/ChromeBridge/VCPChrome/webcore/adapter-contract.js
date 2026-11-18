(function initWebAgentAdapterContract(globalScope, factory) {
    const protocol = globalScope?.VCPWebAgentProtocol ||
        (typeof require === 'function' ? require('./web-agent-protocol.js') : null);
    const api = factory(protocol);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPWebAgentAdapterContract = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdapterContractModule(protocol) {
    'use strict';

    if (!protocol) {
        throw new Error('VCP Web Agent Adapter Contract 需要先加载 web-agent-protocol.js');
    }

    const VERSION = '0.1.0';

    const REQUIRED_METHODS = Object.freeze([
        'getCapabilities',
        'getTargetIdentity',
        'getDocumentState',
        'executePageOperation',
        'executeScript',
        'attachDebugger',
        'detachDebugger',
        'getDebuggerStatus',
        'sendDebuggerCommand',
        'subscribeDebuggerEvents',
        'unsubscribeDebuggerEvents',
        'dispatchNativeInput',
        'captureScreenshot',
        'listTargets',
        'getTarget',
        'getActiveTarget',
        'activateTarget',
        'createTarget',
        'closeTarget',
        'navigate',
        'waitForNavigation'
    ]);

    class WebAgentAdapter {
        constructor(options = {}) {
            this.id = String(options.id || 'unknown-adapter');
            this.version = String(options.version || VERSION);
            this.backend = String(options.backend || this.id);
        }

        async getCapabilities() {
            return [];
        }

        async getTargetIdentity() {
            throw this.notSupported('getTargetIdentity');
        }

        async getDocumentState() {
            throw this.notSupported('getDocumentState');
        }

        async executePageOperation() {
            throw this.notSupported('executePageOperation');
        }

        async executeScript() {
            throw this.notSupported('executeScript');
        }

        async attachDebugger() {
            throw this.notSupported('attachDebugger');
        }

        async detachDebugger() {
            throw this.notSupported('detachDebugger');
        }

        async getDebuggerStatus() {
            throw this.notSupported('getDebuggerStatus');
        }

        async sendDebuggerCommand() {
            throw this.notSupported('sendDebuggerCommand');
        }

        subscribeDebuggerEvents() {
            throw this.notSupported('subscribeDebuggerEvents');
        }

        unsubscribeDebuggerEvents() {
            throw this.notSupported('unsubscribeDebuggerEvents');
        }

        async dispatchNativeInput() {
            throw this.notSupported('dispatchNativeInput');
        }

        async captureScreenshot() {
            throw this.notSupported('captureScreenshot');
        }

        async listTargets() {
            throw this.notSupported('listTargets');
        }

        async getTarget() {
            throw this.notSupported('getTarget');
        }

        async getActiveTarget() {
            throw this.notSupported('getActiveTarget');
        }

        async activateTarget() {
            throw this.notSupported('activateTarget');
        }

        async createTarget() {
            throw this.notSupported('createTarget');
        }

        async closeTarget() {
            throw this.notSupported('closeTarget');
        }

        async navigate() {
            throw this.notSupported('navigate');
        }

        async waitForNavigation() {
            throw this.notSupported('waitForNavigation');
        }

        notSupported(operation) {
            return new protocol.WebAgentError(
                protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                `Adapter ${this.id} 不支持操作: ${operation}`,
                { adapter: this.id, operation }
            );
        }
    }

    function normalizeCapabilitySet(capabilities) {
        if (capabilities instanceof Set) return new Set(capabilities);
        if (Array.isArray(capabilities)) {
            return new Set(capabilities.map(item =>
                typeof item === 'string' ? item : (item?.id || item?.command)
            ).filter(Boolean));
        }
        if (capabilities && typeof capabilities === 'object') {
            return new Set(Object.entries(capabilities)
                .filter(([, enabled]) => enabled === true)
                .map(([id]) => id));
        }
        return new Set();
    }

    function validateAdapter(adapter, options = {}) {
        if (!adapter || typeof adapter !== 'object') {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_CONTRACT_VIOLATION,
                'Adapter 必须是对象'
            );
        }

        const missing = REQUIRED_METHODS.filter(method => typeof adapter[method] !== 'function');
        if (missing.length) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_CONTRACT_VIOLATION,
                `Adapter 缺少必需方法: ${missing.join(', ')}`,
                { adapter: adapter.id || null, missing }
            );
        }

        if (options.requireIdentity !== false && !adapter.id) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.ADAPTER_CONTRACT_VIOLATION,
                'Adapter 缺少 id'
            );
        }
        return adapter;
    }

    async function negotiateCapabilities(adapter) {
        validateAdapter(adapter);
        const declared = normalizeCapabilitySet(await adapter.getCapabilities());
        const catalog = protocol.getCapabilities();
        return {
            adapter: adapter.id,
            adapterVersion: adapter.version || null,
            backend: adapter.backend || adapter.id,
            declared: [...declared],
            supportedCommands: catalog
                .filter(definition =>
                    definition.requires.length === 0 ||
                    definition.requires.every(requirement => declared.has(requirement))
                )
                .map(definition => definition.command),
            unsupportedCommands: catalog
                .filter(definition =>
                    definition.requires.some(requirement => !declared.has(requirement))
                )
                .map(definition => definition.command)
        };
    }

    function assertCommandSupported(definition, capabilitySet, adapter) {
        const capabilities = normalizeCapabilitySet(capabilitySet);
        const missing = definition.requires.filter(requirement => !capabilities.has(requirement));
        if (missing.length) {
            throw new protocol.WebAgentError(
                protocol.ErrorCode.CAPABILITY_NOT_SUPPORTED,
                `当前 Adapter 不支持命令 ${definition.command}`,
                {
                    adapter: adapter?.id || null,
                    command: definition.command,
                    requires: definition.requires,
                    missing
                }
            );
        }
        return true;
    }

    return Object.freeze({
        VERSION,
        REQUIRED_METHODS,
        WebAgentAdapter,
        normalizeCapabilitySet,
        validateAdapter,
        negotiateCapabilities,
        assertCommandSupported
    });
});