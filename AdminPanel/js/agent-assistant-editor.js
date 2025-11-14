// AdminPanel/js/agent-assistant-editor.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';

// 全局状态管理
let currentAgents = [];
let currentEditingAgent = null;
let availableModels = [];
let currentConfigFormat = 'none';
let codemirrorInstance = null;

// 导入相关全局变量
let availableAgentFiles = [];
let agentMappingData = {};
let importHistory = [];
let selectedAgentFile = null;
let selectedAgentMapping = null;

// Agent数据模型
const AgentModel = {
    id: null,
    chineseName: '',
    baseName: '',
    modelId: '',
    systemPrompt: '',
    maxOutputTokens: 40000,
    temperature: 0.7,
    description: '',
    isNew: false  // 标识是否为新创建的Agent
};

/**
 * 初始化 AgentAssistant 编辑器
 */
export async function initializeAgentAssistantEditor() {
    console.log('Initializing AgentAssistant Editor...');

    // 清理现有内容
    cleanupEditor();

    try {
        // 1. 检查配置格式
        await checkConfigurationFormat();

        // 2. 加载可用模型列表
        await loadAvailableModels();

        // 3. 加载Agent配置
        await loadAgentsConfiguration();

        // 4. 渲染编辑器界面
        renderEditorInterface();

        // 5. 设置事件监听器
        setupEventListeners();

        // 6. 初始化主Agent导入功能
        initializeMainAgentImport();

        console.log('AgentAssistant Editor initialized successfully');

    } catch (error) {
        console.error('Failed to initialize AgentAssistant Editor:', error);
        showMessage(`初始化失败: ${error.message}`, 'error');
        renderErrorState(error.message);
    }
}

/**
 * 清理编辑器
 */
function cleanupEditor() {
    if (codemirrorInstance) {
        codemirrorInstance.toTextArea();
        codemirrorInstance = null;
    }
    currentAgents = [];
    currentEditingAgent = null;
    availableModels = [];
    currentConfigFormat = 'none';
}

/**
 * 渲染错误状态
 */
function renderErrorState(errorMessage) {
    const container = document.getElementById('agent-editor-container');
    if (container) {
        container.innerHTML = `
            <div class="error-state">
                <h3>初始化失败</h3>
                <p class="error-message">${errorMessage}</p>
                <button id="retry-init-button" class="primary-button">重试</button>
            </div>
        `;

        const retryButton = document.getElementById('retry-init-button');
        if (retryButton) {
            retryButton.addEventListener('click', initializeAgentAssistantEditor);
        }
    }
}

/**
 * 检查配置格式
 */
async function checkConfigurationFormat() {
    try {
        const formatInfo = await apiFetch(`${API_BASE_URL}/agent-assistant/config-format`);
        currentConfigFormat = formatInfo.currentFormat;

        updateConfigFormatDisplay(formatInfo);
        return formatInfo;
    } catch (error) {
        throw new Error(`无法检测配置格式: ${error.message}`);
    }
}

/**
 * 加载可用模型列表
 */
async function loadAvailableModels() {
    try {
        const modelsData = await apiFetch(`${API_BASE_URL}/models`);
        availableModels = modelsData.models || [];
        console.log(`Loaded ${availableModels.length} available models`);
    } catch (error) {
        console.warn('Failed to load models:', error);
        availableModels = [];
        showMessage('加载模型列表失败，将使用默认模型选项', 'warning');
    }
}

/**
 * 加载Agent配置
 */
async function loadAgentsConfiguration() {
    console.log('🔄 [AgentAssistant] 加载Agent配置...');

    try {
        console.log('📡 [AgentAssistant] 发起API请求:', `${API_BASE_URL}/agent-assistant/agents`);

        const agentsData = await apiFetch(`${API_BASE_URL}/agent-assistant/agents`);

        console.log('✅ [AgentAssistant] API响应数据:', {
            hasResponse: !!agentsData,
            agentCount: agentsData.agents?.length || 0,
            hasGlobalSystemPrompt: !!agentsData.globalSystemPrompt,
            globalSystemPromptLength: agentsData.globalSystemPrompt?.length || 0
        });

        const newAgents = agentsData.agents || [];
        const globalSystemPrompt = agentsData.globalSystemPrompt || "";

        // 更新全局状态
        currentAgents = newAgents;

        // 更新全局提示词字段
        const globalPromptElement = document.getElementById('global-system-prompt');
        if (globalPromptElement && globalPromptElement.value !== globalSystemPrompt) {
            globalPromptElement.value = globalSystemPrompt;
        }

        console.log(`✅ [AgentAssistant] 成功加载 ${currentAgents.length} 个agents配置`);

        // 如果当前正在编辑的Agent在新的列表中不存在，清空编辑状态
        if (currentEditingAgent && currentAgents.length > 0) {
            const agentStillExists = currentAgents.some(agent =>
                agent.chineseName === currentEditingAgent.chineseName &&
                agent.modelId === currentEditingAgent.modelId
            );
            if (!agentStillExists) {
                console.log('🗑️ [AgentAssistant] 当前编辑的Agent已被删除，清空编辑状态');
                currentEditingAgent = null;
            }
        }

        // 如果正在渲染界面，重新渲染
        if (currentEditingAgent) {
            renderAgentEditor();
        } else {
            renderAgentEditor();
        }

        return currentAgents;

    } catch (error) {
        console.error('❌ [AgentAssistant] 加载配置失败:', error);

        if (error.status === 404) {
            // 没有现有配置，创建空配置
            console.log('ℹ️ [AgentAssistant] 没有现有配置，使用空配置');
            currentAgents = [];
            const globalPromptElement = document.getElementById('global-system-prompt');
            if (globalPromptElement) {
                globalPromptElement.value = '';
            }
        } else {
            const errorMessage = `无法加载Agent配置: ${error.message}`;
            console.error('❌ [AgentAssistant] 错误详情:', {
                message: error.message,
                status: error.status,
                details: error.details,
                stack: error.stack
            });

            showMessage(errorMessage, 'error');
            throw new Error(errorMessage);
        }

        return currentAgents;
    }
}

/**
 * 保存Agent配置
 */
async function saveAgentsConfiguration() {
    console.log('🔄 [AgentAssistant] 开始保存配置...');

    try {
        const configData = {
            agents: currentAgents,
            globalSystemPrompt: document.getElementById('global-system-prompt')?.value || ''
        };

        console.log('📊 [AgentAssistant] 准备保存的数据:', {
            agentCount: configData.agents.length,
            globalSystemPromptLength: configData.globalSystemPrompt.length,
            agents: configData.agents.map(a => ({
                chineseName: a.chineseName,
                modelId: a.modelId,
                hasSystemPrompt: !!a.systemPrompt
            }))
        });

        // 显示加载状态
        showMessage('正在保存Agent配置...', 'info');
        updateSaveStatus('正在保存...', 'info');

        // 执行API调用
        const response = await apiFetch(`${API_BASE_URL}/agent-assistant/agents`, {
            method: 'POST',
            body: JSON.stringify(configData)
        });

        console.log('✅ [AgentAssistant] API响应:', response);

        // 验证响应数据
        if (!response || !response.message) {
            throw new Error('API返回数据格式错误');
        }

        // 保存成功的消息
        showMessage(`Agent配置保存成功 (${configData.agents.length} 个Agent)`, 'success');
        updateSaveStatus('已保存', 'success');

        // 等待短暂时间确保文件写入完成，然后重新加载
        console.log('⏳ [AgentAssistant] 等待文件写入完成...');
        await new Promise(resolve => setTimeout(resolve, 500));

        // 重新加载以获取最新状态
        console.log('🔄 [AgentAssistant] 重新加载配置...');
        await loadAgentsConfiguration();

        console.log('✅ [AgentAssistant] 配置保存和重新加载完成');

    } catch (error) {
        console.error('❌ [AgentAssistant] 保存配置失败:', error);

        // 更详细的错误信息
        let errorMessage = `保存失败: ${error.message}`;
        if (error.status) {
            errorMessage += ` (HTTP ${error.status})`;
        }
        if (error.details) {
            errorMessage += ` - ${error.details}`;
        }

        showMessage(errorMessage, 'error');
        updateSaveStatus('保存失败', 'error');

        // 详细错误日志
        console.error('❌ [AgentAssistant] 错误详情:', {
            message: error.message,
            status: error.status,
            details: error.details,
            stack: error.stack,
            configData: {
                agentCount: currentAgents.length,
                globalSystemPromptLength: (document.getElementById('global-system-prompt')?.value || '').length
            }
        });

        throw error;
    }
}

/**
 * 渲染编辑器界面
 */
function renderEditorInterface() {
    renderAgentList();
    renderAgentEditor();
}

/**
 * 渲染Agent列表
 */
function renderAgentList() {
    const container = document.getElementById('agent-list-container');
    if (!container) return;

    if (currentAgents.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>暂无配置的 Agent</p>
                <button id="create-first-agent-button" class="primary-button">创建第一个 Agent</button>
            </div>
        `;

        const createButton = document.getElementById('create-first-agent-button');
        if (createButton) {
            createButton.addEventListener('click', addNewAgent);
        }
        return;
    }

    const agentListHTML = currentAgents.map((agent, index) => `
        <div class="agent-list-item ${agent === currentEditingAgent ? 'active' : ''}"
             data-agent-index="${index}" onclick="selectAgent(${index})">
            <div class="agent-info">
                <h4>${agent.chineseName}</h4>
                <p class="agent-meta">${agent.description || '暂无描述'}</p>
                <span class="model-badge">${agent.modelId}</span>
            </div>
            <div class="agent-actions">
                <button class="edit-agent-button" onclick="event.stopPropagation(); selectAgent(${index})">编辑</button>
                <button class="delete-agent-button" onclick="event.stopPropagation(); deleteAgent(${index})">删除</button>
            </div>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="agent-list">
            ${agentListHTML}
        </div>
    `;
}

/**
 * 渲染Agent编辑器
 */
function renderAgentEditor() {
    const container = document.getElementById('agent-editor-container');
    if (!container) return;

    if (!currentEditingAgent) {
        container.innerHTML = `
            <div class="editor-placeholder">
                <p>选择一个 Agent 进行编辑，或创建新的 Agent</p>
            </div>
        `;
        return;
    }

    const agent = currentEditingAgent;
    container.innerHTML = `
        <div class="agent-editor-form">
            <div class="form-row">
                <label for="agent-chinese-name">Agent 名称 *</label>
                <input type="text" id="agent-chinese-name" value="${agent.chineseName}"
                       placeholder="例如：ResearchBot" required>
            </div>

            <div class="form-row">
                <label for="agent-base-name">基础名称</label>
                <input type="text" id="agent-base-name" value="${agent.baseName}"
                       placeholder="例如：RESEARCH_HELPER" readonly>
                <small class="form-help">自动生成，用于内部标识</small>
            </div>

            <div class="form-row">
                <label for="agent-model-select">模型选择 *</label>
                <div class="model-select-container">
                    <select id="agent-model-select" required>
                        <option value="">请选择模型...</option>
                        ${availableModels.map(model => `
                            <option value="${model.value}" ${model.value === agent.modelId ? 'selected' : ''}>
                                ${model.value}
                            </option>
                        `).join('')}
                    </select>
                    <button type="button" id="refresh-models-button" class="refresh-models-button" title="从API刷新模型列表" onclick="refreshModelsFromAPI()">
                        <span class="refresh-icon">🔄</span>
                    </button>
                </div>
                <small class="form-help">
                    点击刷新按钮从配置的API地址获取最新模型列表
                </small>
            </div>

            <div class="form-row">
                <label for="agent-description">描述</label>
                <input type="text" id="agent-description" value="${agent.description || ''}"
                       placeholder="Agent 功能描述">
            </div>

            <div class="form-row form-row-inline">
                <div class="form-field">
                    <label for="agent-max-tokens">最大输出 Token 数</label>
                    <input type="number" id="agent-max-tokens" value="${agent.maxOutputTokens || 40000}"
                           min="100" max="100000" step="100">
                </div>
                <div class="form-field">
                    <label for="agent-temperature">温度参数</label>
                    <input type="number" id="agent-temperature" value="${agent.temperature || 0.7}"
                           min="0" max="2" step="0.1">
                </div>
            </div>

            <div class="form-row">
                <label for="agent-system-prompt">系统提示词 *</label>
                <div class="codemirror-container">
                    <textarea id="agent-system-prompt" class="codemirror-textarea"></textarea>
                </div>
                <small class="form-help">
                    支持 {{MaidName}}、{{Date}}、{{Time}} 等占位符
                </small>
            </div>

            <div class="form-actions">
                <button id="save-agent-button" class="primary-button">保存 Agent</button>
                <button id="cancel-edit-button" class="secondary-button">取消编辑</button>
            </div>
        </div>
    `;

    // 初始化CodeMirror编辑器
    initializeCodeMirrorEditor(agent.systemPrompt || '');

    // 设置表单监听器
    setupFormListeners();
}

/**
 * 初始化CodeMirror编辑器
 */
function initializeCodeMirrorEditor(initialContent) {
    const textarea = document.getElementById('agent-system-prompt');
    if (!textarea) return;

    // 移除现有的CodeMirror实例
    if (codemirrorInstance) {
        codemirrorInstance.toTextArea();
    }

    // 创建新的CodeMirror实例
    codemirrorInstance = CodeMirror.fromTextArea(textarea, {
        mode: 'markdown',
        lineNumbers: true,
        theme: 'default',
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        extraKeys: {
            'Ctrl-S': function() {
                saveCurrentAgent();
            }
        }
    });

    // 设置初始内容
    codemirrorInstance.setValue(initialContent);

    // 添加占位符高亮
    highlightPlaceholders();

    // 监听内容变化
    codemirrorInstance.on('change', function() {
        updateAgentForm();
    });
}

/**
 * 占位符语法高亮
 */
function highlightPlaceholders() {
    if (!codemirrorInstance) return;

    // 自定义占位符高亮
    const placeholderRegex = /\{\{[^}]+\}\}/g;
    try {
        codemirrorInstance.operation(function() {
            codemirrorInstance.eachLine(function(lineHandle) {
                // CodeMirror eachLine回调参数是lineHandle
                const lineNumber = codemirrorInstance.getLineNumber(lineHandle);
                if (lineNumber >= 0) { // 验证行号有效性
                    const lineText = codemirrorInstance.getLine(lineNumber) || '';
                    if (placeholderRegex.test(lineText)) {
                        codemirrorInstance.addLineClass(lineHandle, 'background', 'placeholder-highlight');
                    } else {
                        codemirrorInstance.removeLineClass(lineHandle, 'background', 'placeholder-highlight');
                    }
                }
            });
        });
    } catch (error) {
        console.warn('占位符高亮失败:', error.message);
    }
}

/**
 * 选择Agent
 */
function selectAgent(index) {
    if (index >= 0 && index < currentAgents.length) {
        currentEditingAgent = { ...currentAgents[index] };
        renderAgentEditor();
    }
}

/**
 * 添加新Agent
 */
function addNewAgent() {
    const newAgent = {
        ...AgentModel,
        chineseName: '',
        baseName: '',
        modelId: '',
        systemPrompt: '',
        isNew: true
    };

    currentEditingAgent = newAgent;
    renderAgentEditor();

    // 聚焦到名称输入框
    setTimeout(() => {
        const nameInput = document.getElementById('agent-chinese-name');
        if (nameInput) nameInput.focus();
    }, 100);
}

/**
 * 删除Agent
 */
function deleteAgent(index) {
    if (index < 0 || index >= currentAgents.length) return;

    const agent = currentAgents[index];
    if (!confirm(`确定要删除 Agent "${agent.chineseName}" 吗？`)) {
        return;
    }

    currentAgents.splice(index, 1);

    // 如果删除的是当前编辑的Agent，清空编辑器
    if (currentEditingAgent === agent) {
        currentEditingAgent = null;
    }

    renderAgentList();
    if (!currentEditingAgent) {
        renderAgentEditor();
    }

    showMessage(`Agent "${agent.chineseName}" 已删除`, 'success');
}

/**
 * 保存当前Agent
 */
function saveCurrentAgent() {
    if (!currentEditingAgent) return;

    // 验证表单
    if (!validateAgentForm()) {
        return;
    }

    // 更新Agent数据
    updateAgentFromForm();

    // 保存到配置
    const existingIndex = currentAgents.findIndex(a =>
        a.chineseName === currentEditingAgent.chineseName
    );

    if (existingIndex >= 0) {
        // 更新现有Agent
        currentAgents[existingIndex] = { ...currentEditingAgent };
    } else {
        // 添加新Agent
        currentAgents.push({ ...currentEditingAgent });
        currentEditingAgent.isNew = false;
    }

    // 重新渲染列表
    renderAgentList();

    // 如果是新创建的，清空编辑状态
    if (currentEditingAgent.isNew) {
        currentEditingAgent = null;
        renderAgentEditor();
    }

    showMessage('Agent 保存成功', 'success');
}

/**
 * 验证Agent表单
 */
function validateAgentForm() {
    const nameInput = document.getElementById('agent-chinese-name');
    const modelSelect = document.getElementById('agent-model-select');
    const promptTextarea = document.getElementById('agent-system-prompt');

    if (!nameInput.value.trim()) {
        showMessage('请输入Agent名称', 'error');
        nameInput.focus();
        return false;
    }

    if (!modelSelect.value) {
        showMessage('请选择模型', 'error');
        modelSelect.focus();
        return false;
    }

    // 修复：检查CodeMirror编辑器的值而不是原始textarea的值
    const systemPromptContent = codemirrorInstance ? codemirrorInstance.getValue().trim() : promptTextarea.value.trim();
    if (!systemPromptContent) {
        showMessage('请输入系统提示词', 'error');
        if (codemirrorInstance) {
            codemirrorInstance.focus();
        } else {
            promptTextarea.focus();
        }
        return false;
    }

    return true;
}

/**
 * 从表单更新Agent数据
 */
function updateAgentFromForm() {
    if (!currentEditingAgent) return;

    currentEditingAgent.chineseName = document.getElementById('agent-chinese-name').value.trim();
    currentEditingAgent.baseName = generateBaseName(currentEditingAgent.chineseName);
    currentEditingAgent.modelId = document.getElementById('agent-model-select').value;
    currentEditingAgent.description = document.getElementById('agent-description').value.trim();
    currentEditingAgent.maxOutputTokens = parseInt(document.getElementById('agent-max-tokens').value) || 40000;
    currentEditingAgent.temperature = parseFloat(document.getElementById('agent-temperature').value) || 0.7;
    currentEditingAgent.systemPrompt = codemirrorInstance ? codemirrorInstance.getValue() : '';
}

/**
 * 更新Agent表单
 */
function updateAgentForm() {
    if (!currentEditingAgent) return;

    const nameInput = document.getElementById('agent-chinese-name');
    if (nameInput && nameInput.value !== currentEditingAgent.chineseName) {
        currentEditingAgent.chineseName = nameInput.value;
        const baseNameInput = document.getElementById('agent-base-name');
        if (baseNameInput) {
            baseNameInput.value = generateBaseName(nameInput.value);
        }
    }
}

/**
 * 生成基础名称
 */
function generateBaseName(chineseName) {
    return chineseName
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toUpperCase()
        .substring(0, 50);
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
    // 工具栏按钮
    const addButton = document.getElementById('add-agent-button');
    const saveButton = document.getElementById('save-all-agents-button');
    const migrateButton = document.getElementById('migrate-to-json-button');

    if (addButton && !addButton.dataset.listenerAttached) {
        addButton.addEventListener('click', addNewAgent);
        addButton.dataset.listenerAttached = 'true';
    }

    if (saveButton && !saveButton.dataset.listenerAttached) {
        saveButton.addEventListener('click', saveAgentsConfiguration);
        saveButton.dataset.listenerAttached = 'true';
    }

    if (migrateButton && !migrateButton.dataset.listenerAttached) {
        migrateButton.addEventListener('click', migrateConfigToJSON);
        migrateButton.dataset.listenerAttached = 'true';
    }

    // 表单事件
    setupFormListeners();
}

/**
 * 设置表单监听器
 */
function setupFormListeners() {
    const chineseNameInput = document.getElementById('agent-chinese-name');
    const saveAgentButton = document.getElementById('save-agent-button');
    const cancelEditButton = document.getElementById('cancel-edit-button');
    const previewButton = document.getElementById('preview-placeholders-button');

    if (chineseNameInput && !chineseNameInput.dataset.listenerAttached) {
        chineseNameInput.addEventListener('input', function() {
            const baseNameInput = document.getElementById('agent-base-name');
            if (baseNameInput) {
                baseNameInput.value = generateBaseName(this.value);
            }
        });
        chineseNameInput.dataset.listenerAttached = 'true';
    }

    if (saveAgentButton && !saveAgentButton.dataset.listenerAttached) {
        saveAgentButton.addEventListener('click', saveCurrentAgent);
        saveAgentButton.dataset.listenerAttached = 'true';
    }

    // 刷新模型列表按钮
    const refreshModelsButton = document.getElementById('refresh-models-button');
    console.log('查找刷新按钮:', refreshModelsButton); // 调试日志
    if (refreshModelsButton && !refreshModelsButton.dataset.listenerAttached) {
        console.log('绑定刷新按钮事件监听器'); // 调试日志
        // 添加多种绑定方式确保事件被正确绑定
        refreshModelsButton.addEventListener('click', refreshModelsFromAPI);
        refreshModelsButton.onclick = refreshModelsFromAPI; // 备用绑定
        refreshModelsButton.dataset.listenerAttached = 'true';
    } else if (!refreshModelsButton) {
        console.warn('未找到刷新按钮元素'); // 调试日志
        // 延迟重试
        setTimeout(() => {
            const retryButton = document.getElementById('refresh-models-button');
            if (retryButton) {
                console.log('延迟绑定刷新按钮事件监听器');
                retryButton.addEventListener('click', refreshModelsFromAPI);
                retryButton.onclick = refreshModelsFromAPI;
            }
        }, 100);
    }

    if (cancelEditButton && !cancelEditButton.dataset.listenerAttached) {
        cancelEditButton.addEventListener('click', function() {
            currentEditingAgent = null;
            renderAgentEditor();
        });
        cancelEditButton.dataset.listenerAttached = 'true';
    }
}

/**
 * 更新配置格式显示
 */
function updateConfigFormatDisplay(formatInfo) {
    const display = document.getElementById('config-format-display');
    const migrateButton = document.getElementById('migrate-to-json-button');

    if (!display) return;

    const formatMap = {
        'json': { text: 'JSON格式', class: 'format-json' },
        'env': { text: 'ENV格式', class: 'format-env' },
        'none': { text: '未配置', class: 'format-none' }
    };

    const format = formatMap[formatInfo.currentFormat] || formatMap['none'];
    display.textContent = format.text;
    display.className = `format-badge ${format.class}`;

    if (migrateButton) {
        migrateButton.style.display = formatInfo.canMigrate ? 'inline-block' : 'none';
    }
}

/**
 * 迁移配置到JSON格式
 */
async function migrateConfigToJSON() {
    try {
        showMessage('正在迁移配置...', 'info');
        await apiFetch(`${API_BASE_URL}/agent-assistant/migrate-to-json`, { method: 'POST' });
        showMessage('配置迁移成功', 'success');
        await checkConfigurationFormat();
    } catch (error) {
        showMessage(`迁移失败: ${error.message}`, 'error');
    }
}

/**
 * 更新保存状态
 */
function updateSaveStatus(message, type) {
    const statusSpan = document.getElementById('agents-save-status');
    if (statusSpan) {
        statusSpan.textContent = message;
        statusSpan.className = `status-message ${type}`;
    }
}

/**
 * 清理编辑器资源
 */
export function cleanupAgentAssistantEditor() {
    cleanupEditor();
}



/**
 * 初始化主Agent导入功能
 */
function initializeMainAgentImport() {
    // 设置导入按钮事件
    setupImportButtons();

    // 设置模态框事件
    setupModalEvents();

    // 加载Agent文件列表
    loadMainAgentFiles();

    // 加载Agent映射
    loadAgentMapping();

    // 加载导入历史
    loadImportHistory();

    console.log('主Agent导入功能已初始化');
}

/**
 * 设置导入按钮事件
 */
function setupImportButtons() {
    const importButton = document.getElementById('import-from-agent-button');
    const historyButton = document.getElementById('import-history-button');

    if (importButton && !importButton.dataset.listenerAttached) {
        importButton.addEventListener('click', openImportModal);
        importButton.dataset.listenerAttached = 'true';
    }

    if (historyButton && !historyButton.dataset.listenerAttached) {
        historyButton.addEventListener('click', openImportHistory);
        historyButton.dataset.listenerAttached = 'true';
    }
}

/**
 * 设置模态框事件
 */
function setupModalEvents() {
    // 导入模态框
    const importModal = document.getElementById('agent-import-modal');
    const closeImportModal = document.getElementById('close-import-modal');
    const cancelImportButton = document.getElementById('cancel-import-button');
    const confirmImportButton = document.getElementById('confirm-import-button');
    const previewRefreshButton = document.getElementById('preview-refresh-button');

    if (closeImportModal && !closeImportModal.dataset.listenerAttached) {
        closeImportModal.addEventListener('click', closeModal);
        closeImportModal.dataset.listenerAttached = 'true';
    }

    if (cancelImportButton && !cancelImportButton.dataset.listenerAttached) {
        cancelImportButton.addEventListener('click', closeModal);
        cancelImportButton.dataset.listenerAttached = 'true';
    }

    if (confirmImportButton && !confirmImportButton.dataset.listenerAttached) {
        confirmImportButton.addEventListener('click', confirmImport);
        confirmImportButton.dataset.listenerAttached = 'true';
    }

    if (previewRefreshButton && !previewRefreshButton.dataset.listenerAttached) {
        previewRefreshButton.addEventListener('click', refreshFilePreview);
        previewRefreshButton.dataset.listenerAttached = 'true';
    }

    // 历史模态框
    const historyModal = document.getElementById('import-history-modal');
    const closeHistoryModalBtn = document.getElementById('close-history-modal');
    const closeHistoryButton = document.getElementById('close-history-button');

    if (closeHistoryModalBtn && !closeHistoryModalBtn.dataset.listenerAttached) {
        closeHistoryModalBtn.addEventListener('click', closeHistoryModal);
        closeHistoryModalBtn.dataset.listenerAttached = 'true';
    }

    if (closeHistoryButton && !closeHistoryButton.dataset.listenerAttached) {
        closeHistoryButton.addEventListener('click', closeHistoryModal);
        closeHistoryButton.dataset.listenerAttached = 'true';
    }

    // 点击模态框背景关闭
    if (importModal && !importModal.dataset.listenerAttached) {
        importModal.addEventListener('click', function(e) {
            if (e.target === this) closeModal();
        });
        importModal.dataset.listenerAttached = 'true';
    }

    if (historyModal && !historyModal.dataset.listenerAttached) {
        historyModal.addEventListener('click', function(e) {
            if (e.target === this) closeHistoryModal();
        });
        historyModal.dataset.listenerAttached = 'true';
    }
}

/**
 * 加载主Agent文件列表
 */
async function loadMainAgentFiles() {
    try {
        const filesData = await apiFetch(`${API_BASE_URL}/agents`);
        availableAgentFiles = filesData.files || [];
        console.log(`Loaded ${availableAgentFiles.length} main agent files`);
    } catch (error) {
        console.error('Failed to load main agent files:', error);
        availableAgentFiles = [];
        showMessage('加载主Agent文件失败', 'error');
    }
}

/**
 * 加载Agent映射
 */
async function loadAgentMapping() {
    try {
        agentMappingData = await apiFetch(`${API_BASE_URL}/agents/map`);
        console.log('Loaded agent mapping:', agentMappingData);
    } catch (error) {
        console.error('Failed to load agent mapping:', error);
        agentMappingData = {};
    }
}

/**
 * 加载Agent文件内容
 */
async function loadAgentFileContent(fileName) {
    try {
        const fileData = await apiFetch(`${API_BASE_URL}/agents/${fileName}`);
        return fileData.content || '';
    } catch (error) {
        console.error(`Failed to load agent file ${fileName}:`, error);
        return '';
    }
}

/**
 * 加载导入历史
 */
function loadImportHistory() {
    try {
        const historyData = localStorage.getItem('agentAssistantImportHistory');
        importHistory = historyData ? JSON.parse(historyData) : [];
        console.log(`Loaded ${importHistory.length} import history records`);
    } catch (error) {
        console.error('Failed to load import history:', error);
        importHistory = [];
    }
}

/**
 * 保存导入历史
 */
function saveImportHistory() {
    try {
        localStorage.setItem('agentAssistantImportHistory', JSON.stringify(importHistory));
    } catch (error) {
        console.error('Failed to save import history:', error);
    }
}

/**
 * 打开导入模态框
 */
function openImportModal() {
    const modal = document.getElementById('agent-import-modal');
    if (!modal) return;

    // 渲染Agent文件列表
    renderAgentFilesGrid();

    // 渲染Agent映射列表
    renderAgentMappingList();

    // 显示模态框
    modal.style.display = 'flex';

    // 聚焦到模态框
    modal.focus();
}

/**
 * 关闭模态框
 */
function closeModal() {
    const modal = document.getElementById('agent-import-modal');
    if (!modal) return;

    modal.style.display = 'none';

    // 重置状态
    selectedAgentFile = null;
    selectedAgentMapping = null;
}

/**
 * 打开导入历史
 */
function openImportHistory() {
    const modal = document.getElementById('import-history-modal');
    if (!modal) return;

    renderImportHistory();
    modal.style.display = 'flex';
}

/**
 * 关闭导入历史
 */
function closeHistoryModal() {
    const modal = document.getElementById('import-history-modal');
    if (!modal) return;

    modal.style.display = 'none';
}

/**
 * 渲染Agent文件网格
 */
function renderAgentFilesGrid() {
    const container = document.getElementById('agent-files-grid');
    if (!container) return;

    if (availableAgentFiles.length === 0) {
        container.innerHTML = '<p class="no-files">暂无Agent文件</p>';
        return;
    }

    const filesHTML = availableAgentFiles.map(fileName => {
        const isSelected = selectedAgentFile === fileName;
        return `
            <div class="agent-file-item ${isSelected ? 'selected' : ''}"
                 data-file="${fileName}" onclick="selectAgentFile('${fileName}')">
                <div class="file-icon">📄</div>
                <div class="file-info">
                    <div class="file-name">${fileName}</div>
                    <div class="file-size">${getFileSize(fileName)}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = filesHTML;
}

/**
 * 渲染Agent映射列表
 */
function renderAgentMappingList() {
    const container = document.getElementById('agent-mapping-list');
    if (!container) return;

    const mappingEntries = Object.entries(agentMappingData);

    if (mappingEntries.length === 0) {
        container.innerHTML = '<p class="no-mappings">暂无Agent映射</p>';
        return;
    }

    const mappingsHTML = mappingEntries.map(([alias, fileName]) => {
        const isSelected = selectedAgentMapping === alias;
        return `
            <div class="agent-mapping-item ${isSelected ? 'selected' : ''}"
                 data-alias="${alias}" onclick="selectAgentMapping('${alias}')">
                <div class="mapping-info">
                    <div class="alias-name">${alias}</div>
                    <div class="mapped-file">${fileName}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = mappingsHTML;
}

/**
 * 渲染导入历史
 */
function renderImportHistory() {
    const container = document.getElementById('import-history-list');
    if (!container) return;

    if (importHistory.length === 0) {
        container.innerHTML = '<p class="no-history">暂无导入历史</p>';
        return;
    }

    const historyHTML = importHistory.slice(0, 20).map((record, index) => {
        const date = new Date(record.timestamp).toLocaleString();
        return `
            <div class="history-item" data-index="${index}">
                <div class="history-info">
                    <div class="source-file">${record.sourceFile}</div>
                    <div class="import-options">
                        ${record.options.append ? '追加' : '替换'} |
                        ${record.options.keepPlaceholders ? '保留占位符' : '替换占位符'}
                    </div>
                    <div class="import-date">${date}</div>
                </div>
                <div class="history-actions">
                    <button class="text-button" onclick="reimportFromHistory(${index})">重新导入</button>
                    <button class="text-button" onclick="deleteHistoryItem(${index})">删除</button>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = historyHTML;
}

/**
 * 选择Agent文件
 */
function selectAgentFile(fileName) {
    selectedAgentFile = fileName;
    selectedAgentMapping = null; // 清除映射选择

    // 更新UI
    updateFileSelection();
    updateMappingSelection();

    // 刷新文件预览
    updateFilePreview();
}

/**
 * 选择Agent映射
 */
function selectAgentMapping(alias) {
    selectedAgentMapping = alias;
    selectedAgentFile = agentMappingData[alias] || null; // 根据映射获取文件名

    // 更新UI
    updateFileSelection();
    updateMappingSelection();

    // 刷新文件预览
    updateFilePreview();
}

/**
 * 更新文件选择状态
 */
function updateFileSelection() {
    const items = document.querySelectorAll('.agent-file-item');
    items.forEach(item => {
        const fileName = item.dataset.file;
        if (fileName === selectedAgentFile) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

/**
 * 更新映射选择状态
 */
function updateMappingSelection() {
    const items = document.querySelectorAll('.agent-mapping-item');
    items.forEach(item => {
        const alias = item.dataset.alias;
        if (alias === selectedAgentMapping) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

/**
 * 更新文件预览
 */
async function updateFilePreview() {
    const previewElement = document.getElementById('agent-file-preview');
    const fileNameElement = document.getElementById('selected-file-name');
    const confirmButton = document.getElementById('confirm-import-button');

    if (!previewElement) return;

    if (!selectedAgentFile) {
        previewElement.textContent = '选择Agent文件以预览内容...';
        if (fileNameElement) fileNameElement.textContent = '请选择一个文件...';
        if (confirmButton) confirmButton.disabled = true;
        return;
    }

    // 显示文件名
    if (fileNameElement) {
        fileNameElement.textContent = selectedAgentFile;
    }

    // 显示加载状态
    previewElement.textContent = '正在加载文件内容...';

    try {
        const content = await loadAgentFileContent(selectedAgentFile);

        if (content) {
            // 显示文件内容（限制长度）
            const previewContent = content.length > 1000
                ? content.substring(0, 1000) + '\n\n... (内容已截断)'
                : content;

            previewElement.textContent = previewContent;

            // 启用导入按钮
            if (confirmButton) confirmButton.disabled = false;
        } else {
            previewElement.textContent = '文件内容为空或无法读取';
            if (confirmButton) confirmButton.disabled = true;
        }
    } catch (error) {
        previewElement.textContent = `加载文件失败: ${error.message}`;
        if (confirmButton) confirmButton.disabled = true;
    }
}

/**
 * 刷新文件预览
 */
function refreshFilePreview() {
    updateFilePreview();
}

/**
 * 确认导入
 */
async function confirmImport() {
    if (!selectedAgentFile) {
        showMessage('请选择一个Agent文件', 'error');
        return;
    }

    try {
        // 获取文件内容
        const content = await loadAgentFileContent(selectedAgentFile);
        if (!content) {
            showMessage('无法读取文件内容', 'error');
            return;
        }

        // 获取导入选项
        const options = {
            append: document.getElementById('append-to-existing').checked,
            keepPlaceholders: document.getElementById('keep-placeholders').checked,
            asTemplate: document.getElementById('import-as-template').checked
        };

        // 执行导入
        const success = await executeImport(content, options);

        if (success) {
            // 添加到历史记录
            addToImportHistory({
                sourceFile: selectedAgentFile,
                targetAgent: currentEditingAgent?.chineseName || '未知',
                options: options,
                timestamp: new Date().toISOString()
            });

            // 关闭模态框
            closeModal();

            // 显示成功消息
            showMessage('Agent配置导入成功', 'success');
        }

    } catch (error) {
        console.error('导入失败:', error);
        showMessage(`导入失败: ${error.message}`, 'error');
    }
}

/**
 * 执行导入操作
 */
async function executeImport(content, options) {
    if (!codemirrorInstance) {
        throw new Error('编辑器未初始化');
    }

    let finalContent = content;

    // 处理占位符
    if (!options.keepPlaceholders) {
        finalContent = content.replace(/\{\{([^}]+)\}\}/g, '[占位符已移除]');
    }

    // 获取当前编辑器内容
    const currentContent = codemirrorInstance.getValue();

    let newContent;
    if (options.asTemplate) {
        // 模板模式：不修改当前内容，只更新显示
        newContent = currentContent;
        showMessage('以模板模式导入，请手动处理内容', 'info');
    } else if (options.append) {
        // 追加模式
        newContent = currentContent + '\n\n' + finalContent;
    } else {
        // 替换模式
        newContent = finalContent;
    }

    // 更新编辑器内容
    codemirrorInstance.setValue(newContent);

    return true;
}

/**
 * 添加到导入历史
 */
function addToImportHistory(record) {
    importHistory.unshift(record); // 添加到开头

    // 限制历史记录数量
    if (importHistory.length > 50) {
        importHistory = importHistory.slice(0, 50);
    }

    // 保存到本地存储
    saveImportHistory();

    // 更新历史按钮显示
    updateHistoryButton();
}

/**
 * 重新导入历史记录
 */
function reimportFromHistory(index) {
    if (index < 0 || index >= importHistory.length) return;

    const record = importHistory[index];

    // 设置选项
    document.getElementById('append-to-existing').checked = record.options.append;
    document.getElementById('keep-placeholders').checked = record.options.keepPlaceholders;
    document.getElementById('import-as-template').checked = record.options.asTemplate;

    // 自动选择源文件
    if (record.sourceFile && availableAgentFiles.includes(record.sourceFile)) {
        selectAgentFile(record.sourceFile);
    }

    showMessage('已从历史记录恢复设置，请确认后导入', 'info');
}

/**
 * 删除历史记录
 */
function deleteHistoryItem(index) {
    if (index < 0 || index >= importHistory.length) return;

    if (confirm('确定要删除这条导入历史吗？')) {
        importHistory.splice(index, 1);
        saveImportHistory();
        renderImportHistory();
        updateHistoryButton();
        showMessage('历史记录已删除', 'success');
    }
}

/**
 * 更新历史按钮显示
 */
function updateHistoryButton() {
    const historyButton = document.getElementById('import-history-button');
    if (historyButton) {
        const hasHistory = importHistory.length > 0;
        historyButton.style.display = hasHistory ? 'inline-block' : 'none';

        if (hasHistory) {
            historyButton.textContent = `导入历史 (${importHistory.length})`;
        }
    }
}

/**
 * 获取文件大小描述（估算）
 */
function getFileSize(fileName) {
    // 这里可以根据实际文件大小进行估算
    return '~1KB';
}

// 全局函数，供HTML调用
window.selectAgent = selectAgent;
window.deleteAgent = deleteAgent;
window.addNewAgent = addNewAgent;
window.saveCurrentAgent = saveCurrentAgent;
window.selectAgentFile = selectAgentFile;
window.selectAgentMapping = selectAgentMapping;
window.reimportFromHistory = reimportFromHistory;
window.deleteHistoryItem = deleteHistoryItem;
window.refreshModelsFromAPI = refreshModelsFromAPI; // 添加刷新函数到全局作用域

/**
 * 从API刷新模型列表
 */
async function refreshModelsFromAPI() {
    console.log('🔥 refreshModelsFromAPI 函数被调用！'); // 调试日志
    const refreshButton = document.getElementById('refresh-models-button');
    const modelSelect = document.getElementById('agent-model-select');

    console.log('刷新按钮:', refreshButton);
    console.log('模型选择框:', modelSelect);

    if (!refreshButton || !modelSelect) {
        console.warn('缺少必要的DOM元素');
        return;
    }

    try {
        // 显示加载状态
        refreshButton.disabled = true;
        refreshButton.classList.add('loading');
        refreshButton.title = '正在刷新模型列表...';

        showMessage('正在从API刷新模型列表...', 'info');

        // 调用新的API端点
        const response = await apiFetch(`${API_BASE_URL}/models/refresh`);

        // 检查响应数据结构
        if (!response.models || !Array.isArray(response.models)) {
            throw new Error('API返回的数据格式不正确');
        }

        // 更新模型列表
        const newModels = response.models;
        const previousSelectedValue = modelSelect.value;

        // 清空并重新填充选项
        modelSelect.innerHTML = '<option value="">请选择模型...</option>';

        newModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.value;
            option.textContent = model.name;
            modelSelect.appendChild(option);
        });

        // 如果之前选中的模型仍然存在，保持选中状态
        if (previousSelectedValue && newModels.some(m => m.value === previousSelectedValue)) {
            modelSelect.value = previousSelectedValue;
        }

        // 更新全局模型列表
        availableModels = newModels;

        // 显示成功消息
        const message = `成功刷新模型列表，共获取 ${newModels.length} 个模型`;
        showMessage(message, 'success');

        console.log(`[AgentAssistant] 刷新模型列表完成:`, {
            total_models: newModels.length,
            source: response.source,
            timestamp: response.timestamp
        });

    } catch (error) {
        console.error('刷新模型列表失败:', error);

        let errorMessage = '刷新模型列表失败';
        if (error.message.includes('API configuration missing')) {
            errorMessage = 'API配置缺失，请在config.env中配置API_Key和API_URL';
        } else if (error.message.includes('API request failed')) {
            errorMessage = 'API请求失败，请检查API_Key和API_URL是否正确';
        } else if (error.message) {
            errorMessage = `刷新失败: ${error.message}`;
        }

        showMessage(errorMessage, 'error');
    } finally {
        // 恢复按钮状态
        refreshButton.disabled = false;
        refreshButton.classList.remove('loading');
        refreshButton.title = '从API刷新模型列表';
    }
}