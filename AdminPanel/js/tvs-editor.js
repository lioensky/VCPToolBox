// AdminPanel/js/tvs-editor.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let currentEditingTvsFile = null;

/**
 * 初始化 TVS 文件编辑器。
 */
export async function initializeTvsFilesEditor() {
    console.log('Initializing TVS Files Editor...');
    const tvsFileContentEditor = document.getElementById('tvs-file-content-editor');
    const tvsFileStatusSpan = document.getElementById('tvs-file-status');
    const saveTvsFileButton = document.getElementById('save-tvs-file-button');

    if (tvsFileContentEditor) tvsFileContentEditor.value = '';
    if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = '';
    if (saveTvsFileButton) saveTvsFileButton.disabled = true;
    currentEditingTvsFile = null;
    
    setupEventListeners();
    await loadTvsFilesList();
}

/**
 * 设置 TVS 编辑器部分的事件监听器。
 */
function setupEventListeners() {
    const tvsFileSelect = document.getElementById('tvs-file-select');
    const saveTvsFileButton = document.getElementById('save-tvs-file-button');

    if (tvsFileSelect && !tvsFileSelect.dataset.listenerAttached) {
        tvsFileSelect.addEventListener('change', (event) => {
            loadTvsFileContent(event.target.value);
        });
        tvsFileSelect.dataset.listenerAttached = 'true';
    }
    if (saveTvsFileButton && !saveTvsFileButton.dataset.listenerAttached) {
        saveTvsFileButton.addEventListener('click', saveTvsFileContent);
        saveTvsFileButton.dataset.listenerAttached = 'true';
    }
}

async function loadTvsFilesList() {
    const tvsFileSelect = document.getElementById('tvs-file-select');
    const tvsFileContentEditor = document.getElementById('tvs-file-content-editor');
    if (!tvsFileSelect) return;

    try {
        const data = await apiFetch(`${API_BASE_URL}/tvsvars`);
        tvsFileSelect.innerHTML = '<option value="">请选择一个文件...</option>';
        if (data.files && data.files.length > 0) {
            data.files.sort((a, b) => a.localeCompare(b));
            data.files.forEach(fileName => {
                const option = document.createElement('option');
                option.value = fileName;
                option.textContent = fileName;
                tvsFileSelect.appendChild(option);
            });
        } else {
            tvsFileSelect.innerHTML = '<option value="">没有找到变量文件</option>';
            if (tvsFileContentEditor) tvsFileContentEditor.placeholder = '没有变量文件可供编辑。';
        }
    } catch (error) {
        tvsFileSelect.innerHTML = '<option value="">加载变量文件列表失败</option>';
        showMessage('加载变量文件列表失败: ' + error.message, 'error');
        if (tvsFileContentEditor) tvsFileContentEditor.placeholder = '加载变量文件列表失败。';
    }
}

async function loadTvsFileContent(fileName) {
    const tvsFileContentEditor = document.getElementById('tvs-file-content-editor');
    const tvsFileStatusSpan = document.getElementById('tvs-file-status');
    const saveTvsFileButton = document.getElementById('save-tvs-file-button');

    if (!fileName) {
        if (tvsFileContentEditor) tvsFileContentEditor.value = '';
        if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = '请选择一个文件。';
        if (saveTvsFileButton) saveTvsFileButton.disabled = true;
        currentEditingTvsFile = null;
        if (tvsFileContentEditor) tvsFileContentEditor.placeholder = '选择一个变量文件以编辑其内容...';
        return;
    }
    if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `正在加载 ${fileName}...`;
    try {
        const data = await apiFetch(`${API_BASE_URL}/tvsvars/${fileName}`);
        if (tvsFileContentEditor) tvsFileContentEditor.value = data.content;
        if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `当前编辑: ${fileName}`;
        if (saveTvsFileButton) saveTvsFileButton.disabled = false;
        currentEditingTvsFile = fileName;
    } catch (error) {
        if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `加载文件 ${fileName} 失败。`;
        showMessage(`加载文件 ${fileName} 失败: ${error.message}`, 'error');
        if (tvsFileContentEditor) tvsFileContentEditor.value = `无法加载文件: ${fileName}\n\n错误: ${error.message}`;
        if (saveTvsFileButton) saveTvsFileButton.disabled = true;
        currentEditingTvsFile = null;
    }
}

async function saveTvsFileContent() {
    const tvsFileContentEditor = document.getElementById('tvs-file-content-editor');
    const tvsFileStatusSpan = document.getElementById('tvs-file-status');
    const saveTvsFileButton = document.getElementById('save-tvs-file-button');

    if (!currentEditingTvsFile) {
        showMessage('没有选择要保存的文件。', 'error');
        return;
    }
    const content = tvsFileContentEditor.value;
    if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `正在保存 ${currentEditingTvsFile}...`;
    if (saveTvsFileButton) saveTvsFileButton.disabled = true;

    try {
        await apiFetch(`${API_BASE_URL}/tvsvars/${currentEditingTvsFile}`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        showMessage(`变量文件 '${currentEditingTvsFile}' 已成功保存!`, 'success');
        if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `变量文件 '${currentEditingTvsFile}' 已保存。`;
    } catch (error) {
        if (tvsFileStatusSpan) tvsFileStatusSpan.textContent = `保存文件 ${currentEditingTvsFile} 失败。`;
    } finally {
        if (saveTvsFileButton) saveTvsFileButton.disabled = false;
    }
}