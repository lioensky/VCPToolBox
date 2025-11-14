// AdminPanel/script.js
import { apiFetch, showMessage } from './js/utils.js';
import { parseEnvToList, buildEnvString, createFormGroup, createCommentOrEmptyElement } from './js/config.js';
import { loadPluginList, loadPluginConfig } from './js/plugins.js';
import { initializeDashboard, stopDashboardUpdates } from './js/dashboard.js';
import { initializeDailyNotesManager } from './js/notes-manager.js';
import { initializeAgentManager } from './js/agent-manager.js';
import { initializeAgentAssistantEditor } from './js/agent-assistant-editor.js';
import { initializeTvsFilesEditor } from './js/tvs-editor.js';
import { initializeServerLogViewer, stopServerLogUpdates } from './js/log-viewer.js';
import { initializePreprocessorOrderManager } from './js/preprocessor-manager.js';
import { initializeSemanticGroupsEditor } from './js/semantic-groups-editor.js';
import { initializeThinkingChainsEditor } from './js/thinking-chains-editor.js';
import { initializeVCPForum } from './js/forum.js';

document.addEventListener('DOMContentLoaded', () => {
    const pluginNavList = document.getElementById('plugin-nav')?.querySelector('ul');
    const baseConfigForm = document.getElementById('base-config-form');
    const restartServerButton = document.getElementById('restart-server-button');
    const sidebarSearchInput = document.getElementById('sidebar-search');

    const API_BASE_URL = '/admin_api';
    let originalBaseConfigEntries = [];

    /**
     * 主导航函数，根据 target 激活对应的功能模块。
     * @param {string} dataTarget - 导航链接的 data-target 属性值
     */
    function navigateTo(dataTarget) {
        const sectionIdToActivate = `${dataTarget}-section`;
        const pluginName = document.querySelector(`a[data-target="${dataTarget}"]`)?.dataset.pluginName;

        // 停止可能正在运行的定时器
        stopDashboardUpdates();
        stopServerLogUpdates();

        document.querySelectorAll('.sidebar nav li a').forEach(link => link.classList.remove('active'));
        document.querySelectorAll('.config-section').forEach(section => section.classList.remove('active-section'));

        const activeLink = document.querySelector(`a[data-target="${dataTarget}"]`);
        if (activeLink) activeLink.classList.add('active');

        const targetSection = document.getElementById(sectionIdToActivate);
        if (targetSection) {
            targetSection.classList.add('active-section');
            
            // 根据 sectionId 初始化对应的模块
            if (pluginName) {
                loadPluginConfig(pluginName).catch(err => console.error(`Failed to load config for ${pluginName}`, err));
            } else {
                switch (sectionIdToActivate) {
                    case 'dashboard-section':
                        initializeDashboard();
                        break;
                    case 'daily-notes-manager-section':
                        initializeDailyNotesManager();
                        break;
                    case 'agent-files-editor-section':
                        initializeAgentManager();
                        break;
                    case 'agent-assistant-editor-section':
                        initializeAgentAssistantEditor();
                        break;
                    case 'tvs-files-editor-section':
                        initializeTvsFilesEditor();
                        break;
                    case 'server-log-viewer-section':
                        initializeServerLogViewer();
                        break;
                    case 'preprocessor-order-manager-section':
                        initializePreprocessorOrderManager();
                        break;
                    case 'semantic-groups-editor-section':
                        initializeSemanticGroupsEditor();
                        break;
                    case 'thinking-chains-editor-section':
                        initializeThinkingChainsEditor();
                        break;
                    case 'vcp-forum-section':
                        initializeVCPForum();
                        break;
                    case 'vcptavern-editor-section':
                       const iframe = targetSection.querySelector('iframe');
                       if (iframe) iframe.src = iframe.src; // Force reload
                       break;
                }
            }
        } else {
           console.warn(`[navigateTo] Target section with ID '${sectionIdToActivate}' not found.`);
       }
   }

    /**
     * 加载全局配置。
     */
    async function loadBaseConfig() {
        if (!baseConfigForm) return;
        try {
            const data = await apiFetch(`${API_BASE_URL}/config/main`);
            originalBaseConfigEntries = parseEnvToList(data.content);
            baseConfigForm.innerHTML = ''; // Clear previous form

            originalBaseConfigEntries.forEach((entry, index) => {
                let formGroup;
                if (entry.isCommentOrEmpty) {
                    formGroup = createCommentOrEmptyElement(entry.value, index);
                } else {
                    let inferredType = 'string';
                    if (/^(true|false)$/i.test(entry.value)) inferredType = 'boolean';
                    else if (!isNaN(parseFloat(entry.value)) && isFinite(entry.value) && !entry.value.includes('.')) inferredType = 'integer';
                    
                    formGroup = createFormGroup(
                        entry.key, entry.value, inferredType,
                        `根目录 config.env 配置项: ${entry.key}`,
                        false, null, false, entry.isMultilineQuoted
                    );
                }
                baseConfigForm.appendChild(formGroup);
            });

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'form-actions';
            actionsDiv.innerHTML = `<button type="submit">保存全局配置</button>`;
            baseConfigForm.appendChild(actionsDiv);
        } catch (error) {
            baseConfigForm.innerHTML = `<p class="error-message">加载全局配置失败: ${error.message}</p>`;
        }
    }

    /**
     * 处理全局配置表单提交。
     * @param {Event} event - 提交事件
     */
    async function handleBaseConfigSubmit(event) {
        event.preventDefault();
        const newConfigString = buildEnvString(baseConfigForm, originalBaseConfigEntries);
        try {
            await apiFetch(`${API_BASE_URL}/config/main`, {
                method: 'POST',
                body: JSON.stringify({ content: newConfigString })
            });
            showMessage('全局配置已保存！部分更改可能需要重启服务生效。', 'success');
            loadBaseConfig();
        } catch (error) { /* Error handled by apiFetch */ }
    }

    /**
     * 重启服务器。
     */
    async function restartServer() {
        if (!confirm('您确定要重启服务器吗？')) return;
        try {
            showMessage('正在发送重启服务器命令...', 'info');
            const response = await apiFetch(`${API_BASE_URL}/server/restart`, { method: 'POST' });
            const message = response?.message || (typeof response === 'string' && response.includes('重启命令已发送') ? response : '服务器重启命令已发送。请稍后检查服务器状态。');
            showMessage(message, 'success', 5000);
        } catch (error) {
            console.error('Restart server failed:', error);
        }
    }

    /**
     * 过滤侧边栏导航项。
     */
    function filterSidebar() {
        const searchTerm = sidebarSearchInput.value.toLowerCase().trim();
        const navLinks = document.querySelectorAll('#plugin-nav li a');
        const categories = document.querySelectorAll('#plugin-nav li.nav-category');

        navLinks.forEach(link => {
            const linkText = link.textContent.toLowerCase();
            const parentLi = link.parentElement;
            parentLi.style.display = linkText.includes(searchTerm) ? '' : 'none';
        });

        categories.forEach(category => {
            let nextElement = category.nextElementSibling;
            let allHidden = true;
            while(nextElement && !nextElement.classList.contains('nav-category')) {
                if(nextElement.style.display !== 'none') {
                    allHidden = false;
                    break;
                }
                nextElement = nextElement.nextElementSibling;
            }
            category.style.display = allHidden ? 'none' : '';
        });
    }

    /**
     * 加载所有初始数据。
     */
    async function loadInitialData() {
        try {
            await loadBaseConfig();
            await loadPluginList();
            const firstLink = pluginNavList.querySelector('a');
            if (firstLink) {
                navigateTo(firstLink.dataset.target);
                firstLink.classList.add('active');
            }
        } catch (error) { /* Error already shown by apiFetch */ }
    }

    // --- Event Listeners ---
    if (pluginNavList) {
        pluginNavList.addEventListener('click', (event) => {
            const anchor = event.target.closest('a');
            if (anchor) {
                event.preventDefault();
                navigateTo(anchor.dataset.target);
            }
        });
    }
    if (baseConfigForm) {
        baseConfigForm.addEventListener('submit', handleBaseConfigSubmit);
    }
    if (restartServerButton) {
        restartServerButton.addEventListener('click', restartServer);
    }
    if (sidebarSearchInput) {
        sidebarSearchInput.addEventListener('input', filterSidebar);
    }

    // --- Initial Load ---
    loadInitialData();
});
