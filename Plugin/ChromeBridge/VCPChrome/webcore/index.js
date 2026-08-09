(function initVCPWebAgentCore(globalScope, factory) {
    const load = (globalName, relativePath) =>
        globalScope?.[globalName] ||
        (typeof require === 'function' ? require(relativePath) : null);

    const api = factory({
        protocol: load('VCPWebAgentProtocol', './web-agent-protocol.js'),
        adapterContract: load('VCPWebAgentAdapterContract', './adapter-contract.js'),
        pageCore: load('VCPWebAgentPageCore', './web-agent-page-core.js'),
        pageRuntime: load('VCPWebAgentPageRuntimeCore', './web-agent-page-runtime-core.js'),
        runtimeCore: load('VCPWebAgentRuntimeCore', './web-agent-runtime-core.js'),
        chromeAdapter: load('VCPChromeWebAgentAdapter', './chrome-adapter.js')
    });

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPWebAgentCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWebAgentCoreIndex(modules) {
    'use strict';

    const required = [
        'protocol',
        'adapterContract',
        'pageCore',
        'pageRuntime',
        'runtimeCore'
    ];
    const missing = required.filter(name => !modules[name]);
    if (missing.length) {
        throw new Error(`VCP Web Agent Core 缺少模块: ${missing.join(', ')}`);
    }

    const versions = Object.freeze({
        protocolVersion: modules.protocol.PROTOCOL_VERSION,
        chromeBridgeProtocolVersion: modules.protocol.CHROME_BRIDGE_PROTOCOL_VERSION,
        protocolModuleVersion: modules.protocol.VERSION,
        pageCoreVersion: modules.pageCore.VERSION,
        pageRuntimeVersion: modules.pageRuntime.VERSION,
        runtimeCoreVersion: modules.runtimeCore.VERSION,
        adapterContractVersion: modules.adapterContract.VERSION,
        chromeAdapterVersion: modules.chromeAdapter?.VERSION || null,
        pageGraphVersion: 1,
        groundedMarkdownVersion: 1
    });

    function createPageRuntime(environment, options) {
        return modules.pageRuntime.createWebAgentPageRuntime(environment, options);
    }

    function createRuntime(adapter, options) {
        return modules.runtimeCore.createWebAgentRuntime(adapter, options);
    }

    function createChromeRuntime(chromeApi, adapterOptions = {}, runtimeOptions = {}) {
        if (!modules.chromeAdapter) {
            throw new Error('当前构建不包含 Chrome Adapter');
        }
        const adapter = modules.chromeAdapter.createChromeWebAgentAdapter(
            chromeApi,
            adapterOptions
        );
        const runtime = createRuntime(adapter, runtimeOptions);
        return { adapter, runtime };
    }

    function getCapabilityCatalog() {
        return modules.protocol.getCapabilities();
    }

    return Object.freeze({
        versions,
        protocol: modules.protocol,
        adapterContract: modules.adapterContract,
        pageCore: modules.pageCore,
        pageRuntime: modules.pageRuntime,
        runtimeCore: modules.runtimeCore,
        adapters: Object.freeze({
            chrome: modules.chromeAdapter
        }),
        createPageRuntime,
        createRuntime,
        createChromeRuntime,
        getCapabilityCatalog
    });
});