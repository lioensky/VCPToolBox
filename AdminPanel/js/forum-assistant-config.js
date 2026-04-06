import { apiFetch, showMessage } from './utils.js';

const API_BASE = '/admin_api';
let listenersAttached = false;

export async function initializeForumAssistantConfig() {
    const section = document.getElementById('forum-assistant-config-section');
    if (!section) return;

    if (!listenersAttached) {
        attachEventListeners();
        listenersAttached = true;
    }

    await loadForumAssistantConfig();
}

function attachEventListeners() {
    const saveBtn = document.getElementById('fa-save-config-button');
    const addBtn = document.getElementById('fa-add-from-existing-button');

    if (saveBtn && !saveBtn.dataset.listenerAttached) {
        saveBtn.addEventListener('click', saveConfig);
        saveBtn.dataset.listenerAttached = 'true';
    }

    if (addBtn && !addBtn.dataset.listenerAttached) {
        addBtn.addEventListener('click', handleAddFromExisting);
        addBtn.dataset.listenerAttached = 'true';
    }
}

async function loadForumAssistantConfig() {
    const statusSpan = document.getElementById('fa-status');
    const container = document.getElementById('fa-agent-cards-container');
    const globalSwitch = document.getElementById('fa-global-enabled');

    if (statusSpan) {
        statusSpan.textContent = '正在加载论坛巡航配置...';
        statusSpan.className = 'status-message info';
    }
    if (container) container.innerHTML = '';

    try {
        const [config, available] = await Promise.all([
            apiFetch(`${API_BASE}/forum-assistant/config`),
            apiFetch(`${API_BASE}/forum-assistant/available-agents`, {}, false)
        ]);

        if (globalSwitch) globalSwitch.checked = config.globalEnabled;

        populateAgentSelect(available.agents || []);

        if (Array.isArray(config.agents) && config.agents.length > 0) {
            config.agents.forEach(a => addAgentCard(a));
        } else if (container) {
            container.innerHTML = '<p class="fa-placeholder">还没有配置论坛巡航 Agent，请从上方已注册 Agent 中选择添加。</p>';
        }

        if (statusSpan) {
            statusSpan.textContent = '配置已加载。';
            statusSpan.className = 'status-message success';
        }
    } catch (error) {
        if (statusSpan) {
            statusSpan.textContent = `加载失败：${error.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}

function populateAgentSelect(agents) {
    const select = document.getElementById('fa-existing-agent-select');
    if (!select) return;

    select.innerHTML = '<option value="">选择一个已注册 Agent...</option>';

    if (agents.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（AgentAssistant 中尚无已注册 Agent）';
        select.appendChild(opt);
        select.disabled = true;
        return;
    }

    agents.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    });
    select.disabled = false;
}

function addAgentCard(agent) {
    const container = document.getElementById('fa-agent-cards-container');
    if (!container) return;

    const placeholder = container.querySelector('.fa-placeholder');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'aa-agent-card fa-agent-card';
    card.dataset.baseName = agent.baseName || '';

    // Header
    const header = document.createElement('div');
    header.className = 'aa-agent-card-header fa-card-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'fa-agent-name';
    nameSpan.textContent = agent.chineseName || '未命名';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'aa-agent-delete-btn';
    deleteBtn.textContent = '移除';
    deleteBtn.addEventListener('click', () => {
        if (confirm(`确定移除 "${agent.chineseName}" 的论坛巡航配置吗？`)) {
            card.remove();
            if (!container.children.length) {
                container.innerHTML = '<p class="fa-placeholder">还没有配置论坛巡航 Agent，请从上方已注册 Agent 中选择添加。</p>';
            }
        }
    });

    header.appendChild(nameSpan);
    header.appendChild(deleteBtn);

    // Body
    const body = document.createElement('div');
    body.className = 'aa-agent-card-body';

    // 开关
    const enableRow = document.createElement('div');
    enableRow.className = 'fa-switch-row';
    const enableLabel = document.createElement('label');
    enableLabel.className = 'switch-container';
    const enableText = document.createElement('span');
    enableText.textContent = '启用巡航';
    const enableInput = document.createElement('input');
    enableInput.type = 'checkbox';
    enableInput.className = 'fa-agent-enabled';
    enableInput.checked = agent.enabled;
    const slider = document.createElement('span');
    slider.className = 'switch-slider';
    enableLabel.appendChild(enableText);
    enableLabel.appendChild(enableInput);
    enableLabel.appendChild(slider);
    enableRow.appendChild(enableLabel);

    // 巡航时间窗口
    const hoursGroup = document.createElement('div');
    hoursGroup.className = 'aa-field-group aa-field-group-full';
    const hoursLabel = document.createElement('label');
    hoursLabel.textContent = '巡航时段（24小时制，逗号分隔）';
    const hoursInput = document.createElement('input');
    hoursInput.type = 'text';
    hoursInput.className = 'fa-agent-hours';
    hoursInput.placeholder = '例如：9,12,18,21（留空 = 每小时都可能触发）';
    hoursInput.value = agent.hours || '';
    const hoursHint = document.createElement('p');
    hoursHint.className = 'aa-hint';
    hoursHint.textContent = '只在这些整点时刻有机会被选中巡航。留空则不限制，每次 cron 触发都参与随机选取。';
    hoursGroup.appendChild(hoursLabel);
    hoursGroup.appendChild(hoursInput);
    hoursGroup.appendChild(hoursHint);

    body.appendChild(enableRow);
    body.appendChild(hoursGroup);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
}

function handleAddFromExisting() {
    const select = document.getElementById('fa-existing-agent-select');
    const container = document.getElementById('fa-agent-cards-container');
    if (!select || !container) return;

    const name = select.value;
    if (!name) {
        showMessage('请先在下拉框中选择一个已注册 Agent。', 'info');
        return;
    }

    const existing = Array.from(container.querySelectorAll('.fa-agent-name')).map(el => el.textContent);
    if (existing.includes(name)) {
        showMessage(`"${name}" 已在巡航列表中，无需重复添加。`, 'info');
        return;
    }

    const base = name.toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'AGENT_' + Date.now().toString(36).toUpperCase();
    addAgentCard({ baseName: base, chineseName: name, enabled: true, hours: '' });
    showMessage(`已添加 "${name}" 到论坛巡航列表。`, 'success');
}

async function saveConfig() {
    const statusSpan = document.getElementById('fa-status');
    const container = document.getElementById('fa-agent-cards-container');
    const globalSwitch = document.getElementById('fa-global-enabled');

    if (!container) return;

    const globalEnabled = globalSwitch ? globalSwitch.checked : false;
    const cards = Array.from(container.querySelectorAll('.fa-agent-card'));
    const agents = [];

    for (const card of cards) {
        const nameEl = card.querySelector('.fa-agent-name');
        const enabledInput = card.querySelector('.fa-agent-enabled');
        const hoursInput = card.querySelector('.fa-agent-hours');

        const chineseName = nameEl ? nameEl.textContent : '';
        if (!chineseName) continue;

        agents.push({
            baseName: card.dataset.baseName || '',
            chineseName,
            enabled: enabledInput ? enabledInput.checked : false,
            hours: hoursInput ? hoursInput.value.trim() : ''
        });
    }

    if (statusSpan) {
        statusSpan.textContent = '正在保存...';
        statusSpan.className = 'status-message info';
    }

    try {
        await apiFetch(`${API_BASE}/forum-assistant/config`, {
            method: 'POST',
            body: JSON.stringify({ globalEnabled, agents })
        });
        showMessage('论坛巡航配置已保存。', 'success');
        if (statusSpan) {
            statusSpan.textContent = '保存成功。';
            statusSpan.className = 'status-message success';
        }
    } catch (error) {
        if (statusSpan) {
            statusSpan.textContent = `保存失败：${error.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}
