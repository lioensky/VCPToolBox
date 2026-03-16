// AdminPanel/js/toolbox-manager.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
const ALIAS_REGEX = /^[A-Za-z0-9_]+$/;

let currentEditingToolboxFile = null;
let availableToolboxFiles = [];
let folderStructure = {};

/**
 * 初始化 Toolbox 管理器。
 */
export async function initializeToolboxManager() {
    console.log('Initializing Toolbox Manager...');

    const toolboxFileContentEditor = document.getElementById('toolbox-file-content-editor');
    const toolboxFileStatusSpan = document.getElementById('toolbox-file-status');
    const toolboxMapStatusSpan = document.getElementById('toolbox-map-status');
    const editingToolboxFileDisplay = document.getElementById('editing-toolbox-file-display');
    const saveToolboxFileButton = document.getElementById('save-toolbox-file-button');
    const toolboxMapListDiv = document.getElementById('toolbox-map-list');

    if (toolboxFileContentEditor) toolboxFileContentEditor.value = '';
    if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = '';
    if (toolboxMapStatusSpan) toolboxMapStatusSpan.textContent = '';
    if (editingToolboxFileDisplay) editingToolboxFileDisplay.textContent = '未选择文件';
    if (saveToolboxFileButton) saveToolboxFileButton.disabled = true;
    currentEditingToolboxFile = null;

    if (toolboxMapListDiv) toolboxMapListDiv.innerHTML = '<p>正在加载 Toolbox 映射...</p>';

    setupEventListeners();

    try {
        const [mapData, filesData] = await Promise.all([
            apiFetch(`${API_BASE_URL}/toolbox/map`),
            apiFetch(`${API_BASE_URL}/toolbox/files`)
        ]);

        availableToolboxFiles = Array.isArray(filesData.files)
            ? filesData.files.sort((a, b) => a.localeCompare(b))
            : [];
        folderStructure = filesData.folderStructure || {};

        renderToolboxMap(mapData || {});
    } catch (error) {
        if (toolboxMapListDiv) {
            toolboxMapListDiv.innerHTML = `<p class="error-message">加载 Toolbox 数据失败: ${error.message}</p>`;
        }
        showMessage(`加载 Toolbox 数据失败: ${error.message}`, 'error');
    }
}

function setupEventListeners() {
    const saveToolboxFileButton = document.getElementById('save-toolbox-file-button');
    const saveToolboxMapButton = document.getElementById('save-toolbox-map-button');
    const addToolboxMapEntryButton = document.getElementById('add-toolbox-map-entry-button');
    const createToolboxFileButton = document.getElementById('create-toolbox-file-button');

    if (saveToolboxFileButton && !saveToolboxFileButton.dataset.listenerAttached) {
        saveToolboxFileButton.addEventListener('click', saveToolboxFileContent);
        saveToolboxFileButton.dataset.listenerAttached = 'true';
    }

    if (saveToolboxMapButton && !saveToolboxMapButton.dataset.listenerAttached) {
        saveToolboxMapButton.addEventListener('click', saveToolboxMap);
        saveToolboxMapButton.dataset.listenerAttached = 'true';
    }

    if (addToolboxMapEntryButton && !addToolboxMapEntryButton.dataset.listenerAttached) {
        addToolboxMapEntryButton.addEventListener('click', addNewToolboxMapEntry);
        addToolboxMapEntryButton.dataset.listenerAttached = 'true';
    }

    if (createToolboxFileButton && !createToolboxFileButton.dataset.listenerAttached) {
        createToolboxFileButton.addEventListener('click', createNewToolboxFileHandler);
        createToolboxFileButton.dataset.listenerAttached = 'true';
    }
}

function renderToolboxMap(map) {
    const toolboxMapListDiv = document.getElementById('toolbox-map-list');
    if (!toolboxMapListDiv) return;

    toolboxMapListDiv.innerHTML = '';

    const aliases = Object.keys(map || {});
    if (aliases.length === 0) {
        toolboxMapListDiv.innerHTML = '<p>没有定义任何 Toolbox。请点击“添加新 Toolbox”来创建一个。</p>';
        return;
    }

    for (const alias of aliases) {
        const rawValue = map[alias];
        const normalized = typeof rawValue === 'string'
            ? { file: rawValue, description: '' }
            : {
                file: rawValue?.file || '',
                description: typeof rawValue?.description === 'string' ? rawValue.description : ''
            };

        const entryDiv = createToolboxMapEntryElement(alias, normalized);
        toolboxMapListDiv.appendChild(entryDiv);
    }
}

function createToolboxMapEntryElement(alias, item = { file: '', description: '' }) {
    const entryDiv = document.createElement('div');
    entryDiv.className = 'toolbox-map-entry';

    const aliasInput = document.createElement('input');
    aliasInput.type = 'text';
    aliasInput.value = alias || '';
    aliasInput.className = 'toolbox-alias-input';
    aliasInput.placeholder = 'Toolbox alias (A-Za-z0-9_)';

    const fileSelect = document.createElement('select');
    fileSelect.className = 'toolbox-file-select';
    fileSelect.innerHTML = '<option value="">选择一个 .txt 或 .md 文件...</option>';
    addFileOptions(fileSelect, folderStructure, '', item.file || '');

    const descriptionInput = document.createElement('textarea');
    descriptionInput.className = 'toolbox-description-input';
    descriptionInput.placeholder = 'description（可为空）';
    descriptionInput.rows = 2;
    descriptionInput.value = typeof item.description === 'string' ? item.description : '';

    const editFileButton = document.createElement('button');
    editFileButton.textContent = '编辑文件';
    editFileButton.className = 'edit-toolbox-file-btn';
    editFileButton.onclick = () => {
        const selectedValue = fileSelect.value;
        if (selectedValue) {
            loadToolboxFileContent(selectedValue);
        } else {
            showMessage('请先为此 Toolbox 选择一个文件。', 'info');
        }
    };

    const deleteButton = document.createElement('button');
    deleteButton.textContent = '删除';
    deleteButton.className = 'delete-toolbox-map-btn';
    deleteButton.onclick = () => {
        if (confirm(`确定要删除 Toolbox "${aliasInput.value || '(未命名)'}" 吗？`)) {
            entryDiv.remove();
        }
    };

    entryDiv.appendChild(aliasInput);
    entryDiv.appendChild(fileSelect);
    entryDiv.appendChild(descriptionInput);
    entryDiv.appendChild(editFileButton);
    entryDiv.appendChild(deleteButton);

    return entryDiv;
}

async function loadToolboxFileContent(filePath) {
    const toolboxFileContentEditor = document.getElementById('toolbox-file-content-editor');
    const toolboxFileStatusSpan = document.getElementById('toolbox-file-status');
    const editingToolboxFileDisplay = document.getElementById('editing-toolbox-file-display');
    const saveToolboxFileButton = document.getElementById('save-toolbox-file-button');

    if (!filePath) {
        if (toolboxFileContentEditor) toolboxFileContentEditor.value = '';
        if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = '';
        if (editingToolboxFileDisplay) editingToolboxFileDisplay.textContent = '未选择文件';
        if (saveToolboxFileButton) saveToolboxFileButton.disabled = true;
        if (toolboxFileContentEditor) {
            toolboxFileContentEditor.placeholder = '从左侧选择一个 Toolbox 文件以编辑其内容...';
        }
        currentEditingToolboxFile = null;
        return;
    }

    if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = `正在加载 ${filePath}...`;

    try {
        const encodedPath = encodeURIComponent(filePath);
        const data = await apiFetch(`${API_BASE_URL}/toolbox/file/${encodedPath}`);

        if (toolboxFileContentEditor) toolboxFileContentEditor.value = data.content ?? '';
        if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = '';
        if (editingToolboxFileDisplay) editingToolboxFileDisplay.textContent = `正在编辑: ${filePath}`;
        if (saveToolboxFileButton) saveToolboxFileButton.disabled = false;

        currentEditingToolboxFile = filePath;
    } catch (error) {
        if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = `加载文件 ${filePath} 失败。`;
        if (editingToolboxFileDisplay) editingToolboxFileDisplay.textContent = `加载失败: ${filePath}`;
        if (toolboxFileContentEditor) {
            toolboxFileContentEditor.value = `无法加载文件: ${filePath}\n\n错误: ${error.message}`;
        }
        if (saveToolboxFileButton) saveToolboxFileButton.disabled = true;
        currentEditingToolboxFile = null;
        showMessage(`加载文件 ${filePath} 失败: ${error.message}`, 'error');
    }
}

async function saveToolboxFileContent() {
    const toolboxFileContentEditor = document.getElementById('toolbox-file-content-editor');
    const toolboxFileStatusSpan = document.getElementById('toolbox-file-status');
    const saveToolboxFileButton = document.getElementById('save-toolbox-file-button');

    if (!currentEditingToolboxFile) {
        showMessage('没有选择要保存的文件。', 'error');
        return;
    }

    const content = toolboxFileContentEditor ? toolboxFileContentEditor.value : '';
    if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = `正在保存 ${currentEditingToolboxFile}...`;
    if (saveToolboxFileButton) saveToolboxFileButton.disabled = true;

    try {
        const encodedPath = encodeURIComponent(currentEditingToolboxFile);
        await apiFetch(`${API_BASE_URL}/toolbox/file/${encodedPath}`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = `Toolbox 文件 '${currentEditingToolboxFile}' 已保存。`;
        showMessage(`Toolbox 文件 '${currentEditingToolboxFile}' 已成功保存!`, 'success');
    } catch (error) {
        if (toolboxFileStatusSpan) toolboxFileStatusSpan.textContent = `保存文件 ${currentEditingToolboxFile} 失败。`;
        showMessage(`保存文件 ${currentEditingToolboxFile} 失败: ${error.message}`, 'error');
    } finally {
        if (saveToolboxFileButton) saveToolboxFileButton.disabled = false;
    }
}

async function saveToolboxMap() {
    const toolboxMapStatusSpan = document.getElementById('toolbox-map-status');
    const toolboxMapListDiv = document.getElementById('toolbox-map-list');
    if (!toolboxMapStatusSpan || !toolboxMapListDiv) return;

    toolboxMapStatusSpan.textContent = '正在保存...';
    toolboxMapStatusSpan.className = 'status-message info';

    const newMap = {};
    let isValid = true;

    toolboxMapListDiv.querySelectorAll('.toolbox-map-entry').forEach(entry => {
        if (!isValid) return;

        const aliasInput = entry.querySelector('.toolbox-alias-input');
        const fileSelect = entry.querySelector('.toolbox-file-select');
        const descriptionInput = entry.querySelector('.toolbox-description-input');

        const alias = aliasInput ? aliasInput.value.trim() : '';
        const file = fileSelect ? fileSelect.value : '';
        const description = descriptionInput ? descriptionInput.value : '';

        if (!alias) {
            showMessage('Toolbox alias 不能为空。', 'error');
            if (aliasInput) aliasInput.focus();
            isValid = false;
            return;
        }

        if (!ALIAS_REGEX.test(alias)) {
            showMessage(`Toolbox alias "${alias}" 不合法。仅允许 A-Z、a-z、0-9、_`, 'error');
            if (aliasInput) aliasInput.focus();
            isValid = false;
            return;
        }

        if (Object.prototype.hasOwnProperty.call(newMap, alias)) {
            showMessage(`Toolbox alias "${alias}" 重复。`, 'error');
            if (aliasInput) aliasInput.focus();
            isValid = false;
            return;
        }

        if (!file) {
            showMessage(`Toolbox "${alias}" 未选择文件。`, 'error');
            if (fileSelect) fileSelect.focus();
            isValid = false;
            return;
        }

        newMap[alias] = {
            file,
            description: typeof description === 'string' ? description : ''
        };
    });

    if (!isValid) {
        toolboxMapStatusSpan.textContent = '保存失败，请检查错误。';
        toolboxMapStatusSpan.className = 'status-message error';
        return;
    }

    try {
        await apiFetch(`${API_BASE_URL}/toolbox/map`, {
            method: 'POST',
            body: JSON.stringify(newMap)
        });

        toolboxMapStatusSpan.textContent = '保存成功!';
        toolboxMapStatusSpan.className = 'status-message success';
        showMessage('Toolbox 映射表已成功保存!', 'success');

        await initializeToolboxManager();
    } catch (error) {
        toolboxMapStatusSpan.textContent = `保存失败: ${error.message}`;
        toolboxMapStatusSpan.className = 'status-message error';
    }
}

function addNewToolboxMapEntry() {
    const toolboxMapListDiv = document.getElementById('toolbox-map-list');
    if (!toolboxMapListDiv) return;

    // 若当前是空提示，先清空
    if (toolboxMapListDiv.children.length === 1 && toolboxMapListDiv.querySelector('p')) {
        toolboxMapListDiv.innerHTML = '';
    }

    const entryDiv = createToolboxMapEntryElement('', { file: '', description: '' });
    toolboxMapListDiv.appendChild(entryDiv);

    const aliasInput = entryDiv.querySelector('.toolbox-alias-input');
    if (aliasInput) aliasInput.focus();
}

async function createNewToolboxFileHandler() {
    const folderOptions = extractFolderOptions(folderStructure);

    let folderPath = '';
    if (folderOptions.length > 0) {
        const answer = prompt(
            `请选择目标文件夹（可选）：\n${folderOptions.join('\n')}\n\n或输入新的文件夹名称，或留空在根目录创建。`,
            ''
        );
        folderPath = (answer || '').trim();
        if (folderPath === '(根目录)') folderPath = '';
        folderPath = folderPath.replace(/[\\/]+$/, '');
    }

    let fileNameInput = prompt('请输入要创建的新 Toolbox 文件名（支持 .txt 或 .md 后缀）:', '');
    if (!fileNameInput || !fileNameInput.trim()) {
        showMessage('文件名不能为空。', 'info');
        return;
    }

    fileNameInput = fileNameInput.trim();
    let finalFileName = fileNameInput;
    if (!/\.(txt|md)$/i.test(finalFileName)) {
        finalFileName = `${finalFileName}.txt`;
    }

    const fullPath = folderPath ? `${folderPath}/${finalFileName}` : finalFileName;

    if (availableToolboxFiles.includes(fullPath)) {
        showMessage(`文件 "${fullPath}" 已存在。`, 'error');
        return;
    }

    if (!confirm(`确定要创建新的 Toolbox 文件 "${fullPath}" 吗？`)) {
        return;
    }

    const toolboxMapStatusSpan = document.getElementById('toolbox-map-status');
    if (toolboxMapStatusSpan) {
        toolboxMapStatusSpan.textContent = `正在创建文件 ${fullPath}...`;
        toolboxMapStatusSpan.className = 'status-message info';
    }

    try {
        await apiFetch(`${API_BASE_URL}/toolbox/new-file`, {
            method: 'POST',
            body: JSON.stringify({ fileName: finalFileName, folderPath })
        });

        showMessage(`文件 "${fullPath}" 已成功创建!`, 'success');
        if (toolboxMapStatusSpan) {
            toolboxMapStatusSpan.textContent = '文件创建成功!';
            toolboxMapStatusSpan.className = 'status-message success';
        }

        await initializeToolboxManager();
    } catch (error) {
        if (toolboxMapStatusSpan) {
            toolboxMapStatusSpan.textContent = `创建文件失败: ${error.message}`;
            toolboxMapStatusSpan.className = 'status-message error';
        }
    }
}

/**
 * 递归添加文件选项到选择器
 * @param {HTMLElement} selectElement
 * @param {Object} structure
 * @param {string} prefix
 * @param {string} selectedFile
 */
function addFileOptions(selectElement, structure, prefix = '', selectedFile = '') {
    for (const [name, item] of Object.entries(structure || {})) {
        if (item.type === 'folder') {
            const folderOption = document.createElement('option');
            folderOption.value = '';
            folderOption.disabled = true;
            folderOption.textContent = `${prefix}${name}/`;
            folderOption.style.fontWeight = 'bold';
            selectElement.appendChild(folderOption);

            addFileOptions(selectElement, item.children, `${prefix}${name}/`, selectedFile);
        } else if (item.type === 'file') {
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
 * 提取所有可选文件夹（用于 prompt 提示）
 * @param {Object} structure
 * @param {string} prefix
 * @returns {string[]}
 */
function extractFolderOptions(structure, prefix = '') {
    const options = ['(根目录)'];

    for (const [name, item] of Object.entries(structure || {})) {
        if (item.type === 'folder') {
            options.push(`${prefix}${name}/`);
            const subOptions = extractFolderOptions(item.children, `${prefix}${name}/`);
            options.push(...subOptions);
        }
    }

    return Array.from(new Set(options));
}
