// AdminPanel/js/semantic-groups-editor.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let semanticGroupsData = {};

/**
 * 初始化语义组编辑器。
 */
export async function initializeSemanticGroupsEditor() {
    console.log('Initializing Semantic Groups Editor...');
    const container = document.getElementById('semantic-groups-container');
    const statusSpan = document.getElementById('semantic-groups-status');
    if (!container || !statusSpan) return;

    container.innerHTML = '<p>正在加载语义组...</p>';
    statusSpan.textContent = '';
    
    setupEventListeners();

    try {
        semanticGroupsData = await apiFetch(`${API_BASE_URL}/semantic-groups`);
        renderSemanticGroups(semanticGroupsData, container);
    } catch (error) {
        container.innerHTML = `<p class="error-message">加载语义组失败: ${error.message}</p>`;
    }
}

/**
 * 设置语义组编辑器部分的事件监听器。
 */
function setupEventListeners() {
    const saveSemanticGroupsButton = document.getElementById('save-semantic-groups-button');
    const addSemanticGroupButton = document.getElementById('add-semantic-group-button');

    if (saveSemanticGroupsButton && !saveSemanticGroupsButton.dataset.listenerAttached) {
        saveSemanticGroupsButton.addEventListener('click', saveSemanticGroups);
        saveSemanticGroupsButton.dataset.listenerAttached = 'true';
    }
    if (addSemanticGroupButton && !addSemanticGroupButton.dataset.listenerAttached) {
        addSemanticGroupButton.addEventListener('click', addNewSemanticGroup);
        addSemanticGroupButton.dataset.listenerAttached = 'true';
    }
}

function renderSemanticGroups(data, container) {
    container.innerHTML = '';
    const groups = data.groups || {};
    if (Object.keys(groups).length === 0) {
        container.innerHTML = '<p>没有找到任何语义组。请点击“添加新组”来创建一个。</p>';
        return;
    }

    for (const groupName in groups) {
        const groupData = groups[groupName];
        const groupElement = createGroupElement(groupName, groupData);
        container.appendChild(groupElement);
    }
}

function createGroupElement(groupName, groupData) {
    const details = document.createElement('details');
    details.className = 'group-details';
    details.open = true;
    details.dataset.groupName = groupName;

    details.innerHTML = `
        <summary class="group-summary">
            <span class="group-name-display">${groupName}</span>
            <button class="delete-group-btn">删除该组</button>
        </summary>
        <div class="group-content">
            <div class="form-group">
                <label>权重 (Weight):</label>
                <input type="number" step="0.1" class="group-weight-input" value="${groupData.weight || 1.0}">
            </div>
            <div class="form-group">
                <label>关键词 (Words):</label>
                <div class="words-container"></div>
            </div>
        </div>
    `;

    const wordsContainer = details.querySelector('.words-container');
    const allWords = [...(groupData.words || []), ...(groupData.auto_learned || [])];
    allWords.forEach(word => {
        const wordTag = createWordTag(word, (groupData.auto_learned || []).includes(word));
        wordsContainer.appendChild(wordTag);
    });

    const addWordInput = document.createElement('input');
    addWordInput.type = 'text';
    addWordInput.placeholder = '添加新关键词...';
    addWordInput.className = 'add-word-input';
    addWordInput.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const newWord = addWordInput.value.trim();
            if (newWord && !allWords.find(w => w === newWord)) {
                const newWordTag = createWordTag(newWord, false);
                wordsContainer.insertBefore(newWordTag, addWordInput);
                addWordInput.value = '';
                allWords.push(newWord);
            }
        }
    };
    wordsContainer.appendChild(addWordInput);

    details.querySelector('.delete-group-btn').onclick = (e) => {
        e.preventDefault();
        if (confirm(`确定要删除语义组 "${groupName}" 吗？`)) {
            details.remove();
        }
    };

    return details;
}

function createWordTag(word, isAutoLearned) {
    const tag = document.createElement('span');
    tag.className = 'word-tag';
    tag.textContent = word;
    tag.dataset.word = word;
    if (isAutoLearned) {
        tag.classList.add('auto-learned');
        tag.title = '此词由 AI 自动学习';
    }

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.className = 'remove-word-btn';
    removeBtn.onclick = () => tag.remove();
    tag.appendChild(removeBtn);
    return tag;
}

async function saveSemanticGroups() {
    const container = document.getElementById('semantic-groups-container');
    const statusSpan = document.getElementById('semantic-groups-status');
    if (!container || !statusSpan) return;

    const newGroups = {};
    const groupElements = container.querySelectorAll('.group-details');

    groupElements.forEach(el => {
        const groupName = el.dataset.groupName;
        const weight = parseFloat(el.querySelector('.group-weight-input').value) || 1.0;
        const words = [];
        const auto_learned = [];

        el.querySelectorAll('.word-tag').forEach(tag => {
            if (tag.classList.contains('auto-learned')) {
                auto_learned.push(tag.dataset.word);
            } else {
                words.push(tag.dataset.word);
            }
        });
        
        const originalGroup = semanticGroupsData.groups[groupName] || {};
        newGroups[groupName] = {
            words,
            auto_learned,
            weight,
            vector: null,
            last_activated: originalGroup.last_activated || null,
            activation_count: originalGroup.activation_count || 0,
            vector_id: originalGroup.vector_id || null
        };
    });

    const dataToSave = {
        config: semanticGroupsData.config || {},
        groups: newGroups
    };

    statusSpan.textContent = '正在保存...';
    statusSpan.className = 'status-message info';
    try {
        const response = await apiFetch(`${API_BASE_URL}/semantic-groups`, {
            method: 'POST',
            body: JSON.stringify(dataToSave)
        });
        showMessage(response.message || '语义组已成功保存!', 'success');
        statusSpan.textContent = '保存成功!';
        statusSpan.className = 'status-message success';
        initializeSemanticGroupsEditor();
    } catch (error) {
        statusSpan.textContent = `保存失败: ${error.message}`;
        statusSpan.className = 'status-message error';
    }
}

function addNewSemanticGroup() {
    const groupName = prompt('请输入新语义组的名称:');
    if (!groupName || !groupName.trim()) return;

    const normalizedGroupName = groupName.trim();
    const container = document.getElementById('semantic-groups-container');
    if (!container) return;

    if (container.querySelector(`[data-group-name="${normalizedGroupName}"]`)) {
        showMessage(`语义组 "${normalizedGroupName}" 已存在!`, 'error');
        return;
    }
    
    if (!container.querySelector('.group-details')) {
        container.innerHTML = '';
    }

    const newGroupData = { words: [], auto_learned: [], weight: 1.0 };
    const newGroupElement = createGroupElement(normalizedGroupName, newGroupData);
    container.appendChild(newGroupElement);
    newGroupElement.scrollIntoView({ behavior: 'smooth' });
}