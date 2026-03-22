// AdminPanel/js/plugins.js
import { apiFetch, showMessage } from './utils.js';
import { parseEnvToList, buildEnvStringForPlugin, createFormGroup, createCommentOrEmptyElement } from './config.js';

const API_BASE_URL = '/admin_api';
let originalPluginConfigs = {}; // Store original parsed entries for each plugin

function renderPluginInstallerSummary(result = null) {
    const summary = document.getElementById('plugin-installer-summary');
    if (!summary) return;

    if (!result) {
        summary.innerHTML = '';
        summary.style.display = 'none';
        return;
    }

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const dependencyHints = Array.isArray(result.dependencyHints) ? result.dependencyHints : [];
    const detailHtml = dependencyHints.length > 0
        ? dependencyHints.map((hint) => `<li><code>${hint.file}</code> - ${hint.message}</li>`).join('')
        : warnings.map((warning) => `<li>${warning}</li>`).join('');

    summary.innerHTML = `
        <div class="config-item">
            <strong>${result.message || '插件操作已完成。'}</strong>
            ${warnings.length > 0 ? `<p>检测到以下依赖提示：</p><ul>${detailHtml}</ul>` : '<p>这次安装没有检测到额外依赖提示。</p>'}
        </div>
    `;
    summary.style.display = 'block';
}

function formatTrashTimestamp(value) {
    if (!value) return '未知时间';

    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '未知时间';
    return date.toLocaleString('zh-CN', { hour12: false });
}

async function restoreTrashedPluginLegacy(trashedFolderName) {
    return restoreTrashedPlugin(trashedFolderName);
    if (!confirm(`确定要恢复插件 "${displayName}" 吗？恢复后会重新加载插件列表。`)) {
        return;
    }

    const result = await apiFetch(`${API_BASE_URL}/plugins/trash/${encodeURIComponent(trashedFolderName)}/restore`, {
        method: 'POST',
        body: JSON.stringify({})
    });

    showMessage(result?.message || '插件已恢复。', 'success', 5000);
    await loadPluginList();
    await loadPluginTrashList();

    const restoredLink = document.querySelector(`a[data-plugin-name="${result?.pluginName || ''}"]`);
    if (restoredLink) {
        restoredLink.click();
    }
}

async function restoreTrashedPlugin(trashedFolderName) {
    const result = await apiFetch(`${API_BASE_URL}/plugins/trash/${encodeURIComponent(trashedFolderName)}/restore`, {
        method: 'POST',
        body: JSON.stringify({})
    });

    showMessage(result?.message || '插件已恢复。', 'success', 5000);
    await loadPluginList();
    await loadPluginTrashList();

    const restoredLink = document.querySelector(`a[data-plugin-name="${result?.pluginName || ''}"]`);
    if (restoredLink) {
        restoredLink.click();
    }
}

async function loadPluginTrashList() {
    const trashList = document.getElementById('plugin-trash-list');
    if (!trashList) return;

    try {
        const trashedPlugins = await apiFetch(`${API_BASE_URL}/plugins/trash`);
        if (!Array.isArray(trashedPlugins) || trashedPlugins.length === 0) {
            trashList.innerHTML = '<p class="description">回收站当前是空的。</p>';
            return;
        }

        trashList.innerHTML = '';
        trashedPlugins.forEach((plugin) => {
            const item = document.createElement('div');
            item.className = 'config-item';

            const title = document.createElement('div');
            title.innerHTML = `<strong>${plugin.displayName || plugin.pluginName}</strong> <span class="plugin-original-name">(${plugin.pluginName})</span>`;
            item.appendChild(title);

            const meta = document.createElement('p');
            meta.className = 'description';
            meta.textContent = `原目录: ${plugin.originalFolderName || '-'} | 删除时间: ${formatTrashTimestamp(plugin.removedAt)}${plugin.version ? ` | 版本: ${plugin.version}` : ''}`;
            item.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'form-actions';

            const restoreButton = document.createElement('button');
            restoreButton.type = 'button';
            restoreButton.textContent = '恢复插件';
            restoreButton.addEventListener('click', async () => {
                if (!confirm(`确定要恢复插件 "${plugin.displayName || plugin.pluginName}" 吗？恢复后会重新加载插件列表。`)) {
                    return;
                }
                restoreButton.disabled = true;
                try {
                    await restoreTrashedPlugin(plugin.trashedFolderName);
                } catch (error) {
                    console.error(`Failed to restore trashed plugin ${plugin.trashedFolderName}:`, error);
                    restoreButton.disabled = false;
                }
            });

            actions.appendChild(restoreButton);
            item.appendChild(actions);
            trashList.appendChild(item);
        });
    } catch (error) {
        console.error('Failed to load trashed plugins:', error);
        trashList.innerHTML = `<p class="error-message">加载回收站失败: ${error.message}</p>`;
    }
}

export function initializePluginInstaller() {
    const form = document.getElementById('plugin-installer-form');
    const input = document.getElementById('plugin-installer-zip-path');
    if (!form || !input || form.dataset.boundInstaller === 'true') return;

    renderPluginInstallerSummary(null);
    loadPluginTrashList().catch((error) => console.error('Failed to initialize plugin trash list:', error));
    form.dataset.boundInstaller = 'true';
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const zipPath = input.value.trim();
        if (!zipPath) {
            showMessage('请输入插件 zip 的本机路径。', 'error');
            return;
        }

        try {
            const result = await apiFetch(`${API_BASE_URL}/plugins/install-local-zip`, {
                method: 'POST',
                body: JSON.stringify({ zipPath })
            });

            const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
            renderPluginInstallerSummary(result);
            showMessage(result?.message || '插件安装成功。', warnings.length > 0 ? 'info' : 'success', 5000);
            if (warnings.length > 0) {
                warnings.forEach((warning) => showMessage(warning, 'info', 6000));
            }

            input.value = '';
            await loadPluginList();
            await loadPluginTrashList();
            const installedLink = document.querySelector(`a[data-plugin-name="${result?.pluginName || ''}"]`);
            if (installedLink) {
                installedLink.click();
            }
        } catch (error) {
            console.error('Failed to install plugin from local zip:', error);
        }
    });
}

/**
 * 加载插件列表并填充侧边栏导航。
 */
export async function loadPluginList() {
    const pluginNavList = document.getElementById('plugin-nav')?.querySelector('ul');
    const configDetailsContainer = document.getElementById('config-details-container');
    if (!pluginNavList || !configDetailsContainer) return;

    try {
        const plugins = await apiFetch(`${API_BASE_URL}/plugins`);
        
        // Clear existing dynamic items
        pluginNavList.querySelectorAll('li.dynamic-plugin-nav-item').forEach(item => item.remove());
        configDetailsContainer.querySelectorAll('section.dynamic-plugin-section').forEach(sec => sec.remove());
        pluginNavList.querySelectorAll('.nav-category').forEach(cat => cat.remove());


        plugins.sort((a, b) => (a.manifest.displayName || a.manifest.name).localeCompare(b.manifest.displayName || b.manifest.name));

        const enabledPlugins = plugins.filter(plugin => plugin.enabled);
        const disabledPlugins = plugins.filter(plugin => !plugin.enabled);

        if (enabledPlugins.length > 0) {
            const enabledCategoryLi = document.createElement('li');
            enabledCategoryLi.className = 'nav-category';
            enabledCategoryLi.textContent = '✅已启用插件';
            pluginNavList.appendChild(enabledCategoryLi);
            enabledPlugins.forEach(plugin => {
                const li = createPluginNavItem(plugin);
                pluginNavList.appendChild(li);
            });
        }

        if (disabledPlugins.length > 0) {
            const disabledCategoryLi = document.createElement('li');
            disabledCategoryLi.className = 'nav-category';
            disabledCategoryLi.textContent = '❎已禁用插件';
            pluginNavList.appendChild(disabledCategoryLi);
            disabledPlugins.forEach(plugin => {
                const li = createPluginNavItem(plugin);
                pluginNavList.appendChild(li);
            });
        }

        plugins.forEach(plugin => {
            createPluginConfigSection(plugin, configDetailsContainer);
        });

    } catch (error) {
        pluginNavList.innerHTML += `<li><p class="error-message">加载插件列表失败: ${error.message}</p></li>`;
    }
}

/**
 * 创建插件导航项。
 * @param {object} plugin - 插件对象
 * @returns {HTMLLIElement} - 列表项元素
 */
function createPluginNavItem(plugin) {
    const li = document.createElement('li');
    li.classList.add('dynamic-plugin-nav-item');
    const a = document.createElement('a');
    a.href = '#';
    const originalName = plugin.manifest.name;
    const displayName = plugin.manifest.displayName || originalName;
    let nameHtml = displayName;
    if (plugin.isDistributed) {
        nameHtml += ` <span class="plugin-type-icon" title="分布式插件 (来自: ${plugin.serverId || '未知'})">☁️</span>`;
    }
    nameHtml += `<br><span class="plugin-original-name">(${originalName})</span>`;
    a.innerHTML = nameHtml;
    a.dataset.target = `plugin-${plugin.manifest.name}-config`;
    a.dataset.pluginName = plugin.manifest.name;
    li.appendChild(a);
    return li;
}

/**
 * 创建插件配置区域。
 * @param {object} plugin - 插件对象
 * @param {HTMLElement} container - 容器元素
 */
function createPluginConfigSection(plugin, container) {
    const pluginSection = document.createElement('section');
    pluginSection.id = `plugin-${plugin.manifest.name}-config-section`;
    pluginSection.classList.add('config-section', 'dynamic-plugin-section');
    
    const originalName = plugin.manifest.name;
    const displayName = plugin.manifest.displayName || originalName;
    
    let descriptionHtml = plugin.manifest.description || '暂无描述';
    if (plugin.manifest.version) descriptionHtml += ` (版本: ${plugin.manifest.version})`;
    if (plugin.isDistributed) descriptionHtml += ` (来自节点: ${plugin.serverId || '未知'})`;
    if (!plugin.enabled) descriptionHtml += ' <span class="plugin-disabled-badge">(已禁用)</span>';

    let titleHtml = `${displayName} <span class="plugin-original-name">(${originalName})</span> 配置`;
    if (!plugin.enabled) titleHtml += ' <span class="plugin-disabled-badge-title">(已禁用)</span>';
    if (plugin.isDistributed) titleHtml += ' <span class="plugin-type-icon" title="分布式插件">☁️</span>';
    
    pluginSection.innerHTML = `<h2>${titleHtml}</h2><p class="plugin-meta">${descriptionHtml}</p>`;

    const pluginControlsDiv = document.createElement('div');
    pluginControlsDiv.className = 'plugin-controls';

    const toggleButton = document.createElement('button');
    toggleButton.id = `toggle-plugin-${plugin.manifest.name}-button`;
    toggleButton.textContent = plugin.enabled ? '禁用插件' : '启用插件';
    toggleButton.classList.add('toggle-plugin-button');
    if (!plugin.enabled) {
        toggleButton.classList.add('disabled-state');
    }

    if (plugin.isDistributed) {
        toggleButton.disabled = true;
        toggleButton.title = '分布式插件的状态由其所在的节点管理，无法在此处直接启停。';
    }

    toggleButton.addEventListener('click', async () => {
        const currentEnabledState = !toggleButton.classList.contains('disabled-state');
        const enable = !currentEnabledState;

        if (!confirm(`确定要${enable ? '启用' : '禁用'}插件 "${displayName}" 吗？更改可能需要重启服务才能生效。`)) {
            return;
        }

        toggleButton.disabled = true;
        toggleButton.textContent = enable ? '正在启用...' : '正在禁用...';

        try {
            const result = await apiFetch(`${API_BASE_URL}/plugins/${plugin.manifest.name}/toggle`, {
                method: 'POST',
                body: JSON.stringify({ enable: enable })
            });
            showMessage(result.message, 'success');
            loadPluginList();
            loadPluginConfig(plugin.manifest.name);
        } catch (error) {
             console.error(`Failed to toggle plugin ${plugin.manifest.name}:`, error);
             toggleButton.disabled = false;
             toggleButton.textContent = currentEnabledState ? '禁用插件' : '启用插件';
             toggleButton.classList.toggle('disabled-state', !currentEnabledState);
        }
    });

    pluginControlsDiv.appendChild(toggleButton);

    const uninstallButton = document.createElement('button');
    uninstallButton.type = 'button';
    uninstallButton.textContent = '卸载插件';
    uninstallButton.classList.add('toggle-plugin-button');
    uninstallButton.style.backgroundColor = '#8f2d2d';
    uninstallButton.style.marginLeft = '8px';

    if (plugin.isDistributed) {
        uninstallButton.disabled = true;
        uninstallButton.title = '分布式插件由远端节点提供，不能在这里直接卸载。';
    } else {
        uninstallButton.addEventListener('click', async () => {
            if (!confirm(`确定要卸载插件 "${displayName}" 吗？第一版会把插件目录移动到 Plugin/.trash。`)) {
                return;
            }

            uninstallButton.disabled = true;
            try {
                const result = await apiFetch(`${API_BASE_URL}/plugins/${plugin.manifest.name}/uninstall`, {
                    method: 'POST',
                    body: JSON.stringify({})
                });
                showMessage(result?.message || '插件已卸载。', 'success', 5000);
                await loadPluginList();
                await loadPluginTrashList();
                document.querySelector('a[data-target="plugin-installer"]')?.click();
            } catch (error) {
                console.error(`Failed to uninstall plugin ${plugin.manifest.name}:`, error);
                uninstallButton.disabled = false;
            }
        });
    }

    pluginControlsDiv.appendChild(uninstallButton);
    pluginSection.appendChild(pluginControlsDiv);

    const form = document.createElement('form');
    form.id = `plugin-${plugin.manifest.name}-config-form`;
    pluginSection.appendChild(form);
    container.appendChild(pluginSection);

    if (plugin.configEnvContent) {
        originalPluginConfigs[plugin.manifest.name] = parseEnvToList(plugin.configEnvContent);
    } else {
        originalPluginConfigs[plugin.manifest.name] = [];
    }
}

/**
 * 加载指定插件的配置并渲染表单。
 * @param {string} pluginName - 插件名称
 */
export async function loadPluginConfig(pluginName) {
    const form = document.getElementById(`plugin-${pluginName}-config-form`);
    if (!form) {
        console.error(`Form not found for plugin ${pluginName}`);
        return;
    }
    form.innerHTML = '';

    try {
        const pluginData = (await apiFetch(`${API_BASE_URL}/plugins`)).find(p => p.manifest.name === pluginName);
        if (!pluginData) {
            throw new Error(`Plugin data for ${pluginName} not found.`);
        }
        
        const manifest = pluginData.manifest;
        const configEnvContent = pluginData.configEnvContent || "";
        originalPluginConfigs[pluginName] = parseEnvToList(configEnvContent);

        const schemaFieldsContainer = document.createElement('div');
        const customFieldsContainer = document.createElement('div');
        let hasSchemaFields = false;
        let hasCustomFields = false;

        const configSchema = manifest.configSchema || {};
        const presentInEnv = new Set(originalPluginConfigs[pluginName].filter(e => !e.isCommentOrEmpty).map(e => e.key));

        for (const key in configSchema) {
            hasSchemaFields = true;
            const expectedType = configSchema[key];
            const entry = originalPluginConfigs[pluginName].find(e => e.key === key && !e.isCommentOrEmpty);
            const value = entry ? entry.value : (manifest.defaults?.[key] ?? '');
            const isMultiline = entry ? entry.isMultilineQuoted : (String(value).includes('\n'));
            
            let descriptionHtml = manifest.configSchemaDescriptions?.[key] || `Schema 定义: ${key}`;
            if (entry) {
                descriptionHtml += ` <span class="defined-in">(当前在插件 .env 中定义)</span>`;
            } else if (manifest.defaults?.[key] !== undefined) {
                descriptionHtml += ` <span class="defined-in">(使用插件清单默认值)</span>`;
            } else {
                 descriptionHtml += ` <span class="defined-in">(未设置，将继承全局或为空)</span>`;
            }

            const formGroup = createFormGroup(key, value, expectedType, descriptionHtml, true, pluginName, false, isMultiline);
            schemaFieldsContainer.appendChild(formGroup);
            presentInEnv.delete(key);
        }

        originalPluginConfigs[pluginName].forEach((entry, index) => {
            if (entry.isCommentOrEmpty) {
                customFieldsContainer.appendChild(createCommentOrEmptyElement(entry.value, `${pluginName}-comment-${index}`));
            } else if (presentInEnv.has(entry.key)) {
                hasCustomFields = true;
                const descriptionHtml = `自定义配置项: ${entry.key} <span class="defined-in">(当前在插件 .env 中定义)</span>`;
                const formGroup = createFormGroup(entry.key, entry.value, 'string', descriptionHtml, true, pluginName, true, entry.isMultilineQuoted);
                customFieldsContainer.appendChild(formGroup);
            }
        });

        if (hasSchemaFields) {
            const schemaTitle = document.createElement('h3');
            schemaTitle.textContent = 'Schema 定义的配置';
            form.appendChild(schemaTitle);
            form.appendChild(schemaFieldsContainer);
        }
        if (hasCustomFields || originalPluginConfigs[pluginName].some(e => e.isCommentOrEmpty)) {
            const customTitle = document.createElement('h3');
            customTitle.textContent = '自定义 .env 配置项 (及注释/空行)';
            form.appendChild(customTitle);
            form.appendChild(customFieldsContainer);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'form-actions';

        const addConfigButton = document.createElement('button');
        addConfigButton.type = 'button';
        addConfigButton.textContent = '添加自定义配置项';
        addConfigButton.classList.add('add-config-btn');
        addConfigButton.addEventListener('click', () => addCustomConfigFieldToPluginForm(form, pluginName, customFieldsContainer));
        actionsDiv.appendChild(addConfigButton);

        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = `保存 ${pluginName} 配置`;
        actionsDiv.appendChild(submitButton);
        form.appendChild(actionsDiv);

        form.removeEventListener('submit', handlePluginFormSubmit);
        form.addEventListener('submit', handlePluginFormSubmit);

        // Invocation Commands Editor
        if (manifest.capabilities?.invocationCommands?.length > 0) {
            const commandsSection = createInvocationCommandsEditor(pluginName, manifest.capabilities.invocationCommands);
            const pluginFormActions = form.querySelector('.form-actions');
            if (pluginFormActions) {
                form.insertBefore(commandsSection, pluginFormActions);
            } else {
                form.appendChild(commandsSection);
            }
        }

    } catch (error) {
        form.innerHTML = `<p class="error-message">加载插件 ${pluginName} 配置失败: ${error.message}</p>`;
    }
}

/**
 * 处理插件配置表单的提交。
 * @param {Event} event - 提交事件
 */
async function handlePluginFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const pluginName = form.id.match(/plugin-(.*?)-config-form/)[1];
    
    const currentPluginEntries = originalPluginConfigs[pluginName] || [];
    const newConfigString = buildEnvStringForPlugin(form, currentPluginEntries, pluginName);

    try {
        await apiFetch(`${API_BASE_URL}/plugins/${pluginName}/config`, {
            method: 'POST',
            body: JSON.stringify({ content: newConfigString })
        });
        showMessage(`${pluginName} 配置已保存！更改可能需要重启插件或服务生效。`, 'success');
        loadPluginConfig(pluginName);
    } catch (error) { /* Error handled by apiFetch */ }
}

/**
 * 向插件表单添加自定义配置字段。
 * @param {HTMLFormElement} form - 表单元素
 * @param {string} pluginName - 插件名称
 * @param {HTMLElement} containerToAddTo - 要添加到的容器
 */
function addCustomConfigFieldToPluginForm(form, pluginName, containerToAddTo) {
    const key = prompt("请输入新自定义配置项的键名 (例如 MY_PLUGIN_VAR):");
    if (!key || !key.trim()) return;
    const normalizedKey = key.trim().replace(/\s+/g, '_');

    if (originalPluginConfigs[pluginName]?.some(entry => entry.key === normalizedKey) || form.elements[`${pluginName}-${normalizedKey}`]) {
        showMessage(`配置项 "${normalizedKey}" 已存在！`, 'error');
        return;
    }

    const descriptionHtml = `自定义配置项: ${normalizedKey} <span class="defined-in">(新添加)</span>`;
    const formGroup = createFormGroup(normalizedKey, '', 'string', descriptionHtml, true, pluginName, true, false);
    
    if (!originalPluginConfigs[pluginName]) {
        originalPluginConfigs[pluginName] = [];
    }
    originalPluginConfigs[pluginName].push({ key: normalizedKey, value: '', isCommentOrEmpty: false, isMultilineQuoted: false });

    const actionsDiv = form.querySelector('.form-actions');
    if (actionsDiv) {
        form.insertBefore(formGroup, actionsDiv);
    } else {
        form.appendChild(formGroup);
    }
}

/**
 * 创建调用命令编辑器的 UI。
 * @param {string} pluginName - 插件名称
 * @param {Array<object>} commands - 命令列表
 * @returns {HTMLDivElement} - 命令编辑器区域的 div 元素
 */
function createInvocationCommandsEditor(pluginName, commands) {
    const commandsSection = document.createElement('div');
    commandsSection.className = 'invocation-commands-section';
    const commandsTitle = document.createElement('h3');
    commandsTitle.textContent = '调用命令 AI 指令编辑';
    commandsSection.appendChild(commandsTitle);

    commands.forEach(cmd => {
        const commandIdentifier = cmd.commandIdentifier || cmd.command;
        if (!commandIdentifier) return;

        const commandItem = document.createElement('div');
        commandItem.className = 'command-item';
        commandItem.dataset.commandIdentifier = commandIdentifier;

        commandItem.innerHTML = `<h4>命令: ${commandIdentifier}</h4>`;

        const cmdFormGroup = document.createElement('div');
        cmdFormGroup.className = 'form-group';

        const descLabel = document.createElement('label');
        const descTextareaId = `cmd-desc-${pluginName}-${commandIdentifier.replace(/\s+/g, '_')}`;
        descLabel.htmlFor = descTextareaId;
        descLabel.textContent = '指令描述 (AI Instructions):';
        cmdFormGroup.appendChild(descLabel);

        const descTextarea = document.createElement('textarea');
        descTextarea.id = descTextareaId;
        descTextarea.className = 'command-description-edit';
        descTextarea.rows = Math.max(5, (cmd.description || '').split('\n').length + 2);
        descTextarea.value = cmd.description || '';
        cmdFormGroup.appendChild(descTextarea);
        
        const cmdActionsDiv = document.createElement('div');
        cmdActionsDiv.className = 'form-actions';

        const saveCmdDescButton = document.createElement('button');
        saveCmdDescButton.type = 'button';
        saveCmdDescButton.textContent = '保存此指令描述';
        
        const cmdStatusP = document.createElement('p');
        cmdStatusP.className = 'status command-status';

        saveCmdDescButton.addEventListener('click', async () => {
            await saveInvocationCommandDescription(pluginName, commandIdentifier, descTextarea, cmdStatusP);
        });
        cmdActionsDiv.appendChild(saveCmdDescButton);
        cmdFormGroup.appendChild(cmdActionsDiv);
        cmdFormGroup.appendChild(cmdStatusP);
        commandItem.appendChild(cmdFormGroup);
        commandsSection.appendChild(commandItem);
    });
    return commandsSection;
}

/**
 * 保存调用命令的描述。
 * @param {string} pluginName - 插件名称
 * @param {string} commandIdentifier - 命令标识符
 * @param {HTMLTextAreaElement} textareaElement - 文本区域元素
 * @param {HTMLElement} statusElement - 状态显示元素
 */
async function saveInvocationCommandDescription(pluginName, commandIdentifier, textareaElement, statusElement) {
    const newDescription = textareaElement.value;
    statusElement.textContent = '正在保存描述...';
    statusElement.className = 'status command-status info';

    const apiUrl = `${API_BASE_URL}/plugins/${pluginName}/commands/${commandIdentifier}/description`;

    if (!pluginName || !commandIdentifier) {
        const errorMsg = `保存描述失败: 插件名称或命令标识符为空。`;
        showMessage(errorMsg, 'error');
        statusElement.textContent = '保存失败: 内部错误';
        statusElement.className = 'status command-status error';
        return;
    }

    try {
        await apiFetch(apiUrl, {
            method: 'POST',
            body: JSON.stringify({ description: newDescription })
        });
        showMessage(`指令 "${commandIdentifier}" 的描述已成功保存!`, 'success');
        statusElement.textContent = '描述已保存!';
        statusElement.className = 'status command-status success';
    } catch (error) {
        statusElement.textContent = `保存失败: ${error.message}`;
        statusElement.className = 'status command-status error';
    }
}

// Listen for custom event to handle config field deletion
document.addEventListener('config-field-deleted', (e) => {
    const { pluginName, key } = e.detail;
    if (pluginName && originalPluginConfigs[pluginName]) {
        originalPluginConfigs[pluginName] = originalPluginConfigs[pluginName].filter(entry => entry.key !== key);
    }
});
