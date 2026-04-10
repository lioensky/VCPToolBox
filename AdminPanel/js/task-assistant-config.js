import { apiFetch, showMessage } from './utils.js';

const API_BASE = '/admin_api';
let listenersAttached = false;
let cachedConfig = null;

export async function initializeTaskAssistantConfig() {
    const section = document.getElementById('task-assistant-config-section');
    if (!section) return;

    if (!listenersAttached) {
        attachEventListeners();
        listenersAttached = true;
    }

    await loadAll();
}

function attachEventListeners() {
    const saveBtn = document.getElementById('fa-save-config-button');
    const addBtn = document.getElementById('fa-add-task-button');
    const refreshBtn = document.getElementById('fa-refresh-button');

    if (saveBtn && !saveBtn.dataset.listenerAttached) {
        saveBtn.addEventListener('click', saveConfig);
        saveBtn.dataset.listenerAttached = 'true';
    }

    if (addBtn && !addBtn.dataset.listenerAttached) {
        addBtn.addEventListener('click', handleAddTask);
        addBtn.dataset.listenerAttached = 'true';
    }

    if (refreshBtn && !refreshBtn.dataset.listenerAttached) {
        refreshBtn.addEventListener('click', loadAll);
        refreshBtn.dataset.listenerAttached = 'true';
    }
}

async function loadAll() {
    await loadConfig();
    await loadStatus();
}

async function loadConfig() {
    const container = document.getElementById('fa-task-cards-container');
    const globalSwitch = document.getElementById('fa-global-enabled');
    const statusSpan = document.getElementById('fa-status');

    if (statusSpan) {
        statusSpan.textContent = '正在加载任务配置...';
        statusSpan.className = 'status-message info';
    }

    if (container) {
        container.innerHTML = '';
    }

    try {
        const data = await apiFetch(`${API_BASE}/task-assistant/config`);
        cachedConfig = data;
        const config = data.config || { globalEnabled: false, tasks: [] };

        if (globalSwitch) {
            globalSwitch.checked = !!config.globalEnabled;
        }

        // --- 获取可用 Agent 列表以供建议 ---
        try {
            const agentData = await apiFetch(`${API_BASE}/agent-assistant/config`);
            const datalist = document.getElementById('fa-available-agents-list');
            if (agentData && Array.isArray(agentData.agents)) {
                if (datalist) {
                    datalist.innerHTML = '';
                    agentData.agents.forEach(agent => {
                        if (agent.chineseName) {
                            const option = document.createElement('option');
                            option.value = agent.chineseName;
                            datalist.appendChild(option);
                        }
                    });
                }
                // 更新缓存在全局，以便 addTaskCard 获取
                cachedConfig = cachedConfig || {};
                cachedConfig.availableAgents = agentData.agents;
            }
        } catch (agentErr) {
            console.warn('[TaskAssistant] Failed to fetch agent list for suggestions:', agentErr);
        }
        // ---------------------------------

        if (Array.isArray(config.tasks) && config.tasks.length > 0) {
            config.tasks.forEach(task => addTaskCard(task));
        } else if (container) {
            container.innerHTML = '<p class="fa-placeholder">还没有任务，请先创建一个任务。</p>';
        }

        renderTaskTypeOptions(data.availableTaskTypes || []);

        if (statusSpan) {
            statusSpan.textContent = '任务配置已加载。';
            statusSpan.className = 'status-message success';
        }
    } catch (e) {
        if (statusSpan) {
            statusSpan.textContent = `加载失败：${e.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}

function renderTaskTypeOptions(taskTypes) {
    const select = document.getElementById('fa-new-task-type');
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '';

    const types = Array.isArray(taskTypes) && taskTypes.length > 0
        ? taskTypes
        : [
            { type: 'forum_patrol', label: '论坛巡航任务' },
            { type: 'custom_prompt', label: '通用提示词任务' }
        ];

    types.forEach(item => {
        const option = document.createElement('option');
        option.value = item.type;
        option.textContent = item.label || item.type;
        select.appendChild(option);
    });

    if (currentValue && types.some(item => item.type === currentValue)) {
        select.value = currentValue;
    }
}

async function loadStatus() {
    const statusContainer = document.getElementById('fa-runtime-status');
    if (!statusContainer) return;

    try {
        const data = await apiFetch(`${API_BASE}/task-assistant/status`);
        let html = `<span class="fa-status-badge ${data.globalEnabled ? 'active' : 'inactive'}">${data.globalEnabled ? '运行中' : '已停止'}</span>`;
        html += ` | 活跃定时器: <strong>${data.activeTimerCount || 0}</strong>`;
        html += ` | 任务总数: <strong>${Array.isArray(data.tasks) ? data.tasks.length : 0}</strong>`;

        if (Array.isArray(data.history) && data.history.length > 0) {
            html += '<div class="fa-agent-states"><div style="font-weight:bold;margin-bottom:0.5rem;">最近执行记录</div>';
            data.history.slice(0, 8).forEach(item => {
                const time = item.finishedAt ? new Date(item.finishedAt).toLocaleString() : '未完成';
                const isError = item.status === 'error';
                html += '<div class="fa-state-item">';
                html += `<span class="fa-state-name">${escapeHtml(item.taskName || item.taskId || '-')}</span>`;
                html += `<span class="fa-state-time">${escapeHtml(time)}</span>`;
                html += `<span class="fa-state-result ${isError ? 'error' : 'success'}">${escapeHtml(item.message || item.status || '-')}</span>`;
                html += '</div>';
            });
            html += '</div>';
        }

        statusContainer.innerHTML = html;
    } catch (e) {
        statusContainer.innerHTML = '<span class="status-message error">状态加载失败</span>';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createInputGroup(labelText, inputElement, hintText = '', isFull = true) {
    const group = document.createElement('div');
    group.className = isFull ? 'aa-field-group aa-field-group-full' : 'aa-field-group';

    const label = document.createElement('label');
    label.textContent = labelText;
    group.appendChild(label);
    group.appendChild(inputElement);

    if (hintText) {
        const hint = document.createElement('p');
        hint.className = 'aa-hint';
        hint.textContent = hintText;
        group.appendChild(hint);
    }

    return group;
}

function createTextInput(className, value = '', placeholder = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = className;
    input.value = value;
    input.placeholder = placeholder;
    return input;
}

function createNumberInput(className, value = '', min = '0') {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = className;
    input.value = value;
    input.min = min;
    return input;
}

function createTextarea(className, value = '', rows = 6, placeholder = '') {
    const textarea = document.createElement('textarea');
    textarea.className = className;
    textarea.rows = rows;
    textarea.value = value;
    textarea.placeholder = placeholder;
    return textarea;
}

function createSelect(className, options, selectedValue) {
    const select = document.createElement('select');
    select.className = className;

    options.forEach(optionData => {
        const option = document.createElement('option');
        option.value = optionData.value;
        option.textContent = optionData.label;
        if (option.value === selectedValue) {
            option.selected = true;
        }
        select.appendChild(option);
    });

    return select;
}

function addTaskCard(task) {
    const container = document.getElementById('fa-task-cards-container');
    if (!container) return;

    // 获取当前可用 Agent 以填充快选列表
    const availableAgentOptions = (cachedConfig?.availableAgents || [])
        .map(a => ({ value: a.chineseName, label: a.chineseName }));
    const selectOptions = [{ value: '', label: '+' }, ...availableAgentOptions];

    const placeholder = container.querySelector('.fa-placeholder');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'aa-agent-card fa-agent-card';
    card.dataset.taskId = task.id || '';

    const header = document.createElement('div');
    header.className = 'aa-agent-card-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'fa-agent-name';
    nameSpan.style.gridColumn = '1 / 2';
    nameSpan.style.gridRow = '1 / 2';
    nameSpan.textContent = task.name || '未命名任务';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'aa-agent-subtitle';
    typeBadge.style.gridColumn = '1 / 2';
    typeBadge.style.gridRow = '2 / 3';
    typeBadge.textContent = `类型: ${task.type === 'forum_patrol' ? '论坛巡航' : '通用提示词'}`;

    const btnGroup = document.createElement('div');
    btnGroup.style.gridColumn = '2 / 3';
    btnGroup.style.gridRow = '1 / 3';
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '0.5rem';
    btnGroup.style.alignItems = 'center';

    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'aa-agent-delete-btn';
    triggerBtn.style.background = 'var(--primary-color)';
    triggerBtn.style.color = '#fff';
    triggerBtn.textContent = '立即执行';
    triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true;
        triggerBtn.textContent = '发送中...';
        try {
            await apiFetch(`${API_BASE}/task-assistant/trigger`, {
                method: 'POST',
                body: JSON.stringify({ taskId: task.id })
            });
            showMessage(`已触发任务 "${task.name}"。`, 'success');
            await loadStatus();
        } catch (e) {
            showMessage(`触发失败：${e.message}`, 'error');
        } finally {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '立即执行';
        }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'aa-agent-delete-btn';
    deleteBtn.textContent = '移除';
    deleteBtn.addEventListener('click', () => {
        if (confirm(`确定移除任务 "${task.name}" 吗？`)) {
            card.remove();
            if (!container.children.length) {
                container.innerHTML = '<p class="fa-placeholder">还没有任务，请先创建一个任务。</p>';
            }
        }
    });

    btnGroup.appendChild(triggerBtn);
    btnGroup.appendChild(deleteBtn);
    header.appendChild(nameSpan);
    header.appendChild(typeBadge);
    header.appendChild(btnGroup);

    const body = document.createElement('div');
    body.className = 'aa-agent-card-body';

    const typeSelect = createSelect('fa-task-type', [
        { value: 'forum_patrol', label: '论坛巡航任务' },
        { value: 'custom_prompt', label: '通用提示词任务' }
    ], task.type || 'forum_patrol');

    const scheduleSelect = createSelect('fa-task-schedule-mode', [
        { value: 'interval', label: '循环任务' },
        { value: 'cron', label: 'CRON 定时' },
        { value: 'manual', label: '仅手动触发' },
        { value: 'once', label: '一次性任务' }
    ], task.schedule?.mode || 'interval');

    const enabledRow = document.createElement('div');
    enabledRow.className = 'fa-switch-row';

    const enableLabel = document.createElement('label');
    enableLabel.className = 'switch-container';

    const enableText = document.createElement('span');
    enableText.textContent = '启用任务';

    const enableInput = document.createElement('input');
    enableInput.type = 'checkbox';
    enableInput.className = 'fa-task-enabled';
    enableInput.checked = task.enabled !== false;

    const slider = document.createElement('span');
    slider.className = 'switch-slider';

    enableLabel.appendChild(enableText);
    enableLabel.appendChild(enableInput);
    enableLabel.appendChild(slider);
    enabledRow.appendChild(enableLabel);

    const delegationLabel = document.createElement('label');
    delegationLabel.className = 'switch-container';
    delegationLabel.style.marginLeft = '1rem';

    const delegationText = document.createElement('span');
    delegationText.textContent = '异步高级委托';

    const delegationInput = document.createElement('input');
    delegationInput.type = 'checkbox';
    delegationInput.className = 'fa-task-delegation';
    delegationInput.checked = !!task.dispatch?.taskDelegation;

    const delegationSlider = document.createElement('span');
    delegationSlider.className = 'switch-slider';

    delegationLabel.appendChild(delegationText);
    delegationLabel.appendChild(delegationInput);
    delegationLabel.appendChild(delegationSlider);
    enabledRow.appendChild(delegationLabel);

    const taskNameInput = createTextInput('fa-task-name-input', task.name || '', '例如：巡航任务-可可');
    const targetAgentsInput = createTextInput('fa-task-targets-input', (task.targets?.agents || []).join(', '), '多个 Agent 用英文逗号分隔');
    targetAgentsInput.setAttribute('list', 'fa-available-agents-list');
    const intervalInput = createNumberInput('fa-task-interval', task.schedule?.intervalMinutes || 60, '10');
    const cronInput = createTextInput('fa-task-cron', task.schedule?.cronValue || '', '例如：0 0 * * * (每日凌晨)');

    const runAtInput = document.createElement('input');
    runAtInput.type = 'datetime-local';
    runAtInput.className = 'fa-task-run-at';
    runAtInput.value = task.schedule?.runAt ? toDatetimeLocalValue(task.schedule.runAt) : '';

    const injectToolsInput = createTextInput('fa-task-inject-tools', (task.dispatch?.injectTools || []).join(', '), '例如：VCPForum');
    const maidInput = createTextInput('fa-task-maid', task.dispatch?.maid || 'VCP系统', '发送者名称');
    const promptTextarea = createTextarea('fa-task-prompt', task.payload?.promptTemplate || '', 8, '输入任务提示词模板');

    const placeholderHint = document.createElement('div');
    placeholderHint.className = 'aa-hint';
    const availablePlaceholders = task.payload?.availablePlaceholders || [];
    placeholderHint.innerHTML = availablePlaceholders.length > 0
        ? `可用占位符：${availablePlaceholders.map(item => `<code>${escapeHtml(item)}</code>`).join(' ')}`
        : '当前任务无额外占位符。';

    const forumPayloadWrap = document.createElement('div');
    forumPayloadWrap.className = 'fa-task-forum-options';

    const includeForumInput = document.createElement('input');
    includeForumInput.type = 'checkbox';
    includeForumInput.className = 'fa-task-include-forum-list';
    includeForumInput.checked = task.payload?.includeForumPostList !== false;

    const includeForumLabel = document.createElement('label');
    includeForumLabel.className = 'switch-container';
    const includeForumText = document.createElement('span');
    includeForumText.textContent = '预读取论坛帖子列表';
    const includeForumSlider = document.createElement('span');
    includeForumSlider.className = 'switch-slider';
    includeForumLabel.appendChild(includeForumText);
    includeForumLabel.appendChild(includeForumInput);
    includeForumLabel.appendChild(includeForumSlider);

    const forumPlaceholderInput = createTextInput(
        'fa-task-forum-placeholder',
        task.payload?.forumListPlaceholder || '{{forum_post_list}}',
        '例如：{{forum_post_list}}'
    );
    const maxPostsInput = createNumberInput('fa-task-max-posts', task.payload?.maxPosts || 200, '1');

    forumPayloadWrap.appendChild(createInputGroup('论坛列表占位符', forumPlaceholderInput, '提示词中出现该占位符时，会自动替换为论坛帖子列表。'));
    forumPayloadWrap.appendChild(createInputGroup('最大读取帖子数', maxPostsInput, '用于控制注入到提示词中的帖子条目数量。'));

    const targetAgentsContainer = document.createElement('div');
    targetAgentsContainer.className = 'fa-targets-input-wrap';
    targetAgentsContainer.append(targetAgentsInput);

    const targetAgentsSelect = createSelect('fa-task-targets-select', selectOptions, '');
    targetAgentsSelect.title = '快选 Agent';
    targetAgentsSelect.addEventListener('change', () => {
        const val = targetAgentsSelect.value;
        if (!val) return;
        let current = targetAgentsInput.value.trim();
        if (current) {
            const agents = current.split(',').map(s => s.trim()).filter(Boolean);
            if (!agents.includes(val)) {
                agents.push(val);
                targetAgentsInput.value = agents.join(', ');
            }
        } else {
            targetAgentsInput.value = val;
        }
        targetAgentsSelect.value = '';
    });
    targetAgentsContainer.append(targetAgentsSelect);

    // --- 随机选取逻辑 (动态生成) ---
    const randomSelect = createSelect('fa-task-random-select', [], '');
    randomSelect.title = '设置随机执行人数';
    randomSelect.style.marginLeft = '0.5rem';
    randomSelect.style.width = 'auto';

    function updateRandomSelectOptions() {
        const text = targetAgentsInput.value || '';
        const parts = text.split(',').map(s => s.trim()).filter(Boolean);
        const candidates = parts.filter(p => !/^random(\d+)$/i.test(p));
        const currentTag = parts.find(p => /^random(\d+)$/i.test(p)) || '';
        
        const count = candidates.length;
        const previousVal = randomSelect.value || currentTag;

        randomSelect.innerHTML = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '不进行随机';
        randomSelect.appendChild(noneOpt);

        // 动态生成 1 到 N 的选项 (上限 30)
        for (let i = 1; i <= Math.min(count, 30); i++) {
            const opt = document.createElement('option');
            opt.value = `random${i}`;
            opt.textContent = `随机 ${i} 人`;
            randomSelect.appendChild(opt);
        }

        // 恢复选中状态
        if (currentTag && [...randomSelect.options].some(o => o.value === currentTag)) {
            randomSelect.value = currentTag;
        } else {
            randomSelect.value = '';
        }
    }

    randomSelect.addEventListener('change', () => {
        let current = targetAgentsInput.value.trim();
        let agents = current.split(',').map(s => s.trim()).filter(Boolean);
        agents = agents.filter(a => !/^random(\d+)$/i.test(a));
        if (randomSelect.value) {
            agents.push(randomSelect.value);
        }
        targetAgentsInput.value = agents.join(', ');
    });

    // 监听输入框变化，实时更新下拉框选项
    targetAgentsInput.addEventListener('input', updateRandomSelectOptions);
    
    // 初始化
    updateRandomSelectOptions();
    
    targetAgentsContainer.append(randomSelect);

    // 修改之前的快捷选择逻辑，增加同步调用
    const originalSelectAdd = targetAgentsSelect.onchange; // 不好拿，直接在事件里加
    targetAgentsSelect.addEventListener('change', updateRandomSelectOptions);
    // ------------------

    body.appendChild(enabledRow);

    const row1 = document.createElement('div');
    row1.className = 'aa-row';
    row1.appendChild(createInputGroup('任务名称', taskNameInput, '', false));
    row1.appendChild(createInputGroup('任务类型', typeSelect, '', false));
    body.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'aa-row';
    row2.appendChild(createInputGroup('目标 Agent', targetAgentsContainer, '可手动输入(逗号分隔)或点击 + 快选', false));
    row2.appendChild(createInputGroup('请求发送者', maidInput, '', false));
    body.appendChild(row2);

    const row3 = document.createElement('div');
    row3.className = 'aa-row';
    row3.appendChild(createInputGroup('调度方式', scheduleSelect, '', false));
    row3.appendChild(createInputGroup('循环间隔(分)', intervalInput, '仅循环任务生效', false));
    body.appendChild(row3);

    body.appendChild(createInputGroup('CRON 表达式', cronInput, '支持标准 CRON 语法，仅 CRON 定时模式生效'));
    body.appendChild(createInputGroup('一次性执行时间', runAtInput, '仅一次性任务生效'));
    body.appendChild(createInputGroup('注入工具', injectToolsInput, '多个工具使用英文逗号分隔'));
    body.appendChild(createInputGroup('提示词模板', promptTextarea, '这里是核心编辑区，用户可自由编辑任务提示词。'));
    body.appendChild(placeholderHint);

    const includeForumRow = document.createElement('div');
    includeForumRow.className = 'fa-switch-row';
    includeForumRow.appendChild(includeForumLabel);
    body.appendChild(includeForumRow);
    body.appendChild(forumPayloadWrap);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    function syncTypeVisibility() {
        const isForumTask = typeSelect.value === 'forum_patrol';
        includeForumRow.style.display = isForumTask ? '' : 'none';
        forumPayloadWrap.style.display = isForumTask ? '' : 'none';
        if (!isForumTask) {
            includeForumInput.checked = false;
        }
    }

    function syncScheduleVisibility() {
        const mode = scheduleSelect.value;
        intervalInput.disabled = (mode !== 'interval');
        runAtInput.disabled = (mode !== 'once');
        cronInput.disabled = (mode !== 'cron');

        // 可选：动态调整父级容器显示
        intervalInput.closest('.aa-field-group').style.opacity = (mode === 'interval' ? '1' : '0.5');
        runAtInput.closest('.aa-field-group').style.opacity = (mode === 'once' ? '1' : '0.5');
        cronInput.closest('.aa-field-group').style.opacity = (mode === 'cron' ? '1' : '0.5');
    }

    typeSelect.addEventListener('change', syncTypeVisibility);
    scheduleSelect.addEventListener('change', syncScheduleVisibility);
    syncTypeVisibility();
    syncScheduleVisibility();
}

function toDatetimeLocalValue(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function handleAddTask() {
    const nameInput = document.getElementById('fa-new-task-name');
    const typeSelect = document.getElementById('fa-new-task-type');

    if (!nameInput || !typeSelect) return;

    const name = nameInput.value.trim();
    if (!name) {
        showMessage('请输入任务名称。', 'info');
        return;
    }

    const type = typeSelect.value || 'forum_patrol';
    const template = cachedConfig?.taskTemplates?.[type] || buildFallbackTemplate(type);
    const newTask = {
        ...template,
        id: `draft_${Date.now()}`,
        name
    };

    addTaskCard(newTask);
    nameInput.value = '';
    showMessage(`已添加新任务草稿：${name}`, 'success');
}

function buildFallbackTemplate(type) {
    if (type === 'custom_prompt') {
        return {
            type,
            enabled: true,
            schedule: { mode: 'manual', intervalMinutes: 60 },
            targets: { agents: [] },
            dispatch: { injectTools: ['VCPForum'], maid: 'VCP系统', taskDelegation: false },
            payload: { promptTemplate: '', availablePlaceholders: [] }
        };
    }

    return {
        type: 'forum_patrol',
        enabled: true,
        schedule: { mode: 'interval', intervalMinutes: 60 },
        targets: { agents: [] },
        dispatch: { injectTools: ['VCPForum'], maid: 'VCP系统', taskDelegation: false },
        payload: {
            promptTemplate: '[论坛小助手:]现在是论坛时间~\n\n以下是完整的论坛帖子列表:\n{{forum_post_list}}',
            includeForumPostList: true,
            forumListPlaceholder: '{{forum_post_list}}',
            maxPosts: 200,
            availablePlaceholders: ['{{forum_post_list}}']
        }
    };
}

function collectTasksFromDom() {
    const cards = Array.from(document.querySelectorAll('.fa-agent-card'));
    return cards.map(card => {
        const taskId = card.dataset.taskId || '';
        const name = card.querySelector('.fa-task-name-input')?.value.trim() || '';
        const type = card.querySelector('.fa-task-type')?.value || 'forum_patrol';
        const enabled = !!card.querySelector('.fa-task-enabled')?.checked;
        const scheduleMode = card.querySelector('.fa-task-schedule-mode')?.value || 'interval';
        const intervalMinutes = parseInt(card.querySelector('.fa-task-interval')?.value, 10) || 60;
        const runAtValue = card.querySelector('.fa-task-run-at')?.value || '';
        const cronValue = card.querySelector('.fa-task-cron')?.value.trim() || '';
        const targets = (card.querySelector('.fa-task-targets-input')?.value || '')
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
        const injectTools = (card.querySelector('.fa-task-inject-tools')?.value || '')
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
        const maid = card.querySelector('.fa-task-maid')?.value.trim() || 'VCP系统';
        const promptTemplate = card.querySelector('.fa-task-prompt')?.value || '';
        const includeForumPostList = !!card.querySelector('.fa-task-include-forum-list')?.checked;
        const forumListPlaceholder = card.querySelector('.fa-task-forum-placeholder')?.value.trim() || '{{forum_post_list}}';
        const maxPosts = parseInt(card.querySelector('.fa-task-max-posts')?.value, 10) || 200;
        const taskDelegation = !!card.querySelector('.fa-task-delegation')?.checked;

        const baseTask = {
            id: taskId.startsWith('draft_') ? undefined : taskId,
            name,
            type,
            enabled,
            schedule: {
                mode: scheduleMode,
                intervalMinutes,
                runAt: scheduleMode === 'once' && runAtValue ? new Date(runAtValue).toISOString() : null,
                cronValue: scheduleMode === 'cron' ? cronValue : null
            },
            targets: { agents: targets },
            dispatch: {
                injectTools,
                maid,
                temporaryContact: true,
                channel: 'AgentAssistant',
                taskDelegation
            }
        };

        if (type === 'forum_patrol') {
            baseTask.payload = {
                promptTemplate,
                includeForumPostList,
                forumListPlaceholder,
                maxPosts,
                availablePlaceholders: ['{{forum_post_list}}']
            };
        } else {
            baseTask.payload = {
                promptTemplate,
                availablePlaceholders: []
            };
        }

        return baseTask;
    });
}

async function saveConfig() {
    const globalSwitch = document.getElementById('fa-global-enabled');
    const statusSpan = document.getElementById('fa-status');

    const globalEnabled = !!globalSwitch?.checked;
    const tasks = collectTasksFromDom();

    if (statusSpan) {
        statusSpan.textContent = '正在保存任务配置...';
        statusSpan.className = 'status-message info';
    }

    try {
        await apiFetch(`${API_BASE}/task-assistant/config`, {
            method: 'POST',
            body: JSON.stringify({
                globalEnabled,
                tasks,
                settings: { maxHistory: 200 }
            })
        });

        showMessage('任务派发中心配置已保存。', 'success');
        if (statusSpan) {
            statusSpan.textContent = '保存成功。';
            statusSpan.className = 'status-message success';
        }

        await loadAll();
    } catch (e) {
        if (statusSpan) {
            statusSpan.textContent = `保存失败：${e.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}
