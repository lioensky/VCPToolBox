// Helper function to parse .env content string into a list of objects
function parseEnvToList(content) {
    const lines = content.split(/\r?\n/);
    const entries = []; // Array of { key, value, isCommentOrEmpty, isMultilineQuoted, originalLineNumStart, originalLineNumEnd }
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        const currentLineNum = i;

        if (trimmedLine.startsWith('#') || trimmedLine === '') {
            entries.push({
                key: null,
                value: line, // For comments/empty, value holds the full line
                isCommentOrEmpty: true,
                isMultilineQuoted: false,
                originalLineNumStart: currentLineNum,
                originalLineNumEnd: currentLineNum
            });
            i++;
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
            // Line without '=', treat as a comment or malformed
            entries.push({ key: null, value: line, isCommentOrEmpty: true, note: 'Malformed line (no equals sign)', originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
            i++;
            continue;
        }

        const key = line.substring(0, eqIndex).trim();
        let valueString = line.substring(eqIndex + 1); // Don't trim initial valueString to check for quotes accurately

        // Check for single-quoted values (can be multiline)
        if (valueString.trim().startsWith("'")) {
            let accumulatedValue;
            // Remove leading quote and any space before it for the first line's content part
            let firstLineContent = valueString.substring(valueString.indexOf("'") + 1);
            
            if (firstLineContent.endsWith("'") && !lines.slice(i + 1).some(l => l.trim().endsWith("'") && !l.trim().startsWith("'"))) {
                // Single line quoted value: KEY='VALUE'
                accumulatedValue = firstLineContent.substring(0, firstLineContent.length - 1);
                entries.push({ key, value: accumulatedValue, isCommentOrEmpty: false, isMultilineQuoted: true, originalLineNumStart: currentLineNum, originalLineNumEnd: i });
            } else {
                // Multiline quoted value
                let multilineContent = [firstLineContent];
                let endLineNum = i;
                i++; // Move to next line
                while (i < lines.length) {
                    const nextLine = lines[i];
                    multilineContent.push(nextLine);
                    endLineNum = i;
                    if (nextLine.trim().endsWith("'")) {
                        // Found the end of the multiline quote
                        // Remove trailing quote from the last line of multiline content
                        let lastContentLine = multilineContent.pop();
                        multilineContent.push(lastContentLine.substring(0, lastContentLine.lastIndexOf("'")));
                        break;
                    }
                    i++;
                }
                accumulatedValue = multilineContent.join('\n');
                entries.push({ key, value: accumulatedValue, isCommentOrEmpty: false, isMultilineQuoted: true, originalLineNumStart: currentLineNum, originalLineNumEnd: endLineNum });
            }
        } else {
            // Normal, unquoted key-value, or value might have spaces but not quoted
            entries.push({ key, value: valueString.trim(), isCommentOrEmpty: false, isMultilineQuoted: false, originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
        }
        i++;
    }
    return entries;
}

document.addEventListener('DOMContentLoaded', () => {
    const mainConfigEditor = document.getElementById('mainConfigEditor');
    const saveMainConfigButton = document.getElementById('saveMainConfig');
    const mainConfigStatus = document.getElementById('mainConfigStatus');
    const restartServerButton = document.getElementById('restartServer'); // 新增：获取重启按钮
    const pluginListDiv = document.getElementById('pluginList');
    const pluginStatus = document.getElementById('pluginStatus');
    const pluginStatsDisplay = document.getElementById('pluginStatsDisplay'); // 获取顶部栏插件统计元素
 
    const API_BASE_URL = '/admin_api'; // 我们将在 server.js 中定义这个基础路径

    // --- 主配置处理 ---
    async function loadMainConfig() {
        try {
            mainConfigStatus.textContent = '正在加载主配置...';
            mainConfigEditor.innerHTML = ''; // 清空旧内容
            // Fetch the filtered content for display (sensitive info like AdminPassword should be absent)
            const response = await fetch(`${API_BASE_URL}/config/main`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            const parsedEntries = parseEnvToList(data.content); // Use the new parser

            parsedEntries.forEach((entry, index) => {
                const lineElement = document.createElement('div');
                lineElement.classList.add('config-item');

                if (entry.isCommentOrEmpty) {
                    const commentElement = document.createElement('div');
                    commentElement.classList.add('config-comment');
                    commentElement.textContent = entry.value; // entry.value holds the full comment/empty line
                    lineElement.appendChild(commentElement);
                    lineElement.dataset.entryType = 'commentOrEmpty';
                    // For comments/empty lines, store the original content for reconstruction
                    lineElement.dataset.originalContentForSave = entry.value;
                } else { // KV pair
                    const key = entry.key;
                    const value = entry.value; // This is the pure value, quotes removed, \n are actual newlines

                    const keyLabel = document.createElement('label');
                    keyLabel.classList.add('config-key');
                    keyLabel.textContent = key;
                    const elementId = `config-value-${index}`;
                    keyLabel.htmlFor = elementId;

                    let valueElement;
                    // Use textarea if the pure value contains newlines OR if it was originally a multiline quoted string
                    if (value.includes('\n') || entry.isMultilineQuoted) {
                        valueElement = document.createElement('textarea');
                        // Estimate rows: at least 3, or enough for content + a bit more
                        valueElement.rows = Math.max(3, value.split('\n').length + (entry.isMultilineQuoted ? 1 : 0));
                        valueElement.value = value; // Textarea handles actual \n correctly
                    } else {
                        valueElement = document.createElement('input');
                        valueElement.type = 'text';
                        valueElement.value = value;
                    }
                    
                    valueElement.classList.add('config-value');
                    valueElement.id = elementId;
                    valueElement.dataset.key = key;
                    // Store if the original value was multiline quoted to help with saving format
                    valueElement.dataset.isMultilineQuoted = entry.isMultilineQuoted;

                    lineElement.appendChild(keyLabel);
                    lineElement.appendChild(valueElement); // Corrected from valueInput to valueElement
                    lineElement.dataset.entryType = 'kv';
                    lineElement.dataset.key = key; // Also on lineElement for easier access during save
                }
                mainConfigEditor.appendChild(lineElement);
            });
            mainConfigStatus.textContent = '主配置已加载';
        } catch (error) {
            console.error('加载主配置失败:', error);
            mainConfigEditor.innerHTML = `<p class="error">加载主配置失败: ${error.message}</p>`;
            mainConfigStatus.textContent = `加载主配置失败: ${error.message}`;
        }
    }

    async function saveMainConfig() {
        try {
            mainConfigStatus.textContent = '正在保存主配置...';

            // 1. Collect UI values
            const editedFieldValues = new Map(); // key -> {value: ui_value (with \n), originalIsMultilineQuoted: boolean}
            const configItems = mainConfigEditor.querySelectorAll('.config-item');

            configItems.forEach(item => {
                const entryType = item.dataset.entryType;
                if (entryType === 'kv') {
                    const key = item.dataset.key;
                    const valueElement = item.querySelector('input.config-value, textarea.config-value');
                    if (valueElement) {
                        // Read the isMultilineQuoted state that was set during load
                        const isMultilineQuotedFromLoad = valueElement.dataset.isMultilineQuoted === 'true';
                        editedFieldValues.set(key, {
                            value: valueElement.value, // value from UI, already has \n if it was a textarea
                            isMultilineQuoted: isMultilineQuotedFromLoad
                        });
                    }
                }
                // For 'commentOrEmpty' items, we'll fetch their original content later if needed, or rely on originalParsedEntries
            });

            // 2. Get original raw content and parse it
            const originalResponse = await fetch(`${API_BASE_URL}/config/main/raw`);
            if (!originalResponse.ok) {
                throw new Error(`获取原始配置失败! status: ${originalResponse.status}`);
            }
            const originalData = await originalResponse.json();
            const originalParsedEntries = parseEnvToList(originalData.content);

            // 3. Merge and construct final content
            const finalContentLines = [];
            const sensitiveKeys = ['AdminPassword', 'AdminUsername'];

            originalParsedEntries.forEach(originalEntry => {
                if (originalEntry.isCommentOrEmpty) {
                    // For comments or empty lines from the original raw file, push their original content
                    finalContentLines.push(originalEntry.value);
                } else { // KV pair from original raw file
                    const key = originalEntry.key;
                    let valueToSave;
                    let saveWithQuotes;

                    if (sensitiveKeys.includes(key)) {
                        valueToSave = originalEntry.value; // Use original value for sensitive keys
                        saveWithQuotes = originalEntry.isMultilineQuoted; // And original quoting style
                    } else if (editedFieldValues.has(key)) {
                        const editedData = editedFieldValues.get(key);
                        valueToSave = editedData.value; // UI value, contains \n if textarea
                        // Decide on quoting: if new value has \n, or if original was multiline quoted (even if new value is single line)
                        saveWithQuotes = valueToSave.includes('\n') || editedData.isMultilineQuoted;
                    } else {
                        // Key was in original but not in UI (e.g., a new key added to original file not yet reflected in UI load after a refresh)
                        // Or a key that /config/main might have filtered but /config/main/raw has.
                        // Fallback to original value and quoting.
                        valueToSave = originalEntry.value;
                        saveWithQuotes = originalEntry.isMultilineQuoted;
                    }

                    if (saveWithQuotes) {
                        // Value already contains \n if it's multiline. Just wrap with single quotes.
                        finalContentLines.push(`${key}='${valueToSave}'`);
                    } else {
                        finalContentLines.push(`${key}=${valueToSave}`);
                    }
                }
            });
            const finalContent = finalContentLines.join('\n');

            // 4. 发送合并后的内容到后端保存
            const response = await fetch(`${API_BASE_URL}/config/main`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: finalContent }), // 发送完整内容
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            mainConfigStatus.textContent = data.message || '主配置已保存。';
            // 重新加载以显示过滤后的内容
            await loadMainConfig();

        } catch (error) {
            console.error('保存主配置失败:', error);
            mainConfigStatus.textContent = `保存主配置失败: ${error.message}`;
        }
    }

    // --- 服务器操作 ---
    async function restartServer() {
        try {
            mainConfigStatus.textContent = '正在发送重启服务器命令...';
            const response = await fetch(`${API_BASE_URL}/server/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误，服务器可能已关闭或正在重启' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            mainConfigStatus.textContent = data.message || '服务器重启命令已发送。请稍后检查服务器状态。';
        } catch (error) {
            console.error('重启服务器失败:', error);
            mainConfigStatus.textContent = `重启服务器失败: ${error.message}`;
        }
    }
 
    // --- 插件管理 ---
    async function loadPlugins() {
        try {
            pluginStatus.textContent = '正在加载插件列表...';
            pluginListDiv.innerHTML = ''; // 清空现有列表
            const response = await fetch(`${API_BASE_URL}/plugins`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const plugins = await response.json();
            if (plugins.length === 0) {
                pluginListDiv.innerHTML = '<p>未找到任何插件。</p>';
                pluginStatus.textContent = '未找到插件。';
                return;
            }
            
            // 更新顶部栏插件数量
            if (pluginStatsDisplay) {
                 pluginStatsDisplay.textContent = `插件: ${plugins.length}`;
            }

            plugins.forEach(plugin => {
                const pluginItem = document.createElement('div');
                pluginItem.classList.add('plugin-item');
                pluginItem.dataset.pluginName = plugin.name;

                let descriptionHtml = '';
                if (plugin.manifest && plugin.manifest.description) {
                    descriptionHtml = `<p><strong>描述:</strong> <span class="description-text">${escapeHtml(plugin.manifest.description)}</span></p>
                                       <textarea class="description-edit" style="display:none;">${escapeHtml(plugin.manifest.description)}</textarea>`;
                } else {
                    descriptionHtml = `<p><strong>描述:</strong> <span class="description-text">(无描述)</span></p>
                                       <textarea class="description-edit" style="display:none;"></textarea>`;
                }


                pluginItem.innerHTML = `
                    <h3>${escapeHtml(plugin.manifest.displayName || plugin.name)} (${escapeHtml(plugin.name)})</h3>
                    ${descriptionHtml}
                    <p><strong>状态:</strong> <span class="plugin-state">${plugin.enabled ? '已启用' : '已禁用'}</span></p>
                    <div class="actions">
                        <button class="toggle-button ${plugin.enabled ? 'enabled' : 'disabled'}">${plugin.enabled ? '禁用插件' : '启用插件'}</button>
                        <button class="edit-description-button">编辑描述</button>
                        <button class="save-description-button" style="display:none;">保存描述</button>
                        <button class="cancel-edit-description-button" style="display:none;">取消编辑</button>
                    </div>
                    <h4>插件配置 (config.env)</h4>
                    <textarea class="plugin-config-content" rows="5" placeholder="此插件没有独立的 config.env 文件，或加载失败。">${plugin.configEnvContent || ''}</textarea>
                    <div class="plugin-config-controls">
                        <button class="save-plugin-config-button">保存插件配置</button>
                        <p class="status plugin-specific-status" id="plugin-config-status-${plugin.name}"></p>
                    </div>
                `;
                
                // --- 新增：显示和编辑 Invocation Commands ---
                const commandsSection = document.createElement('div');
                commandsSection.classList.add('invocation-commands-section');
                let commandsHtml = '<h4>调用命令 (Invocation Commands)</h4>';
                
                if (plugin.manifest && plugin.manifest.capabilities && plugin.manifest.capabilities.invocationCommands && plugin.manifest.capabilities.invocationCommands.length > 0) {
                    commandsHtml += '<div class="commands-list">';
                    plugin.manifest.capabilities.invocationCommands.forEach((command, cmdIndex) => {
                        const commandId = command.commandIdentifier || `cmd-${cmdIndex}`;
                        commandsHtml += `
                            <div class="command-item" data-command-identifier="${escapeHtml(commandId)}">
                                <h5>命令: ${escapeHtml(command.commandIdentifier)}</h5>
                                <label for="cmd-desc-${plugin.name}-${commandId}">指令描述:</label>
                                <textarea id="cmd-desc-${plugin.name}-${commandId}" class="command-description-edit" rows="8">${escapeHtml(command.description || '')}</textarea>
                                <button class="save-command-description-button" data-plugin-name="${plugin.name}" data-command-id="${commandId}">保存此指令描述</button>
                                <p class="status command-specific-status" id="command-status-${plugin.name}-${commandId}"></p>
                            </div>
                        `;
                    });
                    commandsHtml += '</div>';
                } else {
                    commandsHtml += '<p>此插件没有定义调用命令。</p>';
                }
                commandsSection.innerHTML = commandsHtml;
                pluginItem.appendChild(commandsSection);
                // --- 结束新增 ---

                pluginListDiv.appendChild(pluginItem);
            });
            pluginStatus.textContent = '插件列表已加载。';
            attachPluginEventListeners();
        } catch (error) {
            console.error('加载插件列表失败:', error);
            pluginListDiv.innerHTML = `<p>加载插件列表失败: ${error.message}</p>`;
            pluginStatus.textContent = `加载插件列表失败: ${error.message}`;
            // 加载失败时也更新状态显示
            if (pluginStatsDisplay) {
                 pluginStatsDisplay.textContent = `插件: 加载失败`;
            }
        }
    }

    function attachPluginEventListeners() {
        document.querySelectorAll('.plugin-item').forEach(item => {
            const pluginName = item.dataset.pluginName;
            const toggleButton = item.querySelector('.toggle-button');
            const editButton = item.querySelector('.edit-description-button');
            const saveButton = item.querySelector('.save-description-button');
            const cancelButton = item.querySelector('.cancel-edit-description-button');
            const descriptionText = item.querySelector('.description-text');
            const descriptionEdit = item.querySelector('.description-edit');
            const savePluginConfigButton = item.querySelector('.save-plugin-config-button');
            const pluginConfigContent = item.querySelector('.plugin-config-content');
            // const pluginSpecificStatus = item.querySelector('.plugin-specific-status'); // This might be too generic now

            // Event listeners for new command description save buttons
            item.querySelectorAll('.save-command-description-button').forEach(saveCmdDescButton => {
                saveCmdDescButton.addEventListener('click', async () => {
                    const cmdPluginName = saveCmdDescButton.dataset.pluginName;
                    const commandId = saveCmdDescButton.dataset.commandId;
                    const commandItemElement = saveCmdDescButton.closest('.command-item');
                    const descriptionTextarea = commandItemElement.querySelector('.command-description-edit');
                    const newDescription = descriptionTextarea.value;
                    // Placeholder for the actual save function call
                    await saveInvocationCommandDescription(cmdPluginName, commandId, newDescription, commandItemElement);
                });
            });

            if (toggleButton) {
                toggleButton.addEventListener('click', async () => {
                    const enable = !toggleButton.classList.contains('enabled');
                    await togglePlugin(pluginName, enable, item);
                });
            }

            if (editButton && descriptionText && descriptionEdit && saveButton && cancelButton) {
                editButton.addEventListener('click', () => {
                    descriptionText.style.display = 'none';
                    descriptionEdit.style.display = 'block';
                    editButton.style.display = 'none';
                    saveButton.style.display = 'inline-block';
                    cancelButton.style.display = 'inline-block';
                    descriptionEdit.value = descriptionText.textContent === '(无描述)' ? '' : descriptionText.textContent;
                    descriptionEdit.focus();
                });

                saveButton.addEventListener('click', async () => {
                    await savePluginDescription(pluginName, descriptionEdit.value, item);
                });

                cancelButton.addEventListener('click', () => {
                    descriptionText.style.display = 'block';
                    descriptionEdit.style.display = 'none';
                    editButton.style.display = 'inline-block';
                    saveButton.style.display = 'none';
                    cancelButton.style.display = 'none';
                });
            }
            
            if (savePluginConfigButton && pluginConfigContent) {
                savePluginConfigButton.addEventListener('click', async () => {
                    await savePluginConfig(pluginName, pluginConfigContent.value, item);
                });
            }
        });
    }

    async function togglePlugin(pluginName, enable, pluginItemElement) {
        const statusElement = pluginItemElement.querySelector('.plugin-specific-status') || pluginStatus;
        try {
            statusElement.textContent = `正在${enable ? '启用' : '禁用'}插件 ${pluginName}...`;
            const response = await fetch(`${API_BASE_URL}/plugins/${pluginName}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enable }),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            statusElement.textContent = data.message || `插件 ${pluginName} 已${enable ? '启用' : '禁用'}。`;
            // 重新加载插件列表以更新状态
            await loadPlugins();
        } catch (error) {
            console.error(`操作插件 ${pluginName} 失败:`, error);
            statusElement.textContent = `操作插件 ${pluginName} 失败: ${error.message}`;
        }
    }
    
    async function savePluginDescription(pluginName, description, pluginItemElement) {
        const statusElement = pluginItemElement.querySelector('.plugin-specific-status') || pluginStatus;
        try {
            statusElement.textContent = `正在保存 ${pluginName} 的描述...`;
            const response = await fetch(`${API_BASE_URL}/plugins/${pluginName}/description`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description }),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            statusElement.textContent = data.message || `插件 ${pluginName} 的描述已保存。`;
            // 更新界面上的描述并切换回显示模式
            const descriptionText = pluginItemElement.querySelector('.description-text');
            const descriptionEdit = pluginItemElement.querySelector('.description-edit');
            const editButton = pluginItemElement.querySelector('.edit-description-button');
            const saveButton = pluginItemElement.querySelector('.save-description-button');
            const cancelButton = pluginItemElement.querySelector('.cancel-edit-description-button');

            descriptionText.textContent = description || '(无描述)';
            descriptionText.style.display = 'block';
            descriptionEdit.style.display = 'none';
            editButton.style.display = 'inline-block';
            saveButton.style.display = 'none';
            cancelButton.style.display = 'none';

        } catch (error) {
            console.error(`保存插件 ${pluginName} 描述失败:`, error);
            statusElement.textContent = `保存插件 ${pluginName} 描述失败: ${error.message}`;
        }
    }

    async function savePluginConfig(pluginName, content, pluginItemElement) {
        const statusElement = pluginItemElement.querySelector('.plugin-specific-status') || pluginStatus;
        try {
            statusElement.textContent = `正在保存 ${pluginName} 的配置...`;
            const response = await fetch(`${API_BASE_URL}/plugins/${pluginName}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
             if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            statusElement.textContent = data.message || `插件 ${pluginName} 的配置已保存。`;
        } catch (error) {
            console.error(`保存插件 ${pluginName} 配置失败:`, error);
            statusElement.textContent = `保存插件 ${pluginName} 配置失败: ${error.message}`;
        }
    }

    // 新增：函数用于保存调用命令的描述
    async function saveInvocationCommandDescription(pluginName, commandIdentifier, description, commandItemElement) {
        const statusElement = commandItemElement.querySelector('.command-specific-status');
        if (!statusElement) {
            console.error("Status element not found for command item:", commandItemElement);
            pluginStatus.textContent = `保存 ${pluginName} - ${commandIdentifier} 指令描述时发生内部错误。`; // Fallback status
            return;
        }

        statusElement.textContent = `正在保存 ${commandIdentifier} 的描述...`;
        try {
            const response = await fetch(`${API_BASE_URL}/plugins/${pluginName}/commands/${commandIdentifier}/description`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: description }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: '未知错误' }));
                throw new Error(`HTTP error! status: ${response.status} - ${errorData.message}`);
            }
            const data = await response.json();
            statusElement.textContent = data.message || `指令 ${commandIdentifier} 的描述已保存。`;
            // Optionally, re-disable textarea or give other visual feedback
        } catch (error) {
            console.error(`保存指令 ${commandIdentifier} 描述失败:`, error);
            statusElement.textContent = `保存指令 ${commandIdentifier} 描述失败: ${error.message}`;
        }
    }


    function escapeHtml(unsafe) {
        if (unsafe === null || typeof unsafe === 'undefined') {
            return '';
        }
        // 确保这里是正确的替换
        return unsafe
            .toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;") // 修正：这里使用 &quot;
            .replace(/'/g, "&#039;"); // 修正：确保有分号，并且实体正确
    }

    // --- 初始化 ---
    if (saveMainConfigButton) {
        saveMainConfigButton.addEventListener('click', saveMainConfig);
    }
    if (restartServerButton) { // 新增：为重启按钮添加事件监听器
        restartServerButton.addEventListener('click', restartServer);
    }
    
    loadMainConfig();
    loadPlugins();
});