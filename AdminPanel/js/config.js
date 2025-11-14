// AdminPanel/js/config.js

/**
 * 解析 .env 文件内容为对象列表。
 * @param {string} content - .env 文件的文本内容
 * @returns {Array<object>} - 解析后的条目数组
 */
export function parseEnvToList(content) {
    const lines = content.split(/\r?\n/);
    const entries = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        const currentLineNum = i;

        if (trimmedLine.startsWith('#') || trimmedLine === '') {
            entries.push({
                key: null,
                value: line, // For comments/empty, value holds the full line
                isCommentOrEmpty: true,
                isMultilineQuoted: false,
                originalLineNumStart: currentLineNum,
                originalLineNumEnd: currentLineNum
            });
            i++;
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
            entries.push({ key: null, value: line, isCommentOrEmpty: true, note: 'Malformed line (no equals sign)', originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
            i++;
            continue;
        }

        const key = line.substring(0, eqIndex).trim();
        let valueString = line.substring(eqIndex + 1);

        if (valueString.trim().startsWith("'")) {
            let accumulatedValue;
            let firstLineContent = valueString.substring(valueString.indexOf("'") + 1);

            if (firstLineContent.endsWith("'") && !lines.slice(i + 1).some(l => l.trim().endsWith("'") && !l.trim().startsWith("'") && l.includes("='"))) {
                accumulatedValue = firstLineContent.substring(0, firstLineContent.length - 1);
                entries.push({ key, value: accumulatedValue, isCommentOrEmpty: false, isMultilineQuoted: true, originalLineNumStart: currentLineNum, originalLineNumEnd: i });
            } else {
                let multilineContent = [firstLineContent];
                let endLineNum = i;
                i++;
                while (i < lines.length) {
                    const nextLine = lines[i];
                    multilineContent.push(nextLine);
                    endLineNum = i;
                    if (nextLine.trim().endsWith("'")) {
                        let lastContentLine = multilineContent.pop();
                        multilineContent.push(lastContentLine.substring(0, lastContentLine.lastIndexOf("'")));
                        break;
                    }
                    i++;
                }
                accumulatedValue = multilineContent.join('\n');
                entries.push({ key, value: accumulatedValue, isCommentOrEmpty: false, isMultilineQuoted: true, originalLineNumStart: currentLineNum, originalLineNumEnd: endLineNum });
            }
        } else {
            entries.push({ key, value: valueString.trim(), isCommentOrEmpty: false, isMultilineQuoted: false, originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
        }
        i++;
    }
    return entries;
}

/**
 * 根据表单元素和原始解析条目构建 .env 字符串（用于全局配置）。
 * @param {HTMLFormElement} formElement - 表单元素
 * @param {Array<object>} originalParsedEntries - 原始解析的 .env 条目
 * @returns {string} - 新的 .env 文件内容字符串
 */
export function buildEnvString(formElement, originalParsedEntries) {
    const finalLines = [];
    const formElementsMap = new Map();
    Array.from(formElement.querySelectorAll('[data-original-key], [data-is-comment-or-empty="true"]')).forEach(el => {
        if (el.dataset.originalKey) formElementsMap.set(el.dataset.originalKey, el);
        else if (el.dataset.originalContent) formElementsMap.set(`comment-${finalLines.length}`, el); // Unique key for comments
    });

    originalParsedEntries.forEach(entry => {
        if (entry.isCommentOrEmpty) {
            finalLines.push(entry.value); // Push original comment or empty line
        } else {
            const inputElement = formElementsMap.get(entry.key);
            if (inputElement && inputElement.closest('form') === formElement) {
                let value = inputElement.value;
                 if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                    value = inputElement.checked ? 'true' : 'false';
                } else if (inputElement.dataset.expectedType === 'integer') {
                    const intVal = parseInt(value, 10);
                    value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal);
                }

                const isMultiline = entry.isMultilineQuoted || value.includes('\n');
                if (isMultiline) {
                    finalLines.push(`${entry.key}='${value}'`);
                } else {
                    finalLines.push(`${entry.key}=${value}`);
                }
            } else {
                // Key was in original but not in UI
                if (entry.isMultilineQuoted) {
                    finalLines.push(`${entry.key}='${entry.value}'`);
                } else {
                    finalLines.push(`${entry.key}=${entry.value}`);
                }
            }
        }
    });
    
    return finalLines.join('\n');
}

/**
 * 为插件配置构建 .env 字符串。
 * @param {HTMLFormElement} formElement - 插件的表单元素
 * @param {Array<object>} originalParsedEntries - 插件原始解析的 .env 条目
 * @param {string} pluginName - 插件名称
 * @returns {string} - 新的插件 .env 文件内容字符串
 */
export function buildEnvStringForPlugin(formElement, originalParsedEntries, pluginName) {
    const finalLines = [];
    const editedKeysInForm = new Set();

    Array.from(formElement.elements).forEach(el => {
        if (el.dataset.originalKey) editedKeysInForm.add(el.dataset.originalKey);
    });

    originalParsedEntries.forEach(entry => {
        if (entry.isCommentOrEmpty) {
            finalLines.push(entry.value);
        } else {
            const inputElement = formElement.elements[`${pluginName}-${entry.key.replace(/\./g, '_')}`] || formElement.elements[entry.key];
            if (inputElement && editedKeysInForm.has(entry.key)) {
                let value = inputElement.value;
                if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                    value = inputElement.checked ? 'true' : 'false';
                } else if (inputElement.dataset.expectedType === 'integer') {
                    const intVal = parseInt(value, 10);
                    value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal);
                }
                const isMultiline = entry.isMultilineQuoted || value.includes('\n');
                if (isMultiline) {
                    finalLines.push(`${entry.key}='${value}'`);
                } else {
                    finalLines.push(`${entry.key}=${value}`);
                }
            } else if (!editedKeysInForm.has(entry.key)) {
                // Field was intentionally removed (e.g., custom field deleted)
            } else { // Fallback
                 if (entry.isMultilineQuoted) {
                    finalLines.push(`${entry.key}='${entry.value}'`);
                } else {
                    finalLines.push(`${entry.key}=${entry.value}`);
                }
            }
        }
    });
    
    // Add new custom fields
    originalParsedEntries.forEach(entry => {
        if (!entry.isCommentOrEmpty && !finalLines.some(line => line.startsWith(entry.key + "=") || line.startsWith(entry.key + "='"))) {
             const inputElement = formElement.elements[`${pluginName}-${entry.key.replace(/\./g, '_')}`] || formElement.elements[entry.key];
             if (inputElement) {
                let value = inputElement.value;
                 if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                    value = inputElement.checked ? 'true' : 'false';
                }
                const isMultiline = value.includes('\n');
                 if (isMultiline) {
                    finalLines.push(`${entry.key}='${value}'`);
                } else {
                    finalLines.push(`${entry.key}=${value}`);
                }
             }
        }
    });

    return finalLines.join('\n');
}

/**
 * 创建一个用于显示注释或空行的 DOM 元素。
 * @param {string} lineContent - 行内容
 * @param {string|number} uniqueId - 唯一标识符
 * @returns {HTMLDivElement} - 创建的 div 元素
 */
export function createCommentOrEmptyElement(lineContent, uniqueId) {
    const group = document.createElement('div');
    group.className = 'form-group-comment';
    const commentPre = document.createElement('pre');
    commentPre.textContent = lineContent;
    commentPre.dataset.isCommentOrEmpty = "true";
    commentPre.dataset.originalContent = lineContent;
    commentPre.id = `comment-${uniqueId}`;
    group.appendChild(commentPre);
    return group;
}

/**
 * 创建一个表单组（label + input/textarea/switch）。
 * @param {string} key - 配置项的键
 * @param {string|boolean} value - 配置项的值
 * @param {string} type - 输入类型 ('string', 'boolean', 'integer')
 * @param {string} descriptionHtml - 描述文本 (可以是 HTML)
 * @param {boolean} [isPluginConfig=false] - 是否为插件配置
 * @param {string|null} [pluginName=null] - 插件名称
 * @param {boolean} [isCustomDeletableField=false] - 是否为可删除的自定义字段
 * @param {boolean} [isMultiline=false] - 是否为多行文本
 * @returns {HTMLDivElement} - 创建的表单组 div 元素
 */
export function createFormGroup(key, value, type, descriptionHtml, isPluginConfig = false, pluginName = null, isCustomDeletableField = false, isMultiline = false) {
    const group = document.createElement('div');
    group.className = 'form-group';
    const elementIdSuffix = key.replace(/\./g, '_');
    const elementId = `${isPluginConfig && pluginName ? pluginName + '-' : ''}${elementIdSuffix}`;

    const label = document.createElement('label');
    label.htmlFor = elementId;

    const keySpan = document.createElement('span');
    keySpan.className = 'key-name';
    keySpan.textContent = key;
    label.appendChild(keySpan);

    if (isPluginConfig && isCustomDeletableField) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.textContent = '×';
        deleteButton.title = `删除自定义项 ${key}`;
        deleteButton.classList.add('delete-config-btn');
        deleteButton.onclick = (e) => {
            e.stopPropagation();
            if (confirm(`确定要删除自定义配置项 "${key}" 吗？更改将在保存后生效。`)) {
                group.remove();
                // The logic to remove from originalPluginConfigs will be handled in the plugins module
                // This is a simplified approach for modularization.
                const event = new CustomEvent('config-field-deleted', { detail: { pluginName, key } });
                document.dispatchEvent(event);
            }
        };
        label.appendChild(deleteButton);
    }
    
    group.appendChild(label);

    if (descriptionHtml) {
        const descSpan = document.createElement('span');
        descSpan.className = 'description';
        descSpan.innerHTML = descriptionHtml;
        group.appendChild(descSpan);
    }

    let input;
    if (type === 'boolean') {
        const switchContainer = document.createElement('div');
        switchContainer.className = 'switch-container';
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = String(value).toLowerCase() === 'true';
        const sliderSpan = document.createElement('span');
        sliderSpan.className = 'slider';
        switchLabel.appendChild(input);
        switchLabel.appendChild(sliderSpan);
        switchContainer.appendChild(switchLabel);
        const valueDisplay = document.createElement('span');
        valueDisplay.textContent = input.checked ? '启用' : '禁用';
        input.onchange = () => { valueDisplay.textContent = input.checked ? '启用' : '禁用'; };
        switchContainer.appendChild(valueDisplay);
        group.appendChild(switchContainer);
    } else if (type === 'integer') {
        input = document.createElement('input');
        input.type = 'number';
        input.value = value ?? '';
        input.step = '1';
    } else if (isMultiline || String(value).includes('\n') || (typeof value === 'string' && value.length > 60)) {
        input = document.createElement('textarea');
        input.value = value ?? '';
        input.rows = Math.min(10, Math.max(3, String(value).split('\n').length + 1));
    } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = value ?? '';
    }

    input.id = elementId;
    input.name = elementId;
    input.dataset.originalKey = key;
    input.dataset.expectedType = type;
    if (input.type !== 'checkbox') {
        if (/key|api/i.test(key) && input.tagName.toLowerCase() === 'input') {
            input.type = 'password';
            const wrapper = document.createElement('div');
            wrapper.className = 'input-with-toggle';
            
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.textContent = '显示';
            toggleBtn.className = 'toggle-visibility-btn';
            
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (input.type === 'password') {
                    input.type = 'text';
                    toggleBtn.textContent = '隐藏';
                } else {
                    input.type = 'password';
                    toggleBtn.textContent = '显示';
                }
            });
            
            wrapper.appendChild(input);
            wrapper.appendChild(toggleBtn);
            group.appendChild(wrapper);
        } else {
            group.appendChild(input);
        }
    }
    
    return group;
}