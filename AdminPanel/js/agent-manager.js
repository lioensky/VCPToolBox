// AdminPanel/js/agent-manager.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let currentEditingAgentFile = null;
let availableAgentFiles = [];
let folderStructure = {};

/**
 * 初始化 Agent 管理器。
 */
export async function initializeAgentManager() {
    console.log('Initializing Agent Manager...');
    const agentFileContentEditor = document.getElementById('agent-file-content-editor');
    const agentFileStatusSpan = document.getElementById('agent-file-status');
    const agentMapStatusSpan = document.getElementById('agent-map-status');
    const editingAgentFileDisplay = document.getElementById('editing-agent-file-display');
    const saveAgentFileButton = document.getElementById('save-agent-file-button');
    const agentMapListDiv = document.getElementById('agent-map-list');

    if (agentFileContentEditor) agentFileContentEditor.value = '';
    if (agentFileStatusSpan) agentFileStatusSpan.textContent = '';
    if (agentMapStatusSpan) agentMapStatusSpan.textContent = '';
    if (editingAgentFileDisplay) editingAgentFileDisplay.textContent = '未选择文件';
    if (saveAgentFileButton) saveAgentFileButton.disabled = true;
    currentEditingAgentFile = null;
    if (agentMapListDiv) agentMapListDiv.innerHTML = '<p>正在加载 Agent 映射...</p>';

    setupEventListeners();

    try {
        const [mapData, filesData] = await Promise.all([
            apiFetch(`${API_BASE_URL}/agents/map`),
            apiFetch(`${API_BASE_URL}/agents`)
        ]);
        
        availableAgentFiles = filesData.files.sort((a, b) => a.localeCompare(b));
        folderStructure = filesData.folderStructure || {};
        renderAgentMap(mapData);

    } catch (error) {
        if (agentMapListDiv) agentMapListDiv.innerHTML = `<p class="error-message">加载 Agent 数据失败: ${error.message}</p>`;
        showMessage(`加载 Agent 数据失败: ${error.message}`, 'error');
    }
}

/**
 * 设置 Agent 管理器部分的事件监听器。
 */
function setupEventListeners() {
    const saveAgentFileButton = document.getElementById('save-agent-file-button');
    const saveAgentMapButton = document.getElementById('save-agent-map-button');
    const addAgentMapEntryButton = document.getElementById('add-agent-map-entry-button');
    const createAgentFileButton = document.getElementById('create-agent-file-button');

    if (saveAgentFileButton && !saveAgentFileButton.dataset.listenerAttached) {
        saveAgentFileButton.addEventListener('click', saveAgentFileContent);
        saveAgentFileButton.dataset.listenerAttached = 'true';
    }
    if (saveAgentMapButton && !saveAgentMapButton.dataset.listenerAttached) {
        saveAgentMapButton.addEventListener('click', saveAgentMap);
        saveAgentMapButton.dataset.listenerAttached = 'true';
    }
    if (addAgentMapEntryButton && !addAgentMapEntryButton.dataset.listenerAttached) {
        addAgentMapEntryButton.addEventListener('click', addNewAgentMapEntry);
        addAgentMapEntryButton.dataset.listenerAttached = 'true';
    }
    if (createAgentFileButton && !createAgentFileButton.dataset.listenerAttached) {
        createAgentFileButton.addEventListener('click', createNewAgentFileHandler);
        createAgentFileButton.dataset.listenerAttached = 'true';
    }
}

function renderAgentMap(agentMap) {
    const agentMapListDiv = document.getElementById('agent-map-list');
    if (!agentMapListDiv) return;

    agentMapListDiv.innerHTML = '';
    if (Object.keys(agentMap).length === 0) {
        agentMapListDiv.innerHTML = '<p>没有定义任何 Agent。请点击“添加新 Agent”来创建一个。</p>';
    }

    for (const agentName in agentMap) {
        const fileName = agentMap[agentName];
        const entryDiv = createAgentMapEntryElement(agentName, fileName);
        agentMapListDiv.appendChild(entryDiv);
    }
}

function createAgentMapEntryElement(agentName, selectedFile) {
    const entryDiv = document.createElement('div');
    entryDiv.className = 'agent-map-entry';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = agentName;
    nameInput.className = 'agent-name-input';
    nameInput.placeholder = 'Agent 定义名';

    const fileSelect = document.createElement('select');
    fileSelect.className = 'agent-file-select';
    
    fileSelect.innerHTML = '<option value="">选择一个 .txt 或 .md 文件...</option>';

    // 添加文件夹结构的选项
    addFileOptions(fileSelect, folderStructure, '', selectedFile);

    const editFileButton = document.createElement('button');
    editFileButton.textContent = '编辑文件';
    editFileButton.className = 'edit-agent-file-btn';
    editFileButton.onclick = () => {
        const selectedValue = fileSelect.value;
        if (selectedValue) {
            loadAgentFileContent(selectedValue);
        } else {
            showMessage('请先为此 Agent 选择一个文件。', 'info');
        }
    };

    const deleteButton = document.createElement('button');
    deleteButton.textContent = '删除';
    deleteButton.className = 'delete-agent-map-btn';
    deleteButton.onclick = () => {
        if (confirm(`确定要删除 Agent "${nameInput.value || '(未命名)'}" 吗？`)) {
            entryDiv.remove();
        }
    };

    entryDiv.appendChild(nameInput);
    entryDiv.appendChild(document.createTextNode(' → '));
    entryDiv.appendChild(fileSelect);
    entryDiv.appendChild(editFileButton);
    entryDiv.appendChild(deleteButton);

    return entryDiv;
}

async function loadAgentFileContent(fileName) {
    const agentFileContentEditor = document.getElementById('agent-file-content-editor');
    const agentFileStatusSpan = document.getElementById('agent-file-status');
    const editingAgentFileDisplay = document.getElementById('editing-agent-file-display');
    const saveAgentFileButton = document.getElementById('save-agent-file-button');

    if (!fileName) {
        if (agentFileContentEditor) agentFileContentEditor.value = '';
        if (agentFileStatusSpan) agentFileStatusSpan.textContent = '';
        if (editingAgentFileDisplay) editingAgentFileDisplay.textContent = '未选择文件';
        if (saveAgentFileButton) saveAgentFileButton.disabled = true;
        currentEditingAgentFile = null;
        if (agentFileContentEditor) agentFileContentEditor.placeholder = '从左侧选择一个 Agent 以编辑其关联的 .txt 文件...';
        return;
    }
    if (agentFileStatusSpan) agentFileStatusSpan.textContent = `正在加载 ${fileName}...`;
    try {
        // 对文件名进行URL编码，以处理路径中的斜杠
        const encodedFileName = encodeURIComponent(fileName);
        const data = await apiFetch(`${API_BASE_URL}/agents/${encodedFileName}`);
        if (agentFileContentEditor) agentFileContentEditor.value = data.content;
        if (agentFileStatusSpan) agentFileStatusSpan.textContent = ``;
        if (editingAgentFileDisplay) editingAgentFileDisplay.textContent = `正在编辑: ${fileName}`;
        if (saveAgentFileButton) saveAgentFileButton.disabled = false;
        currentEditingAgentFile = fileName;
    } catch (error) {
        if (agentFileStatusSpan) agentFileStatusSpan.textContent = `加载文件 ${fileName} 失败。`;
        if (editingAgentFileDisplay) editingAgentFileDisplay.textContent = `加载失败: ${fileName}`;
        showMessage(`加载文件 ${fileName} 失败: ${error.message}`, 'error');
        if (agentFileContentEditor) agentFileContentEditor.value = `无法加载文件: ${fileName}\n\n错误: ${error.message}`;
        if (saveAgentFileButton) saveAgentFileButton.disabled = true;
        currentEditingAgentFile = null;
    }
}

async function saveAgentFileContent() {
    const agentFileContentEditor = document.getElementById('agent-file-content-editor');
    const agentFileStatusSpan = document.getElementById('agent-file-status');
    const saveAgentFileButton = document.getElementById('save-agent-file-button');

    if (!currentEditingAgentFile) {
        showMessage('没有选择要保存的文件。', 'error');
        return;
    }
    const content = agentFileContentEditor.value;
    if (agentFileStatusSpan) agentFileStatusSpan.textContent = `正在保存 ${currentEditingAgentFile}...`;
    if (saveAgentFileButton) saveAgentFileButton.disabled = true;

    try {
        // 对文件名进行URL编码，以处理路径中的斜杠
        const encodedFileName = encodeURIComponent(currentEditingAgentFile);
        await apiFetch(`${API_BASE_URL}/agents/${encodedFileName}`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        showMessage(`Agent 文件 '${currentEditingAgentFile}' 已成功保存!`, 'success');
        if (agentFileStatusSpan) agentFileStatusSpan.textContent = `Agent 文件 '${currentEditingAgentFile}' 已保存。`;
    } catch (error) {
        if (agentFileStatusSpan) agentFileStatusSpan.textContent = `保存文件 ${currentEditingAgentFile} 失败。`;
    } finally {
        if (saveAgentFileButton) saveAgentFileButton.disabled = false;
    }
}

async function saveAgentMap() {
    const agentMapStatusSpan = document.getElementById('agent-map-status');
    const agentMapListDiv = document.getElementById('agent-map-list');
    if (!agentMapStatusSpan || !agentMapListDiv) return;

    agentMapStatusSpan.textContent = '正在保存...';
    agentMapStatusSpan.className = 'status-message info';
    const newMap = {};
    let isValid = true;

    agentMapListDiv.querySelectorAll('.agent-map-entry').forEach(entry => {
        if (!isValid) return;
        const nameInput = entry.querySelector('.agent-name-input');
        const fileSelect = entry.querySelector('.agent-file-select');
        const agentName = nameInput.value.trim();
        const fileName = fileSelect.value;

        if (!agentName) {
            showMessage('Agent 定义名不能为空。', 'error');
            nameInput.focus();
            isValid = false;
        } else if (newMap[agentName]) {
            showMessage(`Agent 定义名 "${agentName}" 重复。`, 'error');
            nameInput.focus();
            isValid = false;
        } else if (!fileName) {
            showMessage(`Agent "${agentName}" 未选择 .txt 文件。`, 'error');
            fileSelect.focus();
            isValid = false;
        } else {
            newMap[agentName] = fileName;
        }
    });

    if (!isValid) {
        agentMapStatusSpan.textContent = '保存失败，请检查错误。';
        agentMapStatusSpan.className = 'status-message error';
        return;
    }

    try {
        await apiFetch(`${API_BASE_URL}/agents/map`, {
            method: 'POST',
            body: JSON.stringify(newMap)
        });
        showMessage('Agent 映射表已成功保存!', 'success');
        agentMapStatusSpan.textContent = '保存成功!';
        agentMapStatusSpan.className = 'status-message success';
        initializeAgentManager();
    } catch (error) {
        agentMapStatusSpan.textContent = `保存失败: ${error.message}`;
        agentMapStatusSpan.className = 'status-message error';
    }
}

function addNewAgentMapEntry() {
    const agentMapListDiv = document.getElementById('agent-map-list');
    if (!agentMapListDiv) return;
    const entryDiv = createAgentMapEntryElement('', '');
    agentMapListDiv.appendChild(entryDiv);
    entryDiv.querySelector('.agent-name-input').focus();
}

async function createNewAgentFileHandler() {
    // 创建一个简单的文件夹选择对话框
    const folderOptions = extractFolderOptions(folderStructure);
    
    let folderPath = '';
    if (folderOptions.length > 0) {
        folderPath = prompt(`请选择目标文件夹（可选）：\n${folderOptions.join('\n')}\n\n或输入新的文件夹名称，或留空在根目录创建。`, '');
    }
    
    let fileName = prompt("请输入要创建的新文件名（无需包含 .txt 或 .md 后缀）:", "");
    if (!fileName || !fileName.trim()) {
        showMessage('文件名不能为空。', 'info');
        return;
    }

    fileName = fileName.trim();
    const fileExtension = fileName.toLowerCase().endsWith('.md') ? '.md' : '.txt';
    const finalFileName = `${fileName}${fileExtension}`;

    // 检查文件是否已存在
    const fullPath = folderPath ? `${folderPath}/${finalFileName}` : finalFileName;
    if (availableAgentFiles.includes(fullPath)) {
        showMessage(`文件 "${fullPath}" 已存在。`, 'error');
        return;
    }

    if (!confirm(`确定要创建新的 Agent 文件 "${fullPath}" 吗？`)) {
        return;
    }

    const agentMapStatusSpan = document.getElementById('agent-map-status');
    if (agentMapStatusSpan) {
        agentMapStatusSpan.textContent = `正在创建文件 ${fullPath}...`;
        agentMapStatusSpan.className = 'status-message info';
    }

    try {
        await apiFetch(`${API_BASE_URL}/agents/new-file`, {
            method: 'POST',
            body: JSON.stringify({ fileName: finalFileName, folderPath })
        });
        showMessage(`文件 "${fullPath}" 已成功创建!`, 'success');
        if (agentMapStatusSpan) {
            agentMapStatusSpan.textContent = '文件创建成功!';
            agentMapStatusSpan.className = 'status-message success';
        }
        await initializeAgentManager();
    } catch (error) {
        if (agentMapStatusSpan) {
            agentMapStatusSpan.textContent = `创建文件失败: ${error.message}`;
            agentMapStatusSpan.className = 'status-message error';
        }
    }
}

/**
 * 递归添加文件选项到选择器
 * @param {HTMLElement} selectElement - 选择器元素
 * @param {Object} structure - 文件夹结构
 * @param {string} prefix - 当前路径前缀
 * @param {string} selectedFile - 当前选中的文件
 */
function addFileOptions(selectElement, structure, prefix = '', selectedFile = '') {
    for (const [name, item] of Object.entries(structure)) {
        if (item.type === 'folder') {
            // 添加文件夹分隔符
            const folderOption = document.createElement('option');
            folderOption.value = '';
            folderOption.disabled = true;
            folderOption.textContent = `${prefix}${name}/`;
            folderOption.style.fontWeight = 'bold';
            selectElement.appendChild(folderOption);
            
            // 递归添加子文件夹中的文件
            addFileOptions(selectElement, item.children, `${prefix}${name}/`, selectedFile);
        } else if (item.type === 'file') {
            // 添加文件选项
            const option = document.createElement('option');
            option.value = item.path;
            option.textContent = `${prefix}${name}`;
            
            if (item.path === selectedFile) {
                option.selected = true;
            }
            
            selectElement.appendChild(option);
        }
    }
}

/**
 * 从文件夹结构中提取文件夹选项
 * @param {Object} structure - 文件夹结构
 * @param {string} prefix - 当前路径前缀
 * @returns {Array} 文件夹选项数组
 */
function extractFolderOptions(structure, prefix = '') {
    const options = ['(根目录)'];
    
    for (const [name, item] of Object.entries(structure)) {
        if (item.type === 'folder') {
            options.push(`${prefix}${name}/`);
            
            // 递归添加子文件夹
            const subOptions = extractFolderOptions(item.children, `${prefix}${name}/`);
            options.push(...subOptions);
        }
    }
    
    return options;
}