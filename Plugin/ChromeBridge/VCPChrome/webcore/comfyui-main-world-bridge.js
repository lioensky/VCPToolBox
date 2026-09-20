(function initVCPComfyUIMainWorldBridge() {
    'use strict';

    const STATE_ELEMENT_ID = 'vcp-comfyui-agent-state';
    const REQUEST_EVENT = 'vcp-comfyui-agent-request';
    const RESPONSE_EVENT = 'vcp-comfyui-agent-response';
    const MAX_NODES = 300;
    const MAX_WIDGET_VALUE_CHARS = 12000;
    const REFRESH_INTERVAL_MS = 1500;

    if (globalThis.__VCP_COMFYUI_MAIN_WORLD_BRIDGE__) return;
    globalThis.__VCP_COMFYUI_MAIN_WORLD_BRIDGE__ = true;

    let comfyApp = null;
    let lastSerializedState = '';
    let refreshTimer = null;

    function isLikelyComfyUIPage() {
        const title = String(document.title || '').toLowerCase();
        return title.includes('comfyui') ||
            Boolean(document.querySelector('graph-canvas, .comfy-menu, [data-testid*="comfy"]')) ||
            location.port === '8188';
    }

    function normalizeText(value, maxLength = 240) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
    }

    function serializeValue(value) {
        if (value === null || value === undefined) return value ?? null;
        if (typeof value === 'string') return value.slice(0, MAX_WIDGET_VALUE_CHARS);
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) {
            return value.slice(0, 100).map(item => {
                if (typeof item === 'string') return item.slice(0, 500);
                if (typeof item === 'number' || typeof item === 'boolean' || item === null) return item;
                return normalizeText(item, 500);
            });
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return normalizeText(value, 1000);
        }
    }

    function getGraphNodes() {
        const graph = comfyApp?.graph ||
            comfyApp?.canvas?.graph ||
            document.querySelector('graph-canvas')?.graph ||
            document.querySelector('graph-canvas')?.canvas?.graph;
        const nodes = graph?._nodes || graph?.nodes || [];
        return {
            graph,
            nodes: Array.isArray(nodes) ? nodes.slice(0, MAX_NODES) : []
        };
    }

    function serializeSlot(slot, index) {
        return {
            index,
            name: normalizeText(slot?.localized_name || slot?.label || slot?.name || `slot-${index}`, 160),
            type: normalizeText(slot?.type, 120),
            connected: slot?.link !== null && slot?.link !== undefined ||
                (Array.isArray(slot?.links) && slot.links.length > 0)
        };
    }

    function serializeWidget(widget, index) {
        const options = widget?.options || {};
        const values = Array.isArray(options.values)
            ? options.values.slice(0, 200).map(value => serializeValue(value))
            : undefined;
        return {
            index,
            name: normalizeText(widget?.name || widget?.label || `widget-${index}`, 160),
            type: normalizeText(widget?.type || typeof widget?.value, 80),
            value: serializeValue(widget?.value),
            disabled: widget?.disabled === true,
            options: values ? { values } : undefined
        };
    }

    function serializeNode(node, index) {
        return {
            id: String(node?.id ?? index),
            type: normalizeText(node?.type || node?.constructor?.type || 'unknown', 180),
            title: normalizeText(node?.title || node?.getTitle?.() || node?.type || `Node ${index}`, 240),
            mode: Number.isFinite(Number(node?.mode)) ? Number(node.mode) : null,
            selected: node?.is_selected === true || node?.selected === true,
            collapsed: node?.flags?.collapsed === true,
            position: Array.isArray(node?.pos)
                ? node.pos.slice(0, 2).map(value => Math.round(Number(value) || 0))
                : null,
            widgets: Array.isArray(node?.widgets)
                ? node.widgets.map(serializeWidget)
                : [],
            inputs: Array.isArray(node?.inputs)
                ? node.inputs.map(serializeSlot)
                : [],
            outputs: Array.isArray(node?.outputs)
                ? node.outputs.map(serializeSlot)
                : []
        };
    }

    function compareStableIds(left, right) {
        return String(left).localeCompare(String(right), undefined, { numeric: true });
    }

    function serializeGraphLinks(graph) {
        const source = graph?.links;
        const links = source instanceof Map
            ? Array.from(source.values())
            : Array.isArray(source)
                ? source
                : Object.values(source || {});

        return links
            .filter(Boolean)
            .map(link => ({
                originNodeId: String(link?.origin_id ?? ''),
                originSlot: Number.isFinite(Number(link?.origin_slot))
                    ? Number(link.origin_slot)
                    : -1,
                targetNodeId: String(link?.target_id ?? ''),
                targetSlot: Number.isFinite(Number(link?.target_slot))
                    ? Number(link.target_slot)
                    : -1,
                type: normalizeText(link?.type, 120)
            }))
            .sort((left, right) =>
                compareStableIds(left.originNodeId, right.originNodeId) ||
                left.originSlot - right.originSlot ||
                compareStableIds(left.targetNodeId, right.targetNodeId) ||
                left.targetSlot - right.targetSlot ||
                left.type.localeCompare(right.type)
            );
    }

    function createSemanticFingerprint(state) {
        return JSON.stringify({
            version: state.version,
            adapter: state.adapter,
            detected: state.detected,
            ready: state.ready,
            workflow: state.workflow,
            nodes: state.nodes.map(node => ({
                id: node.id,
                type: node.type,
                title: node.title,
                mode: node.mode,
                widgets: node.widgets,
                inputs: node.inputs,
                outputs: node.outputs
            })),
            links: state.links
        });
    }

    function ensureStateElement() {
        let element = document.getElementById(STATE_ELEMENT_ID);
        if (!element) {
            element = document.createElement('script');
            element.id = STATE_ELEMENT_ID;
            element.type = 'application/json';
            element.setAttribute('data-vcp-internal', 'comfyui-state');
            (document.documentElement || document.head || document.body)?.appendChild(element);
        }
        return element;
    }

    function publishState(reason = 'interval') {
        if (!isLikelyComfyUIPage()) return;
        const { graph, nodes } = getGraphNodes();
        const serializedNodes = nodes
            .map(serializeNode)
            .sort((left, right) => compareStableIds(left.id, right.id));
        const state = {
            version: 1,
            adapter: 'comfyui-litegraph',
            detected: true,
            ready: Boolean(comfyApp && graph),
            reason,
            generatedAt: Date.now(),
            workflow: {
                title: normalizeText(document.title.replace(/\s*-\s*ComfyUI\s*$/i, ''), 240),
                nodeCount: serializedNodes.length
            },
            nodes: serializedNodes,
            links: serializeGraphLinks(graph)
        };
        const semanticFingerprint = createSemanticFingerprint(state);
        if (semanticFingerprint === lastSerializedState) return;
        lastSerializedState = semanticFingerprint;
        ensureStateElement().textContent = JSON.stringify(state);
        document.dispatchEvent(new CustomEvent('vcp-comfyui-agent-state-updated'));
    }

    function coerceWidgetValue(widget, requestedValue) {
        const current = widget?.value;
        if (typeof current === 'number') {
            const parsed = Number(requestedValue);
            if (!Number.isFinite(parsed)) throw new Error('该 widget 需要数值');
            return parsed;
        }
        if (typeof current === 'boolean') {
            if (typeof requestedValue === 'boolean') return requestedValue;
            const normalized = String(requestedValue).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
            throw new Error('该 widget 需要布尔值');
        }
        return String(requestedValue ?? '');
    }

    function findWidget(nodeId, widgetIndex, widgetName) {
        const { graph, nodes } = getGraphNodes();
        const node = graph?.getNodeById?.(Number(nodeId)) ||
            graph?.getNodeById?.(String(nodeId)) ||
            nodes.find(item => String(item?.id) === String(nodeId));
        if (!node) throw new Error(`未找到 ComfyUI 节点: ${nodeId}`);
        const widgets = Array.isArray(node.widgets) ? node.widgets : [];
        let widget = Number.isInteger(Number(widgetIndex))
            ? widgets[Number(widgetIndex)]
            : null;
        if (!widget && widgetName) {
            widget = widgets.find(item => String(item?.name) === String(widgetName));
        }
        if (!widget) throw new Error(`节点 ${nodeId} 未找到 widget: ${widgetName || widgetIndex}`);
        return { node, widget, graph };
    }

    async function applyWidgetValue(request) {
        const { node, widget, graph } = findWidget(
            request.nodeId,
            request.widgetIndex,
            request.widgetName
        );
        if (widget.disabled === true) throw new Error('目标 widget 已禁用');
        const before = serializeValue(widget.value);
        const value = coerceWidgetValue(widget, request.value);
        widget.value = value;
        if (typeof widget.callback === 'function') {
            widget.callback(value, comfyApp?.canvas, node);
        }
        node.onWidgetChanged?.(widget.name, value, before, widget);
        node.setDirtyCanvas?.(true, true);
        graph?.setDirtyCanvas?.(true, true);
        graph?.change?.();
        comfyApp?.canvas?.setDirty?.(true, true);
        await Promise.resolve();
        return {
            nodeId: String(node.id),
            widgetName: String(widget.name || request.widgetName || ''),
            widgetIndex: Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : Number(request.widgetIndex),
            before,
            value: serializeValue(widget.value),
            verified: Object.is(widget.value, value) || String(widget.value) === String(value)
        };
    }

    document.addEventListener(REQUEST_EVENT, event => {
        const detail = event.detail || {};
        const requestId = String(detail.requestId || '');
        if (!requestId || detail.action !== 'set-widget-value') return;
        Promise.resolve()
            .then(() => applyWidgetValue(detail))
            .then(result => {
                publishState('widget-action');
                document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
                    detail: { requestId, status: 'success', result }
                }));
            })
            .catch(error => {
                document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
                    detail: {
                        requestId,
                        status: 'error',
                        code: 'COMFYUI_WIDGET_ACTION_FAILED',
                        error: error.message || String(error)
                    }
                }));
            });
    });

    async function initialize() {
        if (!isLikelyComfyUIPage()) return;
        try {
            const moduleUrl = new URL('/scripts/app.js', location.href).href;
            const module = await import(moduleUrl);
            comfyApp = module?.app || module?.default?.app || module?.default || null;
        } catch (error) {
            console.debug('[VCP ComfyUI Bridge] 无法导入 ComfyUI app.js，将保留 DOM 降级能力:', error);
        }
        publishState('initialize');
        refreshTimer = setInterval(() => publishState('interval'), REFRESH_INTERVAL_MS);
        window.addEventListener('beforeunload', () => clearInterval(refreshTimer), { once: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();