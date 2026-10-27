import { COMPONENT_MANIFEST } from './component-manifest.js';

const COMPONENTS = new Map();
const ENHANCERS = new Map();
const controllerByElement = new WeakMap();

function updateRangeProgress(element) {
    const min = Number(element.min || 0);
    const max = Number(element.max || 100);
    const value = Number(element.value);
    const progress = max > min && Number.isFinite(value)
        ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
        : 0;
    element.style.setProperty('--vcp-ui-range-progress', `${Math.round(progress * 1000) / 1000}%`);
}

function devWarn(message) {
    console.warn(`[VCPUI] ${message}`);
}

function icon(name, className = '') {
    const span = document.createElement('span');
    span.className = `vcp-ui-icon ${className}`.trim();
    span.setAttribute('aria-hidden', 'true');
    span.textContent = name;
    queueMicrotask(() => {
        if (span.isConnected) window.VCPIcons?.set?.(span, name);
    });
    return span;
}

function appendContent(target, content) {
    target.replaceChildren();
    if (content instanceof Node) target.appendChild(content);
    else if (content !== undefined && content !== null) target.textContent = String(content);
}

function emit(element, type) {
    element.dispatchEvent(new Event(type, { bubbles: true }));
}

function listen(records, target, type, handler, options) {
    target.addEventListener(type, handler, options);
    records.push(() => target.removeEventListener(type, handler, options));
}

function makeController(element, state, render, cleanup = () => {}, { removeOnDestroy = true } = {}) {
    const records = [];
    let destroyed = false;
    const controller = {
        element,
        update(patch = {}) {
            if (destroyed) return controller;
            Object.assign(state, patch);
            render(state, records);
            return controller;
        },
        focus() {
            const target = element.matches('button, input, textarea, select, [tabindex]')
                ? element
                : element.querySelector('button, input, textarea, select, [tabindex]');
            target?.focus();
            return controller;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            const errors = [];
            records.splice(0).forEach(dispose => {
                try { dispose(); } catch (error) { errors.push(error); }
            });
            try { cleanup(); } catch (error) { errors.push(error); }
            controllerByElement.delete(element);
            if (removeOnDestroy) element.remove();
            if (errors.length) throw new AggregateError(errors, 'VCPUI controller cleanup failed.');
        },
        _listen(target, type, handler, options) {
            if (destroyed) throw new Error('Cannot add a listener to a destroyed VCPUI controller.');
            listen(records, target, type, handler, options);
        },
        get destroyed() { return destroyed; }
    };
    controllerByElement.set(element, controller);
    render(state, records);
    return controller;
}

function attachControlApi(controller, control) {
    Object.defineProperty(controller, 'control', {
        configurable: true,
        enumerable: true,
        get: () => control,
    });
    controller.getValue = () => control?.value;
    controller.setValue = (value, options = {}) => {
        const normalized = value == null ? '' : String(value);
        controller.update({ value: normalized });
        if (control) control.value = normalized;
        if (options.emit) emit(control, options.event || 'input');
        return controller;
    };
    controller.setDisabled = disabled => {
        controller.update({ disabled: Boolean(disabled) });
        if (control) control.disabled = Boolean(disabled);
        return controller;
    };
    return controller;
}

function rangeEnhancer(element, options = {}, { removeOnDestroy = false } = {}) {
    if (!element?.matches?.('input[type="range"]')) {
        throw new TypeError('VCPUI Range enhancement requires an input[type="range"].');
    }

    const originallyEnhanced = element.classList.contains('vcp-ui-range');
    const originalSize = element.getAttribute('data-size');
    const originalAriaLabel = element.getAttribute('aria-label');
    const originalProgress = element.style.getPropertyValue('--vcp-ui-range-progress');
    const state = {
        size: 'md',
        label: originalAriaLabel || '',
        ...options
    };

    const controller = makeController(element, state, current => {
        element.classList.add('vcp-ui-range');
        element.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
        if (current.label) element.setAttribute('aria-label', current.label);
        if (current.min !== undefined) element.min = String(current.min);
        if (current.max !== undefined) element.max = String(current.max);
        if (current.step !== undefined) element.step = String(current.step);
        if (current.value !== undefined && element.value !== String(current.value)) element.value = String(current.value);
        if (current.disabled !== undefined) element.disabled = Boolean(current.disabled);
        updateRangeProgress(element);
    }, () => {
        if (originalProgress) element.style.setProperty('--vcp-ui-range-progress', originalProgress);
        else element.style.removeProperty('--vcp-ui-range-progress');
        if (!originallyEnhanced) element.classList.remove('vcp-ui-range');
        if (originalSize === null) element.removeAttribute('data-size');
        else element.setAttribute('data-size', originalSize);
        if (originalAriaLabel === null) element.removeAttribute('aria-label');
        else element.setAttribute('aria-label', originalAriaLabel);
    }, { removeOnDestroy });

    controller._listen(element, 'input', () => {
        state.value = element.value;
        updateRangeProgress(element);
        state.onInput?.(Number(element.value), element);
    });
    controller._listen(element, 'change', () => {
        state.value = element.value;
        updateRangeProgress(element);
        state.onChange?.(Number(element.value), element);
    });
    return controller;
}

function rangeFactory(options = {}) {
    const element = document.createElement('input');
    element.type = 'range';
    return rangeEnhancer(element, options, { removeOnDestroy: true });
}

function nativeControlEnhancer(element, kind, options = {}) {
    const selectors = {
        input: 'input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])',
        textarea: 'textarea',
        select: 'select'
    };
    if (!element?.matches?.(selectors[kind])) {
        throw new TypeError(`VCPUI ${kind} enhancement received an incompatible element.`);
    }

    const className = `vcp-ui-native-${kind}`;
    const originallyEnhanced = element.classList.contains(className);
    const originalSize = element.getAttribute('data-size');
    const originalInvalid = element.getAttribute('aria-invalid');
    const originalAriaLabel = element.getAttribute('aria-label');
    const state = { size: 'md', ...options };

    const controller = makeController(element, state, current => {
        element.classList.add(className);
        element.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
        if (current.label) element.setAttribute('aria-label', current.label);
        if (current.invalid !== undefined) element.setAttribute('aria-invalid', String(Boolean(current.invalid)));
        if (current.disabled !== undefined) element.disabled = Boolean(current.disabled);
        if (current.readonly !== undefined && 'readOnly' in element) element.readOnly = Boolean(current.readonly);
    }, () => {
        if (!originallyEnhanced) element.classList.remove(className);
        if (originalSize === null) element.removeAttribute('data-size');
        else element.setAttribute('data-size', originalSize);
        if (originalInvalid === null) element.removeAttribute('aria-invalid');
        else element.setAttribute('aria-invalid', originalInvalid);
        if (originalAriaLabel === null) element.removeAttribute('aria-label');
        else element.setAttribute('aria-label', originalAriaLabel);
    }, { removeOnDestroy: false });
    attachControlApi(controller, element);
    controller.kernel = 'native';
    controller.kind = kind;
    return controller;
}

function selectEnhancer(element, options = {}) {
    if (!element?.matches?.('select')) {
        throw new TypeError('VCPUI select enhancement received an incompatible element.');
    }

    // Existing business forms can opt out of a replacement custom element.
    // This keeps their native DOM identity and lifecycle intact while still
    // applying the shared VCPUI sizing, focus and validation contract. New
    // VCPUI-owned controls continue to use Web Awesome through selectFactory.
    if (options.kernel === 'native') return nativeControlEnhancer(element, 'select', options);

    const wa = waControl('select', {});
    if (!wa) return nativeControlEnhancer(element, 'select', options);

    const originallyNativeSelect = element.classList.contains('vcp-ui-native-select');
    const originallySelectSource = element.classList.contains('vcp-ui-select-source');
    const originalSize = element.getAttribute('data-size');
    const originalAriaHidden = element.getAttribute('aria-hidden');
    const originalTabIndex = element.getAttribute('tabindex');
    const originallyHidden = element.hidden;
    const state = { size: element.dataset.size || 'md', ...options };
    const propertyRestorers = [];
    let syncing = false;
    let observer;
    let renderedOptionsSignature = null;

    wa.className = 'vcp-ui-select vcp-ui-wa-select vcp-ui-select-proxy';
    wa.dataset.vcpSelectProxyFor = element.id || '';
    wa.setAttribute('data-vcp-select-proxy', 'true');
    element.classList.add('vcp-ui-native-select', 'vcp-ui-select-source');
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('tabindex', '-1');

    const insertProxy = () => {
        if (!wa.isConnected && element.parentNode) element.after(wa);
    };

    const nativeOptionRecords = () => [...element.options].map(option => ({
        value: option.value,
        label: option.label || option.textContent || option.value,
        disabled: option.disabled || Boolean(option.closest('optgroup')?.disabled),
        group: option.closest('optgroup')?.label || '',
    }));

    const syncNativeToProxy = () => {
        if (syncing) return;
        syncing = true;
        insertProxy();
        const businessClasses = [...element.classList]
            .filter(name => !['vcp-ui-native-select', 'vcp-ui-select-source'].includes(name));
        wa.className = ['vcp-ui-select', 'vcp-ui-wa-select', 'vcp-ui-select-proxy', ...businessClasses].join(' ');
        wa.removeAttribute('style');
        [
            'display', 'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
            'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
            'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
            'gridArea', 'gridColumn', 'gridRow', 'order', 'boxSizing', 'fontSize',
        ].forEach(property => {
            const value = element.style[property];
            if (value) wa.style[property] = value;
        });
        waSize(wa, element.dataset.size || state.size);
        wa.disabled = Boolean(element.disabled);
        wa.required = Boolean(element.required);
        wa.name = '';
        const label = state.label || element.getAttribute('aria-label') || element.labels?.[0]?.textContent?.trim() || '';
        if (label) wa.setAttribute('aria-label', label);
        else wa.removeAttribute('aria-label');
        ['aria-describedby', 'aria-labelledby', 'title'].forEach(attribute => {
            const value = element.getAttribute(attribute);
            if (value) wa.setAttribute(attribute, value);
            else wa.removeAttribute(attribute);
        });
        const invalid = state.invalid ?? element.getAttribute('aria-invalid') === 'true';
        if (invalid) wa.setAttribute('aria-invalid', 'true');
        else wa.removeAttribute('aria-invalid');
        if (typeof wa.setCustomValidity === 'function') {
            wa.setCustomValidity(invalid ? (state.invalidMessage || element.validationMessage || ' ') : '');
        }
        const optionRecords = nativeOptionRecords();
        const optionsSignature = JSON.stringify(optionRecords);
        if (optionsSignature !== renderedOptionsSignature) {
            wa.replaceChildren();
            let previousGroup = null;
            optionRecords.forEach(record => {
                const option = document.createElement('wa-option');
                option.value = record.value;
                option.disabled = record.disabled;
                option.textContent = record.label;
                if (record.group) {
                    option.dataset.group = record.group;
                    option.setAttribute('aria-label', `${record.group}: ${record.label}`);
                    if (record.group !== previousGroup) option.dataset.groupStart = 'true';
                }
                previousGroup = record.group;
                wa.append(option);
            });
            renderedOptionsSignature = optionsSignature;
        }
        const proxyValue = wa.value == null ? '' : String(wa.value);
        if (proxyValue !== element.value) wa.value = element.value;
        syncing = false;
    };

    const syncProxyToNative = event => {
        if (syncing) return;
        syncing = true;
        const nextValue = wa.value == null ? '' : String(wa.value);
        const changed = element.value !== nextValue;
        element.value = nextValue;
        syncing = false;
        event?.stopPropagation?.();
        if (event?.type === 'input' && changed) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (event?.type === 'change') {
            // Web Awesome normally emits input followed by change. If a
            // component/version emits only change, retain native ordering by
            // synthesizing the missing input before the committed change.
            if (changed) element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
    };

    const patchProperty = property => {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor?.get || !descriptor?.set) return;
        const own = Object.getOwnPropertyDescriptor(element, property);
        Object.defineProperty(element, property, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: () => descriptor.get.call(element),
            set: value => {
                descriptor.set.call(element, value);
                queueMicrotask(syncNativeToProxy);
            },
        });
        propertyRestorers.push(() => {
            if (own) Object.defineProperty(element, property, own);
            else delete element[property];
        });
    };

    const patchMethod = method => {
        if (typeof element[method] !== 'function') return;
        const own = Object.getOwnPropertyDescriptor(element, method);
        const original = element[method].bind(element);
        Object.defineProperty(element, method, {
            configurable: true,
            value: (...args) => {
                const result = original(...args);
                queueMicrotask(syncNativeToProxy);
                return result;
            },
        });
        propertyRestorers.push(() => {
            if (own) Object.defineProperty(element, method, own);
            else delete element[method];
        });
    };

    patchProperty('value');
    patchProperty('selectedIndex');
    patchMethod('add');
    patchMethod('remove');
    const ownFocus = Object.getOwnPropertyDescriptor(element, 'focus');
    Object.defineProperty(element, 'focus', {
        configurable: true,
        value: (...args) => wa.focus?.(...args),
    });
    propertyRestorers.push(() => {
        if (ownFocus) Object.defineProperty(element, 'focus', ownFocus);
        else delete element.focus;
    });

    let controller;
    controller = makeController(wa, state, current => {
        if (current.value !== undefined && element.value !== String(current.value)) element.value = String(current.value);
        if (current.disabled !== undefined) element.disabled = Boolean(current.disabled);
        if (current.required !== undefined) element.required = Boolean(current.required);
        syncNativeToProxy();
    }, () => {
        observer?.disconnect();
        propertyRestorers.splice(0).reverse().forEach(restore => restore());
        controllerByElement.delete(element);
        if (!originallyNativeSelect) element.classList.remove('vcp-ui-native-select');
        if (!originallySelectSource) element.classList.remove('vcp-ui-select-source');
        if (originalSize === null) element.removeAttribute('data-size');
        else element.setAttribute('data-size', originalSize);
        if (originalAriaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', originalAriaHidden);
        if (originalTabIndex === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', originalTabIndex);
        element.hidden = originallyHidden;
    });
    controller.nativeElement = element;
    attachControlApi(controller, element);
    controller.kernel = 'webawesome-proxy';
    controller.kind = 'select';
    controller.refresh = () => {
        syncNativeToProxy();
        return controller;
    };
    controllerByElement.set(element, controller);
    controller._listen(wa, 'input', syncProxyToNative);
    controller._listen(wa, 'change', syncProxyToNative);
    // Refresh just before the listbox opens. Do not refresh on focus or every
    // pointerdown: Web Awesome restores focus before it emits the committed
    // input/change pair, so a focus refresh would overwrite the user's new
    // choice with the old native value. Pointerdown also fires for options and
    // must never rebuild the option being clicked.
    controller._listen(wa, 'wa-show', syncNativeToProxy);
    controller._listen(element, 'input', syncNativeToProxy);
    controller._listen(element, 'change', syncNativeToProxy);
    [...(element.labels || [])].forEach(label => controller._listen(label, 'click', event => {
        event.preventDefault();
        wa.focus?.();
    }));
    if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => queueMicrotask(syncNativeToProxy));
        observer.observe(element, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    queueMicrotask(syncNativeToProxy);
    return waFocus(controller, wa);
}

function nativeSwitchEnhancer(element, options = {}) {
    if (!element?.matches?.('label.switch')) {
        throw new TypeError('VCPUI Switch enhancement requires a label.switch element.');
    }
    const input = element.querySelector('input[type="checkbox"]');
    if (!input) throw new TypeError('VCPUI Switch enhancement requires a checkbox input.');

    const originallyEnhanced = element.classList.contains('vcp-ui-native-switch');
    const originalSize = element.getAttribute('data-size');
    const originalState = element.getAttribute('data-state');
    const state = { size: 'md', ...options };
    let controller;
    const sync = () => {
        element.dataset.state = input.checked ? 'on' : 'off';
        element.classList.toggle('is-disabled', input.disabled);
    };

    controller = makeController(element, state, current => {
        element.classList.add('vcp-ui-native-switch');
        element.dataset.size = normalize(current.size, ['sm', 'md'], 'md', 'size');
        if (current.checked !== undefined) input.checked = Boolean(current.checked);
        if (current.disabled !== undefined) input.disabled = Boolean(current.disabled);
        sync();
    }, () => {
        if (!originallyEnhanced) element.classList.remove('vcp-ui-native-switch', 'is-disabled');
        if (originalSize === null) element.removeAttribute('data-size');
        else element.setAttribute('data-size', originalSize);
        if (originalState === null) element.removeAttribute('data-state');
        else element.setAttribute('data-state', originalState);
    }, { removeOnDestroy: false });
    controller._listen(input, 'change', sync);
    return controller;
}

function settingsSectionEnhancer(element, options = {}, { removeOnDestroy = false } = {}) {
    if (!element?.matches?.('.agent-settings-section, .group-settings-section, .vcp-ui-settings-section')) {
        throw new TypeError('VCPUI SettingsSection enhancement received an incompatible element.');
    }

    const header = options.header || element.querySelector(options.headerSelector || '.agent-settings-section-header, .group-settings-section-header, .vcp-ui-settings-section-header');
    const toggle = options.toggle || element.querySelector(options.toggleSelector || '.agent-settings-toggle-btn, .group-settings-toggle-btn, .vcp-ui-settings-section-toggle');
    const content = options.content || element.querySelector(options.contentSelector || '.agent-settings-section-content, .group-settings-section-content, .vcp-ui-settings-section-content');
    if (!header || !toggle || !content) throw new TypeError('VCPUI SettingsSection requires header, toggle, and content elements.');

    const originallyEnhanced = element.classList.contains('vcp-ui-settings-section');
    const originalState = element.getAttribute('data-state');
    const originalExpanded = toggle.getAttribute('aria-expanded');
    const originalControls = toggle.getAttribute('aria-controls');
    const generatedContentId = !content.id;
    if (generatedContentId) content.id = `vcp-ui-settings-section-${crypto.randomUUID()}`;
    const state = { collapsed: undefined, manageToggle: false, ...options };
    let observer;
    let controller;

    const sync = () => {
        const collapsed = element.classList.contains('collapsed');
        element.dataset.state = collapsed ? 'collapsed' : 'expanded';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-controls', content.id);
    };

    controller = makeController(element, state, current => {
        element.classList.add('vcp-ui-settings-section');
        if (current.collapsed !== undefined) element.classList.toggle('collapsed', Boolean(current.collapsed));
        sync();
    }, () => {
        observer?.disconnect();
        if (!originallyEnhanced) element.classList.remove('vcp-ui-settings-section');
        if (originalState === null) element.removeAttribute('data-state');
        else element.setAttribute('data-state', originalState);
        if (originalExpanded === null) toggle.removeAttribute('aria-expanded');
        else toggle.setAttribute('aria-expanded', originalExpanded);
        if (originalControls === null) toggle.removeAttribute('aria-controls');
        else toggle.setAttribute('aria-controls', originalControls);
        if (generatedContentId) content.removeAttribute('id');
    }, { removeOnDestroy });

    observer = new window.MutationObserver(sync);
    observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    if (state.manageToggle) {
        controller._listen(header, 'click', event => {
            if (event.target.closest('button') && event.target !== toggle && !toggle.contains(event.target)) return;
            element.classList.toggle('collapsed');
            sync();
            emit(element, 'change');
        });
    }
    return controller;
}

function settingsSectionFactory(options = {}) {
    const element = document.createElement('section');
    element.className = 'vcp-ui-settings-section';
    const header = document.createElement('header');
    header.className = 'vcp-ui-settings-section-header';
    const title = document.createElement('strong');
    title.textContent = options.title || '设置分区';
    const summary = document.createElement('span');
    summary.className = 'vcp-ui-settings-section-summary';
    summary.textContent = options.summary || '';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'vcp-ui-settings-section-toggle';
    toggle.setAttribute('aria-label', '展开或收起设置分区');
    toggle.append(icon('chevron_down'));
    const content = document.createElement('div');
    content.className = 'vcp-ui-settings-section-content';
    appendContent(content, options.content || '');
    header.append(title, summary, toggle);
    element.append(header, content);
    return settingsSectionEnhancer(element, { ...options, header, toggle, content, manageToggle: true }, { removeOnDestroy: true });
}

function fieldEnhancer(element, options = {}) {
    if (!element?.matches?.('.group-settings-field-shell, .style-control-item, .agent-name-wrapper, .group-name-wrapper, .params-content > div:not(.form-group-inline), .vcp-ui-settings-field, .vcp-ui-field')) {
        throw new TypeError('VCPUI Field enhancement received an incompatible element.');
    }
    const control = options.control || element.querySelector('input:not([type="hidden"]), select, textarea');
    if (!control) throw new TypeError('VCPUI Field enhancement requires a form control.');

    const label = options.labelElement
        || (control.id ? element.querySelector(`label[for="${control.id}"]`) : null)
        || element.querySelector('label');
    const helper = options.helperElement || element.querySelector('.group-settings-helper-text, small, .form-hint');
    const originallyEnhanced = element.classList.contains('vcp-ui-settings-field');
    const originalState = element.getAttribute('data-state');
    const originalInvalid = control.getAttribute('aria-invalid');
    const originalDescribedBy = control.getAttribute('aria-describedby');
    const originalHelperText = helper?.textContent || '';
    const generatedHelperId = Boolean(helper && !helper.id);
    if (generatedHelperId) helper.id = `vcp-ui-field-help-${crypto.randomUUID()}`;
    const state = { invalid: undefined, error: '', ...options };
    let controller;

    const syncValidity = () => {
        const invalid = state.invalid !== undefined ? Boolean(state.invalid) : !control.checkValidity();
        element.dataset.state = invalid || state.error ? 'error' : 'default';
        control.setAttribute('aria-invalid', String(Boolean(invalid || state.error)));
        if (helper?.id) control.setAttribute('aria-describedby', helper.id);
        if (label && control.id) label.htmlFor = control.id;
    };

    controller = makeController(element, state, current => {
        element.classList.add('vcp-ui-settings-field');
        if (helper) helper.textContent = current.error || originalHelperText;
        syncValidity();
    }, () => {
        if (!originallyEnhanced) element.classList.remove('vcp-ui-settings-field');
        if (originalState === null) element.removeAttribute('data-state');
        else element.setAttribute('data-state', originalState);
        if (originalInvalid === null) control.removeAttribute('aria-invalid');
        else control.setAttribute('aria-invalid', originalInvalid);
        if (originalDescribedBy === null) control.removeAttribute('aria-describedby');
        else control.setAttribute('aria-describedby', originalDescribedBy);
        if (helper) helper.textContent = originalHelperText;
        if (generatedHelperId) helper.removeAttribute('id');
    }, { removeOnDestroy: false });
    controller._listen(control, 'invalid', () => {
        state.invalid = true;
        syncValidity();
    });
    controller._listen(control, 'input', () => {
        state.invalid = undefined;
        state.error = '';
        syncValidity();
    });
    controller._listen(control, 'change', syncValidity);
    return controller;
}

function settingsActionBarEnhancer(element, options = {}, { removeOnDestroy = false } = {}) {
    if (!element?.matches?.('.form-actions, .vcp-ui-settings-action-bar, .global-settings-footer')) {
        throw new TypeError('VCPUI SettingsActionBar enhancement received an incompatible element.');
    }
    const form = options.form || element.closest('form');
    const submit = options.submit || element.querySelector('button[type="submit"]');
    const danger = options.danger || element.querySelector('.danger-button, [data-variant="danger"]');
    if (!form || !submit) throw new TypeError('VCPUI SettingsActionBar requires a form and submit button.');

    const originallyEnhanced = element.classList.contains('vcp-ui-settings-action-bar');
    const originalState = element.getAttribute('data-state');
    const originalBusy = submit.getAttribute('aria-busy');
    const originalDangerBusy = danger?.getAttribute('aria-busy') ?? null;
    const state = { dirty: false, saving: false, deleting: false, error: false, ...options };
    let fallbackTimer = null;
    let controller;

    const renderState = () => {
        element.dataset.state = state.deleting ? 'deleting' : state.saving ? 'saving' : state.error ? 'error' : state.dirty ? 'dirty' : 'clean';
        submit.setAttribute('aria-busy', String(Boolean(state.saving)));
        danger?.setAttribute('aria-busy', String(Boolean(state.deleting)));
    };

    controller = makeController(element, state, () => {
        element.classList.add('vcp-ui-settings-action-bar');
        renderState();
    }, () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (!originallyEnhanced) element.classList.remove('vcp-ui-settings-action-bar');
        if (originalState === null) element.removeAttribute('data-state');
        else element.setAttribute('data-state', originalState);
        if (originalBusy === null) submit.removeAttribute('aria-busy');
        else submit.setAttribute('aria-busy', originalBusy);
        if (danger) {
            if (originalDangerBusy === null) danger.removeAttribute('aria-busy');
            else danger.setAttribute('aria-busy', originalDangerBusy);
        }
    }, { removeOnDestroy });

    const markDirty = event => {
        if (event.target.matches('button, input[type="hidden"]')) return;
        state.dirty = true;
        state.error = false;
        renderState();
    };
    controller._listen(form, 'input', markDirty);
    controller._listen(form, 'change', markDirty);
    controller._listen(form, 'submit', () => {
        state.saving = true;
        state.deleting = false;
        state.error = false;
        renderState();
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
            if (!state.saving) return;
            state.saving = false;
            state.error = true;
            renderState();
        }, 15000);
    });
    controller._listen(form, 'vcp-settings-save-result', event => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        state.saving = false;
        state.deleting = false;
        state.error = !event.detail?.success;
        state.dirty = !event.detail?.success;
        renderState();
    });
    if (danger) {
        controller._listen(danger, 'click', () => {
            state.deleting = true;
            state.saving = false;
            state.error = false;
            renderState();
            if (fallbackTimer) clearTimeout(fallbackTimer);
            fallbackTimer = setTimeout(() => {
                if (!state.deleting) return;
                state.deleting = false;
                state.error = true;
                renderState();
            }, 15000);
        });
    }
    controller._listen(form, 'vcp-settings-delete-result', event => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        state.saving = false;
        state.deleting = false;
        state.error = !event.detail?.success && !event.detail?.cancelled;
        if (event.detail?.success) state.dirty = false;
        renderState();
    });
    controller.markSaved = () => controller.update({ saving: false, deleting: false, error: false, dirty: false });
    controller.markError = () => controller.update({ saving: false, deleting: false, error: true, dirty: true });
    return controller;
}

function settingsActionBarFactory(options = {}) {
    const form = options.form || document.createElement('form');
    const element = document.createElement('footer');
    element.className = 'vcp-ui-settings-action-bar';
    const submit = buttonFactory({ label: options.saveLabel || '保存设置', type: 'submit', variant: 'primary' });
    const danger = options.dangerLabel ? buttonFactory({ label: options.dangerLabel, variant: 'danger' }) : null;
    element.append(submit.element);
    if (danger) element.append(danger.element);
    if (!options.form) form.append(element);
    const controller = settingsActionBarEnhancer(element, { ...options, form, submit: submit.element, danger: danger?.element }, { removeOnDestroy: true });
    const destroy = controller.destroy.bind(controller);
    controller.destroy = () => {
        submit.destroy();
        danger?.destroy();
        destroy();
    };
    controller.form = form;
    return controller;
}

function normalize(value, allowed, fallback, property) {
    if (!value) return fallback;
    if (allowed.includes(value)) return value;
    devWarn(`Unknown ${property} "${value}"; using "${fallback}".`);
    return fallback;
}

function setCommon(element, state, variants, sizes = ['sm', 'md', 'lg']) {
    element.dataset.variant = normalize(state.variant, variants, variants[0], 'variant');
    element.dataset.size = normalize(state.size, sizes, sizes.includes('md') ? 'md' : sizes[0], 'size');
    element.dataset.state = state.loading ? 'loading' : state.invalid ? 'invalid' : state.active ? 'active' : 'default';
    element.classList.toggle('is-block', Boolean(state.block));
    element.classList.toggle('is-disabled', Boolean(state.disabled));
}

// Builds a Web Awesome-backed control when the component bundle has been lazily
// registered (the consuming surface preloads it through VCPWebAwesome) and the
// adapter is available in next mode. Falls back to null so factories use the
// native DOM control; business pages keep the VCPUI API either way.
function waControl(tag, attrs = {}) {
    if (document.documentElement.dataset.uiMode !== 'next') return null;
    if (!window.VCPWebAwesome?.isDefined?.(tag)) return null;
    return window.VCPWebAwesome.create(tag, attrs);
}

function waSize(wa, value, sizes = ['sm', 'md', 'lg'], map = { sm: 's', md: 'm', lg: 'l' }) {
    wa.setAttribute('size', map[normalize(value, sizes, 'md', 'size')] || 'm');
}

function waFocus(controller, wa) {
    const baseFocus = controller.focus.bind(controller);
    controller.focus = () => {
        if (typeof wa.focus === 'function') wa.focus();
        else baseFocus();
        return controller;
    };
    return controller;
}

function nextFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 16);
}

// Legacy callers of Input/Textarea/Select reach the control through
// `element.querySelector('input'|'textarea'|'select')` and then read/write
// `.value` (and sometimes `.options`/`.selectedIndex`). A Web Awesome control
// keeps its native input inside a shadow root, so those paths would silently
// return null and crash. This bridge keeps them working:
//   - `querySelector`/`querySelectorAll` first search the light DOM, then the
//     WA shadow root (the real internal control once connected), then fall back
//     to a detached native shim.
//   - the shim is a real `<input>`/`<textarea>`/`<select>` element, so `.value`,
//     `.options`, `.selectedIndex`, `.addEventListener(...)` and `.disabled` /
//     `.required` / `.readOnly` never throw even before the WA element is
//     connected; `.value`/`.disabled`/`.required`/`.readOnly` forward to the
//     WA control, and WA `input`/`change` events are relayed onto the shim.
function bridgeNativeControl(wa, kind) {
    const tag = kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input';
    const shim = document.createElement(tag);
    if (kind === 'input') shim.type = 'text';
    if (kind === 'textarea') shim.rows = 4;
    shim.className = 'vcp-ui-native-bridge';
    shim.setAttribute('tabindex', '-1');
    shim.setAttribute('aria-hidden', 'true');

    Object.defineProperty(shim, 'value', {
        configurable: true,
        get() {
            const value = wa.value;
            return value == null ? '' : String(value);
        },
        set(next) {
            wa.value = next == null ? '' : String(next);
        }
    });
    ['disabled', 'required'].forEach(property => {
        Object.defineProperty(shim, property, {
            configurable: true,
            get: () => Boolean(wa[property]),
            set: next => { wa[property] = Boolean(next); }
        });
    });
    if (kind !== 'select') {
        Object.defineProperty(shim, 'readOnly', {
            configurable: true,
            get: () => Boolean(wa.readonly),
            set: next => { wa.readonly = Boolean(next); }
        });
    }
    if (kind === 'select') {
        const options = () => [...wa.querySelectorAll('wa-option')];
        const findSelectedIndex = () => {
            const value = wa.value;
            return options().findIndex(option => String(option.value) === String(value));
        };
        const selectByIndex = index => {
            const option = options()[Number(index)];
            if (option) wa.value = option.value;
        };
        ['options', 'selectedIndex'].forEach(property => {
            if (property in wa) return;
            Object.defineProperty(wa, property, {
                configurable: true,
                get: property === 'options' ? options : findSelectedIndex,
                set: property === 'options' ? undefined : selectByIndex
            });
        });
        Object.defineProperty(shim, 'options', {
            configurable: true,
            get: options
        });
        Object.defineProperty(shim, 'selectedIndex', {
            configurable: true,
            get: findSelectedIndex,
            set: selectByIndex
        });
    }
    ['input', 'change'].forEach(type => {
        wa.addEventListener(type, () => {
            shim.dispatchEvent(new Event(type, { bubbles: true }));
        });
    });

    const matchesControl = selector => new RegExp(`(^|[\\s,>+~])${tag}([\\s,>+~]|$)`, 'i').test(selector);
    const originalQuery = wa.querySelector.bind(wa);
    const originalQueryAll = wa.querySelectorAll.bind(wa);
    wa.querySelector = selector => {
        const hit = originalQuery(selector);
        if (hit) return hit;
        const shadow = wa.shadowRoot?.querySelector(selector);
        if (shadow) return shadow;
        return matchesControl(selector) ? shim : null;
    };
    wa.querySelectorAll = selector => {
        const hits = originalQueryAll(selector);
        if (hits.length) return hits;
        const shadow = wa.shadowRoot?.querySelectorAll(selector);
        if (shadow?.length) return shadow;
        return matchesControl(selector) ? [shim] : hits;
    };
    return shim;
}

// Checkbox/Switch keep their native toggle inside the WA shadow root. The WA
// element itself exposes `.checked`, and legacy `querySelector('input[...]')`
// paths are bridged to the real internal checkbox input.
function bridgeCheckedControl(wa) {
    const matchesInput = selector => /(^|[\s,>+~])input([\s,>+~]|$)/i.test(selector);
    const originalQuery = wa.querySelector.bind(wa);
    const originalQueryAll = wa.querySelectorAll.bind(wa);
    wa.querySelector = selector => {
        const hit = originalQuery(selector);
        if (hit) return hit;
        const shadow = wa.shadowRoot?.querySelector(selector);
        if (shadow) return shadow;
        return matchesInput(selector) ? wa.input ?? null : null;
    };
    wa.querySelectorAll = selector => {
        const hits = originalQueryAll(selector);
        if (hits.length) return hits;
        const shadow = wa.shadowRoot?.querySelectorAll(selector);
        if (shadow?.length) return shadow;
        return matchesInput(selector) && wa.input ? [wa.input] : hits;
    };
}

function buttonFactory(options = {}) {
    const wa = waControl('button', {});
    if (wa) {
        wa.className = 'vcp-ui-button vcp-ui-wa-button';
        const state = { label: 'Button', variant: 'primary', size: 'md', ...options };
        const controller = makeController(wa, state, current => {
            const variants = {
                primary: 'brand', secondary: 'neutral', outline: 'neutral', ghost: 'neutral',
                danger: 'danger', link: 'neutral',
            };
            setCommon(wa, current, Object.keys(variants), ['sm', 'md', 'lg', 'xl']);
            wa.setAttribute('variant', variants[current.variant] || 'brand');
            wa.setAttribute('appearance', current.variant === 'ghost' || current.variant === 'link' ? 'plain' : current.variant === 'outline' ? 'outlined' : 'filled');
            waSize(wa, current.size, ['sm', 'md', 'lg', 'xl'], { sm: 's', md: 'm', lg: 'l', xl: 'l' });
            wa.disabled = Boolean(current.disabled || current.loading);
            wa.loading = Boolean(current.loading);
            wa.setAttribute('type', current.type || 'button');
            wa.replaceChildren();
            if (!current.loading && current.icon) {
                const start = document.createElement('span');
                start.slot = 'start';
                start.append(icon(current.icon));
                wa.append(start);
            }
            const label = document.createElement('span');
            label.textContent = current.label;
            wa.append(label);
        });
        return waFocus(controller, wa);
    }
    const element = document.createElement('button');
    element.type = options.type || 'button';
    element.className = 'vcp-ui-button';
    const state = { label: 'Button', variant: 'primary', size: 'md', ...options };
    return makeController(element, state, current => {
        setCommon(element, current, ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link'], ['sm', 'md', 'lg', 'xl']);
        element.disabled = Boolean(current.disabled || current.loading);
        element.setAttribute('aria-busy', String(Boolean(current.loading)));
        element.replaceChildren();
        if (current.loading) element.append(icon('progress_activity', 'vcp-ui-spinner'));
        else if (current.icon) element.append(icon(current.icon));
        const label = document.createElement('span');
        label.textContent = current.label;
        element.append(label);
    });
}

function iconButtonFactory(options = {}) {
    const wa = waControl('button', {});
    if (wa) {
        wa.className = 'vcp-ui-icon-button vcp-ui-wa-icon-button';
        const state = { icon: 'more_horiz', label: '', variant: 'ghost', size: 'md', ...options };
        const controller = makeController(wa, state, current => {
            if (!current.label) devWarn('IconButton requires a non-empty aria-label.');
            const variants = { ghost: 'neutral', secondary: 'neutral', outline: 'neutral', danger: 'danger' };
            const appearances = { ghost: 'plain', secondary: 'filled', outline: 'outlined', danger: 'plain' };
            setCommon(wa, current, ['ghost', 'secondary', 'outline', 'danger'], ['sm', 'md']);
            wa.setAttribute('variant', variants[current.variant] || 'neutral');
            wa.setAttribute('appearance', appearances[current.variant] || 'plain');
            waSize(wa, current.size, ['sm', 'md'], { sm: 's', md: 'm' });
            wa.disabled = Boolean(current.disabled);
            wa.loading = Boolean(current.loading);
            wa.setAttribute('aria-label', current.label || 'Icon button');
            wa.setAttribute('aria-pressed', String(Boolean(current.active)));
            wa.setAttribute('title', current.title || current.label || '');
            wa.replaceChildren(icon(current.icon));
        });
        return waFocus(controller, wa);
    }
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'vcp-ui-icon-button';
    const state = { icon: 'more_horiz', label: '', variant: 'ghost', size: 'md', ...options };
    return makeController(element, state, current => {
        if (!current.label) devWarn('IconButton requires a non-empty aria-label.');
        setCommon(element, current, ['ghost', 'secondary', 'outline', 'danger'], ['sm', 'md']);
        element.disabled = Boolean(current.disabled);
        element.classList.toggle('is-active', Boolean(current.active));
        element.setAttribute('aria-label', current.label || 'Icon button');
        element.title = current.title || current.label || '';
        element.replaceChildren(icon(current.icon));
    });
}

function textControlFactory(kind, options = {}) {
    const wa = kind === 'input' ? waControl('input', {}) : waControl('textarea', {});
    if (wa) {
        wa.className = kind === 'input'
            ? 'vcp-ui-input vcp-ui-wa-input'
            : 'vcp-ui-textarea vcp-ui-wa-textarea';
        const state = { size: 'md', value: '', ...options };
        const controller = makeController(wa, state, current => {
            waSize(wa, current.size);
            wa.disabled = Boolean(current.disabled);
            wa.readonly = Boolean(current.readonly);
            wa.required = Boolean(current.required);
            wa.placeholder = current.placeholder || '';
            if (kind === 'textarea') {
                wa.rows = Number(current.rows) || 4;
                wa.resize = current.resize || 'vertical';
            } else {
                wa.type = current.type || 'text';
            }
            wa.value = String(current.value ?? '');
            wa.replaceChildren();
            if (current.leadingIcon) {
                const start = document.createElement('span');
                start.slot = 'start';
                start.append(icon(current.leadingIcon, 'vcp-ui-control-icon'));
                wa.append(start);
            }
            if (current.trailingIcon) {
                const end = document.createElement('span');
                end.slot = 'end';
                end.append(icon(current.trailingIcon, 'vcp-ui-control-icon'));
                wa.append(end);
            }
            if (current.invalid) wa.setAttribute('aria-invalid', 'true');
            else wa.removeAttribute('aria-invalid');
            if (typeof wa.setCustomValidity === 'function') {
                wa.setCustomValidity(current.invalid ? (current.invalidMessage || ' ') : '');
            }
        });
        controller._listen(wa, 'input', () => { state.value = wa.value; });
        bridgeNativeControl(wa, kind);
        attachControlApi(controller, wa);
        return waFocus(controller, wa);
    }
    const wrapper = document.createElement('span');
    wrapper.className = `vcp-ui-${kind}-wrap`;
    const control = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
    control.className = `vcp-ui-${kind}`;
    wrapper.appendChild(control);
    const state = { size: 'md', value: '', ...options };
    const controller = makeController(wrapper, state, current => {
        setCommon(wrapper, current, ['default'], ['sm', 'md', 'lg']);
        control.disabled = Boolean(current.disabled);
        control.readOnly = Boolean(current.readonly);
        control.required = Boolean(current.required);
        control.placeholder = current.placeholder || '';
        control.setAttribute('aria-invalid', String(Boolean(current.invalid)));
        if (kind === 'input') control.type = current.type || 'text';
        if (kind === 'textarea') {
            control.rows = current.rows || 4;
            wrapper.dataset.resize = current.resize || 'vertical';
        }
        if (control.value !== String(current.value ?? '')) control.value = String(current.value ?? '');
        wrapper.querySelectorAll('.vcp-ui-control-icon').forEach(node => node.remove());
        if (current.leadingIcon) wrapper.prepend(icon(current.leadingIcon, 'vcp-ui-control-icon is-leading'));
        if (current.trailingIcon) wrapper.append(icon(current.trailingIcon, 'vcp-ui-control-icon is-trailing'));
    });
    attachControlApi(controller, control);
    controller._listen(control, 'input', () => { state.value = control.value; });
    return controller;
}

function selectFactory(options = {}) {
    const wa = waControl('select', { value: options.value ?? '', disabled: options.disabled });
    if (wa) {
        const state = { size: 'md', options: [], value: '', placeholder: '', ...options };
        const controller = makeController(wa, state, current => {
            waSize(wa, current.size);
            wa.disabled = Boolean(current.disabled);
            wa.required = Boolean(current.required);
            if (current.placeholder) wa.placeholder = current.placeholder;
            else wa.removeAttribute('placeholder');
            if (current.invalid) wa.setAttribute('aria-invalid', 'true');
            else wa.removeAttribute('aria-invalid');
            if (typeof wa.setCustomValidity === 'function') {
                wa.setCustomValidity(current.invalid ? (current.invalidMessage || ' ') : '');
            }
            wa.replaceChildren();
            if (current.placeholder) {
                const placeholder = document.createElement('wa-option');
                placeholder.value = '';
                placeholder.disabled = true;
                placeholder.textContent = current.placeholder;
                wa.append(placeholder);
            }
            (current.options || []).forEach(item => {
                const normalized = typeof item === 'string' ? { label: item, value: item } : item;
                const option = document.createElement('wa-option');
                option.value = normalized.value;
                option.disabled = Boolean(normalized.disabled);
                option.textContent = normalized.label;
                wa.append(option);
            });
            if (current.value !== undefined) wa.value = String(current.value);
        });
        controller._listen(wa, 'change', event => {
            // Only relay the trusted Web Awesome change; the relayed Event we
            // dispatch below would otherwise re-enter this listener forever
            // (RangeError: call stack size exceeded).
            if (event.isTrusted) emit(wa, 'change');
        });
        bridgeNativeControl(wa, 'select');
        waFocus(controller, wa);
        attachControlApi(controller, wa);
        return controller;
    }
    const element = document.createElement('select');
    element.className = 'vcp-ui-select';
    const state = { size: 'md', options: [], value: '', placeholder: '', ...options };
    const controller = makeController(element, state, current => {
        setCommon(element, current, ['default'], ['sm', 'md', 'lg']);
        element.disabled = Boolean(current.disabled);
        element.setAttribute('aria-invalid', String(Boolean(current.invalid)));
        element.replaceChildren();
        if (current.placeholder) {
            const placeholder = new Option(current.placeholder, '');
            placeholder.disabled = true;
            element.add(placeholder);
        }
        current.options.forEach(item => {
            const normalized = typeof item === 'string' ? { label: item, value: item } : item;
            const option = new Option(normalized.label, normalized.value);
            option.disabled = Boolean(normalized.disabled);
            element.add(option);
        });
        element.value = String(current.value ?? '');
    });
    attachControlApi(controller, element);
    return controller;
}

function checkboxFactory(options = {}) {
    const wa = waControl('checkbox', {});
    if (wa) {
        wa.className = 'vcp-ui-checkbox vcp-ui-wa-checkbox';
        const state = { label: 'Checkbox', checked: false, indeterminate: false, ...options };
        const controller = makeController(wa, state, current => {
            wa.checked = Boolean(current.checked);
            wa.indeterminate = Boolean(current.indeterminate);
            wa.disabled = Boolean(current.disabled);
            wa.required = Boolean(current.required);
            wa.value = String(current.value ?? 'on');
            wa.replaceChildren();
            const label = document.createElement('span');
            label.textContent = current.label;
            wa.append(label);
        });
        controller._listen(wa, 'change', () => {
            state.checked = wa.checked;
            state.indeterminate = false;
            controller.update();
        });
        bridgeCheckedControl(wa);
        return waFocus(controller, wa);
    }
    const element = document.createElement('label');
    element.className = 'vcp-ui-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const visual = document.createElement('span');
    visual.className = 'vcp-ui-checkbox-box';
    visual.append(icon('check'));
    const label = document.createElement('span');
    element.append(input, visual, label);
    const state = { label: 'Checkbox', checked: false, indeterminate: false, ...options };
    const controller = makeController(element, state, current => {
        input.checked = Boolean(current.checked);
        input.indeterminate = Boolean(current.indeterminate);
        input.disabled = Boolean(current.disabled);
        element.classList.toggle('is-disabled', input.disabled);
        element.dataset.state = current.indeterminate ? 'indeterminate' : input.checked ? 'checked' : 'unchecked';
        visual.firstChild.textContent = current.indeterminate ? 'remove' : 'check';
        label.textContent = current.label;
    });
    controller._listen(input, 'change', () => {
        state.checked = input.checked;
        state.indeterminate = false;
        controller.update();
    });
    return controller;
}

function switchFactory(options = {}) {
    const wa = waControl('switch', {});
    if (wa) {
        wa.className = 'vcp-ui-switch vcp-ui-wa-switch';
        const state = { label: 'Switch', checked: false, size: 'md', ...options };
        const controller = makeController(wa, state, current => {
            waSize(wa, current.size, ['sm', 'md'], { sm: 's', md: 'm' });
            wa.checked = Boolean(current.checked);
            wa.disabled = Boolean(current.disabled);
            wa.required = Boolean(current.required);
            wa.value = String(current.value ?? 'on');
            wa.replaceChildren();
            const label = document.createElement('span');
            label.className = 'vcp-ui-switch-label';
            label.textContent = current.label;
            wa.append(label);
        });
        controller._listen(wa, 'change', () => {
            state.checked = wa.checked;
            controller.update();
        });
        bridgeCheckedControl(wa);
        return waFocus(controller, wa);
    }
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'vcp-ui-switch';
    element.setAttribute('role', 'switch');
    const track = document.createElement('span');
    track.className = 'vcp-ui-switch-track';
    track.appendChild(document.createElement('span')).className = 'vcp-ui-switch-thumb';
    const label = document.createElement('span');
    label.className = 'vcp-ui-switch-label';
    element.append(track, label);
    const state = { label: 'Switch', checked: false, size: 'md', ...options };
    const controller = makeController(element, state, current => {
        element.dataset.size = normalize(current.size, ['sm', 'md'], 'md', 'size');
        element.dataset.state = current.checked ? 'on' : 'off';
        element.disabled = Boolean(current.disabled);
        element.setAttribute('aria-checked', String(Boolean(current.checked)));
        label.textContent = current.label;
    });
    controller._listen(element, 'click', () => {
        state.checked = !state.checked;
        controller.update();
        emit(element, 'input');
        emit(element, 'change');
    });
    return controller;
}

function fieldFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-field';
    const header = document.createElement('div');
    header.className = 'vcp-ui-field-header';
    const label = document.createElement('label');
    const required = document.createElement('span');
    required.className = 'vcp-ui-required';
    required.textContent = '*';
    header.append(label, required);
    const controlHost = document.createElement('div');
    controlHost.className = 'vcp-ui-field-control';
    const message = document.createElement('div');
    message.className = 'vcp-ui-field-message';
    element.append(header, controlHost, message);
    const state = { label: 'Field', helper: '', error: '', required: false, ...options };
    return makeController(element, state, current => {
        label.textContent = current.label;
        required.hidden = !current.required;
        element.dataset.state = current.error ? 'error' : 'default';
        message.textContent = current.error || current.helper || '';
        if (current.control) {
            const control = current.control.element || current.control;
            if (controlHost.firstChild !== control) controlHost.replaceChildren(control);
            const native = control.matches?.('input, textarea, select') ? control : control.querySelector?.('input, textarea, select');
            if (native) {
                if (!native.id) native.id = `vcp-ui-field-${crypto.randomUUID()}`;
                label.htmlFor = native.id;
                native.required = Boolean(current.required);
                native.setAttribute('aria-invalid', String(Boolean(current.error)));
            }
        }
    });
}

function badgeFactory(options = {}) {
    const element = document.createElement('span');
    element.className = 'vcp-ui-badge';
    const state = { label: 'Badge', variant: 'neutral', ...options };
    return makeController(element, state, current => {
        element.dataset.variant = normalize(current.variant, ['neutral', 'accent', 'success', 'warning', 'danger'], 'neutral', 'variant');
        element.textContent = current.label;
    });
}

function alertFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-alert';
    element.setAttribute('role', 'status');
    const state = { title: '', message: '', variant: 'info', dismissible: false, ...options };
    let controller;
    controller = makeController(element, state, current => {
        const variants = ['info', 'success', 'warning', 'danger'];
        element.dataset.variant = normalize(current.variant, variants, 'info', 'variant');
        element.replaceChildren(icon({ info: 'info', success: 'check_circle', warning: 'warning', danger: 'error' }[element.dataset.variant]));
        const body = document.createElement('div');
        body.className = 'vcp-ui-alert-body';
        if (current.title) {
            const title = document.createElement('strong');
            title.textContent = current.title;
            body.append(title);
        }
        const message = document.createElement('span');
        message.textContent = current.message;
        body.append(message);
        element.append(body);
        if (current.dismissible) {
            const close = iconButtonFactory({ icon: 'close', label: '关闭提示', size: 'sm' });
            close.element.addEventListener('click', () => controller.destroy(), { once: true });
            element.append(close.element);
        }
    });
    return controller;
}

function cardFactory(options = {}) {
    const wa = waControl('card', {});
    if (wa) {
        wa.className = 'vcp-ui-card vcp-ui-wa-card';
        if (options.interactive) {
            wa.setAttribute('role', 'button');
            wa.tabIndex = 0;
        }
        const state = { title: '', description: '', variant: options.interactive ? 'interactive' : 'default', ...options };
        return makeController(wa, state, current => {
            wa.dataset.variant = normalize(current.variant, ['default', 'outlined', 'interactive', 'selected'], 'default', 'variant');
            wa.appearance = wa.dataset.variant === 'outlined' ? 'outlined' : 'filled';
            if (current.interactive || options.interactive) wa.setAttribute('aria-pressed', String(wa.dataset.variant === 'selected'));
            wa.replaceChildren();
            const body = document.createElement('div');
            body.className = 'vcp-ui-card-body';
            if (current.title) {
                const title = document.createElement('strong');
                title.className = 'vcp-ui-card-title';
                title.textContent = current.title;
                body.append(title);
            }
            if (current.description) {
                const description = document.createElement('span');
                description.className = 'vcp-ui-card-description';
                description.textContent = current.description;
                body.append(description);
            }
            if (current.content) appendContent(body, current.content);
            wa.append(body);
        });
    }
    const element = document.createElement(options.interactive ? 'button' : 'section');
    if (element instanceof HTMLButtonElement) element.type = 'button';
    element.className = 'vcp-ui-card';
    const state = { title: '', description: '', variant: options.interactive ? 'interactive' : 'default', ...options };
    return makeController(element, state, current => {
        element.dataset.variant = normalize(current.variant, ['default', 'outlined', 'interactive', 'selected'], 'default', 'variant');
        element.setAttribute('aria-pressed', String(element.dataset.variant === 'selected'));
        element.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = current.title;
        const description = document.createElement('span');
        description.textContent = current.description;
        element.append(title, description);
        if (current.content) appendContent(element, current.content);
    });
}

function tabsFactory(options = {}) {
    const wa = waControl('tab-group', {});
    if (wa) {
        const state = { items: [], value: '', ...options };
        const controller = makeController(wa, state, current => {
            if (!current.value && current.items[0]) current.value = current.items[0].value;
            wa.replaceChildren();
            (current.items || []).forEach(item => {
                const tab = document.createElement('wa-tab');
                tab.setAttribute('panel', item.value);
                if (item.disabled) tab.setAttribute('disabled', '');
                tab.textContent = item.label;
                wa.append(tab);
                const panel = document.createElement('wa-tab-panel');
                panel.setAttribute('name', item.value);
                wa.append(panel);
            });
            if (current.value) wa.active = String(current.value);
        });
        controller._listen(wa, 'wa-tab-show', event => {
            if (event.target !== wa) return;
            if (event.detail?.name !== undefined) state.value = event.detail.name;
            emit(wa, 'change');
        });
        return controller;
    }
    const element = document.createElement('div');
    element.className = 'vcp-ui-tabs';
    element.setAttribute('role', 'tablist');
    const state = { items: [], value: '', ...options };
    let controller;
    controller = makeController(element, state, current => {
        element.replaceChildren();
        if (!current.value && current.items[0]) current.value = current.items[0].value;
        current.items.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vcp-ui-tab';
            button.setAttribute('role', 'tab');
            button.dataset.value = item.value;
            button.disabled = Boolean(item.disabled);
            button.setAttribute('aria-selected', String(item.value === current.value));
            button.tabIndex = item.value === current.value ? 0 : -1;
            button.textContent = item.label;
            button.addEventListener('click', () => {
                state.value = item.value;
                controller.update();
                emit(element, 'change');
            });
            element.append(button);
        });
    });
    controller._listen(element, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...element.querySelectorAll('[role="tab"]:not(:disabled)')];
        const current = tabs.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click();
        tabs[next].focus();
    });
    return controller;
}

function toolbarFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-toolbar';
    element.setAttribute('role', 'toolbar');
    const state = { start: [], end: [], label: '工具栏', ...options };
    return makeController(element, state, current => {
        element.setAttribute('aria-label', current.label);
        const start = document.createElement('div');
        const end = document.createElement('div');
        start.className = 'vcp-ui-toolbar-group';
        end.className = 'vcp-ui-toolbar-group is-end';
        const add = (host, item) => {
            if (item === 'separator') {
                const separator = document.createElement('span');
                separator.className = 'vcp-ui-toolbar-separator';
                separator.setAttribute('role', 'separator');
                host.append(separator);
            } else host.append(item.element || item);
        };
        current.start.forEach(item => add(start, item));
        current.end.forEach(item => add(end, item));
        element.replaceChildren(start, end);
    });
}

function listFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-list';
    element.setAttribute('role', 'list');
    const state = { items: [], ...options };
    return makeController(element, state, current => {
        element.replaceChildren();
        current.items.forEach(item => {
            const row = document.createElement(item.interactive === false ? 'div' : 'button');
            if (row instanceof HTMLButtonElement) row.type = 'button';
            row.className = 'vcp-ui-list-item';
            row.setAttribute('role', 'listitem');
            if (item.value !== undefined) row.dataset.value = String(item.value);
            row.disabled = Boolean(item.disabled);
            row.dataset.state = item.selected ? 'selected' : 'default';
            if (item.icon) row.append(icon(item.icon));
            const copy = document.createElement('span');
            copy.className = 'vcp-ui-list-copy';
            const primary = document.createElement('strong');
            primary.textContent = item.label;
            copy.append(primary);
            if (item.description) {
                const secondary = document.createElement('span');
                secondary.textContent = item.description;
                copy.append(secondary);
            }
            row.append(copy);
            if (item.trailing) {
                const trailing = document.createElement('span');
                trailing.className = 'vcp-ui-list-trailing';
                trailing.textContent = item.trailing;
                row.append(trailing);
            }
            item.onClick && row.addEventListener('click', item.onClick);
            element.append(row);
        });
    });
}

function tableFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-table-frame';
    const state = { columns: [], rows: [], loading: false, empty: '暂无数据', ...options };
    return makeController(element, state, current => {
        if (current.loading) {
            element.replaceChildren(icon('progress_activity', 'vcp-ui-spinner'), document.createTextNode(' 正在加载'));
            element.dataset.state = 'loading';
            return;
        }
        if (!current.rows.length) {
            element.textContent = current.empty;
            element.dataset.state = 'empty';
            return;
        }
        element.dataset.state = 'ready';
        const table = document.createElement('table');
        const head = table.createTHead().insertRow();
        current.columns.forEach(column => {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = column.label;
            head.append(cell);
        });
        const body = table.createTBody();
        current.rows.forEach(row => {
            const tr = body.insertRow();
            current.columns.forEach(column => {
                const cell = tr.insertCell();
                cell.textContent = row[column.key] ?? '';
            });
        });
        element.replaceChildren(table);
    });
}

function emptyStateFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-empty-state';
    const state = { icon: 'inbox', title: '暂无内容', description: '', actions: [], ...options };
    return makeController(element, state, current => {
        element.replaceChildren(icon(current.icon, 'vcp-ui-empty-state-icon'));
        const title = document.createElement('strong');
        title.textContent = current.title;
        const description = document.createElement('p');
        description.textContent = current.description;
        const actions = document.createElement('div');
        actions.className = 'vcp-ui-empty-state-actions';
        current.actions.forEach(action => actions.append(action.element || action));
        element.append(title, description, actions);
    });
}

function dividerFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-divider';
    element.setAttribute('role', 'separator');
    const state = { label: '', orientation: 'horizontal', ...options };
    return makeController(element, state, current => {
        element.dataset.orientation = normalize(current.orientation, ['horizontal', 'vertical'], 'horizontal', 'orientation');
        element.setAttribute('aria-orientation', element.dataset.orientation);
        element.replaceChildren();
        if (current.label) {
            const label = document.createElement('span');
            label.textContent = current.label;
            element.append(label);
        }
    });
}

function tooltipFactory(options = {}) {
    const trigger = options.trigger?.element || options.trigger;
    const wa = waControl('tooltip');
    if (wa && trigger) {
        if (!trigger.id) trigger.id = `vcp-ui-wa-tip-${crypto.randomUUID()}`;
        wa.setAttribute('for', trigger.id);
        const state = { content: '', placement: 'top', open: false, ...options };
        return makeController(wa, state, current => {
            wa.setAttribute('placement', normalize(current.placement, ['top', 'right', 'bottom', 'left'], 'top', 'placement'));
            wa.textContent = current.content;
        });
    }
    const element = document.createElement('span');
    element.className = 'vcp-ui-tooltip';
    const bubble = document.createElement('span');
    bubble.className = 'vcp-ui-tooltip-bubble';
    bubble.id = `vcp-ui-tooltip-${crypto.randomUUID()}`;
    bubble.setAttribute('role', 'tooltip');
    const state = { content: '', placement: 'top', open: false, ...options };
    let triggerNode = null;
    let controller;
    controller = makeController(element, state, (current, records) => {
        element.dataset.placement = normalize(current.placement, ['top', 'right', 'bottom', 'left'], 'top', 'placement');
        element.dataset.state = current.open ? 'open' : 'closed';
        const nextTrigger = current.trigger?.element || current.trigger;
        if (nextTrigger && triggerNode !== nextTrigger) {
            triggerNode = nextTrigger;
            triggerNode.setAttribute('aria-describedby', bubble.id);
            listen(records, triggerNode, 'mouseenter', () => controller.update({ open: true }));
            listen(records, triggerNode, 'mouseleave', () => controller.update({ open: false }));
            listen(records, triggerNode, 'focus', () => controller.update({ open: true }));
            listen(records, triggerNode, 'blur', () => controller.update({ open: false }));
        }
        bubble.textContent = current.content;
        if (element.firstChild !== triggerNode || element.lastChild !== bubble) element.replaceChildren(triggerNode, bubble);
    }, () => triggerNode?.removeAttribute('aria-describedby'));
    return controller;
}

function skeletonFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-skeleton';
    element.setAttribute('aria-hidden', 'true');
    const state = { variant: 'text', lines: 1, size: 'md', ...options };
    return makeController(element, state, current => {
        element.dataset.variant = normalize(current.variant, ['text', 'rect', 'circle'], 'text', 'variant');
        element.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
        element.replaceChildren();
        const count = element.dataset.variant === 'text' ? Math.max(1, Math.min(6, Number(current.lines) || 1)) : 1;
        for (let index = 0; index < count; index += 1) {
            const line = document.createElement('span');
            line.className = 'vcp-ui-skeleton-line';
            element.append(line);
        }
    });
}

function segmentedControlFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-segmented';
    element.setAttribute('role', 'radiogroup');
    const state = { items: [], value: '', size: 'md', label: '选项', ...options };
    let controller;
    controller = makeController(element, state, current => {
        element.dataset.size = normalize(current.size, ['sm', 'md'], 'md', 'size');
        element.setAttribute('aria-label', current.label);
        if (!current.value && current.items[0]) current.value = current.items[0].value;
        element.replaceChildren();
        current.items.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'radio');
            button.dataset.value = item.value;
            button.disabled = Boolean(item.disabled);
            button.setAttribute('aria-checked', String(item.value === current.value));
            button.tabIndex = item.value === current.value ? 0 : -1;
            if (item.icon) button.append(icon(item.icon));
            const label = document.createElement('span');
            label.textContent = item.label;
            button.append(label);
            button.addEventListener('click', () => {
                state.value = item.value;
                controller.update();
                emit(element, 'change');
            });
            element.append(button);
        });
    });
    controller._listen(element, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const items = [...element.querySelectorAll('[role="radio"]:not(:disabled)')];
        const current = items.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        items[next].click();
        items[next].focus();
    });
    return controller;
}

function paginationFactory(options = {}) {
    const element = document.createElement('nav');
    element.className = 'vcp-ui-pagination';
    element.setAttribute('aria-label', options.label || '分页');
    const state = { page: 1, total: 0, pageSize: 10, maxButtons: 5, ...options };
    let controller;
    controller = makeController(element, state, current => {
        const pageCount = Math.max(1, Math.ceil(current.total / current.pageSize));
        current.page = Math.min(pageCount, Math.max(1, Number(current.page) || 1));
        const maxButtons = Math.max(3, Number(current.maxButtons) || 5);
        const half = Math.floor(maxButtons / 2);
        let start = Math.max(1, current.page - half);
        const end = Math.min(pageCount, start + maxButtons - 1);
        start = Math.max(1, end - maxButtons + 1);
        element.replaceChildren();
        const addButton = (label, page, disabled, ariaLabel = label) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.disabled = disabled;
            button.setAttribute('aria-label', ariaLabel);
            button.setAttribute('aria-current', page === current.page && !disabled ? 'page' : 'false');
            button.textContent = label;
            button.addEventListener('click', () => {
                state.page = page;
                controller.update();
                emit(element, 'change');
            });
            element.append(button);
        };
        addButton('chevron_left', current.page - 1, current.page === 1, '上一页');
        element.lastChild.classList.add('vcp-ui-icon');
        for (let page = start; page <= end; page += 1) addButton(String(page), page, false, `第 ${page} 页`);
        addButton('chevron_right', current.page + 1, current.page === pageCount, '下一页');
        element.lastChild.classList.add('vcp-ui-icon');
    });
    return controller;
}

function scrollAreaFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-scroll-area';
    const viewport = document.createElement('div');
    viewport.className = 'vcp-ui-scroll-area-viewport';
    viewport.tabIndex = options.tabIndex ?? 0;
    const fade = document.createElement('div');
    fade.className = 'vcp-ui-scroll-area-fade';
    fade.setAttribute('aria-hidden', 'true');
    element.append(viewport, fade);
    const state = { content: '', size: 'md', label: '可滚动内容', ...options };
    const sync = () => {
        const scrollable = viewport.scrollHeight > viewport.clientHeight + 1;
        const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
        element.dataset.scrollable = String(scrollable);
        element.dataset.atBottom = String(atBottom);
    };
    let observer;
    const controller = makeController(element, state, current => {
        element.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
        viewport.setAttribute('aria-label', current.label);
        if (current.content !== undefined && viewport.firstChild !== current.content) appendContent(viewport, current.content);
        queueMicrotask(sync);
    }, () => observer?.disconnect());
    controller._listen(viewport, 'scroll', sync, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(sync);
        observer.observe(viewport);
    }
    controller.scrollToTop = () => viewport.scrollTo({ top: 0, behavior: 'smooth' });
    controller.scrollToBottom = () => viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    return controller;
}

function focusable(dialog) {
    return [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
}

function modalFactory(options = {}) {
    // Complex application dialogs may opt into the deterministic native DOM
    // shell. This still uses the VCPUI Modal contract, but avoids custom
    // element upgrade/hide-animation races for surfaces that own cancellable
    // IPC work or native WebContentsView visibility leases.
    const wa = options.native === true ? null : waControl('dialog', {});
    if (wa) {
        wa.className = 'vcp-ui-wa-dialog';
        const previousFocus = document.activeElement;
        const state = {
            title: 'Dialog', size: 'md', content: '', actions: [],
            closeOnBackdrop: true, dismissible: true, ...options
        };
        let controller;
        let finalized = false;
        let programmaticClose = false;
        const finalize = result => {
            if (finalized) return false;
            finalized = true;
            state.onClose?.(result);
            return true;
        };
        const close = result => {
            if (finalized) return;
            programmaticClose = true;
            finalize(result);
            wa.open = false;
        };
        controller = makeController(wa, state, current => {
            wa.setAttribute('label', current.title);
            wa.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
            // WA's target-only light-dismiss check can confuse dialog surface
            // whitespace with the backdrop after a top-layer Select opens.
            // VCPUI owns the stricter geometry-based dismissal contract below.
            wa.lightDismiss = false;
            wa.removeAttribute('light-dismiss');
            wa.replaceChildren();
            const body = document.createElement('div');
            body.className = 'vcp-ui-modal-body';
            appendContent(body, current.content);
            wa.append(body);
            const footer = document.createElement('div');
            footer.setAttribute('slot', 'footer');
            footer.className = 'vcp-ui-modal-actions';
            (current.actions || []).forEach(action => footer.append(action.element || action));
            wa.append(footer);
            let frames = 0;
            const ensureOpen = () => {
                if (wa.isConnected) {
                    // Establish the declared initial focus before showModal's
                    // native autofocus algorithm and WA's follow-up frame run.
                    // All three paths then retain the same focus owner.
                    const initialFocus = wa.querySelector('[autofocus]');
                    Promise.resolve(initialFocus?.updateComplete).then(() => {
                        if (!wa.isConnected) return;
                        initialFocus?.focus();
                        wa.open = true;
                    });
                    return;
                }
                if (frames++ < 60) nextFrame(ensureOpen);
            };
            queueMicrotask(ensureOpen);
        });
        controller.close = close;
        controller._listen(wa, 'pointerdown', event => {
            if (!state.closeOnBackdrop || !state.dismissible) return;
            // A Select listbox is rendered outside the dialog box by wa-popup.
            // Its pointerdown precedes the option's mouseup selection. Treat
            // the entire interaction as owned by the open Select, even when
            // top-layer retargeting removes wa-select from composedPath().
            if ([...wa.querySelectorAll('wa-select')].some(select => select.open)) return;
            const path = event.composedPath?.() || [];
            if (path.some(node => node?.localName === 'wa-select' || node?.localName === 'wa-option')) return;
            const dialog = wa.shadowRoot?.querySelector('[part~="dialog"]');
            const rect = dialog?.getBoundingClientRect();
            if (!rect) return;
            const outside = event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom;
            if (outside) close(null);
        });
        controller._listen(wa, 'wa-hide', event => {
            // WA lifecycle events bubble. A nested Select closing its listbox
            // must not be mistaken for the owning Dialog closing.
            if (event.target !== wa) return;
            if (!state.dismissible && !programmaticClose) {
                event.preventDefault();
                return;
            }
            finalize(null);
        });
        controller._listen(wa, 'wa-after-hide', event => {
            if (event.target !== wa) return;
            // Defensive fallback for runtimes that omit the cancellable hide
            // event. All user and programmatic close paths share one finalizer.
            finalize(null);
            controller.destroy();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        });
        return controller;
    }
    const overlay = document.createElement('div');
    overlay.className = 'vcp-ui-modal-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'vcp-ui-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const titleId = options.titleId || `vcpUiModalTitle-${Math.random().toString(36).slice(2)}`;
    dialog.setAttribute('aria-labelledby', titleId);
    overlay.append(dialog);
    const previousFocus = document.activeElement;
    const state = {
        title: 'Dialog', size: 'md', content: '', actions: [],
        closeOnBackdrop: true, dismissible: true, ...options
    };
    let controller;
    let finalized = false;
    const close = result => {
        if (finalized) return;
        finalized = true;
        state.onClose?.(result);
        controller.destroy();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
    controller = makeController(overlay, state, (current, records) => {
        dialog.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
        dialog.replaceChildren();
        const header = document.createElement('header');
        const title = document.createElement('h2');
        title.id = titleId;
        title.textContent = current.title;
        const closeButton = options.native === true
            ? (() => {
                const element = document.createElement('button');
                element.type = 'button';
                element.className = 'vcp-ui-icon-button';
                element.setAttribute('aria-label', '关闭对话框');
                element.title = '关闭对话框';
                element.append(icon('close'));
                return { element, destroy: () => element.remove() };
            })()
            : iconButtonFactory({ icon: 'close', label: '关闭对话框', size: 'sm' });
        const closeFromButton = () => close(null);
        closeButton.element.disabled = !current.dismissible;
        closeButton.element.setAttribute('aria-disabled', String(!current.dismissible));
        closeButton.element.addEventListener('click', closeFromButton, { once: true });
        records.push(() => {
            closeButton.element?.removeEventListener('click', closeFromButton);
            closeButton.destroy();
        });
        header.append(title, closeButton.element);
        const body = document.createElement('div');
        body.className = 'vcp-ui-modal-body';
        appendContent(body, current.content);
        const footer = document.createElement('footer');
        current.actions.forEach(action => footer.append(action.element || action));
        dialog.append(header, body, footer);
    });
    controller.close = close;
    controller._listen(overlay, 'mousedown', event => {
        if (event.target === overlay && state.closeOnBackdrop && state.dismissible) close(null);
    });
    controller._listen(document, 'keydown', event => {
        if (event.key !== 'Escape' || !overlay.isConnected || !state.dismissible) return;
        const openOverlays = [...document.querySelectorAll('.vcp-ui-modal-overlay')]
            .filter(candidate => candidate.isConnected);
        if (openOverlays.at(-1) !== overlay) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
    }, true);
    controller._listen(overlay, 'keydown', event => {
        if (event.key !== 'Tab') return;
        const items = focusable(dialog);
        if (!items.length) return;
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    queueMicrotask(() => controller.focus());
    return controller;
}

function toastFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-toast';
    element.setAttribute('role', 'status');
    const state = { message: '', variant: 'info', dismissible: true, ...options };
    let controller;
    controller = makeController(element, state, current => {
        element.dataset.variant = normalize(current.variant, ['info', 'success', 'warning', 'error'], 'info', 'variant');
        element.replaceChildren(icon({ info: 'info', success: 'check_circle', warning: 'warning', error: 'error' }[element.dataset.variant]));
        const message = document.createElement('span');
        message.textContent = current.message;
        element.append(message);
        if (current.dismissible) {
            const close = iconButtonFactory({ icon: 'close', label: '关闭通知', size: 'sm' });
            close.element.addEventListener('click', () => controller.destroy(), { once: true });
            element.append(close.element);
        }
    });
    controller._listen(element, 'click', () => controller.destroy());
    return controller;
}

function confirmFactory(options = {}) {
    const content = document.createElement('p');
    content.className = 'vcp-ui-dialog-copy';
    content.textContent = options.message || '确定继续吗？';
    let modal;
    const cancel = buttonFactory({ label: options.cancelLabel || '取消', variant: 'ghost' });
    const confirm = buttonFactory({ label: options.confirmLabel || '确认', variant: options.danger ? 'danger' : 'primary' });
    modal = modalFactory({ ...options, content, actions: [cancel, confirm] });
    cancel.element.addEventListener('click', () => modal.close(false));
    confirm.element.addEventListener('click', () => modal.close(true));
    return modal;
}

function inputDialogFactory(options = {}) {
    const form = document.createElement('form');
    form.className = 'vcp-ui-dialog-form';
    const control = options.multiline
        ? textControlFactory('textarea', { value: options.value, placeholder: options.placeholder, rows: options.rows || 4 })
        : textControlFactory('input', { value: options.value, placeholder: options.placeholder });
    const error = document.createElement('div');
    error.className = 'vcp-ui-dialog-error';
    form.append(control.element, error);
    let modal;
    const cancel = buttonFactory({ label: options.cancelLabel || '取消', variant: 'ghost' });
    const submit = buttonFactory({ label: options.confirmLabel || '确认', variant: 'primary', type: 'submit' });
    modal = modalFactory({ ...options, content: form, actions: [cancel, submit] });
    const native = control.element.querySelector('input, textarea');
    const validate = () => {
        const value = native.value.trim();
        const message = options.required && !value ? '此项不能为空' : options.validate?.(value);
        error.textContent = message || '';
        native.setAttribute('aria-invalid', String(Boolean(message)));
        return message ? null : value;
    };
    cancel.element.addEventListener('click', () => modal.close(null));
    form.addEventListener('submit', event => {
        event.preventDefault();
        const value = validate();
        if (value !== null) modal.close(value);
    });
    return modal;
}

function windowControlsFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-window-controls';
    element.setAttribute('role', 'toolbar');
    element.setAttribute('aria-label', '窗口控制');
    const state = {
        pinned: false,
        onPin: null,
        onMinimize: null,
        onMaximize: null,
        onClose: null,
        extensions: [],
        ...options
    };

    // 同步能力判定（0 CLS 关键）：若环境存在同步 canPin() 且为 false，或用户显式配置 pin: false，则首帧即可确定不展示置顶
    // 仅在 Windows 且为非嵌入式独立窗口时，canPin 同步返回 true
    const isPinCapable = options.pin !== false && typeof window !== 'undefined' && Boolean(
        typeof window.utilityAPI?.canPin === 'function'
            ? window.utilityAPI.canPin()
            : window.utilityAPI?.togglePinWindow
    );

    let pin = null;
    let unlistenPinned = null;

    if (isPinCapable) {
        pin = iconButtonFactory({
            icon: 'push_pin',
            label: '置顶窗口',
            size: 'sm',
            variant: 'ghost'
        });
        pin.element.classList.add('vcp-ui-window-control-button', 'vcp-ui-window-control-pin');
    }

    const minimize = iconButtonFactory({ icon: 'remove', label: '最小化窗口', size: 'sm', variant: 'ghost' });
    const maximize = iconButtonFactory({ icon: 'crop_square', label: '最大化窗口', size: 'sm', variant: 'ghost' });
    const close = iconButtonFactory({ icon: 'close', label: '关闭窗口', size: 'sm', variant: 'ghost' });
    close.element.classList.add('vcp-ui-window-control-button', 'vcp-ui-window-control-close');

    [minimize.element, maximize.element].forEach(button => {
        button.classList.add('vcp-ui-window-control-button');
    });

    const controller = makeController(element, state, current => {
        const extensions = Array.isArray(current.extensions) ? current.extensions : [];
        const buttons = [];
        if (pin) {
            pin.element.classList.toggle('is-pinned', Boolean(current.pinned));
            pin.element.setAttribute('aria-pressed', String(Boolean(current.pinned)));
            pin.element.title = current.pinned ? '取消置顶' : '置顶窗口';
            pin.element.setAttribute('aria-label', current.pinned ? '取消置顶' : '置顶窗口');
            buttons.push(pin.element);
        }
        buttons.push(...extensions, minimize.element, maximize.element, close.element);
        element.replaceChildren(...buttons);
    }, () => {
        if (typeof unlistenPinned === 'function') {
            unlistenPinned();
            unlistenPinned = null;
        }
    });

    // 单向事件驱动与防连击：状态由主进程 onWindowPinnedChanged 驱动
    if (pin) {
        let isToggling = false;
        controller._listen(pin.element, 'click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof state.onPin === 'function') {
                state.onPin();
                return;
            }
            if (isToggling) return;
            isToggling = true;
            try {
                await window.utilityAPI?.togglePinWindow?.();
            } catch (err) {
                console.warn('[VCPUI][WindowControls] togglePinWindow failed:', err);
            } finally {
                setTimeout(() => { isToggling = false; }, 150);
            }
        });

        if (typeof window.utilityAPI?.onWindowPinnedChanged === 'function') {
            unlistenPinned = window.utilityAPI.onWindowPinnedChanged(isPinned => {
                if (!controller.destroyed) controller.update({ pinned: Boolean(isPinned) });
            });
        }

        window.utilityAPI?.isWindowPinned?.().then(isPinned => {
            if (!controller.destroyed && Boolean(isPinned) !== controller.element.querySelector('.vcp-ui-window-control-pin')?.classList.contains('is-pinned')) {
                controller.update({ pinned: Boolean(isPinned) });
            }
        }).catch(() => {});
    }

    minimize.element.addEventListener('click', () => {
        if (typeof state.onMinimize === 'function') state.onMinimize();
        else window.utilityAPI?.minimizeWindow?.();
    });
    maximize.element.addEventListener('click', () => {
        if (typeof state.onMaximize === 'function') state.onMaximize();
        else window.utilityAPI?.maximizeWindow?.();
    });
    close.element.addEventListener('click', () => {
        if (typeof state.onClose === 'function') state.onClose();
        else window.utilityAPI?.closeWindow?.();
    });
    return controller;
}
function appPageShellFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-page-shell vcp-ui-scope';
    const header = document.createElement('header');
    header.className = 'vcp-ui-page-shell-header';
    const title = document.createElement('h1');
    title.className = 'vcp-ui-page-shell-title';
    const actions = document.createElement('div');
    actions.className = 'vcp-ui-page-shell-actions';
    const content = document.createElement('div');
    content.className = 'vcp-ui-page-shell-content';
    header.append(title, actions);
    element.append(header, content);
    const embeddedDefault = document.documentElement.dataset.vcpEmbeddedApp === 'true'
        || new URLSearchParams(window.location.search).has('vcpEmbedded');
    const state = { title: '', actions: [], content: '', embedded: embeddedDefault, windowControls: true, onMinimize: null, onMaximize: null, onClose: null, ...options };
    let windowControls;
    const controller = makeController(element, state, current => {
        element.dataset.embedded = String(Boolean(current.embedded));
        if (current.title instanceof Node) appendContent(title, current.title);
        else title.textContent = current.title || '';
        actions.replaceChildren();
        (current.actions || []).forEach(action => actions.append(action.element || action));
        if (current.content !== undefined) appendContent(content, current.content);
        // Guard on the header's actual children, not element.isConnected:
        // before the shell is mounted isConnected is false and repeated
        // update() calls would stack duplicate WindowControls sets.
        const hasWindowControls = Boolean(header.querySelector('.vcp-ui-window-controls'));
        if (!current.embedded && current.windowControls && !hasWindowControls) {
            windowControls = windowControlsFactory({
                onMinimize: current.onMinimize,
                onMaximize: current.onMaximize,
                onClose: current.onClose,
            });
            header.append(windowControls.element);
        } else if (current.embedded && hasWindowControls) {
            windowControls?.destroy();
            windowControls = null;
        }
    }, () => windowControls?.destroy());
    return controller;
}

function asyncBoundaryFactory(options = {}) {
    const element = document.createElement('div');
    element.className = 'vcp-ui-async-boundary';
    const state = { status: 'idle', content: '', error: '', empty: '', emptyIcon: 'inbox', emptyDescription: '', loadingLines: 3, retryLabel: '重试', onRetry: null, ...options };
    const controller = makeController(element, state, current => {
        element.dataset.status = current.status;
        element.replaceChildren();
        if (current.status === 'loading') {
            const skeleton = skeletonFactory({ variant: 'text', lines: current.loadingLines });
            element.append(skeleton.element);
        } else if (current.status === 'error') {
            const alert = alertFactory({ title: '加载失败', message: current.error || '发生错误', variant: 'danger' });
            const retry = buttonFactory({ label: current.retryLabel, variant: 'secondary', icon: 'refresh' });
            retry.element.addEventListener('click', () => current.onRetry?.());
            element.append(alert.element, retry.element);
        } else if (current.status === 'empty') {
            const empty = emptyStateFactory({ icon: current.emptyIcon, title: current.empty || '暂无数据', description: current.emptyDescription });
            element.append(empty.element);
        } else if (current.content !== undefined && current.content !== null) {
            appendContent(element, current.content);
        }
    });
    return controller;
}

[
    ['Button', buttonFactory], ['IconButton', iconButtonFactory],
    ['Input', options => textControlFactory('input', options)],
    ['Textarea', options => textControlFactory('textarea', options)],
    ['Select', selectFactory], ['Range', rangeFactory], ['Checkbox', checkboxFactory], ['Switch', switchFactory],
    ['Field', fieldFactory], ['Badge', badgeFactory], ['Alert', alertFactory], ['Card', cardFactory],
    ['SettingsSection', settingsSectionFactory], ['SettingsActionBar', settingsActionBarFactory],
    ['Tabs', tabsFactory], ['Toolbar', toolbarFactory], ['List', listFactory], ['ListItem', listFactory],
    ['TableFrame', tableFactory], ['EmptyState', emptyStateFactory], ['Divider', dividerFactory],
    ['Tooltip', tooltipFactory], ['Skeleton', skeletonFactory], ['SegmentedControl', segmentedControlFactory],
    ['Pagination', paginationFactory], ['ScrollArea', scrollAreaFactory], ['Modal', modalFactory],
    ['Toast', toastFactory], ['ConfirmDialog', confirmFactory], ['InputDialog', inputDialogFactory],
    ['AppPageShell', appPageShellFactory], ['WindowControls', windowControlsFactory],
    ['AsyncBoundary', asyncBoundaryFactory]
].forEach(([name, factory]) => COMPONENTS.set(name.toLowerCase(), factory));

ENHANCERS.set('input', (element, options) => nativeControlEnhancer(element, 'input', options));
ENHANCERS.set('textarea', (element, options) => nativeControlEnhancer(element, 'textarea', options));
ENHANCERS.set('select', selectEnhancer);
ENHANCERS.set('range', (element, options) => rangeEnhancer(element, options));
ENHANCERS.set('switch', nativeSwitchEnhancer);
ENHANCERS.set('field', fieldEnhancer);
ENHANCERS.set('settingssection', settingsSectionEnhancer);
ENHANCERS.set('settingsactionbar', settingsActionBarEnhancer);

let feedbackHost;
let activeDialog = null;
const dialogQueue = [];
const toastTimers = new Map();
const loadingTokens = new Map();
const feedbackOwners = new Set();
const rootFeedbackOwner = createFeedbackOwnerRecord('root');
let loadingSequence = 0;

function createFeedbackOwnerRecord(label) {
    return {
        label: String(label || 'feedback-owner'),
        active: true,
        dialogs: new Set(),
        toasts: new Set(),
        loading: [],
    };
}

function ensureFeedbackHost() {
    if (feedbackHost?.isConnected) return feedbackHost;
    feedbackHost = document.createElement('div');
    feedbackHost.className = 'vcp-ui-feedback-host vcp-ui-scope';

    const loadingLayer = document.createElement('div');
    loadingLayer.className = 'vcp-ui-loading-layer';
    loadingLayer.hidden = true;

    const spinner = document.createElement('span');
    spinner.className = 'vcp-ui-icon vcp-ui-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.textContent = 'progress_activity';

    const loadingLabel = document.createElement('span');
    loadingLabel.className = 'vcp-ui-loading-label';
    loadingLabel.textContent = '正在处理';

    loadingLayer.append(spinner, loadingLabel);

    const toastStack = document.createElement('div');
    toastStack.className = 'vcp-ui-toast-stack';

    const dialogHost = document.createElement('div');
    dialogHost.className = 'vcp-ui-dialog-host';

    feedbackHost.append(loadingLayer, toastStack, dialogHost);
    document.body.append(feedbackHost);
    return feedbackHost;
}

function runDialog(factory, owner = rootFeedbackOwner) {
    if (!owner.active) return Promise.resolve(null);
    return new Promise(resolve => {
        const item = { factory, owner, settled: false, resolve };
        owner.dialogs.add(item);
        dialogQueue.push(item);
        processDialogQueue();
    });
}

function settleDialog(item, result) {
    if (!item || item.settled) return;
    item.settled = true;
    item.owner.dialogs.delete(item);
    item.resolve(result);
}

function processDialogQueue() {
    if (activeDialog || !dialogQueue.length) return;
    const item = dialogQueue.shift();
    if (!item.owner.active) {
        settleDialog(item, null);
        processDialogQueue();
        return;
    }
    const dialog = item.factory(result => {
        if (activeDialog?.item === item) activeDialog = null;
        settleDialog(item, result);
        processDialogQueue();
    });
    activeDialog = { controller: dialog, item };
    ensureFeedbackHost().querySelector('.vcp-ui-dialog-host').append(dialog.element);
}

function removeToast(owner, controller) {
    owner.toasts.delete(controller);
    const timer = toastTimers.get(controller);
    if (timer !== undefined) clearTimeout(timer);
    toastTimers.delete(controller);
}

function createOwnedToast(owner, message, options = {}) {
    if (!owner.active) return null;
    const text = String(message ?? '');
    const stack = ensureFeedbackHost().querySelector('.vcp-ui-toast-stack');
    if (stack && text) {
        const existing = [...owner.toasts].find(t => t.element?.textContent?.includes(text));
        if (existing) {
            const timer = toastTimers.get(existing);
            if (timer !== undefined) clearTimeout(timer);
            const duration = options.duration ?? 4200;
            if (duration > 0) {
                toastTimers.set(existing, setTimeout(() => existing.destroy(), duration));
            }
            return existing;
        }
    }
    const controller = toastFactory({ ...options, message });
    const originalDestroy = controller.destroy.bind(controller);
    controller.destroy = () => {
        removeToast(owner, controller);
        return originalDestroy();
    };
    owner.toasts.add(controller);
    ensureFeedbackHost().querySelector('.vcp-ui-toast-stack').append(controller.element);
    const duration = options.duration ?? 4200;
    if (duration > 0) {
        const timer = setTimeout(() => controller.destroy(), duration);
        toastTimers.set(controller, timer);
    }
    return controller;
}

function updateLoadingLayer() {
    const host = loadingTokens.size ? ensureFeedbackHost() : feedbackHost;
    const layer = host?.querySelector('.vcp-ui-loading-layer');
    if (!layer) return loadingTokens.size;
    layer.hidden = loadingTokens.size === 0;
    if (loadingTokens.size) {
        const latest = [...loadingTokens.values()].reduce((current, candidate) => (
            !current || candidate.sequence > current.sequence ? candidate : current
        ), null);
        layer.querySelector('.vcp-ui-loading-label').textContent = latest?.label || '正在处理';
    }
    return loadingTokens.size;
}

function setOwnedLoading(owner, visible, label = '正在处理') {
    if (visible) {
        if (!owner.active) return loadingTokens.size;
        const token = Symbol(owner.label);
        owner.loading.push(token);
        loadingTokens.set(token, { owner, label: String(label || '正在处理'), sequence: ++loadingSequence });
    } else {
        const token = owner.loading.pop();
        if (token) loadingTokens.delete(token);
    }
    return updateLoadingLayer();
}

async function disposeFeedbackOwner(owner) {
    if (!owner.active) return;
    owner.active = false;
    feedbackOwners.delete(owner);
    const queued = dialogQueue.filter(item => item.owner === owner);
    queued.forEach(item => {
        const index = dialogQueue.indexOf(item);
        if (index >= 0) dialogQueue.splice(index, 1);
        settleDialog(item, null);
    });
    if (activeDialog?.item.owner === owner) activeDialog.controller.close(null);
    [...owner.toasts].forEach(controller => controller.destroy());
    owner.loading.splice(0).forEach(token => loadingTokens.delete(token));
    updateLoadingLayer();
    processDialogQueue();
}

function createFeedbackHandle(scope) {
    const label = scope?.label ? `feedback:${scope.label}` : 'feedback-owner';
    const owner = createFeedbackOwnerRecord(label);
    feedbackOwners.add(owner);
    let disposePromise = null;
    const handle = Object.freeze({
        toast: (message, options = {}) => createOwnedToast(owner, message, options),
        confirm: (options = {}) => runDialog(onClose => confirmFactory({ title: '请确认', ...options, onClose }), owner),
        prompt: (options = {}) => runDialog(onClose => inputDialogFactory({ title: '请输入', ...options, onClose }), owner),
        setLoading: (visible, label = '正在处理') => setOwnedLoading(owner, visible, label),
        dispose() {
            if (!disposePromise) disposePromise = disposeFeedbackOwner(owner);
            return disposePromise;
        },
        get disposed() { return !owner.active; }
    });
    if (scope?.own) {
        try {
            scope.own(() => handle.dispose(), label, 'feedback-owner');
        } catch (error) {
            void handle.dispose();
            throw error;
        }
    }
    return handle;
}

const feedback = Object.freeze({
    owner(scope) {
        return createFeedbackHandle(scope);
    },
    toast(message, options = {}) {
        return createOwnedToast(rootFeedbackOwner, message, options);
    },
    confirm(options = {}) {
        return runDialog(onClose => confirmFactory({ title: '请确认', ...options, onClose }));
    },
    prompt(options = {}) {
        return runDialog(onClose => inputDialogFactory({ title: '请输入', ...options, onClose }));
    },
    setLoading(visible, label = '正在处理') {
        return setOwnedLoading(rootFeedbackOwner, visible, label);
    },
    cancelAll() {
        const queued = dialogQueue.splice(0);
        queued.forEach(item => settleDialog(item, null));
        [...feedbackOwners, rootFeedbackOwner].forEach(owner => {
            [...owner.toasts].forEach(controller => controller.destroy());
            owner.loading.splice(0).forEach(token => loadingTokens.delete(token));
        });
        activeDialog?.controller.close(null);
        activeDialog = null;
        feedbackHost?.remove();
        feedbackHost = null;
    }
});

function observeControls(root = document, options = {}) {
    const kinds = new Set(options.kinds || ['Select']);
    const filter = typeof options.filter === 'function' ? options.filter : () => true;
    const owned = new Set();
    const cleanupDisconnected = () => {
        owned.forEach(controller => {
            const proxyConnected = controller.element?.isConnected === true;
            const nativeConnected = controller.nativeElement?.isConnected === true;
            if (proxyConnected || nativeConnected) return;
            controller.destroy?.();
            owned.delete(controller);
        });
    };
    const enhanceTree = candidate => {
        if (document.documentElement.dataset.uiMode !== 'next') return;
        const scope = candidate?.nodeType === 1 ? candidate : root;
        const selects = [];
        if (kinds.has('Select')) {
            if (scope?.matches?.('select:not(.vcp-ui-select-source)')) selects.push(scope);
            scope?.querySelectorAll?.('select:not(.vcp-ui-select-source)').forEach(select => selects.push(select));
        }
        selects.filter(filter).forEach(select => {
            try {
                const controller = VCPUI.enhance('Select', select);
                owned.add(controller);
            } catch (error) {
                console.warn('[VCPUI] Unable to enhance dynamic Select:', error);
            }
        });
    };
    enhanceTree(root);
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(records => {
        // Wait until the current DOM transaction has settled. A business
        // renderer may replace a native Select and its Web Awesome proxy in
        // separate mutations; cleaning synchronously could race that move.
        queueMicrotask(() => {
            cleanupDisconnected();
            records.forEach(record => record.addedNodes.forEach(enhanceTree));
        });
    });
    observer?.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
    return Object.freeze({
        refresh: () => {
            cleanupDisconnected();
            enhanceTree(root);
        },
        destroy() {
            observer?.disconnect();
            owned.forEach(controller => controller.destroy?.());
            owned.clear();
        },
    });
}

const VCPUI = Object.freeze({
    create(name, options = {}) {
        const factory = COMPONENTS.get(String(name).toLowerCase());
        if (!factory) throw new Error(`Unknown VCPUI component: ${name}`);
        return factory(options);
    },
    enhance(name, element, options = {}) {
        const normalized = String(name).toLowerCase();
        const enhancer = ENHANCERS.get(normalized);
        if (!enhancer) throw new Error(`Unknown VCPUI enhancer: ${name}`);
        const existing = controllerByElement.get(element);
        if (existing) {
            const canUpgradeSelect = normalized === 'select'
                && existing.kernel === 'native'
                && document.documentElement.dataset.uiMode === 'next'
                && window.VCPWebAwesome?.isDefined?.('select');
            if (!canUpgradeSelect) return existing.update(options);
            existing.destroy();
        }
        return enhancer(element, options);
    },
    feedback,
    setDensity(target, density = 'comfortable') {
        const normalized = normalize(density, ['compact', 'comfortable'], 'comfortable', 'density');
        const candidate = target?.element || target;
        const scope = candidate?.classList?.contains('vcp-ui-scope')
            ? candidate
            : candidate?.closest?.('.vcp-ui-scope') || document.querySelector('.vcp-ui-scope');
        if (!scope) return normalized;
        scope.dataset.density = normalized;
        window.dispatchEvent(new CustomEvent('vcp-ui-density-changed', { detail: { density: normalized, scope } }));
        return normalized;
    },
    getDensity(target) {
        const candidate = target?.element || target;
        const scope = candidate?.classList?.contains('vcp-ui-scope') ? candidate : candidate?.closest?.('.vcp-ui-scope');
        return scope?.dataset.density === 'compact' ? 'compact' : 'comfortable';
    },
    getController(element) {
        return controllerByElement.get(element) || null;
    },
    observeControls,
    getComponentMeta(name) {
        const normalized = String(name).toLowerCase();
        return COMPONENT_MANIFEST.find(item => item.name.toLowerCase() === normalized || item.aliases.some(alias => alias.toLowerCase() === normalized)) || null;
    },
    manifest: COMPONENT_MANIFEST,
    components: Object.freeze([...COMPONENTS.keys()])
});

window.VCPUI = VCPUI;
window.dispatchEvent(new CustomEvent('vcp-ui-ready'));

export default VCPUI;
