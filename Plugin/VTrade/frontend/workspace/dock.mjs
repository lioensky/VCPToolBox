import VCPUI from '../vendor/vcp-ui/vcp-ui.js';

// A split tree of tab groups. Panels keep their DOM when they move, so a chart is never rebuilt by a drag.
// model = { root: Split | Group, panels: { [panelId]: { kind, link, state } } }
// Split = { type: 'split', dir: 'row' | 'col', sizes: number[], children: [] }; Group = { type: 'group', id, tabs: [panelId], active }
const MIN_PX = 160;
export const LINKS = Object.freeze({ a: '联动组 A', b: '联动组 B', c: '联动组 C' });
let sequence = 0;
export const uid = prefix => `${prefix}-${Date.now().toString(36)}${(sequence++).toString(36)}`;

export function normalize(node) {
    if (!node) return null;
    if (node.type === 'group') {
        node.tabs = node.tabs.filter(Boolean);
        if (!node.tabs.length) return null;
        if (!node.tabs.includes(node.active)) node.active = node.tabs[0];
        return node;
    }
    const children = [], sizes = [];
    node.children.forEach((child, i) => {
        const next = normalize(child);
        if (!next) return;
        const share = node.sizes?.[i] ?? 1 / node.children.length;
        if (next.type === 'split' && next.dir === node.dir) {
            next.children.forEach((c, j) => { children.push(c); sizes.push(share * next.sizes[j]); });
        } else { children.push(next); sizes.push(share); }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return { type: 'split', dir: node.dir, children, sizes: sizes.map(s => s / total) };
}
// A small anchored menu built from VCPUI List; closes on choice, outside press or Escape.
export function openMenu(anchor, items) {
    document.querySelector('.ws-menu')?.remove();
    const host = document.createElement('div');
    host.className = 'ws-menu'; host.setAttribute('role', 'menu');
    const list = VCPUI.create('List', { items: items.map(item => ({ ...item, onClick: () => { close(); item.onClick(); } })) });
    host.append(list.element); document.body.append(host);
    const rect = anchor.getBoundingClientRect(), width = host.offsetWidth, height = host.offsetHeight;
    host.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, rect.right - width))}px`;
    host.style.top = `${rect.bottom + height + 4 > innerHeight ? Math.max(4, rect.top - height - 4) : rect.bottom + 4}px`;
    const outside = event => { if (!host.contains(event.target) && !anchor.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    function close() {
        list.destroy(); host.remove();
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true);
    }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    host.querySelector('button')?.focus();
}
// One-line name prompt; resolves the trimmed text, or null when dismissed. VCPUI's InputDialog places its submit
// button in the footer outside its form, where it cannot submit without Web Awesome, so the button is wired here.
export function promptText({ title, label = title, value = '', placeholder = '', confirmLabel = '确定', maxLength = 20 }) {
    return new Promise(resolve => {
        const form = document.createElement('form');
        form.className = 'vcp-ui-dialog-form';
        const input = VCPUI.create('Input', { value, placeholder });
        const native = input.element.querySelector('input') || input.element;
        native.maxLength = maxLength; native.setAttribute('aria-label', label);
        form.append(input.element);
        const cancel = VCPUI.create('Button', { label: '取消', variant: 'ghost' });
        const confirm = VCPUI.create('Button', { label: confirmLabel, variant: 'primary' });
        const modal = VCPUI.create('Modal', { title, size: 'sm', content: form, actions: [cancel, confirm],
            onClose: result => { input.destroy(); resolve(result ?? null); } });
        form.addEventListener('submit', event => {
            event.preventDefault();
            const text = native.value.trim();
            if (text) modal.close(text); else native.focus();
        });
        confirm.element.addEventListener('click', () => form.requestSubmit());
        cancel.element.addEventListener('click', () => modal.close(null));
        document.body.append(modal.element);
        requestAnimationFrame(() => native.focus());
    });
}
function* walk(node, parent = null, index = 0) {
    if (!node) return;
    yield { node, parent, index };
    if (node.type === 'split') for (let i = 0; i < node.children.length; i++) yield* walk(node.children[i], node, i);
}

export class DockLayout {
    // mount(panelId) -> { element, dispose?, shown? }; describe(panelId) -> { title, link }
    constructor(root, { mount, describe, onChange, onAdd, onLink, empty }) {
        Object.assign(this, { root, mount, describe, onChange, onAdd, onLink, empty });
        this.mounted = new Map(); this.controls = []; this.focused = null; this.maximized = null;
        root.classList.add('dock-root');
    }
    setModel(model) {
        const keep = new Set(Object.keys(model.panels));
        for (const [id, panel] of this.mounted) if (!keep.has(id)) { panel.dispose?.(); this.mounted.delete(id); }
        this.model = model; this.model.root = normalize(model.root); this.maximized = null;
        this.focused = this.groups()[0]?.id || null;
        this.render();
    }
    groups() { return [...walk(this.model.root)].map(e => e.node).filter(n => n.type === 'group'); }
    groupOf(panelId) { return this.groups().find(g => g.tabs.includes(panelId)); }
    changed() { this.model.root = normalize(this.model.root); this.render(); this.onChange?.(this.model); }
    add(panelId, groupId = this.focused) {
        const group = this.groups().find(g => g.id === groupId) || this.groups().at(-1);
        if (group) { group.tabs.push(panelId); group.active = panelId; this.focused = group.id; }
        else this.model.root = { type: 'group', id: uid('g'), tabs: [panelId], active: panelId };
        this.changed();
    }
    close(panelId) {
        const group = this.groupOf(panelId);
        if (!group) return;
        group.tabs = group.tabs.filter(id => id !== panelId);
        delete this.model.panels[panelId];
        this.mounted.get(panelId)?.dispose?.(); this.mounted.delete(panelId);
        if (!group.tabs.length && this.maximized === group.id) this.maximized = null;
        this.changed();
    }
    activate(groupId, panelId) {
        const group = this.groups().find(g => g.id === groupId);
        if (!group || group.active === panelId) return;
        group.active = panelId; this.focused = groupId;
        this.changed();
    }
    move(panelId, targetId, zone) {
        const source = this.groupOf(panelId), target = this.groups().find(g => g.id === targetId);
        if (!source || !target || source === target && (zone === 'center' || source.tabs.length === 1)) return;
        source.tabs = source.tabs.filter(id => id !== panelId);
        if (zone === 'center') { target.tabs.push(panelId); target.active = panelId; this.focused = target.id; }
        else {
            const fresh = { type: 'group', id: uid('g'), tabs: [panelId], active: panelId };
            const pair = zone === 'left' || zone === 'top' ? [fresh, target] : [target, fresh];
            this.replace(target, { type: 'split', dir: zone === 'left' || zone === 'right' ? 'row' : 'col', sizes: [.5, .5], children: pair });
            this.focused = fresh.id;
        }
        this.changed();
    }
    replace(node, next) {
        if (this.model.root === node) { this.model.root = next; return; }
        for (const entry of walk(this.model.root)) if (entry.node === node) { entry.parent.children[entry.index] = next; return; }
    }
    focus(groupId) {
        this.focused = groupId;
        for (const section of this.root.querySelectorAll('.dock-group')) section.classList.toggle('is-focused', section.dataset.group === groupId);
    }
    panel(id) {
        if (!this.mounted.has(id)) this.mounted.set(id, this.mount(id));
        return this.mounted.get(id);
    }
    render() {
        this.controls.forEach(c => c.destroy()); this.controls = [];
        const node = this.maximized ? this.groups().find(g => g.id === this.maximized) : this.model.root;
        this.root.replaceChildren(node ? this.node(node) : this.empty());
        for (const group of this.groups()) this.mounted.get(group.active)?.shown?.();
    }
    node(n) { return n.type === 'split' ? this.split(n) : this.group(n); }
    split(n) {
        const element = document.createElement('div');
        element.className = 'dock-split'; element.dataset.dir = n.dir;
        n.children.forEach((child, i) => {
            if (i) element.append(this.splitter(n, i, element));
            const cell = document.createElement('div');
            cell.className = 'dock-cell'; cell.style.flex = `${n.sizes[i]} 1 0px`;
            cell.append(this.node(child)); element.append(cell);
        });
        return element;
    }
    splitter(n, i, container) {
        const bar = document.createElement('div');
        bar.className = 'dock-splitter';
        bar.setAttribute('role', 'separator');
        bar.setAttribute('aria-orientation', n.dir === 'row' ? 'vertical' : 'horizontal');
        bar.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault(); bar.setPointerCapture(event.pointerId);
            const row = n.dir === 'row', cells = [...container.children].filter(c => c.classList.contains('dock-cell'));
            const total = (row ? container.clientWidth : container.clientHeight) || 1, start = row ? event.clientX : event.clientY;
            const a = n.sizes[i - 1], b = n.sizes[i], min = Math.min((a + b) / 2, MIN_PX / total);
            const move = e => {
                const next = Math.max(min, Math.min(a + b - min, a + ((row ? e.clientX : e.clientY) - start) / total));
                n.sizes[i - 1] = next; n.sizes[i] = a + b - next;
                cells[i - 1].style.flex = `${n.sizes[i - 1]} 1 0px`; cells[i].style.flex = `${n.sizes[i]} 1 0px`;
            };
            const end = () => {
                bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', end); bar.removeEventListener('pointercancel', end);
                this.onChange?.(this.model);
            };
            bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
        });
        bar.addEventListener('dblclick', () => { n.sizes = n.sizes.map(() => 1 / n.sizes.length); this.changed(); });
        return bar;
    }
    group(g) {
        const section = document.createElement('section');
        section.className = 'dock-group'; section.dataset.group = g.id;
        section.classList.toggle('is-focused', this.focused === g.id);
        section.addEventListener('pointerdown', () => this.focus(g.id), true);
        const head = document.createElement('div');
        head.className = 'dock-head';
        const tabs = VCPUI.create('Tabs', { items: g.tabs.map(id => ({ value: id, label: this.describe(id).title })), value: g.active });
        tabs.element.classList.add('dock-tabs');
        tabs.element.addEventListener('change', () => {
            const value = tabs.element.querySelector('[aria-selected="true"]')?.dataset.value;
            if (value) this.activate(g.id, value);
        });
        this.dragSource(tabs.element);
        const active = this.describe(g.active), maximized = this.maximized === g.id;
        const button = (icon, label, onClick) => {
            const control = VCPUI.create('IconButton', { icon, label, size: 'sm' });
            control.element.addEventListener('click', onClick);
            this.controls.push(control);
            return control.element;
        };
        const link = button(active.link ? 'link' : 'unlink', active.link ? `${LINKS[active.link]}（点击切换）` : '未联动（点击切换）',
            () => this.onLink?.(g.active));
        link.dataset.link = active.link || 'none';
        const menuItems = () => [
            { icon: 'add', label: '在此组添加面板', onClick: () => this.onAdd?.(g.id) },
            { icon: 'maximize-2', label: maximized ? '还原布局' : '最大化此组', onClick: () => { this.maximized = maximized ? null : g.id; this.render(); } },
            ...Object.entries(LINKS).map(([key, label]) => ({ icon: 'link', label: `加入${label}`, selected: active.link === key,
                onClick: () => this.onLink?.(g.active, key) })),
            { icon: 'unlink', label: '取消联动', selected: !active.link, onClick: () => this.onLink?.(g.active, null) },
            { icon: 'close', label: `关闭“${active.title}”`, onClick: () => this.close(g.active) },
        ];
        const more = button('more_horiz', '面板组操作', () => openMenu(more, menuItems()));
        head.addEventListener('contextmenu', event => { event.preventDefault(); openMenu(more, menuItems()); });
        const actions = document.createElement('div');
        actions.className = 'dock-actions';
        actions.append(link, more);
        this.controls.push(tabs);
        head.append(tabs.element, actions);
        const body = document.createElement('div');
        body.className = 'dock-body';
        for (const id of g.tabs) {
            const panel = this.panel(id);
            panel.element.hidden = id !== g.active;
            body.append(panel.element);
        }
        section.append(head, body);
        return section;
    }
    dragSource(strip) {
        strip.addEventListener('pointerdown', event => {
            const tab = event.target.closest('.vcp-ui-tab');
            if (!tab || event.button !== 0) return;
            const panelId = tab.dataset.value, x0 = event.clientX, y0 = event.clientY;
            let ghost = null, drop = null, target = null;
            const move = e => {
                if (!ghost) {
                    if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
                    ghost = document.createElement('div'); ghost.className = 'dock-ghost'; ghost.textContent = this.describe(panelId).title;
                    drop = document.createElement('div'); drop.className = 'dock-drop'; drop.hidden = true;
                    document.body.append(ghost, drop); document.body.classList.add('dock-dragging');
                }
                ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
                target = this.dropTarget(e.clientX, e.clientY);
                this.paintDrop(drop, target);
            };
            const end = e => {
                window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
                if (!ghost) return;
                ghost.remove(); drop.remove(); document.body.classList.remove('dock-dragging');
                if (target && e.type === 'pointerup') this.move(panelId, target.groupId, target.zone);
            };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
        });
    }
    dropTarget(x, y) {
        const section = document.elementFromPoint(x, y)?.closest('.dock-group');
        if (!section || !this.root.contains(section)) return null;
        const rect = section.getBoundingClientRect();
        if (y <= section.querySelector('.dock-head').getBoundingClientRect().bottom) return { groupId: section.dataset.group, zone: 'center', rect };
        const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
        const [edge] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((a, b) => a[1] - b[1]);
        return { groupId: section.dataset.group, zone: edge[1] < .25 ? edge[0] : 'center', rect };
    }
    paintDrop(drop, target) {
        drop.hidden = !target;
        if (!target) return;
        let { left, top, width, height } = target.rect;
        if (target.zone === 'left' || target.zone === 'right') { width /= 2; if (target.zone === 'right') left += width; }
        if (target.zone === 'top' || target.zone === 'bottom') { height /= 2; if (target.zone === 'bottom') top += height; }
        Object.assign(drop.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    }
}
