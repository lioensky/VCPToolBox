// AdminPanel/js/placeholder-viewer.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';

let allPlaceholdersList = [];

const TYPE_LABELS = {
    static_plugin: '静态插件',
    async_placeholder: '动态占位符',
    agent: 'Agent',
    env_tar_var: '环境变量',
    env_sar: '模型专属指令(SarPrompt)',
    fixed: '固定时间/Port',
    tool_description: '工具描述',
    vcp_all_tools: 'VCPAllTools',
    image_key: 'Image_Key',
    diary: '日记本',
    diary_character: '角色日记本'
};

function getTypeLabel(type) {
    return TYPE_LABELS[type] || type;
}

/**
 * 初始化占位符查看器：拉取列表、渲染表格、绑定详情弹窗与筛选。
 */
export async function initializePlaceholderViewer() {
    const listEl = document.getElementById('placeholder-viewer-list');
    const filterType = document.getElementById('placeholder-filter-type');
    const filterKeyword = document.getElementById('placeholder-filter-keyword');
    if (!listEl) return;

    listEl.innerHTML = '<p>正在加载占位符列表...</p>';
    setupDetailModal();
    setupFilterListeners();

    try {
        const result = await apiFetch(`${API_BASE_URL}/placeholders`);
        allPlaceholdersList = (result && result.data && result.data.list) ? result.data.list : [];
        populateTypeFilter(allPlaceholdersList, filterType);
        applyPlaceholderFilters();
    } catch (error) {
        listEl.innerHTML = `<p class="error-message">加载占位符列表失败: ${error.message}</p>`;
    }
}

function populateTypeFilter(list, selectEl) {
    if (!selectEl) return;
    const options = selectEl.querySelectorAll('option');
    options.forEach((opt, i) => { if (i > 0) opt.remove(); });
    const types = [...new Set(list.map(item => item.type).filter(Boolean))].sort();
    types.forEach(type => {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = getTypeLabel(type);
        selectEl.appendChild(opt);
    });
}

function setupFilterListeners() {
    const filterType = document.getElementById('placeholder-filter-type');
    const filterKeyword = document.getElementById('placeholder-filter-keyword');
    if (filterType && !filterType.dataset.listenerAttached) {
        filterType.addEventListener('change', applyPlaceholderFilters);
        filterType.dataset.listenerAttached = 'true';
    }
    if (filterKeyword && !filterKeyword.dataset.listenerAttached) {
        filterKeyword.addEventListener('input', applyPlaceholderFilters);
        filterKeyword.dataset.listenerAttached = 'true';
    }
}

function applyPlaceholderFilters() {
    const typeVal = (document.getElementById('placeholder-filter-type') || {}).value || '';
    const keyword = ((document.getElementById('placeholder-filter-keyword') || {}).value || '').trim().toLowerCase();
    let list = allPlaceholdersList;
    if (typeVal) list = list.filter(item => item.type === typeVal);
    if (keyword) {
        list = list.filter(item => {
            const name = (item.name || '').toLowerCase();
            const preview = (item.preview || '').toLowerCase();
            return name.includes(keyword) || preview.includes(keyword);
        });
    }
    const listEl = document.getElementById('placeholder-viewer-list');
    if (listEl) renderPlaceholderList(list, listEl);
}

function renderPlaceholderList(list, container) {
    container.innerHTML = '';
    if (!list || list.length === 0) {
        container.innerHTML = '<p class="description">当前无可用占位符。</p>';
        return;
    }
    const table = document.createElement('table');
    table.className = 'placeholder-viewer-table';
    table.innerHTML = `
        <colgroup>
            <col class="col-type">
            <col class="col-name">
            <col class="col-preview">
            <col class="col-desc">
            <col class="col-charcount">
        </colgroup>
        <thead>
            <tr>
                <th>类型</th>
                <th>占位符名称</th>
                <th>内容预览</th>
                <th>描述</th>
                <th>字符数</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    list.forEach(item => {
        const charCount = item.charCount != null ? String(item.charCount) : '—';
        const desc = item.description != null ? String(item.description) : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(getTypeLabel(item.type))}</td>
            <td><code>${escapeHtml(item.name || '')}</code></td>
            <td class="placeholder-preview-cell">
                <span class="placeholder-preview-text">${escapeHtml(item.preview || '')}</span>
                <span class="material-symbols-outlined placeholder-expand-icon" title="查看详情" aria-label="查看详情">expand_content</span>
            </td>
            <td class="placeholder-desc">${escapeHtml(desc)}</td>
            <td class="placeholder-charcount">${escapeHtml(charCount)}</td>
        `;
        const expandIcon = tr.querySelector('.placeholder-expand-icon');
        expandIcon.addEventListener('click', (e) => { e.preventDefault(); openDetail(item.type, item.name); });
        tbody.appendChild(tr);
    });
    container.appendChild(table);
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function setupDetailModal() {
    const modal = document.getElementById('placeholder-detail-modal');
    const backdrop = modal && modal.querySelector('.placeholder-detail-modal-backdrop');
    const closeBtn = modal && modal.querySelector('.placeholder-detail-modal-close');
    const tabs = modal && modal.querySelectorAll('.placeholder-detail-tab');
    if (!modal) return;
    if (backdrop && !backdrop.dataset.listenerAttached) {
        backdrop.addEventListener('click', closeDetailModal);
        backdrop.dataset.listenerAttached = 'true';
    }
    if (closeBtn && !closeBtn.dataset.listenerAttached) {
        closeBtn.addEventListener('click', closeDetailModal);
        closeBtn.dataset.listenerAttached = 'true';
    }
    if (tabs && tabs.length && !tabs[0].dataset.listenerAttached) {
        tabs.forEach(tab => {
            tab.addEventListener('click', () => switchDetailTab(tab.getAttribute('data-tab')));
        });
        tabs[0].dataset.listenerAttached = 'true';
    }
}

function switchDetailTab(tabId) {
    const tabs = document.querySelectorAll('.placeholder-detail-tab');
    const panels = document.querySelectorAll('.placeholder-detail-panel');
    tabs.forEach(t => {
        const isActive = t.getAttribute('data-tab') === tabId;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    panels.forEach(p => {
        const panelTab = p.id.replace('placeholder-detail-panel-', '');
        p.classList.toggle('active', panelTab === tabId);
    });
}

function closeDetailModal() {
    const modal = document.getElementById('placeholder-detail-modal');
    if (modal) {
        modal.setAttribute('aria-hidden', 'true');
        modal.classList.remove('show');
    }
}

function openDetailModal() {
    const modal = document.getElementById('placeholder-detail-modal');
    if (modal) {
        modal.setAttribute('aria-hidden', 'false');
        modal.classList.add('show');
    }
}

async function openDetail(type, name) {
    const titleEl = document.getElementById('placeholder-detail-title');
    const panelRaw = document.getElementById('placeholder-detail-panel-raw');
    const panelMarkdown = document.getElementById('placeholder-detail-panel-markdown');
    const panelJson = document.getElementById('placeholder-detail-panel-json');
    if (!titleEl || !panelRaw || !panelMarkdown || !panelJson) return;
    titleEl.textContent = name || '';
    panelRaw.innerHTML = '<p>加载中...</p>';
    panelMarkdown.innerHTML = '';
    panelJson.innerHTML = '';
    switchDetailTab('raw');
    openDetailModal();
    try {
        const result = await apiFetch(`${API_BASE_URL}/placeholders/detail?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
        const value = (result && result.data && result.data.value) != null ? String(result.data.value) : '';
        renderDetailPanels(value, panelRaw, panelMarkdown, panelJson);
    } catch (error) {
        panelRaw.innerHTML = '';
        panelRaw.textContent = `加载详情失败: ${error.message}`;
        panelMarkdown.innerHTML = '';
        panelJson.innerHTML = '';
        showMessage(`加载详情失败: ${error.message}`, 'error');
    }
}

function renderDetailPanels(value, panelRaw, panelMarkdown, panelJson) {
    // 1. 原始文本
    const preRaw = document.createElement('pre');
    preRaw.className = 'placeholder-detail-raw';
    preRaw.textContent = value;
    panelRaw.innerHTML = '';
    panelRaw.appendChild(preRaw);

    // 2. Markdown 渲染
    panelMarkdown.innerHTML = '';
    if (typeof marked !== 'undefined' && marked.parse) {
        try {
            const div = document.createElement('div');
            div.className = 'placeholder-detail-markdown';
            div.innerHTML = marked.parse(value);
            panelMarkdown.appendChild(div);
        } catch (e) {
            panelMarkdown.textContent = `Markdown 渲染失败: ${e.message}`;
        }
    } else {
        panelMarkdown.textContent = '未加载 Markdown 库，无法渲染。';
    }

    // 3. JSON 格式化
    panelJson.innerHTML = '';
    const preJson = document.createElement('pre');
    preJson.className = 'placeholder-detail-json';
    try {
        const parsed = JSON.parse(value);
        preJson.textContent = JSON.stringify(parsed, null, 2);
        panelJson.appendChild(preJson);
    } catch (e) {
        preJson.textContent = `非合法 JSON，无法格式化。\n${e.message}`;
        panelJson.appendChild(preJson);
    }
}
