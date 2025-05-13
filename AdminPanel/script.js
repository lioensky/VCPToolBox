document.addEventListener('DOMContentLoaded', () => {
    const mainConfigContent = document.getElementById('mainConfigContent');
    const saveMainConfigButton = document.getElementById('saveMainConfig');
    const mainConfigStatus = document.getElementById('mainConfigStatus');
    const restartServerButton = document.getElementById('restartServer'); // 新增：获取重启按钮
    const pluginListDiv = document.getElementById('pluginList');
    const pluginStatus = document.getElementById('pluginStatus');

    const API_BASE_URL = '/admin_api'; // 我们将在 server.js 中定义这个基础路径

    // --- 主配置处理 ---
    async function loadMainConfig() {
        try {
            mainConfigStatus.textContent = '正在加载主配置...';
            const response = await fetch(`${API_BASE_URL}/config/main`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            // 过滤掉包含密码的行
            const filteredContent = data.content.split('\n').filter(line => 
                !/^\s*(AdminPassword|AdminUsername)\s*=/i.test(line)
            ).join('\n');
            mainConfigContent.value = filteredContent;
            mainConfigStatus.textContent = '主配置已加载 (敏感信息已隐藏)。';
        } catch (error) {
            console.error('加载主配置失败:', error);
            mainConfigContent.value = '';
            mainConfigStatus.textContent = `加载主配置失败: ${error.message}`;
        }
    }

    async function saveMainConfig() {
        // 注意：从安全角度考虑，不建议直接通过前端修改包含敏感信息（如密码）的主配置文件。
        // 这里的实现是为了满足请求，但在生产环境中应有更安全的机制。
        // 我们需要获取原始文件内容，合并修改，然后保存，以避免丢失密码行。
        try {
            mainConfigStatus.textContent = '正在保存主配置...';
            
            // 1. 获取当前显示的（可能已修改的）非敏感内容
            const editedContentLines = mainConfigContent.value.split('\n');
            
            // 2. 获取服务器上的原始完整内容（包括敏感信息）
            const originalResponse = await fetch(`${API_BASE_URL}/config/main/raw`); // 需要一个新的后端端点
             if (!originalResponse.ok) {
                throw new Error(`获取原始配置失败! status: ${originalResponse.status}`);
            }
            const originalData = await originalResponse.json();
            const originalContentLines = originalData.content.split('\n');

            // 3. 合并：保留原始敏感行，更新其他行
            const sensitiveKeys = ['AdminPassword', 'AdminUsername'];
            const finalContentLines = [];
            const editedKeys = new Set();

            // 添加编辑过的非敏感行
            editedContentLines.forEach(line => {
                const match = line.match(/^\s*([^#=\s]+)\s*=/);
                if (match) {
                    const key = match[1];
                     if (!sensitiveKeys.some(sensitiveKey => new RegExp(`^${sensitiveKey}$`, 'i').test(key))) {
                        finalContentLines.push(line);
                        editedKeys.add(key.toLowerCase()); // 记录已处理的key的小写形式
                    }
                } else {
                     // 保留注释和空行
                    finalContentLines.push(line);
                }
            });
            
             // 添加原始文件中的敏感行 (如果它们没有被错误地包含在编辑内容中)
            originalContentLines.forEach(line => {
                const match = line.match(/^\s*([^#=\s]+)\s*=/);
                 if (match) {
                    const key = match[1];
                    if (sensitiveKeys.some(sensitiveKey => new RegExp(`^${sensitiveKey}$`, 'i').test(key))) {
                         // 检查编辑内容中是否已存在此敏感key，理论上不应该有，但以防万一
                         if (!editedContentLines.some(editedLine => new RegExp(`^\\s*${key}\\s*=`, 'i').test(editedLine))) {
                            finalContentLines.push(line); // 添加原始敏感行
                         }
                    } else if (!editedKeys.has(key.toLowerCase())) {
                         // 如果原始行不是敏感行，并且在编辑内容中没有出现过，也添加（防止删除未编辑的行）
                         // 但这可能导致意外行为，如果用户删除了某行。更安全的做法可能是只合并已知key。
                         // 暂时注释掉，只保存编辑过的和敏感的。
                         // finalContentLines.push(line);
                    }
                } else if (!editedContentLines.includes(line) && /^\s*#/.test(line)) {
                     // 如果原始行是注释，并且编辑内容里没有这一行（可能被删了），也考虑是否保留
                     // 暂时不保留被删除的注释
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
                    <button class="save-plugin-config-button">保存插件配置</button>
                    <p class="status plugin-specific-status"></p>
                `;
                pluginListDiv.appendChild(pluginItem);
            });
            pluginStatus.textContent = '插件列表已加载。';
            attachPluginEventListeners();
        } catch (error) {
            console.error('加载插件列表失败:', error);
            pluginListDiv.innerHTML = `<p>加载插件列表失败: ${error.message}</p>`;
            pluginStatus.textContent = `加载插件列表失败: ${error.message}`;
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
            const pluginSpecificStatus = item.querySelector('.plugin-specific-status');


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