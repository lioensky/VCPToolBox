document.addEventListener('DOMContentLoaded', () => {
    const presetSelect = document.getElementById('preset-select');
    const loadPresetBtn = document.getElementById('load-preset');
    const newPresetBtn = document.getElementById('new-preset');
    const deletePresetBtn = document.getElementById('delete-preset');
    const editorContainer = document.getElementById('editor-container');
    const presetNameInput = document.getElementById('preset-name');
    const presetDescriptionInput = document.getElementById('preset-description');
    const presetPlaceholderAllowlistInput = document.getElementById('preset-placeholder-allowlist');
    const rulesList = document.getElementById('rules-list');
    const addRuleBtn = document.getElementById('add-rule');
    const savePresetBtn = document.getElementById('save-preset');

    const API_BASE_URL = '/admin_api/vcptavern';
    let currentPreset = null;
    let draggedItem = null;

    async function fetchPresets() {
        try {
            const response = await fetch(`${API_BASE_URL}/presets`);
            const presets = await response.json();
            presetSelect.innerHTML = '<option value="">--选择一个预设--</option>';
            presets.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                presetSelect.appendChild(option);
            });
        } catch (error) {
            console.error('获取预设列表失败:', error);
            alert('获取预设列表失败!');
        }
    }

    async function loadPreset(name) {
        if (!name) {
            editorContainer.classList.add('hidden');
            return;
        }
        try {
            const response = await fetch(`${API_BASE_URL}/presets/${name}`);
            if (!response.ok) {
                throw new Error(`服务器返回 ${response.status}`);
            }
            currentPreset = await response.json();
            presetNameInput.value = name;
            presetNameInput.disabled = true; // Don't allow editing name of existing preset
            presetDescriptionInput.value = currentPreset.description || '';
            presetPlaceholderAllowlistInput.value = (currentPreset.placeholderAllowlist || [])
                .map(item => String(item).replace(/^\{\{|\}\}$/g, '').trim())
                .filter(Boolean)
                .join('\n');
            renderRules(currentPreset.rules || []);
            editorContainer.classList.remove('hidden');
        } catch (error) {
            console.error(`加载预设 ${name} 失败:`, error);
            alert(`加载预设 ${name} 失败!`);
        }
    }

    function renderRules(rules) {
        rulesList.innerHTML = '';
        rules.forEach(rule => {
            const ruleElement = createRuleElement(rule);
            rulesList.appendChild(ruleElement);
        });
    }

    function createRuleElement(rule) {
        const ruleId = rule.id || `rule-${Date.now()}-${Math.random()}`;
        const card = document.createElement('div');
        card.className = 'rule-card';
        card.dataset.id = ruleId;

        card.innerHTML = `
            <div class="rule-header">
                <div class="drag-handle" title="拖拽移动">⋮⋮</div>
                <h3 contenteditable="true">${rule.name || '新规则'}</h3>
                <div class="rule-controls">
                    <button class="toggle-rule" title="启用/禁用">${rule.enabled ? '🟢' : '🔴'}</button>
                    <button class="delete-rule" title="删除规则">🗑️</button>
                </div>
            </div>
            <div class="rule-body">
                <div class="form-group">
                    <label>注入类型</label>
                    <select class="rule-type">
                        <option value="relative" ${rule.type === 'relative' ? 'selected' : ''}>相对注入</option>
                        <option value="depth" ${rule.type === 'depth' ? 'selected' : ''}>深度注入</option>
                        <option value="embed" ${rule.type === 'embed' ? 'selected' : ''}>嵌入</option>
                    </select>
                </div>
                <div class="form-group relative-options" style="display: ${(rule.type === 'relative' || rule.type === 'embed') ? 'flex' : 'none'};">
                    <label>相对位置</label>
                    <select class="rule-position">
                        <option value="before" ${(rule.position === 'before' || !rule.position) ? 'selected' : ''}>之前</option>
                        <option value="after" ${rule.position === 'after' ? 'selected' : ''}>之后</option>
                    </select>
                </div>
                <div class="form-group relative-options" style="display: ${(rule.type === 'relative' || rule.type === 'embed') ? 'flex' : 'none'};">
                    <label>目标</label>
                    <select class="rule-target">
                        <option value="system" ${(rule.target === 'system' || !rule.target) ? 'selected' : ''}>系统提示</option>
                        <option value="last_user" ${rule.target === 'last_user' ? 'selected' : ''}>最后的用户消息</option>
                    </select>
                </div>
                <div class="form-group depth-options" style="display: ${rule.type === 'depth' ? 'flex' : 'none'};">
                    <label>深度</label>
                    <input type="number" class="rule-depth" value="${rule.depth || 1}" min="1">
                </div>
                <div class="form-group role-options" style="display: ${rule.type !== 'embed' ? 'flex' : 'none'};">
                    <label>注入角色</label>
                    <select class="rule-content-role">
                        <option value="system" ${rule.content.role === 'system' ? 'selected' : ''}>system</option>
                        <option value="user" ${rule.content.role === 'user' ? 'selected' : ''}>user</option>
                        <option value="assistant" ${rule.content.role === 'assistant' ? 'selected' : ''}>assistant</option>
                    </select>
                </div>
                <div class="form-group" style="grid-column: 1 / -1;">
                    <label>注入内容</label>
                    <textarea class="rule-content-text" style="${rule.ui?.textareaWidth ? `width: ${rule.ui.textareaWidth};` : ''} ${rule.ui?.textareaHeight ? `height: ${rule.ui.textareaHeight};` : ''}">${rule.content.content || ''}</textarea>
                </div>
            </div>
        `;

        // Event Listeners
        card.querySelector('.rule-type').addEventListener('change', (e) => {
            const relativeOptions = card.querySelectorAll('.relative-options');
            const depthOptions = card.querySelectorAll('.depth-options');
            const roleOptions = card.querySelectorAll('.role-options');
            const type = e.target.value;

            if (type === 'relative') {
                relativeOptions.forEach(el => el.style.display = 'flex');
                depthOptions.forEach(el => el.style.display = 'none');
                roleOptions.forEach(el => el.style.display = 'flex');
            } else if (type === 'depth') {
                relativeOptions.forEach(el => el.style.display = 'none');
                depthOptions.forEach(el => el.style.display = 'flex');
                roleOptions.forEach(el => el.style.display = 'flex');
            } else if (type === 'embed') {
                relativeOptions.forEach(el => el.style.display = 'flex');
                depthOptions.forEach(el => el.style.display = 'none');
                roleOptions.forEach(el => el.style.display = 'none');
            }
        });

        card.querySelector('.delete-rule').addEventListener('click', () => card.remove());
        
        const toggleBtn = card.querySelector('.toggle-rule');
        toggleBtn.addEventListener('click', () => {
             const isEnabled = toggleBtn.textContent === '🟢';
             toggleBtn.textContent = isEnabled ? '🔴' : '🟢';
        });

        // Drag and Drop
        const dragHandle = card.querySelector('.drag-handle');

        // 拖拽事件应该绑定在卡片上，而不是手柄上
        card.addEventListener('dragstart', (e) => {
            draggedItem = card;
            // 使用微任务延迟添加class，确保拖拽的视觉反馈正确
            setTimeout(() => card.classList.add('dragging'), 0);
        });

        card.addEventListener('dragend', (e) => {
            // 拖拽结束后清理
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
            }
            draggedItem = null;
            // 确保拖拽结束后，卡片恢复不可拖拽状态
            card.draggable = false;
        });

        // 使用 mousedown 来控制是否启用拖拽，这是正确的
        card.addEventListener('mousedown', (e) => {
            // 只在点击拖拽手柄时才允许拖拽
            if (e.target === dragHandle) {
                card.draggable = true;
            } else {
                card.draggable = false;
            }
        });

        return card;
    }
    
    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.rule-card:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    function collectPresetDataFromUI() {
        const name = presetNameInput.value.trim();
        if (!name.match(/^[a-zA-Z0-9_-]+$/)) {
            alert('预设名称只能包含英文字母、数字、下划线和连字符。');
            return null;
        }

        const rules = [];
        document.querySelectorAll('#rules-list .rule-card').forEach(card => {
            const rule = {
                id: card.dataset.id,
                name: card.querySelector('h3').textContent,
                enabled: card.querySelector('.toggle-rule').textContent === '🟢',
                type: card.querySelector('.rule-type').value,
                content: {
                    role: card.querySelector('.rule-content-role').value,
                    content: card.querySelector('.rule-content-text').value
                },
                ui: {
                    textareaWidth: card.querySelector('.rule-content-text').style.width,
                    textareaHeight: card.querySelector('.rule-content-text').style.height
                }
            };
            if (rule.type === 'relative' || rule.type === 'embed') {
                rule.position = card.querySelector('.rule-position').value;
                rule.target = card.querySelector('.rule-target').value;
            }
            
            if (rule.type === 'depth') {
                rule.depth = parseInt(card.querySelector('.rule-depth').value, 10);
            }
            rules.push(rule);
        });

        return {
            name: document.getElementById('preset-name').value.trim(),
            description: document.getElementById('preset-description').value.trim(),
            placeholderAllowlist: presetPlaceholderAllowlistInput.value
                .split(/[\n,，]+/)
                .map(item => item.trim().replace(/^\{\{|\}\}$/g, ''))
                .filter((item, index, items) => item && items.indexOf(item) === index),
            rules: rules
        };
    }

    // --- Main Event Listeners ---

    loadPresetBtn.addEventListener('click', () => {
        const selectedPreset = presetSelect.value;
        loadPreset(selectedPreset);
    });

    newPresetBtn.addEventListener('click', () => {
        currentPreset = null;
        presetNameInput.value = '';
        presetNameInput.disabled = false;
        presetDescriptionInput.value = '';
        presetPlaceholderAllowlistInput.value = '';
        rulesList.innerHTML = '';
        editorContainer.classList.remove('hidden');
    });
    
    deletePresetBtn.addEventListener('click', async () => {
        const selectedPreset = presetSelect.value;
        if (!selectedPreset) {
            alert('请先选择一个要删除的预设。');
            return;
        }
        if (!confirm(`确定要删除预设 "${selectedPreset}" 吗？此操作不可撤销。`)) {
            return;
        }
        try {
            const response = await fetch(`${API_BASE_URL}/presets/${selectedPreset}`, { method: 'DELETE' });
            if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
            alert('预设删除成功！');
            editorContainer.classList.add('hidden');
            fetchPresets();
        } catch (error) {
            console.error('删除预设失败:', error);
            alert('删除预设失败!');
        }
    });

    addRuleBtn.addEventListener('click', () => {
        const newRule = {
            id: `rule-${Date.now()}`,
            name: '新规则',
            enabled: true,
            type: 'relative',
            position: 'before',
            target: 'system',
            content: { role: 'system', content: '' }
        };
        const ruleElement = createRuleElement(newRule);
        rulesList.appendChild(ruleElement);
    });

    savePresetBtn.addEventListener('click', async () => {
        const presetData = collectPresetDataFromUI();
        if (!presetData) return;
        
        try {
            const response = await fetch(`${API_BASE_URL}/presets/${presetData.name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(presetData)
            });
            if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
            alert('预设保存成功！');
            fetchPresets().then(() => {
                presetSelect.value = presetData.name;
                loadPreset(presetData.name);
            });
        } catch (error) {
            console.error('保存预设失败:', error);
            alert('保存预设失败!');
        }
    });

    // --- Drag and Drop Logic for the list ---
    rulesList.addEventListener('dragover', (e) => {
        e.preventDefault();
        const afterElement = getDragAfterElement(rulesList, e.clientY);
        const currentDragged = document.querySelector('.dragging');
        if (!currentDragged) return; // Guard against errors

        if (afterElement == null) {
            rulesList.appendChild(currentDragged);
        } else {
            rulesList.insertBefore(currentDragged, afterElement);
        }
    });

    // Initial load
    fetchPresets();
});
