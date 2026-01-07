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

function createThemeElement(themeName, chainConfig) {
    const details = document.createElement('details');
    details.className = 'theme-details';
    details.open = true;
    details.dataset.themeName = themeName;

    // 支持新旧格式
    let clusters, kSequence;
    if (Array.isArray(chainConfig)) {
        // 旧格式：直接是簇数组
        clusters = chainConfig;
        kSequence = new Array(clusters.length).fill(1); // 默认都是1
    } else if (chainConfig && chainConfig.clusters) {
        // 新格式：包含clusters和kSequence的对象
        clusters = chainConfig.clusters || [];
        kSequence = chainConfig.kSequence || new Array(clusters.length).fill(1);
    } else {
        clusters = [];
        kSequence = [];
    }

    details.innerHTML = `
        <summary class="theme-summary">
            <span class="theme-name-display">主题: ${themeName}</span>
            <button class="delete-theme-btn">删除该主题</button>
        </summary>
        <div class="theme-content">
            <div class="k-sequence-editor">
                <h4>K值序列配置</h4>
                <p class="description">每个思维簇对应的检索数量（K值）</p>
                <div class="k-sequence-inputs" data-theme-name="${themeName}"></div>
            </div>
            <ul class="draggable-list theme-chain-list" data-theme-name="${themeName}"></ul>
        </div>
    `;

    const chainList = details.querySelector('.theme-chain-list');
    const kSequenceInputs = details.querySelector('.k-sequence-inputs');
    
    if (clusters.length > 0) {
        clusters.forEach((clusterName, index) => {
            const listItem = createChainItemElement(clusterName, index);
            chainList.appendChild(listItem);
            
            // 创建对应的K值输入框
            const kInput = createKValueInput(clusterName, kSequence[index] || 1, index);
            kSequenceInputs.appendChild(kInput);
        });
    } else {
        const placeholder = document.createElement('li');
        placeholder.className = 'drop-placeholder';
        placeholder.textContent = '将思维簇拖拽到此处';
        chainList.appendChild(placeholder);
        
        kSequenceInputs.innerHTML = '<p class="no-clusters-message">添加思维簇后将显示K值配置</p>';
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

function createChainItemElement(clusterName, index = null) {
    const li = document.createElement('li');
    li.className = 'chain-item';
    li.draggable = true;
    li.dataset.clusterName = clusterName;
    if (index !== null) {
        li.dataset.index = index;
    }

    li.innerHTML = `<span class="cluster-name">${clusterName}</span>`;
    
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.className = 'remove-cluster-btn';
    removeBtn.onclick = () => {
        // 先获取theme-details，再删除元素
        const themeDetails = li.closest('.theme-details');
        li.remove();
        // 更新K值输入框
        updateKSequenceInputs(themeDetails);
    };
    li.appendChild(removeBtn);
    
    li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', clusterName);
        e.dataTransfer.effectAllowed = 'move';
        
        // 记录原始父元素
        li.dataset.originalParent = li.parentNode.className;
        
        setTimeout(() => {
            li.classList.add('dragging');
            
            // 如果是从可用模块拖拽，创建一个占位符
            const isFromAvailable = !li.querySelector('.remove-cluster-btn');
            if (isFromAvailable) {
                const placeholder = document.createElement('li');
                placeholder.className = 'dragging-placeholder';
                placeholder.textContent = clusterName;
                li.dataset.placeholder = 'true';
                document.body.appendChild(placeholder);
            }
        }, 0);
    });
    li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        
        // 移除占位符
        const placeholder = document.querySelector('.dragging-placeholder');
        if (placeholder) {
            placeholder.remove();
        }
        delete li.dataset.placeholder;
        
        // 拖拽结束后更新K值输入框
        updateKSequenceInputs(li.closest('.theme-details'));
    });

    return li;
}

/**
 * 创建K值输入框
 */
function createKValueInput(clusterName, kValue, index) {
    const div = document.createElement('div');
    div.className = 'k-value-input-group';
    div.dataset.clusterName = clusterName;
    div.dataset.index = index;
    
    div.innerHTML = `
        <label class="k-value-label">${clusterName}:</label>
        <input type="number" class="k-value-input" min="1" max="20" value="${kValue}" data-cluster="${clusterName}">
        <span class="k-value-hint">检索数量</span>
    `;
    
    return div;
}

/**
 * 更新K值序列输入框
 */
function updateKSequenceInputs(themeDetails) {
    if (!themeDetails) return;
    
    const kSequenceInputs = themeDetails.querySelector('.k-sequence-inputs');
    const chainItems = themeDetails.querySelectorAll('.chain-item');
    
    if (!kSequenceInputs) return;
    
    // 清空现有输入框
    kSequenceInputs.innerHTML = '';
    
    if (chainItems.length === 0) {
        kSequenceInputs.innerHTML = '<p class="no-clusters-message">添加思维簇后将显示K值配置</p>';
        return;
    }
    
    // 为每个簇创建K值输入框
    chainItems.forEach((item, index) => {
        const clusterName = item.dataset.clusterName;
        const existingInput = kSequenceInputs.querySelector(`[data-cluster="${clusterName}"]`);
        const kValue = existingInput ? existingInput.value : 1;
        
        const kInput = createKValueInput(clusterName, kValue, index);
        kSequenceInputs.appendChild(kInput);
    });
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
        const dragging = document.querySelector('.dragging');
        
        if (!dragging) return;

        const isFromAvailable = dragging.dataset.placeholder === 'true';
        const isInSameList = dragging.parentNode === listElement;

        if (isFromAvailable) {
            // 从可用模块拖拽：使用占位符显示位置
            const placeholder = document.querySelector('.dragging-placeholder');
            if (placeholder) {
                const afterElement = getDragAfterElement(listElement, e.clientY);
                if (afterElement == null) {
                    listElement.appendChild(placeholder);
                } else {
                    listElement.insertBefore(placeholder, afterElement);
                }
            }
        } else if (isInSameList) {
            // 同列表内排序：移动实际元素
            const afterElement = getDragAfterElement(listElement, e.clientY);
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

        const isFromAvailable = dragging.dataset.placeholder === 'true';
        const isInSameList = dragging.parentNode === listElement;

        if (isFromAvailable) {
            // 从可用模块拖拽到主题列表
            listElement.querySelector('.drop-placeholder')?.remove();

            const alreadyExists = [...listElement.querySelectorAll('.chain-item')]
                                     .some(item => item.dataset.clusterName === clusterName);

            if (clusterName && !alreadyExists) {
                const newItem = createChainItemElement(clusterName);
                
                const afterElement = getDragAfterElement(listElement, e.clientY);
                
                if (afterElement == null) {
                    listElement.appendChild(newItem);
                } else {
                    listElement.insertBefore(newItem, afterElement);
                }
                
                dragging.remove();
                updateKSequenceInputs(listElement.closest('.theme-details'));
            } else {
                dragging.remove();
            }

            // 恢复可用簇列表
            const editorContainer = document.getElementById('thinking-chains-container');
            const oldAvailableContainer = editorContainer.querySelector('.available-clusters-container');
            if (oldAvailableContainer) {
                const newAvailableContainer = createAvailableClustersElement();
                oldAvailableContainer.replaceWith(newAvailableContainer);
            }
        } else if (isInSameList) {
            // 主题内排序，已经在dragover中完成了位置更新
            // 只需要更新K值输入框
            updateKSequenceInputs(listElement.closest('.theme-details'));
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
        
        // 收集K值序列
        const kSequence = [];
        const kInputs = el.querySelectorAll('.k-value-input');
        kInputs.forEach(input => {
            const kValue = parseInt(input.value) || 1;
            kSequence.push(Math.max(1, Math.min(20, kValue))); // 限制在1-20之间
        });
        
        // 使用新格式保存
        newChains[themeName] = {
            clusters: clusters,
            kSequence: kSequence.length > 0 ? kSequence : new Array(clusters.length).fill(1)
        };
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

    // 使用新格式创建空主题
    const newThemeElement = createThemeElement(normalizedThemeName, { clusters: [], kSequence: [] });
    container.appendChild(newThemeElement);
    newThemeElement.scrollIntoView({ behavior: 'smooth' });
}
