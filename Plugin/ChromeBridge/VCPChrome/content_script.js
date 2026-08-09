'use strict';

if (
    !globalThis.VCPWebAgentPageCore?.createWebAgentPageCore ||
    !globalThis.VCPWebAgentPageRuntimeCore?.createWebAgentPageRuntime
) {
    throw new Error(
        'VCP Web Agent Page Core 未加载；请确认 webcore 脚本位于 content_script.js 之前'
    );
}

let isActiveTab = false;
let isMonitoringEnabled = false;
let redactSensitiveDom = true;
let commandInProgress = false;
let suppressAutoSnapshotUntil = 0;
let pendingSnapshotRefresh = false;
let lastStableContentHash = '';
let lastStructureHash = '';
let duplicateSnapshotSkippedCount = 0;

const pageRuntime = globalThis.VCPWebAgentPageRuntimeCore.createWebAgentPageRuntime(
    { window, document, Node },
    { redactSensitiveDom }
);

console.log(
    `[VCP Content] Web Agent Page Runtime Core v${pageRuntime.version} 已接入`,
    pageRuntime.getIdentity()
);

function sendRuntimeMessage(message) {
    try {
        if (!globalThis.chrome?.runtime?.id) {
            return Promise.reject(new Error('Extension context invalidated'));
        }
        const pending = chrome.runtime.sendMessage(message);
        return pending && typeof pending.then === 'function'
            ? pending
            : Promise.resolve(pending);
    } catch (error) {
        return Promise.reject(error);
    }
}

const LEGACY_PAGE_COMMANDS = Object.freeze({
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
    scroll: 'page_scroll'
});

function normalizePageCommand(command) {
    return LEGACY_PAGE_COMMANDS[String(command || '')] || String(command || '');
}

function getCommandContext(data = {}) {
    const identity = pageRuntime.getIdentity();
    return {
        runtimeInstanceId: data.runtimeInstanceId ?? data.targetContext?.runtimeInstanceId ?? identity.runtimeInstanceId,
        documentGeneration: data.documentGeneration ?? data.targetContext?.documentGeneration ?? identity.documentGeneration,
        snapshotId: data.snapshotId ?? data.targetContext?.snapshotId ?? null
    };
}

function buildExecutionOptions(data = {}) {
    return {
        strict: data.strict === true || data.options?.strict === true,
        verification: data.verification || data.options?.verification || 'auto',
        backend: data.actionBackend || data.options?.backend || 'page-core',
        allowFallback: false,
        targetContext: getCommandContext(data)
    };
}

async function executePageCommand(data = {}) {
    const command = normalizePageCommand(data.command);
    const params = {
        ...data,
        targetContext: getCommandContext(data)
    };
    delete params.command;
    return pageRuntime.execute(command, params, buildExecutionOptions(data));
}

function createPageInfo() {
    const startedAt = performance.now();
    const pageInfo = pageRuntime.snapshot();
    pageInfo.performance = {
        snapshotDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        duplicateSnapshotSkippedCount
    };
    return pageInfo;
}

function sendPageInfoUpdate(options = {}) {
    const forced = options.force === true;

    if (!forced && (commandInProgress || Date.now() < suppressAutoSnapshotUntil)) {
        pendingSnapshotRefresh = true;
        return;
    }

    if (!forced && !isMonitoringEnabled) return;
    if (!forced && !isActiveTab && document.hidden) return;

    const pageInfo = createPageInfo();
    const stableChanged =
        pageInfo.contentHash !== lastStableContentHash ||
        pageInfo.structureHash !== lastStructureHash;

    if (!forced && !stableChanged) {
        duplicateSnapshotSkippedCount += 1;
        return;
    }

    lastStableContentHash = pageInfo.contentHash || '';
    lastStructureHash = pageInfo.structureHash || '';

    sendRuntimeMessage({
        type: 'PAGE_INFO_UPDATE',
        data: {
            ...pageInfo,
            force: forced
        }
    }).catch(() => {
        // 页面导航或扩展上下文销毁时无需重试有状态上报。
    });
}

function scheduleFreshSnapshot(delayMs = 500) {
    setTimeout(() => {
        pendingSnapshotRefresh = false;
        sendPageInfoUpdate({ force: true });
    }, delayMs);
}

async function handleLegacyCommand(request) {
    const data = request.data || {};
    commandInProgress = true;
    suppressAutoSnapshotUntil = Date.now() + 1500;

    let result;
    try {
        result = await executePageCommand(data);
    } catch (error) {
        result = {
            status: 'error',
            code: error.code || 'COMMAND_EXECUTION_ERROR',
            error: error.message,
            details: error.details || null
        };
    } finally {
        commandInProgress = false;
    }

    if (data.fallbackUsed === true && result?.result && typeof result.result === 'object') {
        result.result.fallbackUsed = true;
        result.result.fallbackReason = data.fallbackReason || 'CDP_BACKEND_UNAVAILABLE';
        result.result.backendRequested = 'cdp-input';
    }

    sendRuntimeMessage({
        type: 'COMMAND_RESULT',
        data: {
            requestId: data.requestId,
            sourceClientId: data.sourceClientId,
            ...result
        }
    }).catch(() => {
        // 导航后旧文档通道销毁属于正常生命周期事件。
    });

    scheduleFreshSnapshot();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CLEAR_STATE') {
        lastStableContentHash = '';
        lastStructureHash = '';
        isActiveTab = false;
        pageRuntime.invalidateDocument('navigation_clear_state');
        sendResponse({
            success: true,
            identity: pageRuntime.getIdentity()
        });
        return false;
    }

    if (request.type === 'REQUEST_PAGE_INFO_UPDATE') {
        isMonitoringEnabled = true;
        isActiveTab = true;
        sendPageInfoUpdate({ force: request.force === true });
        sendResponse({ success: true });
        return false;
    }

    if (request.type === 'MONITORING_STATUS_CHANGED') {
        isMonitoringEnabled = request.isMonitoringEnabled === true;
        if (!isMonitoringEnabled) isActiveTab = false;
        sendResponse({ success: true, isMonitoringEnabled });
        return false;
    }

    if (request.type === 'PRIVACY_SETTINGS_CHANGED') {
        redactSensitiveDom = request.redactSensitiveDom !== false;
        pageRuntime.setRedactionEnabled(redactSensitiveDom);
        lastStableContentHash = '';
        lastStructureHash = '';
        sendPageInfoUpdate({ force: true });
        sendResponse({ success: true, redactSensitiveDom });
        return false;
    }

    if (request.type === 'GET_GROUNDED_PAGE_INFO') {
        const pageInfo = createPageInfo();
        sendResponse({
            success: Boolean(pageInfo?.agentView?.markdown),
            pageInfo,
            markdown:
                pageInfo?.agentView?.markdown ||
                pageInfo?.pageContentMarkdown ||
                pageInfo?.markdown ||
                ''
        });
        return false;
    }

    if (request.type === 'FORCE_PAGE_UPDATE') {
        lastStableContentHash = '';
        lastStructureHash = '';
        const pageInfo = createPageInfo();
        sendRuntimeMessage({
            type: 'PAGE_INFO_UPDATE',
            data: { ...pageInfo, force: true }
        }).then(() => {
            sendResponse({ success: true, identity: pageRuntime.getIdentity() });
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }

    if (request.type === 'EXECUTE_CORE_COMMAND') {
        commandInProgress = true;
        suppressAutoSnapshotUntil = Date.now() + 1500;
        executePageCommand(request.data || {})
            .then(result => sendResponse(result))
            .catch(error => sendResponse({
                status: 'error',
                code: error.code || 'COMMAND_EXECUTION_ERROR',
                error: error.message,
                details: error.details || null
            }))
            .finally(() => {
                commandInProgress = false;
                scheduleFreshSnapshot();
            });
        return true;
    }

    if (request.type === 'EXECUTE_COMMAND') {
        handleLegacyCommand(request);
        return true;
    }

    return false;
});

const debouncedSendPageInfoUpdate = debounce(() => sendPageInfoUpdate(), 500);

const observer = new MutationObserver(mutations => {
    const structural = mutations.some(mutation => {
        if (mutation.type === 'childList' || mutation.type === 'characterData') {
            return true;
        }
        if (mutation.type !== 'attributes') return false;

        const attributeName = String(mutation.attributeName || '');
        if (attributeName === 'vcp-id' || attributeName.startsWith('data-vcp-')) {
            return false;
        }

        return [
            'role',
            'aria-label',
            'aria-expanded',
            'aria-selected',
            'aria-checked',
            'placeholder',
            'name',
            'id',
            'type',
            'contenteditable',
            'href',
            'style',
            'class',
            'disabled',
            'checked',
            'selected',
            'value',
            'hidden'
        ].includes(attributeName);
    });

    // 监控开关只决定是否允许上报，不得把 Core 自己写入的句柄属性
    // 当成页面变化，否则会形成“快照 -> 标记 -> 快照”的自激循环。
    if (structural) debouncedSendPageInfoUpdate();
});

if (document.body) {
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });
}

document.addEventListener('click', debouncedSendPageInfoUpdate);
document.addEventListener('focusin', debouncedSendPageInfoUpdate);
document.addEventListener('scroll', debouncedSendPageInfoUpdate, true);

window.addEventListener('load', () => {
    isActiveTab = !document.hidden;
    sendPageInfoUpdate();
});

document.addEventListener('visibilitychange', () => {
    if (!isMonitoringEnabled) {
        isActiveTab = false;
        return;
    }

    if (document.visibilityState !== 'visible') {
        isActiveTab = false;
        return;
    }

    sendRuntimeMessage({ type: 'VERIFY_ACTIVE_TAB' })
        .then(response => {
            isActiveTab = response?.isActive === true;
            if (isActiveTab) {
                lastStableContentHash = '';
                sendPageInfoUpdate();
            }
        })
        .catch(() => {
            isActiveTab = false;
        });
});

window.addEventListener('focus', () => {
    if (!isMonitoringEnabled) return;
    sendRuntimeMessage({ type: 'VERIFY_ACTIVE_TAB' })
        .then(response => {
            if (response?.isActive) {
                isActiveTab = true;
                sendPageInfoUpdate();
            }
        })
        .catch(() => {});
});

setInterval(() => {
    if (isMonitoringEnabled && isActiveTab && !document.hidden) {
        sendPageInfoUpdate();
    }
}, 5000);

chrome.storage.local.get(
    ['isMonitoringEnabled', 'redactSensitiveDom'],
    result => {
        isMonitoringEnabled = result.isMonitoringEnabled === true;
        redactSensitiveDom = result.redactSensitiveDom !== false;
        pageRuntime.setRedactionEnabled(redactSensitiveDom);
        if (result.redactSensitiveDom === undefined) {
            chrome.storage.local.set({ redactSensitiveDom: true });
        }
    }
);

function debounce(func, wait) {
    let timeout;
    return function debounced(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}
