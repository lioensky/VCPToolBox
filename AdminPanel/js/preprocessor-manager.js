// AdminPanel/js/preprocessor-manager.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';

/**
 * 初始化预处理器顺序管理器。
 */
export async function initializePreprocessorOrderManager() {
    const preprocessorListUl = document.getElementById('preprocessor-list');
    const preprocessorOrderStatusSpan = document.getElementById('preprocessor-order-status');

    if (!preprocessorListUl || !preprocessorOrderStatusSpan) {
        console.error('Preprocessor manager elements not found in the DOM.');
        return;
    }
    
    console.log('Initializing Preprocessor Order Manager...');
    preprocessorListUl.innerHTML = '<li>Loading...</li>';
    preprocessorOrderStatusSpan.textContent = '';
    
    setupEventListeners();

    try {
        const data = await apiFetch(`${API_BASE_URL}/preprocessors/order`);
        renderPreprocessorList(data.order, preprocessorListUl);
    } catch (error) {
        preprocessorListUl.innerHTML = `<li class="error-message">Failed to load preprocessor order: ${error.message}</li>`;
        showMessage(`Failed to load preprocessor order: ${error.message}`, 'error');
    }
}

/**
 * 设置预处理器管理器部分的事件监听器。
 */
function setupEventListeners() {
    const preprocessorListContainer = document.getElementById('preprocessor-list');
    const savePreprocessorOrderButton = document.getElementById('save-preprocessor-order-button');

    if (preprocessorListContainer && !preprocessorListContainer.dataset.listenerAttached) {
        preprocessorListContainer.addEventListener('dragover', handleDragOver);
        preprocessorListContainer.dataset.listenerAttached = 'true';
    }
    
    if (savePreprocessorOrderButton && !savePreprocessorOrderButton.dataset.listenerAttached) {
        savePreprocessorOrderButton.addEventListener('click', savePreprocessorOrder);
        savePreprocessorOrderButton.dataset.listenerAttached = 'true';
    }
}

function renderPreprocessorList(order, preprocessorListUl) {
    preprocessorListUl.innerHTML = '';
    if (order && order.length > 0) {
        order.forEach(plugin => {
            const li = document.createElement('li');
            li.draggable = true;
            li.dataset.pluginName = plugin.name;

            li.innerHTML = `
                <div class="plugin-info">
                    <span class="plugin-name">${plugin.displayName}</span>
                    <span class="plugin-description">${plugin.description}</span>
                </div>
            `;

            li.addEventListener('dragstart', () => {
                setTimeout(() => li.classList.add('dragging'), 0);
            });
            li.addEventListener('dragend', () => {
                li.classList.remove('dragging');
            });

            preprocessorListUl.appendChild(li);
        });
    } else {
        preprocessorListUl.innerHTML = '<li>No message preprocessor plugins found.</li>';
    }
}

function handleDragOver(e) {
    e.preventDefault();
    const container = e.currentTarget;
    const afterElement = getDragAfterElement(container, e.clientY);
    const dragging = document.querySelector('.dragging');
    if (dragging) {
        if (afterElement == null) {
            container.appendChild(dragging);
        } else {
            container.insertBefore(dragging, afterElement);
        }
    }
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('li:not(.dragging)')];
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

async function savePreprocessorOrder() {
    const preprocessorListUl = document.getElementById('preprocessor-list');
    const preprocessorOrderStatusSpan = document.getElementById('preprocessor-order-status');
    if (!preprocessorListUl || !preprocessorOrderStatusSpan) return;

    const newOrder = [...preprocessorListUl.querySelectorAll('li')].map(li => li.dataset.pluginName);
    preprocessorOrderStatusSpan.textContent = 'Saving...';
    preprocessorOrderStatusSpan.className = 'status-message info';

    try {
        const response = await apiFetch(`${API_BASE_URL}/preprocessors/order`, {
            method: 'POST',
            body: JSON.stringify({ order: newOrder })
        });
        showMessage(response.message, 'success');
        
        const latestData = await apiFetch(`${API_BASE_URL}/preprocessors/order`);
        preprocessorOrderStatusSpan.textContent = 'Order saved and reloaded!';
        preprocessorOrderStatusSpan.className = 'status-message success';
        renderPreprocessorList(latestData.order, preprocessorListUl);
    } catch (error) {
        preprocessorOrderStatusSpan.textContent = `Error: ${error.message}`;
        preprocessorOrderStatusSpan.className = 'status-message error';
    }
}