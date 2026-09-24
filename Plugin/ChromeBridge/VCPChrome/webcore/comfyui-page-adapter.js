(function initVCPComfyUIPageAdapter(globalScope, factory) {
    'use strict';
    const api = factory(globalScope);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalScope) globalScope.VCPComfyUIPageAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createComfyUIPageAdapterModule(globalScope) {
    'use strict';

    const VERSION = '0.1.0';
    const STATE_ELEMENT_ID = 'vcp-comfyui-agent-state';
    const REQUEST_EVENT = 'vcp-comfyui-agent-request';
    const RESPONSE_EVENT = 'vcp-comfyui-agent-response';
    const TARGET_PATTERN = /^comfy-widget-([^-]+)-(\d+)$/;
    const ACTION_TIMEOUT_MS = 3000;

    function normalizeText(value, maxLength = 240) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
    }

    function escapeMarkdown(value) {
        return String(value ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/\|/g, '\\|')
            .replace(/\r/g, '')
            .trim();
    }

    function formatWidgetValue(value) {
        if (value === null || value === undefined || value === '') return '(空)';
        if (typeof value === 'string') {
            const escaped = escapeMarkdown(value);
            return escaped.includes('\n')
                ? `\n\n\`\`\`text\n${escaped.slice(0, 12000)}\n\`\`\``
                : `\`${escaped.slice(0, 2000)}\``;
        }
        try {
            return `\`${escapeMarkdown(JSON.stringify(value)).slice(0, 2000)}\``;
        } catch {
            return `\`${escapeMarkdown(value).slice(0, 2000)}\``;
        }
    }

    function isLikelyComfyUIPage(documentObject, windowObject) {
        const title = String(documentObject?.title || '').toLowerCase();
        return title.includes('comfyui') ||
            windowObject?.location?.port === '8188' ||
            Boolean(documentObject?.querySelector?.(
                'graph-canvas, .comfy-menu, [data-testid*="comfy"]'
            ));
    }

    function readState(documentObject, windowObject) {
        if (!isLikelyComfyUIPage(documentObject, windowObject)) return null;
        const element = documentObject.getElementById(STATE_ELEMENT_ID);
        if (!element?.textContent) {
            return {
                version: 1,
                adapter: 'comfyui-litegraph',
                detected: true,
                ready: false,
                generatedAt: Date.now(),
                workflow: {
                    title: normalizeText(documentObject.title),
                    nodeCount: 0
                },
                nodes: []
            };
        }
        try {
            const state = JSON.parse(element.textContent);
            if (state?.adapter !== 'comfyui-litegraph') return null;
            state.nodes = Array.isArray(state.nodes) ? state.nodes : [];
            return state;
        } catch {
            return null;
        }
    }

    function getWidgetTarget(nodeId, widgetIndex) {
        return `comfy-widget-${String(nodeId)}-${Number(widgetIndex)}`;
    }

    function parseWidgetTarget(target) {
        const match = String(target || '').trim().match(TARGET_PATTERN);
        return match ? { nodeId: match[1], widgetIndex: Number(match[2]) } : null;
    }

    function createWidgetRecords(state) {
        if (!state?.ready) return [];
        const records = [];
        for (const node of state.nodes) {
            for (const widget of Array.isArray(node.widgets) ? node.widgets : []) {
                records.push({
                    target: getWidgetTarget(node.id, widget.index),
                    nodeId: String(node.id),
                    nodeTitle: node.title || node.type || `Node ${node.id}`,
                    nodeType: node.type || 'unknown',
                    widgetIndex: Number(widget.index),
                    widgetName: widget.name || `widget-${widget.index}`,
                    widgetType: widget.type || typeof widget.value,
                    value: widget.value,
                    disabled: widget.disabled === true,
                    options: widget.options || null
                });
            }
        }
        return records;
    }

    function formatSlotList(slots) {
        const values = (Array.isArray(slots) ? slots : []).map(slot => {
            const status = slot.connected ? '已连接' : '未连接';
            const type = slot.type ? `:${slot.type}` : '';
            return `${slot.name || `slot-${slot.index}`}${type}(${status})`;
        });
        return values.length ? values.join('、') : '无';
    }

    function buildMarkdown(state) {
        if (!state) return '';
        const lines = [
            '',
            '## ComfyUI 工作流',
            '',
            state.ready
                ? `> 已连接 LiteGraph；共识别 ${state.nodes.length} 个节点。`
                : '> 已检测到 ComfyUI，但 LiteGraph 状态桥尚未就绪；当前仅可使用普通 DOM 控件。',
            '> 可编辑 widget 使用 `type` 或 `set_value`，target 使用下方 `comfy-widget-*` 标识。',
            ''
        ];
        if (!state.ready) return lines.join('\n').trim();

        for (const node of state.nodes) {
            const title = escapeMarkdown(node.title || node.type || `Node ${node.id}`);
            lines.push(`### ${title}（节点 ${escapeMarkdown(node.id)}｜${escapeMarkdown(node.type)}）`);
            if (node.mode !== null && node.mode !== undefined) {
                lines.push(`- 状态：mode=${node.mode}${node.collapsed ? '，已折叠' : ''}${node.selected ? '，已选中' : ''}`);
            }
            lines.push(`- 输入：${formatSlotList(node.inputs)}`);
            lines.push(`- 输出：${formatSlotList(node.outputs)}`);
            const widgets = Array.isArray(node.widgets) ? node.widgets : [];
            if (!widgets.length) {
                lines.push('- 参数：无可编辑 widget');
            } else {
                lines.push('- 参数：');
                for (const widget of widgets) {
                    const target = getWidgetTarget(node.id, widget.index);
                    lines.push(
                        `  - ${escapeMarkdown(widget.name)} [${escapeMarkdown(widget.type)}` +
                        `${widget.disabled ? '，禁用' : ''}] target=${target} ` +
                        `value=${formatWidgetValue(widget.value)}`
                    );
                }
            }
            lines.push('');
        }
        return lines.join('\n').trim();
    }

    function buildSnapshot(documentObject, windowObject) {
        const state = readState(documentObject, windowObject);
        if (!state) return null;
        return {
            adapter: 'comfyui-litegraph',
            version: VERSION,
            ready: state.ready === true,
            generatedAt: state.generatedAt || Date.now(),
            workflow: state.workflow || null,
            nodes: state.nodes,
            widgets: createWidgetRecords(state),
            markdown: buildMarkdown(state)
        };
    }

    function dispatchWidgetAction(documentObject, action) {
        const requestId = `vcp-comfy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId;
            const cleanup = () => {
                documentObject.removeEventListener(RESPONSE_EVENT, onResponse);
                clearTimeout(timeoutId);
            };
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const onResponse = event => {
                const detail = event.detail || {};
                if (String(detail.requestId || '') !== requestId) return;
                if (detail.status === 'success') {
                    finish(resolve, detail.result || {});
                    return;
                }
                const error = new Error(detail.error || 'ComfyUI widget 更新失败');
                error.code = detail.code || 'COMFYUI_WIDGET_ACTION_FAILED';
                finish(reject, error);
            };
            timeoutId = setTimeout(() => {
                const error = new Error('等待 ComfyUI MAIN World 状态桥响应超时');
                error.code = 'COMFYUI_BRIDGE_TIMEOUT';
                finish(reject, error);
            }, ACTION_TIMEOUT_MS);

            documentObject.addEventListener(RESPONSE_EVENT, onResponse);
            documentObject.dispatchEvent(new globalScope.CustomEvent(REQUEST_EVENT, {
                detail: {
                    requestId,
                    action: 'set-widget-value',
                    nodeId: action.nodeId,
                    widgetIndex: action.widgetIndex,
                    widgetName: action.widgetName,
                    value: action.value
                }
            }));
        });
    }

    async function execute(command, params, environment) {
        const parsed = parseWidgetTarget(params?.target);
        if (!parsed) return null;
        if (!['type', 'set_value'].includes(command)) {
            const error = new Error(`ComfyUI widget 目标不支持命令: ${command}`);
            error.code = 'COMFYUI_WIDGET_COMMAND_UNSUPPORTED';
            throw error;
        }

        const snapshot = buildSnapshot(environment.document, environment.window);
        if (!snapshot?.ready) {
            const error = new Error('ComfyUI LiteGraph 状态桥尚未就绪');
            error.code = 'COMFYUI_BRIDGE_NOT_READY';
            throw error;
        }
        const record = snapshot.widgets.find(widget =>
            widget.nodeId === parsed.nodeId &&
            widget.widgetIndex === parsed.widgetIndex
        );
        if (!record) {
            const error = new Error(`未找到 ComfyUI widget: ${params.target}`);
            error.code = 'COMFYUI_WIDGET_NOT_FOUND';
            throw error;
        }
        if (record.disabled) {
            const error = new Error(`ComfyUI widget 已禁用: ${record.widgetName}`);
            error.code = 'ELEMENT_NOT_INTERACTABLE';
            throw error;
        }

        const result = await dispatchWidgetAction(environment.document, {
            ...parsed,
            widgetName: record.widgetName,
            value: params.value ?? params.text ?? ''
        });
        return {
            status: result.verified === false ? 'error' : 'success',
            code: result.verified === false ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFIED',
            message: result.verified === false
                ? `ComfyUI 参数更新后读回不一致: ${record.widgetName}`
                : `已更新 ComfyUI 节点参数: ${record.nodeTitle} / ${record.widgetName}`,
            result: {
                ...result,
                attempted: true,
                backendUsed: 'comfyui-main-world',
                fallbackUsed: false,
                requiresFreshSnapshot: true,
                targetResolution: {
                    source: 'comfyui-widget-registry',
                    handleId: params.target,
                    confidence: 1,
                    candidateCount: 1,
                    scoreMargin: 1,
                    signatureValid: true
                }
            }
        };
    }

    return Object.freeze({
        VERSION,
        STATE_ELEMENT_ID,
        TARGET_PATTERN,
        isLikelyComfyUIPage,
        readState,
        getWidgetTarget,
        parseWidgetTarget,
        createWidgetRecords,
        buildMarkdown,
        buildSnapshot,
        execute
    });
});