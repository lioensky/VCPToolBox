// AdminPanel/js/thinking-chains-editor.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let thinkingChainsData = {};
let availableClusters = [];

/**
 * 初始化思维链编辑器。
 */
export async function initializeThinkingChainsEditor() {
    console.log('Initializing Thinking Chains Editor...');
    const container = document.getElementById('thinking-chains-container');
    const statusSpan = document.getElementById('thinking-chains-status');
    if (!container || !statusSpan) return;

    container.innerHTML = '<p>正在加载思维链配置...</p>';
    statusSpan.textContent = '';
    
    setupEventListeners();

    try {
        const [chainsResponse, clustersResponse] = await Promise.all([
            apiFetch(`${API_BASE_URL}/thinking-chains`),
            apiFetch(`${API_BASE_URL}/available-clusters`)
        ]);
        
        thinkingChainsData = chainsResponse;
        availableClusters = clustersResponse.clusters || [];
        
        renderThinkingChainsEditor(container);

    } catch (error) {
        container.innerHTML = `<p class="error-message">加载思维链配置失败: ${error.message}</p>`;
    }
}

/**
 * 设置思维链编辑器部分的事件监听器。
 */
function setupEventListeners() {
    const saveThinkingChainsButton = document.getElementById('save-thinking-chains-button');
    const addThinkingChainThemeButton = document.getElementById('add-thinking-chain-theme-button');

    if (saveThinkingChainsButton && !saveThinkingChainsButton.dataset.listenerAttached) {
        saveThinkingChainsButton.addEventListener('click', saveThinkingChains);
        saveThinkingChainsButton.dataset.listenerAttached = 'true';
    }
    if (addThinkingChainThemeButton && !addThinkingChainThemeButton.dataset.listenerAttached) {
        addThinkingChainThemeButton.addEventListener('click', addNewThinkingChainTheme);
        addThinkingChainThemeButton.dataset.listenerAttached = 'true';
    }
}

function renderThinkingChainsEditor(container) {
    container.innerHTML = '';
    const themes = thinkingChainsData.chains || {};

    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'thinking-chains-editor-wrapper';

    const themesContainer = document.createElement('div');
    themesContainer.id = 'thinking-chains-themes-container';
    themesContainer.className = 'thinking-chains-themes-container';

    if (Object.keys(themes).length === 0) {
        themesContainer.innerHTML = '<p>没有找到任何思维链主题。请点击“添加新主题”来创建一个。</p>';
    } else {
        for (const themeName in themes) {
            const themeElement = createThemeElement(themeName, themes[themeName]);
            themesContainer.appendChild(themeElement);
        }
    }

    const availableClustersElement = createAvailableClustersElement();

    editorWrapper.appendChild(themesContainer);
    editorWrapper.appendChild(availableClustersElement);
    container.appendChild(editorWrapper);
}

function createThemeElement(themeName, chain) {
    const details = document.createElement('details');
    details.className = 'theme-details';
    details.open = true;
    details.dataset.themeName = themeName;

    details.innerHTML = `
        <summary class="theme-summary">
            <span class="theme-name-display">主题: ${themeName}</span>
            <button class="delete-theme-btn">删除该主题</button>
        </summary>
        <div class="theme-content">
            <ul class="draggable-list theme-chain-list" data-theme-name="${themeName}"></ul>
        </div>
    `;

    const chainList = details.querySelector('.theme-chain-list');
    if (chain.length > 0) {
        chain.forEach(clusterName => {
            const listItem = createChainItemElement(clusterName);
            chainList.appendChild(listItem);
        });
    } else {
        const placeholder = document.createElement('li');
        placeholder.className = 'drop-placeholder';
        placeholder.textContent = '将思维簇拖拽到此处';
        chainList.appendChild(placeholder);
    }

    details.querySelector('.delete-theme-btn').onclick = (e) => {
        e.preventDefault();
        if (confirm(`确定要删除主题 "${themeName}" 吗？`)) {
            details.remove();
        }
    };

    setupDragAndDrop(chainList);
    return details;
}

function createChainItemElement(clusterName) {
    const li = document.createElement('li');
    li.className = 'chain-item';
    li.draggable = true;
    li.dataset.clusterName = clusterName;

    li.innerHTML = `<span class="cluster-name">${clusterName}</span>`;
    
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.className = 'remove-cluster-btn';
    removeBtn.onclick = () => li.remove();
    li.appendChild(removeBtn);
    
    li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', clusterName);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => li.classList.add('dragging'), 0);
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    return li;
}

function createAvailableClustersElement() {
    const container = document.createElement('div');
    container.className = 'available-clusters-container';

    container.innerHTML = `
        <h3>可用的思维簇模块</h3>
        <p class="description">将模块从这里拖拽到左侧的主题列表中。</p>
        <ul class="draggable-list available-clusters-list"></ul>
    `;

    const list = container.querySelector('.available-clusters-list');
    availableClusters.forEach(clusterName => {
        const listItem = createChainItemElement(clusterName);
        listItem.querySelector('.remove-cluster-btn').remove(); // These are templates, not removable
        list.appendChild(listItem);
    });

    return container;
}

function setupDragAndDrop(listElement) {
    listElement.addEventListener('dragover', e => {
        e.preventDefault();
        const afterElement = getDragAfterElement(listElement, e.clientY);
        const dragging = document.querySelector('.dragging');
        if (dragging) {
            if (afterElement == null) {
                listElement.appendChild(dragging);
            } else {
                listElement.insertBefore(dragging, afterElement);
            }
        }
    });

    listElement.addEventListener('drop', e => {
        e.preventDefault();
        const clusterName = e.dataTransfer.getData('text/plain');
        const dragging = document.querySelector('.dragging');
        if (!dragging) return;

        const isFromAvailable = !dragging.querySelector('.remove-cluster-btn');

        if (isFromAvailable) {
            listElement.querySelector('.drop-placeholder')?.remove();

            const alreadyExists = [...listElement.querySelectorAll('.chain-item')]
                                     .some(item => item.dataset.clusterName === clusterName);

            if (clusterName && !alreadyExists) {
                const newItem = createChainItemElement(clusterName);
                listElement.replaceChild(newItem, dragging);
            } else {
                dragging.remove();
            }

            // Restore the available clusters list
            const editorContainer = document.getElementById('thinking-chains-container');
            const oldAvailableContainer = editorContainer.querySelector('.available-clusters-container');
            if (oldAvailableContainer) {
                const newAvailableContainer = createAvailableClustersElement();
                oldAvailableContainer.replaceWith(newAvailableContainer);
            }
        }
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('li:not(.dragging):not(.drop-placeholder)')];
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

async function saveThinkingChains() {
    const container = document.getElementById('thinking-chains-container');
    const statusSpan = document.getElementById('thinking-chains-status');
    if (!container || !statusSpan) return;

    const newChains = {};
    container.querySelectorAll('.theme-details').forEach(el => {
        const themeName = el.dataset.themeName;
        const clusters = [...el.querySelectorAll('.chain-item')].map(item => item.dataset.clusterName);
        newChains[themeName] = clusters;
    });

    const dataToSave = { ...thinkingChainsData, chains: newChains };

    statusSpan.textContent = '正在保存...';
    statusSpan.className = 'status-message info';
    try {
        await apiFetch(`${API_BASE_URL}/thinking-chains`, {
            method: 'POST',
            body: JSON.stringify(dataToSave)
        });
        showMessage('思维链配置已成功保存!', 'success');
        statusSpan.textContent = '保存成功!';
        statusSpan.className = 'status-message success';
        initializeThinkingChainsEditor();
    } catch (error) {
        statusSpan.textContent = `保存失败: ${error.message}`;
        statusSpan.className = 'status-message error';
    }
}

function addNewThinkingChainTheme() {
    const themeName = prompt('请输入新思维链主题的名称 (例如: creative-writing):');
    if (!themeName || !themeName.trim()) return;

    const normalizedThemeName = themeName.trim();
    const container = document.getElementById('thinking-chains-themes-container');
    if (!container) return;

    if (container.querySelector(`[data-theme-name="${normalizedThemeName}"]`)) {
        showMessage(`主题 "${normalizedThemeName}" 已存在!`, 'error');
        return;
    }
    
    container.querySelector('p')?.remove(); // Remove placeholder text if it exists

    const newThemeElement = createThemeElement(normalizedThemeName, []);
    container.appendChild(newThemeElement);
    newThemeElement.scrollIntoView({ behavior: 'smooth' });
}