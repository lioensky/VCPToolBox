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

    await loadConfig();
    await loadStatus();
}

function attachEventListeners() {
    const saveBtn = document.getElementById('fa-save-config-button');
    const addBtn = document.getElementById('fa-add-agent-button');

    if (saveBtn && !saveBtn.dataset.listenerAttached) {
        saveBtn.addEventListener('click', saveConfig);
        saveBtn.dataset.listenerAttached = 'true';
    }
    if (addBtn && !addBtn.dataset.listenerAttached) {
        addBtn.addEventListener('click', handleAddAgent);
        addBtn.dataset.listenerAttached = 'true';
    }
}

async function loadConfig() {
    const container = document.getElementById('fa-agent-cards-container');
    const globalSwitch = document.getElementById('fa-global-enabled');
    const statusSpan = document.getElementById('fa-status');

    if (statusSpan) {
        statusSpan.textContent = '正在加载...';
        statusSpan.className = 'status-message info';
    }
    if (container) container.innerHTML = '';

    try {
        const data = await apiFetch(`${API_BASE}/forum-assistant/config`);
        const config = data.config || { globalEnabled: false, agents: [] };

        if (globalSwitch) globalSwitch.checked = config.globalEnabled;

        if (Array.isArray(config.agents) && config.agents.length > 0) {
            config.agents.forEach(a => addAgentCard(a));
        } else if (container) {
            container.innerHTML = '<p class="fa-placeholder">还没有配置巡航 Agent，请点击上方"添加 Agent"按钮。</p>';
        }

        if (statusSpan) {
            statusSpan.textContent = '配置已加载。';
            statusSpan.className = 'status-message success';
        }
    } catch (e) {
        if (statusSpan) {
            statusSpan.textContent = `加载失败：${e.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}

async function loadStatus() {
    const statusContainer = document.getElementById('fa-runtime-status');
    if (!statusContainer) return;

    try {
        const data = await apiFetch(`${API_BASE}/forum-assistant/status`);
        let html = `<span class="fa-status-badge ${data.globalEnabled ? 'active' : 'inactive'}">${data.globalEnabled ? '运行中' : '已停止'}</span>`;
        html += ` | 活跃定时器: <strong>${data.activeTimerCount || 0}</strong>`;

        if (data.agentStates && Object.keys(data.agentStates).length > 0) {
            html += '<div class="fa-agent-states">';
            for (const [name, state] of Object.entries(data.agentStates)) {
                const time = state.lastRunTime ? new Date(state.lastRunTime).toLocaleString() : '从未';
                const isError = state.lastResult && state.lastResult.startsWith('error');
                html += `<div class="fa-state-item"><span class="fa-state-name">${name}</span>`;
                html += `<span class="fa-state-time">上次: ${time}</span>`;
                html += `<span class="fa-state-result ${isError ? 'error' : 'success'}">${state.lastResult || '-'}</span>`;
                html += `</div>`;
            }
            html += '</div>';
        }
        statusContainer.innerHTML = html;
    } catch (e) {
        statusContainer.innerHTML = `<span class="status-message error">状态加载失败</span>`;
    }
}

function addAgentCard(agent) {
    const container = document.getElementById('fa-agent-cards-container');
    if (!container) return;

    const placeholder = container.querySelector('.fa-placeholder');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'aa-agent-card fa-agent-card';

    const header = document.createElement('div');
    header.className = 'aa-agent-card-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'fa-agent-name';
    nameSpan.textContent = agent.chineseName || '未命名';

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '0.5rem';

    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'aa-agent-delete-btn';
    triggerBtn.style.background = 'var(--primary-color)';
    triggerBtn.style.color = '#fff';
    triggerBtn.textContent = '立即巡航';
    triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true;
        triggerBtn.textContent = '发送中...';
        try {
            await apiFetch(`${API_BASE}/forum-assistant/trigger`, {
                method: 'POST',
                body: JSON.stringify({ agentName: agent.chineseName })
            });
            showMessage(`已触发 "${agent.chineseName}" 巡航任务。`, 'success');
        } catch (e) {
            showMessage(`触发失败：${e.message}`, 'error');
        } finally {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '立即巡航';
        }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'aa-agent-delete-btn';
    deleteBtn.textContent = '移除';
    deleteBtn.addEventListener('click', () => {
        if (confirm(`确定移除 "${agent.chineseName}" 的巡航配置吗？`)) {
            card.remove();
            if (!container.children.length) {
                container.innerHTML = '<p class="fa-placeholder">还没有配置巡航 Agent，请点击上方"添加 Agent"按钮。</p>';
            }
        }
    });

    btnGroup.appendChild(triggerBtn);
    btnGroup.appendChild(deleteBtn);
    header.appendChild(nameSpan);
    header.appendChild(btnGroup);

    const body = document.createElement('div');
    body.className = 'aa-agent-card-body';

    // 开关行
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

    // 间隔设置
    const intervalGroup = document.createElement('div');
    intervalGroup.className = 'aa-field-group aa-field-group-full';
    const intervalLabel = document.createElement('label');
    intervalLabel.textContent = '巡航间隔（分钟）';
    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.className = 'fa-agent-interval';
    intervalInput.min = '10';
    intervalInput.placeholder = '最小 10 分钟';
    intervalInput.value = agent.intervalMinutes || 60;
    const intervalHint = document.createElement('p');
    intervalHint.className = 'aa-hint';
    intervalHint.textContent = '每隔多少分钟触发一次巡航（最小 10 分钟）。定时器在保存配置后自动重启。';
    intervalGroup.appendChild(intervalLabel);
    intervalGroup.appendChild(intervalInput);
    intervalGroup.appendChild(intervalHint);

    body.appendChild(enableRow);
    body.appendChild(intervalGroup);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
}

function handleAddAgent() {
    const nameInput = document.getElementById('fa-new-agent-name');
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) {
        showMessage('请输入 Agent 的中文名。', 'info');
        return;
    }

    const container = document.getElementById('fa-agent-cards-container');
    if (container) {
        const existing = Array.from(container.querySelectorAll('.fa-agent-name')).map(el => el.textContent);
        if (existing.includes(name)) {
            showMessage(`"${name}" 已在巡航列表中。`, 'info');
            return;
        }
    }

    addAgentCard({ chineseName: name, enabled: true, intervalMinutes: 60 });
    nameInput.value = '';
    showMessage(`已添加 "${name}"。`, 'success');
}

async function saveConfig() {
    const container = document.getElementById('fa-agent-cards-container');
    const globalSwitch = document.getElementById('fa-global-enabled');
    const statusSpan = document.getElementById('fa-status');

    if (!container) return;

    const globalEnabled = globalSwitch ? globalSwitch.checked : false;
    const cards = Array.from(container.querySelectorAll('.fa-agent-card'));
    const agents = [];

    for (const card of cards) {
        const nameEl = card.querySelector('.fa-agent-name');
        const enabledInput = card.querySelector('.fa-agent-enabled');
        const intervalInput = card.querySelector('.fa-agent-interval');

        const chineseName = nameEl ? nameEl.textContent : '';
        if (!chineseName) continue;

        agents.push({
            chineseName,
            enabled: enabledInput ? enabledInput.checked : false,
            intervalMinutes: intervalInput ? parseInt(intervalInput.value) || 60 : 60
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
        showMessage('论坛巡航配置已保存，定时器已重启。', 'success');
        if (statusSpan) {
            statusSpan.textContent = '保存成功。';
            statusSpan.className = 'status-message success';
        }
        await loadStatus();
    } catch (e) {
        if (statusSpan) {
            statusSpan.textContent = `保存失败：${e.message}`;
            statusSpan.className = 'status-message error';
        }
    }
}
