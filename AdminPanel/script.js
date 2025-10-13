// script.js
document.addEventListener('DOMContentLoaded', () => {
    const pluginNavList = document.getElementById('plugin-nav').querySelector('ul');
    const configDetailsContainer = document.getElementById('config-details-container');
    const baseConfigForm = document.getElementById('base-config-form');
    const loadingOverlay = document.getElementById('loading-overlay');
    const messagePopup = document.getElementById('message-popup');
    const restartServerButton = document.getElementById('restart-server-button');

    // Dashboard Elements
    const dashboardSection = document.getElementById('dashboard-section');
    const cpuProgress = document.getElementById('cpu-progress');
    const cpuUsageText = document.getElementById('cpu-usage-text');
    const cpuInfoText = document.getElementById('cpu-info-text');
    const memProgress = document.getElementById('mem-progress');
    const memUsageText = document.getElementById('mem-usage-text');
    const memInfoText = document.getElementById('mem-info-text');
    const pm2ProcessList = document.getElementById('pm2-process-list');
    const nodeInfoList = document.getElementById('node-info-list');
    const activityChartCanvas = document.getElementById('activity-chart-canvas'); // New canvas element
    let monitorIntervalId = null; // For dashboard auto-refresh
    let activityDataPoints = new Array(60).fill(0); // Holds the last 60 data points for the chart
    let lastLogCheckTime = null; // Initialize to null, will be set to the latest log timestamp on first run

    // Daily Notes Manager Elements
    const dailyNotesSection = document.getElementById('daily-notes-manager-section'); // The main section for daily notes
    const notesFolderListUl = document.getElementById('notes-folder-list');
    const notesListViewDiv = document.getElementById('notes-list-view');
    const noteEditorAreaDiv = document.getElementById('note-editor-area');
    const editingNoteFolderInput = document.getElementById('editing-note-folder');
    const editingNoteFileInput = document.getElementById('editing-note-file');
    const noteContentEditorTextarea = document.getElementById('note-content-editor');
    const saveNoteButton = document.getElementById('save-note-content');
    const cancelEditNoteButton = document.getElementById('cancel-edit-note');
    const noteEditorStatusSpan = document.getElementById('note-editor-status');
    const moveSelectedNotesButton = document.getElementById('move-selected-notes');
    const moveTargetFolderSelect = document.getElementById('move-target-folder');
    const deleteSelectedNotesButton = document.getElementById('delete-selected-notes-button'); // 新增：批量删除按钮
    const notesActionStatusSpan = document.getElementById('notes-action-status');
    const searchDailyNotesInput = document.getElementById('search-daily-notes'); // 新增：搜索框

    // RAG Tags Config Elements
    const ragTagsConfigAreaDiv = document.getElementById('rag-tags-config-area');
    const ragTagsFolderNameSpan = document.getElementById('rag-tags-folder-name');
    const ragThresholdEnabledCheckbox = document.getElementById('rag-threshold-enabled');
    const ragThresholdValueSlider = document.getElementById('rag-threshold-value');
    const ragThresholdDisplaySpan = document.getElementById('rag-threshold-display');
    const ragTagsContainer = document.getElementById('rag-tags-container');
    const addRagTagButton = document.getElementById('add-rag-tag-button');
    const saveRagTagsConfigButton = document.getElementById('save-rag-tags-config');
    const ragTagsStatusSpan = document.getElementById('rag-tags-status');
    
    let ragTagsData = {}; // 存储所有的RAG-Tags配置
    let currentRagFolder = null; // 当前选中的文件夹名称

    // Agent Manager Elements
    const agentMapListDiv = document.getElementById('agent-map-list');
    const addAgentMapEntryButton = document.getElementById('add-agent-map-entry-button');
    const saveAgentMapButton = document.getElementById('save-agent-map-button');
    const agentMapStatusSpan = document.getElementById('agent-map-status');
    const editingAgentFileDisplay = document.getElementById('editing-agent-file-display');
    const agentFileContentEditor = document.getElementById('agent-file-content-editor');
    const saveAgentFileButton = document.getElementById('save-agent-file-button');
    const agentFileStatusSpan = document.getElementById('agent-file-status');
    const createAgentFileButton = document.getElementById('create-agent-file-button'); // 新增：创建文件按钮

    // TVS Files Editor Elements
    const tvsFileSelect = document.getElementById('tvs-file-select');
    const tvsFileContentEditor = document.getElementById('tvs-file-content-editor');
    const saveTvsFileButton = document.getElementById('save-tvs-file-button');
    const tvsFileStatusSpan = document.getElementById('tvs-file-status');

    // Server Log Viewer Elements
    const serverLogViewerSection = document.getElementById('server-log-viewer-section');
    const copyServerLogButton = document.getElementById('copy-server-log-button'); // Changed from refreshServerLogButton
    const serverLogPathDisplay = document.getElementById('server-log-path-display');
    const serverLogStatusSpan = document.getElementById('server-log-status');
    const serverLogContentPre = document.getElementById('server-log-content');
    let serverLogIntervalId = null; // For server log auto-refresh
    
    // Sidebar Search
    const sidebarSearchInput = document.getElementById('sidebar-search');

    const API_BASE_URL = '/admin_api'; // Corrected API base path
    const MONITOR_API_BASE_URL = '/admin_api/system-monitor'; // New API base for monitoring, corrected path

    // --- Utility Functions ---
    function showLoading(show) {
        loadingOverlay.classList.toggle('visible', show);
    }

    function showMessage(message, type = 'info', duration = 3500) {
        messagePopup.textContent = message;
        messagePopup.className = 'message-popup';
        messagePopup.classList.add(type);
        messagePopup.classList.add('show');
        setTimeout(() => {
            messagePopup.classList.remove('show');
        }, duration);
    }

    async function apiFetch(url, options = {}, showLoader = true) {
        if (showLoader) showLoading(true);
        try {
            const defaultHeaders = {
                'Content-Type': 'application/json',
            };
            options.headers = { ...defaultHeaders, ...options.headers };

            const response = await fetch(url, options); // url is already API_BASE_URL + path
            if (!response.ok) {
                let errorData = { error: `HTTP error ${response.status}`, details: response.statusText };
                try {
                    const jsonError = await response.json();
                    errorData = { ...errorData, ...jsonError };
                } catch (e) { /* Ignore if response is not JSON */ }
                throw new Error(errorData.message || errorData.error || errorData.details || `HTTP error ${response.status}`);
            }
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                return await response.json();
            } else {
                return await response.text();
            }
        } catch (error) {
            console.error('API Fetch Error:', error.message, error);
            showMessage(`操作失败: ${error.message}`, 'error');
            throw error;
        } finally {
            if (showLoader) showLoading(false);
        }
    }

    // --- .env Parsing and Building (Adapted from user's original script) ---
    function parseEnvToList(content) {
        const lines = content.split(/\r?\n/);
        const entries = [];
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
                entries.push({ key: null, value: line, isCommentOrEmpty: true, note: 'Malformed line (no equals sign)', originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
                i++;
                continue;
            }

            const key = line.substring(0, eqIndex).trim();
            let valueString = line.substring(eqIndex + 1);

            if (valueString.trim().startsWith("'")) {
                let accumulatedValue;
                let firstLineContent = valueString.substring(valueString.indexOf("'") + 1);

                if (firstLineContent.endsWith("'") && !lines.slice(i + 1).some(l => l.trim().endsWith("'") && !l.trim().startsWith("'") && l.includes("='"))) {
                    accumulatedValue = firstLineContent.substring(0, firstLineContent.length - 1);
                    entries.push({ key, value: accumulatedValue, isCommentOrEmpty: false, isMultilineQuoted: true, originalLineNumStart: currentLineNum, originalLineNumEnd: i });
                } else {
                    let multilineContent = [firstLineContent];
                    let endLineNum = i;
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        multilineContent.push(nextLine);
                        endLineNum = i;
                        if (nextLine.trim().endsWith("'")) {
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
                entries.push({ key, value: valueString.trim(), isCommentOrEmpty: false, isMultilineQuoted: false, originalLineNumStart: currentLineNum, originalLineNumEnd: currentLineNum });
            }
            i++;
        }
        return entries;
    }

    function buildEnvString(formElement, originalParsedEntries) {
        const newEnvLines = [];
        const editedKeys = new Set();

        // Iterate through form elements to get edited values
        for (let i = 0; i < formElement.elements.length; i++) {
            const element = formElement.elements[i];
            if (element.name && element.dataset.originalKey) { // Ensure it's an editable field
                const key = element.dataset.originalKey;
                editedKeys.add(key);
                let value = element.value;
                const originalEntry = originalParsedEntries.find(entry => entry.key === key);
                let isMultiline = (originalEntry && originalEntry.isMultilineQuoted) || value.includes('\n');
                
                if (element.type === 'checkbox' && element.dataset.expectedType === 'boolean') {
                     value = element.checked ? 'true' : 'false';
                     isMultiline = false; // Booleans are not multiline
                } else if (element.dataset.expectedType === 'integer') {
                    const intVal = parseInt(value, 10);
                    value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal);
                    isMultiline = false; // Integers are not multiline
                }


                if (isMultiline) {
                    newEnvLines.push(`${key}='${value}'`);
                } else {
                    newEnvLines.push(`${key}=${value}`);
                }
            }
        }
        
        // Reconstruct with original comments, empty lines, and unedited/newly added custom fields
        const finalLines = [];
        const formElementsMap = new Map();
        Array.from(baseConfigForm.querySelectorAll('[data-original-key], [data-is-comment-or-empty="true"]')).forEach(el => {
            if (el.dataset.originalKey) formElementsMap.set(el.dataset.originalKey, el);
            else if (el.dataset.originalContent) formElementsMap.set(`comment-${finalLines.length}`, el); // Unique key for comments
        });


        originalParsedEntries.forEach(entry => {
            if (entry.isCommentOrEmpty) {
                finalLines.push(entry.value); // Push original comment or empty line
            } else {
                const inputElement = formElementsMap.get(entry.key);
                if (inputElement && inputElement.closest('form') === baseConfigForm) { // Check if element is part of the current form
                    let value = inputElement.value;
                     if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                        value = inputElement.checked ? 'true' : 'false';
                    } else if (inputElement.dataset.expectedType === 'integer') {
                        const intVal = parseInt(value, 10);
                        value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal);
                    }

                    const isMultiline = entry.isMultilineQuoted || value.includes('\n');
                    if (isMultiline) {
                        finalLines.push(`${entry.key}='${value}'`);
                    } else {
                        finalLines.push(`${entry.key}=${value}`);
                    }
                } else {
                    // Key was in original but not in UI (e.g. filtered out, or error)
                    // Fallback to original representation
                    if (entry.isMultilineQuoted) {
                        finalLines.push(`${entry.key}='${entry.value}'`);
                    } else {
                        finalLines.push(`${entry.key}=${entry.value}`);
                    }
                }
            }
        });
        
        // Add any new custom fields from the form that were not in originalParsedEntries
        // This part is more relevant for plugin configs with "add custom field"
        // For base config, we generally edit existing or rely on server to add new ones if needed.

        return finalLines.join('\n');
    }


    // --- Load Initial Data ---
    async function loadInitialData() {
        try {
            await loadBaseConfig();
            await loadPluginList();
            const firstLink = pluginNavList.querySelector('a');
            if (firstLink) {
                // Ensure the correct section ID is used if it's different from data-target
                const sectionId = firstLink.dataset.target.endsWith('-section') ? firstLink.dataset.target : `${firstLink.dataset.target}-section`;
                navigateTo(firstLink.dataset.target);
                firstLink.classList.add('active');
            }
        } catch (error) { /* Error already shown by apiFetch */ }
    }

    // --- Base Configuration ---
    let originalBaseConfigEntries = []; // Store parsed entries for saving

    async function loadBaseConfig() {
        try {
            const data = await apiFetch(`${API_BASE_URL}/config/main`); // Use correct endpoint
            originalBaseConfigEntries = parseEnvToList(data.content);
            baseConfigForm.innerHTML = ''; // Clear previous form

            originalBaseConfigEntries.forEach((entry, index) => {
                let formGroup;
                if (entry.isCommentOrEmpty) {
                    formGroup = createCommentOrEmptyElement(entry.value, index);
                } else {
                    let inferredType = 'string';
                    if (typeof entry.value === 'boolean' || /^(true|false)$/i.test(entry.value)) inferredType = 'boolean';
                    else if (!isNaN(parseFloat(entry.value)) && isFinite(entry.value) && !entry.value.includes('.')) inferredType = 'integer';
                    
                    formGroup = createFormGroup(
                        entry.key,
                        entry.value,
                        inferredType,
                        `根目录 config.env 配置项: ${entry.key}`,
                        false, // isPluginConfig
                        null,  // pluginName
                        false, // isCustomDeletableField
                        entry.isMultilineQuoted // Pass multiline info
                    );
                }
                baseConfigForm.appendChild(formGroup);
            });

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'form-actions';
            const submitButton = document.createElement('button');
            submitButton.type = 'submit';
            submitButton.textContent = '保存全局配置';
            actionsDiv.appendChild(submitButton);
            baseConfigForm.appendChild(actionsDiv);
        } catch (error) {
            baseConfigForm.innerHTML = `<p class="error-message">加载全局配置失败: ${error.message}</p>`;
        }
    }

    baseConfigForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const newConfigString = buildEnvString(baseConfigForm, originalBaseConfigEntries);
        try {
            await apiFetch(`${API_BASE_URL}/config/main`, { // Use correct endpoint
                method: 'POST',
                body: JSON.stringify({ content: newConfigString })
            });
            showMessage('全局配置已保存！部分更改可能需要重启服务生效。', 'success');
            loadBaseConfig(); // Reload to reflect changes and ensure consistency
        } catch (error) { /* Error handled by apiFetch */ }
    });


    // --- Plugin Configuration ---
    let originalPluginConfigs = {}; // Store original parsed entries for each plugin

    async function loadPluginList() {
        try {
            const plugins = await apiFetch(`${API_BASE_URL}/plugins`);
            // Clear existing DYNAMIC plugin nav items
            const dynamicNavItems = pluginNavList.querySelectorAll('li.dynamic-plugin-nav-item');
            dynamicNavItems.forEach(item => item.remove());
            // Clear existing DYNAMIC plugin sections
            const dynamicPluginSections = configDetailsContainer.querySelectorAll('section.dynamic-plugin-section');
            dynamicPluginSections.forEach(sec => sec.remove());

            plugins.sort((a, b) => (a.manifest.displayName || a.manifest.name).localeCompare(b.manifest.displayName || b.manifest.name));

            plugins.forEach(plugin => {
                const li = document.createElement('li');
                li.classList.add('dynamic-plugin-nav-item'); // Add class for dynamic items
                const a = document.createElement('a');
                a.href = '#';
                const originalName = plugin.manifest.name;
                const displayName = plugin.manifest.displayName || originalName;
                let nameHtml = displayName;
                if (plugin.isDistributed) {
                    nameHtml += ` <span class="plugin-type-icon" title="分布式插件 (来自: ${plugin.serverId || '未知'})">☁️</span>`;
                }
                nameHtml += `<br><span class="plugin-original-name">(${originalName})</span>`;
                a.innerHTML = nameHtml; // Use innerHTML to render the span
                a.dataset.target = `plugin-${plugin.manifest.name}-config`;
                a.dataset.pluginName = plugin.manifest.name;
                li.appendChild(a);
                pluginNavList.appendChild(li);

                const pluginSection = document.createElement('section');
                pluginSection.id = `plugin-${plugin.manifest.name}-config-section`;
                pluginSection.classList.add('config-section', 'dynamic-plugin-section'); // Add class for dynamic items
                
                let descriptionHtml = plugin.manifest.description || '暂无描述';
                if (plugin.manifest.version) descriptionHtml += ` (版本: ${plugin.manifest.version})`;
                if (plugin.isDistributed) descriptionHtml += ` (来自节点: ${plugin.serverId || '未知'})`;
                if (!plugin.enabled) descriptionHtml += ' <span class="plugin-disabled-badge">(已禁用)</span>';

                let titleHtml = `${displayName} <span class="plugin-original-name">(${originalName})</span> 配置`;
                if (!plugin.enabled) titleHtml += ' <span class="plugin-disabled-badge-title">(已禁用)</span>';
                if (plugin.isDistributed) titleHtml += ' <span class="plugin-type-icon" title="分布式插件">☁️</span>';
                
                pluginSection.innerHTML = `<h2>${titleHtml}</h2>
                                           <p class="plugin-meta">${descriptionHtml}</p>`;

                // Add a control area for plugin actions like toggle
                const pluginControlsDiv = document.createElement('div');
                pluginControlsDiv.className = 'plugin-controls';

                const toggleButton = document.createElement('button');
                toggleButton.id = `toggle-plugin-${plugin.manifest.name}-button`;
                toggleButton.textContent = plugin.enabled ? '禁用插件' : '启用插件';
                toggleButton.classList.add('toggle-plugin-button');
                if (!plugin.enabled) {
                    toggleButton.classList.add('disabled-state');
                }

                // 禁用分布式插件的管理功能
                if (plugin.isDistributed) {
                    toggleButton.disabled = true;
                    toggleButton.title = '分布式插件的状态由其所在的节点管理，无法在此处直接启停。';
                }

                toggleButton.addEventListener('click', async () => {
                    const currentEnabledState = !toggleButton.classList.contains('disabled-state'); // Determine current state from class
                    const enable = !currentEnabledState; // Target state is the opposite

                    // Optional: Confirm action
                    if (!confirm(`确定要${enable ? '启用' : '禁用'}插件 "${plugin.manifest.displayName || plugin.manifest.name}" 吗？更改可能需要重启服务才能生效。`)) {
                        return;
                    }

                    toggleButton.disabled = true; // Disable button during operation
                    toggleButton.textContent = enable ? '正在启用...' : '正在禁用...';

                    try {
                        const result = await apiFetch(`${API_BASE_URL}/plugins/${plugin.manifest.name}/toggle`, {
                            method: 'POST',
                            body: JSON.stringify({ enable: enable })
                        });
                        showMessage(result.message, 'success');

                        // Refresh the plugin list and the current plugin's config
                        loadPluginList(); // Refresh sidebar status
                        loadPluginConfig(plugin.manifest.name); // Refresh current section

                    } catch (error) {
                         // apiFetch already shows error message
                         console.error(`Failed to toggle plugin ${plugin.manifest.name}:`, error);
                         // Restore button state on error
                         toggleButton.disabled = false;
                         toggleButton.textContent = currentEnabledState ? '禁用插件' : '启用插件'; // Revert text
                         if (!currentEnabledState) {
                             toggleButton.classList.add('disabled-state');
                         } else {
                             toggleButton.classList.remove('disabled-state');
                         }
                    }
                });

                pluginControlsDiv.appendChild(toggleButton);
                pluginSection.appendChild(pluginControlsDiv); // Add controls before the form

                const form = document.createElement('form');
                form.id = `plugin-${plugin.manifest.name}-config-form`;
                pluginSection.appendChild(form);
                configDetailsContainer.appendChild(pluginSection);

                // Store original config if available (for saving later)
                if (plugin.configEnvContent) {
                    originalPluginConfigs[plugin.manifest.name] = parseEnvToList(plugin.configEnvContent);
                } else {
                    originalPluginConfigs[plugin.manifest.name] = []; // Empty if no config.env
                }
            });
        } catch (error) {
            pluginNavList.innerHTML += `<li><p class="error-message">加载插件列表失败: ${error.message}</p></li>`;
        }
    }

    async function loadPluginConfig(pluginName) {
        const form = document.getElementById(`plugin-${pluginName}-config-form`);
        if (!form) {
            console.error(`Form not found for plugin ${pluginName}`);
            return;
        }
        form.innerHTML = ''; // Clear previous form content

        try {
            // Fetch fresh plugin details, including manifest and config.env content
            // The /api/plugins endpoint in server.js already provides this,
            // but if we need more detailed schema vs custom, we might need a specific endpoint
            // For now, let's assume we use the initially loaded originalPluginConfigs[pluginName]
            
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

            // Display schema-defined fields first
            for (const key in configSchema) {
                hasSchemaFields = true;
                const expectedType = configSchema[key];
                const entry = originalPluginConfigs[pluginName].find(e => e.key === key && !e.isCommentOrEmpty);
                const value = entry ? entry.value : (manifest.defaults && manifest.defaults[key] !== undefined ? manifest.defaults[key] : '');
                const isMultiline = entry ? entry.isMultilineQuoted : (String(value).includes('\n'));
                
                let descriptionHtml = `Schema 定义: ${key}`;
                if (manifest.configSchemaDescriptions && manifest.configSchemaDescriptions[key]) {
                    descriptionHtml = manifest.configSchemaDescriptions[key];
                }
                if (entry) {
                    descriptionHtml += ` <span class="defined-in">(当前在插件 .env 中定义)</span>`;
                } else if (manifest.defaults && manifest.defaults[key] !== undefined) {
                    descriptionHtml += ` <span class="defined-in">(使用插件清单默认值)</span>`;
                } else {
                     descriptionHtml += ` <span class="defined-in">(未设置，将继承全局或为空)</span>`;
                }

                const formGroup = createFormGroup(key, value, expectedType, descriptionHtml, true, pluginName, false, isMultiline);
                schemaFieldsContainer.appendChild(formGroup);
                presentInEnv.delete(key); // Remove from set as it's handled
            }

            // Display remaining .env fields (custom or not in schema) and comments/empty lines
            originalPluginConfigs[pluginName].forEach((entry, index) => {
                if (entry.isCommentOrEmpty) {
                    customFieldsContainer.appendChild(createCommentOrEmptyElement(entry.value, `${pluginName}-comment-${index}`));
                } else if (presentInEnv.has(entry.key)) { // Custom field (was in .env but not in schema)
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
            addConfigButton.addEventListener('click', () => addCustomConfigFieldToPluginForm(form, pluginName, customFieldsContainer, originalPluginConfigs[pluginName]));
            actionsDiv.appendChild(addConfigButton);

            const submitButton = document.createElement('button');
            submitButton.type = 'submit';
            submitButton.textContent = `保存 ${pluginName} 配置`;
            actionsDiv.appendChild(submitButton);
            form.appendChild(actionsDiv);

            form.removeEventListener('submit', handlePluginFormSubmit);
            form.addEventListener('submit', handlePluginFormSubmit);

            // --- Add Invocation Commands Editor ---
            if (manifest.capabilities && manifest.capabilities.invocationCommands && manifest.capabilities.invocationCommands.length > 0) {
                const commandsSection = document.createElement('div');
                commandsSection.className = 'invocation-commands-section';
                const commandsTitle = document.createElement('h3');
                commandsTitle.textContent = '调用命令 AI 指令编辑';
                commandsSection.appendChild(commandsTitle);

                manifest.capabilities.invocationCommands.forEach(cmd => {
                    const commandIdentifier = cmd.commandIdentifier || cmd.command; // Use commandIdentifier or fallback to command
                    if (!commandIdentifier) return; // Skip if no identifier

                    const commandItem = document.createElement('div');
                    commandItem.className = 'command-item';
                    commandItem.dataset.commandIdentifier = commandIdentifier;

                    const commandHeader = document.createElement('h4');
                    commandHeader.textContent = `命令: ${commandIdentifier}`;
                    commandItem.appendChild(commandHeader);

                    const cmdFormGroup = document.createElement('div');
                    cmdFormGroup.className = 'form-group'; // Reuse form-group styling

                    const descLabel = document.createElement('label');
                    const descTextareaId = `cmd-desc-${pluginName}-${commandIdentifier.replace(/\s+/g, '_')}`;
                    descLabel.htmlFor = descTextareaId;
                    descLabel.textContent = '指令描述 (AI Instructions):';
                    cmdFormGroup.appendChild(descLabel);

                    const descTextarea = document.createElement('textarea');
                    descTextarea.id = descTextareaId;
                    descTextarea.className = 'command-description-edit';
                    descTextarea.rows = Math.max(5, (cmd.description || '').split('\n').length + 2); // Adjust rows
                    descTextarea.value = cmd.description || '';
                    cmdFormGroup.appendChild(descTextarea);
                    
                    const cmdActionsDiv = document.createElement('div');
                    cmdActionsDiv.className = 'form-actions'; // Reuse form-actions styling for consistency

                    const saveCmdDescButton = document.createElement('button');
                    saveCmdDescButton.type = 'button';
                    saveCmdDescButton.textContent = '保存此指令描述';
                    saveCmdDescButton.classList.add('save-command-description-btn'); // Add specific class if needed for styling
                    
                    const cmdStatusP = document.createElement('p');
                    cmdStatusP.className = 'status command-status'; // For feedback

                    saveCmdDescButton.addEventListener('click', async () => {
                        await saveInvocationCommandDescription(pluginName, commandIdentifier, descTextarea, cmdStatusP);
                    });
                    cmdActionsDiv.appendChild(saveCmdDescButton);
                    cmdFormGroup.appendChild(cmdActionsDiv);
                    cmdFormGroup.appendChild(cmdStatusP);
                    commandItem.appendChild(cmdFormGroup);
                    commandsSection.appendChild(commandItem);
                });
                // Append commands section after the main plugin config form's content, but before its actions
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

    async function saveInvocationCommandDescription(pluginName, commandIdentifier, textareaElement, statusElement) {
        const newDescription = textareaElement.value;
        statusElement.textContent = '正在保存描述...';
        statusElement.className = 'status command-status info'; // Reset and indicate processing

        const apiUrl = `${API_BASE_URL}/plugins/${pluginName}/commands/${commandIdentifier}/description`;
        // Log the values before making the API call
        console.log(`[saveInvocationCommandDescription] Attempting to save:
Plugin Name: ${pluginName}
Command Identifier: ${commandIdentifier}
API URL: ${apiUrl}
Description Length: ${newDescription.length}`);

        if (!pluginName || !commandIdentifier) {
            const errorMsg = `保存描述失败: 插件名称或命令标识符为空。Plugin: '${pluginName}', Command: '${commandIdentifier}'`;
            console.error(errorMsg);
            showMessage(errorMsg, 'error');
            statusElement.textContent = '保存失败: 内部错误 (缺少标识符)';
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
            statusElement.classList.remove('info', 'error');
            statusElement.classList.add('success');

            // Optionally, update the manifest in memory if needed, or rely on next full load
            // For now, we assume a full reload/navigation will pick up changes.
            // Or, update the textarea's original value if we want to track "dirty" state.
        } catch (error) {
            // showMessage is already called by apiFetch on error
            statusElement.textContent = `保存失败: ${error.message}`;
            statusElement.classList.remove('info', 'success');
            statusElement.classList.add('error');
        }
    }
    
    function addCustomConfigFieldToPluginForm(form, pluginName, containerToAddTo, currentParsedEntries) {
        const key = prompt("请输入新自定义配置项的键名 (例如 MY_PLUGIN_VAR):");
        if (!key || !key.trim()) return;
        const normalizedKey = key.trim().replace(/\s+/g, '_');

        if (currentParsedEntries.some(entry => entry.key === normalizedKey) || form.elements[normalizedKey]) {
            showMessage(`配置项 "${normalizedKey}" 已存在！`, 'error');
            return;
        }

        const descriptionHtml = `自定义配置项: ${normalizedKey} <span class="defined-in">(新添加)</span>`;
        const formGroup = createFormGroup(normalizedKey, '', 'string', descriptionHtml, true, pluginName, true, false);
        
        // Add to currentParsedEntries so buildEnvString can find it
        currentParsedEntries.push({ key: normalizedKey, value: '', isCommentOrEmpty: false, isMultilineQuoted: false });

        let targetContainer = containerToAddTo;
         if (!targetContainer || !form.contains(targetContainer)) {
            const customSectionTitle = Array.from(form.querySelectorAll('h3')).find(h => h.textContent.includes('自定义 .env 配置项'));
            if (customSectionTitle) {
                targetContainer = customSectionTitle.nextElementSibling; // Assuming div container follows h3
                if (!targetContainer || targetContainer.classList.contains('form-actions')) { // If no div or it's the actions
                    targetContainer = form.querySelector('.form-actions') || form;
                }
            } else {
                 targetContainer = form.querySelector('.form-actions') || form;
            }
        }
        
        const actionsDiv = form.querySelector('.form-actions');
        if (actionsDiv && targetContainer.contains(actionsDiv)) { // Insert before actions if actions are in target
            targetContainer.insertBefore(formGroup, actionsDiv);
        } else if (actionsDiv && form.contains(actionsDiv)) { // Insert before actions if actions are in form (but not target)
             form.insertBefore(formGroup, actionsDiv);
        } else { // Append to target or form if no actions div
            targetContainer.appendChild(formGroup);
        }
    }


    async function handlePluginFormSubmit(event) {
        event.preventDefault();
        const form = event.target;
        const pluginName = form.id.match(/plugin-(.*?)-config-form/)[1];
        
        // Rebuild the .env string from the form, preserving comments and order
        const currentPluginEntries = originalPluginConfigs[pluginName] || [];
        const newConfigString = buildEnvStringForPlugin(form, currentPluginEntries, pluginName);

        try {
            await apiFetch(`${API_BASE_URL}/plugins/${pluginName}/config`, {
                method: 'POST',
                body: JSON.stringify({ content: newConfigString })
            });
            showMessage(`${pluginName} 配置已保存！更改可能需要重启插件或服务生效。`, 'success');
            loadPluginConfig(pluginName); // Reload to reflect changes
        } catch (error) { /* Error handled by apiFetch */ }
    }

    function buildEnvStringForPlugin(formElement, originalParsedEntries, pluginName) {
        const finalLines = [];
        const editedKeysInForm = new Set();

        // Collect all keys that are actually present as editable fields in the form
        Array.from(formElement.elements).forEach(el => {
            if (el.dataset.originalKey) editedKeysInForm.add(el.dataset.originalKey);
        });

        originalParsedEntries.forEach(entry => {
            if (entry.isCommentOrEmpty) {
                finalLines.push(entry.value);
            } else {
                const inputElement = formElement.elements[`${pluginName}-${entry.key.replace(/\./g, '_')}`] || formElement.elements[entry.key];
                if (inputElement && editedKeysInForm.has(entry.key)) {
                    let value = inputElement.value;
                    if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                        value = inputElement.checked ? 'true' : 'false';
                    } else if (inputElement.dataset.expectedType === 'integer') {
                        const intVal = parseInt(value, 10);
                        value = isNaN(intVal) ? (value === '' ? '' : value) : String(intVal);
                    }
                    const isMultiline = entry.isMultilineQuoted || value.includes('\n');
                    if (isMultiline) {
                        finalLines.push(`${entry.key}='${value}'`);
                    } else {
                        finalLines.push(`${entry.key}=${value}`);
                    }
                } else if (!editedKeysInForm.has(entry.key)) { // Key was in original but not in form (e.g. deleted custom field)
                    // Do not add it back if it was a custom field that got deleted.
                    // If it was a schema field that somehow disappeared from form, it's an issue.
                    // For simplicity, if it's not in the form's editable fields, we assume it was intentionally removed or handled.
                } else { // Fallback for keys that might be missing from form but were in original (should be rare)
                     if (entry.isMultilineQuoted) {
                        finalLines.push(`${entry.key}='${entry.value}'`);
                    } else {
                        finalLines.push(`${entry.key}=${entry.value}`);
                    }
                }
            }
        });
        
        // Add new custom fields that were added via "Add Custom" button
        // These would have been added to originalParsedEntries by addCustomConfigFieldToPluginForm
        // and should be picked up by the loop above if they have corresponding form elements.
        // If a new field was added and then immediately saved, it should be in formElement.elements.
        // Let's ensure any new keys in originalPluginConfigs[pluginName] that are also in the form are added
        const currentPluginEntries = originalPluginConfigs[pluginName] || [];
        currentPluginEntries.forEach(entry => {
            if (!entry.isCommentOrEmpty && !finalLines.some(line => line.startsWith(entry.key + "=") || line.startsWith(entry.key + "='"))) {
                 const inputElement = formElement.elements[`${pluginName}-${entry.key.replace(/\./g, '_')}`] || formElement.elements[entry.key];
                 if (inputElement) { // It's a new field added to the form
                    let value = inputElement.value;
                     if (inputElement.type === 'checkbox' && inputElement.dataset.expectedType === 'boolean') {
                        value = inputElement.checked ? 'true' : 'false';
                    }
                    const isMultiline = value.includes('\n');
                     if (isMultiline) {
                        finalLines.push(`${entry.key}='${value}'`);
                    } else {
                        finalLines.push(`${entry.key}=${value}`);
                    }
                 }
            }
        });


        return finalLines.join('\n');
    }


    function createCommentOrEmptyElement(lineContent, uniqueId) {
        const group = document.createElement('div');
        group.className = 'form-group-comment'; // Different class for styling
        const commentPre = document.createElement('pre');
        commentPre.textContent = lineContent;
        commentPre.dataset.isCommentOrEmpty = "true";
        commentPre.dataset.originalContent = lineContent; // Store for saving
        commentPre.id = `comment-${uniqueId}`;
        group.appendChild(commentPre);
        return group;
    }


    function createFormGroup(key, value, type, descriptionHtml, isPluginConfig = false, pluginName = null, isCustomDeletableField = false, isMultiline = false) {
        const group = document.createElement('div');
        group.className = 'form-group';
        const elementIdSuffix = key.replace(/\./g, '_');
        const elementId = `${isPluginConfig && pluginName ? pluginName + '-' : ''}${elementIdSuffix}`;

        const label = document.createElement('label');
        label.htmlFor = elementId;

        const keySpan = document.createElement('span');
        keySpan.className = 'key-name';
        keySpan.textContent = key;
        label.appendChild(keySpan);

        if (isPluginConfig && isCustomDeletableField) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.textContent = '×';
            deleteButton.title = `删除自定义项 ${key}`;
            deleteButton.classList.add('delete-config-btn');
            deleteButton.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`确定要删除自定义配置项 "${key}" 吗？更改将在保存后生效。`)) {
                    group.remove();
                    // Also remove from originalPluginConfigs[pluginName] to prevent re-adding on save
                    if (pluginName && originalPluginConfigs[pluginName]) {
                        originalPluginConfigs[pluginName] = originalPluginConfigs[pluginName].filter(entry => entry.key !== key);
                    } else if (!pluginName && originalBaseConfigEntries) { // For base config if ever needed
                        originalBaseConfigEntries = originalBaseConfigEntries.filter(entry => entry.key !== key);
                    }
                }
            };
            label.appendChild(deleteButton);
        }
        
        group.appendChild(label); // Add label first

        if (descriptionHtml) {
            const descSpan = document.createElement('span');
            descSpan.className = 'description';
            descSpan.innerHTML = descriptionHtml; // Use innerHTML for spans from server
            group.appendChild(descSpan);
        }

        let input;
        if (type === 'boolean') {
            const switchContainer = document.createElement('div');
            switchContainer.className = 'switch-container';
            const switchLabel = document.createElement('label');
            switchLabel.className = 'switch';
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = String(value).toLowerCase() === 'true';
            const sliderSpan = document.createElement('span');
            sliderSpan.className = 'slider';
            switchLabel.appendChild(input);
            switchLabel.appendChild(sliderSpan);
            switchContainer.appendChild(switchLabel);
            const valueDisplay = document.createElement('span');
            valueDisplay.textContent = input.checked ? '启用' : '禁用';
            input.onchange = () => { valueDisplay.textContent = input.checked ? '启用' : '禁用'; };
            switchContainer.appendChild(valueDisplay);
            group.appendChild(switchContainer);
        } else if (type === 'integer') {
            input = document.createElement('input');
            input.type = 'number';
            input.value = value !== null && value !== undefined ? value : '';
            input.step = '1';
        } else if (isMultiline || String(value).includes('\n') || (typeof value === 'string' && value.length > 60)) {
            input = document.createElement('textarea');
            input.value = value !== null && value !== undefined ? value : '';
            input.rows = Math.min(10, Math.max(3, String(value).split('\n').length + 1));
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = value !== null && value !== undefined ? value : '';
        }

        input.id = elementId;
        input.name = elementId; // Use unique name for form submission if needed, but we build string manually
        input.dataset.originalKey = key; // Store original key for mapping back
        input.dataset.expectedType = type;
        if (input.type !== 'checkbox') {
            if (/key|api/i.test(key) && input.tagName.toLowerCase() === 'input') {
                input.type = 'password';
                const wrapper = document.createElement('div');
                wrapper.className = 'input-with-toggle';
                
                const toggleBtn = document.createElement('button');
                toggleBtn.type = 'button';
                toggleBtn.textContent = '显示';
                toggleBtn.className = 'toggle-visibility-btn';
                
                toggleBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (input.type === 'password') {
                        input.type = 'text';
                        toggleBtn.textContent = '隐藏';
                    } else {
                        input.type = 'password';
                        toggleBtn.textContent = '显示';
                    }
                });
                
                wrapper.appendChild(input);
                wrapper.appendChild(toggleBtn);
                group.appendChild(wrapper);
            } else {
                group.appendChild(input);
            }
        }
        
        return group;
    }


    function navigateTo(dataTarget) {
        const sectionIdToActivate = `${dataTarget}-section`;
        const pluginName = document.querySelector(`a[data-target="${dataTarget}"]`)?.dataset.pluginName;

        // Clear intervals when navigating away from their respective sections
        if (sectionIdToActivate !== 'server-log-viewer-section' && serverLogIntervalId) {
            clearInterval(serverLogIntervalId);
            serverLogIntervalId = null;
            console.log('Server log auto-refresh stopped.');
        }
        if (sectionIdToActivate !== 'dashboard-section' && monitorIntervalId) {
            clearInterval(monitorIntervalId);
            monitorIntervalId = null;
            console.log('Dashboard monitoring stopped.');
        }

        document.querySelectorAll('.sidebar nav li a').forEach(link => link.classList.remove('active'));
        document.querySelectorAll('.config-section').forEach(section => section.classList.remove('active-section'));

        const activeLink = document.querySelector(`a[data-target="${dataTarget}"]`);
        if (activeLink) activeLink.classList.add('active');

        const targetSection = document.getElementById(sectionIdToActivate);
        if (targetSection) {
            targetSection.classList.add('active-section');
            
            // Initialize the relevant section
            if (pluginName) {
                loadPluginConfig(pluginName).catch(err => console.error(`Failed to load config for ${pluginName}`, err));
            } else if (sectionIdToActivate === 'dashboard-section') {
                initializeDashboard();
            } else if (sectionIdToActivate === 'daily-notes-manager-section') {
                initializeDailyNotesManager();
            } else if (sectionIdToActivate === 'agent-files-editor-section') {
                initializeAgentManager();
            } else if (sectionIdToActivate === 'tvs-files-editor-section') {
                initializeTvsFilesEditor();
            } else if (sectionIdToActivate === 'server-log-viewer-section') {
                initializeServerLogViewer();
            } else if (sectionIdToActivate === 'vcptavern-editor-section') {
               const iframe = targetSection.querySelector('iframe');
               if (iframe) {
                   iframe.src = iframe.src; // Force reload
               }
           } else if (sectionIdToActivate === 'preprocessor-order-manager-section') {
                initializePreprocessorOrderManager();
          } else if (sectionIdToActivate === 'semantic-groups-editor-section') {
               initializeSemanticGroupsEditor();
          }
        } else {
            console.warn(`[navigateTo] Target section with ID '${sectionIdToActivate}' not found.`);
        }
    }

    pluginNavList.addEventListener('click', (event) => {
        const anchor = event.target.closest('a');
        if (anchor) {
            event.preventDefault();
            const dataTarget = anchor.dataset.target;
            navigateTo(dataTarget);
        }
    });

    // --- Server Restart Function ---
    async function restartServer() {
        if (!confirm('您确定要重启服务器吗？')) {
            return;
        }
        try {
            showMessage('正在发送重启服务器命令...', 'info');
            const response = await apiFetch(`${API_BASE_URL}/server/restart`, { method: 'POST' });
            // The server typically closes the connection upon successful restart command,
            // so a successful JSON response might not always come.
            // We'll rely on the HTTP status or a simple text message if provided.
            if (typeof response === 'string' && response.includes('重启命令已发送')) {
                 showMessage(response, 'success', 5000);
            } else if (response && response.message) {
                showMessage(response.message, 'success', 5000);
            }
            else {
                showMessage('服务器重启命令已发送。请稍后检查服务器状态。', 'success', 5000);
            }
        } catch (error) {
            // Error is already shown by apiFetch, but we can add a specific console log
            console.error('Restart server failed:', error);
        }
    }

    if (restartServerButton) {
        restartServerButton.addEventListener('click', restartServer);
    }

    loadInitialData();

    // --- Sidebar Search Functionality ---
    sidebarSearchInput.addEventListener('input', (event) => {
        const searchTerm = event.target.value.toLowerCase().trim();
        const navLinks = document.querySelectorAll('#plugin-nav li a');
        const categories = document.querySelectorAll('#plugin-nav li.nav-category');

        navLinks.forEach(link => {
            const linkText = link.textContent.toLowerCase();
            const parentLi = link.parentElement;
            if (linkText.includes(searchTerm)) {
                parentLi.style.display = '';
            } else {
                parentLi.style.display = 'none';
            }
        });

        // Hide categories if all items within them are hidden
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
    });

    // --- New Server Activity Chart Functions ---
    async function updateActivityChart() {
        if (!activityChartCanvas) return;

        try {
            const logData = await apiFetch(`${API_BASE_URL}/server-log`, {}, false);
            const logLines = logData.content.split('\n');
            
            let newLogsCount = 0;
            let latestTimeInThisBatch = null;

            const regex = /\[(\d{4}\/\d{1,2}\/\d{1,2}\s\d{1,2}:\d{2}:\d{2})\]/;
            for (const line of logLines) {
                const match = line.match(regex);
                if (match && match[1]) {
                    const timestamp = new Date(match[1]);
                    if (isNaN(timestamp.getTime())) {
                        continue; // Skip invalid dates
                    }

                    // On the very first run, lastLogCheckTime will be null.
                    // We just want to find the latest timestamp to set a baseline.
                    // On subsequent runs, we count logs newer than our last known time.
                    if (lastLogCheckTime && timestamp > lastLogCheckTime) {
                        newLogsCount++;
                    }

                    // Track the most recent timestamp seen in this fetched log content
                    if (!latestTimeInThisBatch || timestamp > latestTimeInThisBatch) {
                        latestTimeInThisBatch = timestamp;
                    }
                }
            }
            
            // Update our reference time to the latest timestamp we found in the logs.
            // This makes the check independent of client-side clock and corrects for skew.
            if (latestTimeInThisBatch) {
                lastLogCheckTime = latestTimeInThisBatch;
            }
            
            // Push new data and remove the oldest
            activityDataPoints.push(newLogsCount);
            if (activityDataPoints.length > 60) {
                activityDataPoints.shift();
            }

        } catch (error) {
            console.error('Failed to update activity chart data:', error);
            // On error, just push a 0 to keep the chart moving
            activityDataPoints.push(0);
            if (activityDataPoints.length > 60) {
                activityDataPoints.shift();
            }
        }
    }

    function drawActivityChart() {
        if (!activityChartCanvas) return;
        const canvas = activityChartCanvas;
        const ctx = canvas.getContext('2d');
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;
        canvas.width = width;
        canvas.height = height;

        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        const lineColor = theme === 'dark' ? 'rgba(138, 180, 248, 0.8)' : 'rgba(26, 115, 232, 0.8)';
        const fillColor = theme === 'dark' ? 'rgba(138, 180, 248, 0.15)' : 'rgba(26, 115, 232, 0.15)';
        const gridColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        
        const maxCount = Math.max(5, ...activityDataPoints); // Set a minimum max height for better visuals
        const padding = 10;

        ctx.clearRect(0, 0, width, height);

        // Draw grid lines
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 5; i++) {
            const y = height / 5 * i + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Draw the line and area fill
        ctx.beginPath();
        
        const points = activityDataPoints.map((d, i) => {
            const x = (i / (activityDataPoints.length - 1)) * (width - padding * 2) + padding;
            const y = height - (d / maxCount) * (height - padding * 2) - padding;
            return { x, y };
        });

        if (points.length > 0) {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i].y);
            }
        }
        
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Area fill
        if (points.length > 1) {
            ctx.lineTo(points[points.length - 1].x, height - padding);
            ctx.lineTo(points[0].x, height - padding);
            ctx.closePath();
            ctx.fillStyle = fillColor;
            ctx.fill();
        }
    }
    // --- End Server Activity Chart Functions ---

    // --- Dashboard Functions ---
    function initializeDashboard() {
        console.log('Initializing Dashboard...');
        if (monitorIntervalId) {
            clearInterval(monitorIntervalId);
        }
        updateDashboardData(); // Initial load
        
        // Initial chart population
        updateActivityChart().then(() => {
            drawActivityChart();
        });

        monitorIntervalId = setInterval(() => {
            updateDashboardData();
            updateActivityChart().then(() => {
                 drawActivityChart();
            });
        }, 5000); // Refresh every 5 seconds
    }

    async function updateDashboardData() {
        try {
            const [resources, processes] = await Promise.all([
                apiFetch(`${MONITOR_API_BASE_URL}/system/resources`, {}, false), // Pass false to hide loader
                apiFetch(`${MONITOR_API_BASE_URL}/pm2/processes`, {}, false)   // Pass false to hide loader
            ]);
            
            // Update CPU
            const cpuUsage = resources.system.cpu.usage.toFixed(1);
            updateProgressCircle(cpuProgress, cpuUsageText, cpuUsage);
            cpuInfoText.innerHTML = `平台: ${resources.system.nodeProcess.platform} <br> 架构: ${resources.system.nodeProcess.arch}`;

            // Update Memory
            const memUsed = resources.system.memory.used;
            const memTotal = resources.system.memory.total;
            const memUsage = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : 0;
            updateProgressCircle(memProgress, memUsageText, memUsage);
            memInfoText.innerHTML = `已用: ${(memUsed / 1024 / 1024 / 1024).toFixed(2)} GB <br> 总共: ${(memTotal / 1024 / 1024 / 1024).toFixed(2)} GB`;
            
            // Update PM2 Processes
            pm2ProcessList.innerHTML = ''; // Clear previous
            if (processes.success && processes.processes.length > 0) {
                processes.processes.forEach(proc => {
                    const procEl = document.createElement('div');
                    procEl.className = 'process-item';
                    procEl.innerHTML = `
                        <strong>${proc.name}</strong> (PID: ${proc.pid})
                        <span class="status ${proc.status}">${proc.status}</span> <br>
                        CPU: ${proc.cpu}% | RAM: ${(proc.memory / 1024 / 1024).toFixed(1)} MB
                    `;
                    pm2ProcessList.appendChild(procEl);
                });
            } else {
                pm2ProcessList.innerHTML = '<p>没有正在运行的 PM2 进程。</p>';
            }

            // Update Node.js Info
            const nodeInfo = resources.system.nodeProcess;
            const uptimeSeconds = nodeInfo.uptime;
            const uptimeHours = Math.floor(uptimeSeconds / 3600);
            const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
            nodeInfoList.innerHTML = `
                <div class="node-info-item"><strong>PID:</strong> ${nodeInfo.pid}</div>
                <div class="node-info-item"><strong>Node.js 版本:</strong> ${nodeInfo.version}</div>
                <div class="node-info-item"><strong>内存占用:</strong> ${(nodeInfo.memory.rss / 1024 / 1024).toFixed(2)} MB</div>
                <div class="node-info-item"><strong>运行时间:</strong> ${uptimeHours}h ${uptimeMinutes}m</div>
            `;

        } catch (error) {
            console.error('Failed to update dashboard data:', error);
            pm2ProcessList.innerHTML = `<p class="error-message">加载 PM2 数据失败: ${error.message}</p>`;
            nodeInfoList.innerHTML = `<p class="error-message">加载系统数据失败: ${error.message}</p>`;
        }
    }

    function updateProgressCircle(circleElement, textElement, percentage) {
        const radius = 54;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (percentage / 100) * circumference;
        
        const progressBar = circleElement.querySelector('.progress-bar');
        progressBar.style.strokeDashoffset = offset;
        textElement.textContent = `${percentage}%`;
    }
    // --- End Dashboard Functions ---
 
    // --- Daily Notes Manager Functions ---
    let currentNotesFolder = null;
    let selectedNotes = new Set();
    let easyMDE = null; // 用于存储EasyMDE实例

    async function initializeDailyNotesManager() {
        console.log('Initializing Daily Notes Manager...');
        notesListViewDiv.innerHTML = ''; // Clear previous notes
        noteEditorAreaDiv.style.display = 'none'; // Hide editor
        ragTagsConfigAreaDiv.style.display = 'none'; // Hide RAG tags config area
        notesActionStatusSpan.textContent = '';
        moveSelectedNotesButton.disabled = true;
        if (deleteSelectedNotesButton) deleteSelectedNotesButton.disabled = true; // 新增：禁用删除按钮
        if (searchDailyNotesInput) searchDailyNotesInput.value = ''; // 清空搜索框
        await loadRagTagsConfig(); // 加载RAG-Tags配置
        await loadNotesFolders();
        // Optionally, load notes from the first folder automatically or show a placeholder
    }

    async function loadNotesFolders() {
        try {
            const data = await apiFetch(`${API_BASE_URL}/dailynotes/folders`);
            console.log('[DailyNotes] loadNotesFolders - API response data:', data); // 调试输出
            console.log('[DailyNotes] loadNotesFolders - typeof data:', typeof data); // 调试输出
            if (data && typeof data === 'object') { // 调试输出
                console.log('[DailyNotes] loadNotesFolders - data.folders:', data.folders);
            }
            notesFolderListUl.innerHTML = '';
            moveTargetFolderSelect.innerHTML = '<option value="">选择目标文件夹...</option>';

            if (data.folders && data.folders.length > 0) {
                data.folders.forEach(folder => {
                    const li = document.createElement('li');
                    li.textContent = folder;
                    li.dataset.folderName = folder;
                    li.addEventListener('click', () => {
                        loadNotesForFolder(folder);
                        // Update active class
                        notesFolderListUl.querySelectorAll('li').forEach(item => item.classList.remove('active'));
                        li.classList.add('active');
                    });
                    notesFolderListUl.appendChild(li);

                    const option = document.createElement('option');
                    option.value = folder;
                    option.textContent = folder;
                    moveTargetFolderSelect.appendChild(option);
                });
                // Automatically select and load the first folder if none is current or if current is no longer valid
                if (!currentNotesFolder || !data.folders.includes(currentNotesFolder)) {
                    if (notesFolderListUl.firstChild) {
                         notesFolderListUl.firstChild.click(); // Simulate click to load notes and set active
                    }
                } else {
                    // Reselect current folder if it still exists
                     const currentFolderLi = notesFolderListUl.querySelector(`li[data-folder-name="${currentNotesFolder}"]`);
                     if (currentFolderLi) currentFolderLi.classList.add('active');
                }
            } else {
                notesFolderListUl.innerHTML = '<li>没有找到日记文件夹。</li>';
                notesListViewDiv.innerHTML = '<p>没有日记可以显示。</p>';
            }
        } catch (error) {
            notesFolderListUl.innerHTML = '<li>加载文件夹列表失败。</li>';
            showMessage('加载文件夹列表失败: ' + error.message, 'error');
        }
    }

    async function loadNotesForFolder(folderName) {
        currentNotesFolder = folderName;
        selectedNotes.clear(); // Clear selection when changing folder
        updateMoveButtonStatus();
        notesListViewDiv.innerHTML = '<p>正在加载日记...</p>'; // Loading state
        noteEditorAreaDiv.style.display = 'none'; // Ensure editor is hidden
        if(searchDailyNotesInput) searchDailyNotesInput.value = ''; // Clear search input when loading a folder

        try {
            const data = await apiFetch(`${API_BASE_URL}/dailynotes/folder/${folderName}`);
            notesListViewDiv.innerHTML = ''; // Clear loading state
            if (data.notes && data.notes.length > 0) {
                data.notes.forEach(note => {
                    // renderNoteCard now expects note.folderName to be part of the note object for consistency
                    // or pass folderName explicitly if the endpoint doesn't return it per note
                    const card = renderNoteCard(note, folderName); // Pass folderName explicitly
                    notesListViewDiv.appendChild(card);
                });
            } else {
                notesListViewDiv.innerHTML = `<p>文件夹 "${folderName}" 中没有日记。</p>`;
            }
            
            // 加载并显示该文件夹的RAG-Tags配置
            displayRagTagsForFolder(folderName);
            
        } catch (error) {
            notesListViewDiv.innerHTML = `<p>加载文件夹 "${folderName}" 中的日记失败。</p>`;
            showMessage(`加载日记失败: ${error.message}`, 'error');
        }
        // No longer call filterNotesBySearch here, search is independent or triggered by input
    }

    async function filterNotesBySearch() {
        if (!searchDailyNotesInput) return;
        const searchTerm = searchDailyNotesInput.value.trim();

        if (searchTerm === '') {
            // If search term is empty, reload notes for the current folder
            if (currentNotesFolder) {
                loadNotesForFolder(currentNotesFolder);
            } else {
                notesListViewDiv.innerHTML = '<p>请输入搜索词或选择一个文件夹。</p>';
            }
            return;
        }

        notesListViewDiv.innerHTML = '<p>正在搜索日记...</p>';
        try {
            // Use currentNotesFolder if available for targeted search, otherwise global (if API supports)
            const searchUrl = currentNotesFolder
                ? `${API_BASE_URL}/dailynotes/search?term=${encodeURIComponent(searchTerm)}&folder=${encodeURIComponent(currentNotesFolder)}`
                : `${API_BASE_URL}/dailynotes/search?term=${encodeURIComponent(searchTerm)}`; // Global search

            const data = await apiFetch(searchUrl);
            notesListViewDiv.innerHTML = ''; // Clear loading/previous results

            if (data.notes && data.notes.length > 0) {
                data.notes.forEach(note => {
                    // The search API now returns folderName with each note
                    const card = renderNoteCard(note, note.folderName);
                    notesListViewDiv.appendChild(card);
                });
            } else {
                notesListViewDiv.innerHTML = `<p>没有找到与 "${searchTerm}" 相关的日记。</p>`;
            }
        } catch (error) {
            notesListViewDiv.innerHTML = `<p>搜索日记失败: ${error.message}</p>`;
            showMessage(`搜索失败: ${error.message}`, 'error');
        }
    }

    function renderNoteCard(note, folderName) { // folderName is passed explicitly or from note object
        const card = document.createElement('div');
        card.className = 'note-card';
        card.dataset.fileName = note.name;
        card.dataset.folderName = folderName;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'note-select-checkbox';
        checkbox.addEventListener('change', (e) => {
            const noteId = `${folderName}/${note.name}`;
            if (e.target.checked) {
                selectedNotes.add(noteId);
                card.classList.add('selected');
            } else {
                selectedNotes.delete(noteId);
                card.classList.remove('selected');
            }
            updateMoveButtonStatus();
        });

        const fileNameP = document.createElement('p');
        fileNameP.className = 'note-card-filename';
        fileNameP.textContent = note.name;
        
        const previewP = document.createElement('p');
        previewP.className = 'note-card-preview';
        // Use the preview from the note object, fallback to lastModified if preview is not available
        previewP.textContent = note.preview || `修改于: ${new Date(note.lastModified).toLocaleString()}`;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'note-card-actions';
        const editButton = document.createElement('button');
        editButton.textContent = '编辑';
        editButton.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent card click if button is separate
            openNoteForEditing(folderName, note.name);
        });

        actionsDiv.appendChild(editButton);
        
        card.appendChild(checkbox);
        card.appendChild(fileNameP);
        card.appendChild(previewP);
        card.appendChild(actionsDiv);

        // Card click also opens for editing (if not clicking checkbox or button)
        card.addEventListener('click', (e) => {
            if (e.target !== checkbox && !actionsDiv.contains(e.target)) {
                 openNoteForEditing(folderName, note.name);
            }
        });
        return card;
    }
    
    function updateMoveButtonStatus() {
        const hasSelection = selectedNotes.size > 0;
        moveSelectedNotesButton.disabled = !hasSelection;
        moveTargetFolderSelect.disabled = !hasSelection;
        if (deleteSelectedNotesButton) deleteSelectedNotesButton.disabled = !hasSelection; // 新增：更新删除按钮状态
    }

    async function openNoteForEditing(folderName, fileName) {
        notesActionStatusSpan.textContent = '';
        try {
            const data = await apiFetch(`${API_BASE_URL}/dailynotes/note/${folderName}/${fileName}`);
            editingNoteFolderInput.value = folderName;
            editingNoteFileInput.value = fileName;
            
            // 销毁旧的EasyMDE实例（如果存在）
            if (easyMDE) {
                easyMDE.toTextArea();
                easyMDE = null;
            }
            
            noteContentEditorTextarea.value = data.content;
            
            // 初始化EasyMDE
            easyMDE = new EasyMDE({
                element: noteContentEditorTextarea,
                spellChecker: false,
                sideBySideFullscreen: false,
                status: ['lines', 'words', 'cursor'],
                toolbar: ["bold", "italic", "heading", "|", "quote", "unordered-list", "ordered-list", "|", "link", "image", "|", "preview", "side-by-side", "fullscreen", "|", "guide"],
                previewClass: ['editor-preview', 'custom-preview'],
                previewRender: function(plainText, preview) {
                    // 使用 EasyMDE 自带的 markdown 渲染
                    setTimeout(function() {
                        preview.innerHTML = easyMDE.markdown(plainText);
                    }, 1);
                    return "Loading...";
                }
            });

            document.getElementById('notes-list-view').style.display = 'none';
            document.querySelector('.notes-sidebar').style.display = 'none'; // Hide sidebar too
            document.querySelector('.notes-toolbar').style.display = 'none';
            document.querySelector('.notes-content-area').style.display = 'none'; // Hide content area
            noteEditorAreaDiv.style.display = 'block';
            noteEditorStatusSpan.textContent = `正在编辑: ${folderName}/${fileName}`;
        } catch (error) {
            showMessage(`打开日记 ${fileName} 失败: ${error.message}`, 'error');
        }
    }

    async function saveNoteChanges() {
        const folderName = editingNoteFolderInput.value;
        const fileName = editingNoteFileInput.value;
        const content = easyMDE.value(); // 从EasyMDE获取内容

        if (!folderName || !fileName) {
            showMessage('无法保存日记，缺少文件信息。', 'error');
            return;
        }
        noteEditorStatusSpan.textContent = '正在保存...';
        try {
            await apiFetch(`${API_BASE_URL}/dailynotes/note/${folderName}/${fileName}`, {
                method: 'POST',
                body: JSON.stringify({ content })
            });
            showMessage(`日记 ${fileName} 已成功保存!`, 'success');
            closeNoteEditor(); // This will also trigger a refresh of the notes list if current folder matches
            if (currentNotesFolder === folderName) {
                loadNotesForFolder(folderName); // Refresh the list
            }
        } catch (error) {
            noteEditorStatusSpan.textContent = `保存失败: ${error.message}`;
            // showMessage is handled by apiFetch
        }
    }

    function closeNoteEditor() {
        // 销毁EasyMDE实例
        if (easyMDE) {
            easyMDE.toTextArea();
            easyMDE = null;
        }
        noteEditorAreaDiv.style.display = 'none';
        editingNoteFolderInput.value = '';
        editingNoteFileInput.value = '';
        noteContentEditorTextarea.value = '';
        noteEditorStatusSpan.textContent = '';
        
        document.getElementById('notes-list-view').style.display = 'grid'; // or 'block' if not grid
        document.querySelector('.notes-sidebar').style.display = 'block'; // Show sidebar again
        document.querySelector('.notes-toolbar').style.display = 'flex'; // Show toolbar again
        document.querySelector('.notes-content-area').style.display = 'flex'; // Show content area again, restore its flex display

        // If a folder was active, re-highlight it (or simply reload folders which reloads notes)
        // For simplicity, if currentNotesFolder is set, reload its notes.
        if (currentNotesFolder) {
            // loadNotesForFolder(currentNotesFolder); // This might be too much if just canceling
        }
    }
    
    async function moveSelectedNotesHandler() { // Renamed to avoid conflict if any
        const targetFolder = moveTargetFolderSelect.value;
        if (!targetFolder) {
            showMessage('请选择一个目标文件夹。', 'error');
            return;
        }
        if (selectedNotes.size === 0) {
            showMessage('没有选中的日记。', 'error');
            return;
        }

        const notesToMove = Array.from(selectedNotes).map(noteId => {
            const [folder, file] = noteId.split('/');
            return { folder, file };
        });

        notesActionStatusSpan.textContent = '正在移动...';
        try {
            const response = await apiFetch(`${API_BASE_URL}/dailynotes/move`, {
                method: 'POST',
                body: JSON.stringify({ sourceNotes: notesToMove, targetFolder })
            });
            showMessage(response.message || `${notesToMove.length} 个日记已移动。`, response.errors && response.errors.length > 0 ? 'error' : 'success');
            if (response.errors && response.errors.length > 0) {
                console.error('移动日记时发生错误:', response.errors);
                notesActionStatusSpan.textContent = `部分移动失败: ${response.errors.map(e => e.error).join(', ')}`;
            } else {
                 notesActionStatusSpan.textContent = '';
            }
            
            // Refresh current folder and folder list (as folders might have changed)
            const folderToReload = currentNotesFolder; // Store before clearing
            selectedNotes.clear();
            updateMoveButtonStatus();
            await loadNotesFolders(); // This will re-populate target folder select and folder list
            
            // Try to reselect the previously active folder, or the target folder if current was source
            let reselectFolder = folderToReload;
            if (notesToMove.some(n => n.folder === folderToReload)) { // If we moved from current folder
                // Check if current folder still exists or if it became empty and should switch
                // For now, just reload it. loadNotesFolders will handle active state.
            }
            
            // If current folder was one of the source folders, reload it.
            // If the target folder is now the current folder, also good.
            // loadNotesFolders will try to re-activate currentNotesFolder if it exists.
            // If not, it loads the first one.
            if (folderToReload) {
                 const currentFolderLi = notesFolderListUl.querySelector(`li[data-folder-name="${folderToReload}"]`);
                 if (currentFolderLi) {
                    currentFolderLi.click(); // This will trigger loadNotesForFolder
                 } else if (notesFolderListUl.firstChild) { // If original folder gone, click first
                    notesFolderListUl.firstChild.click();
                 } else {
                    notesListViewDiv.innerHTML = '<p>请选择一个文件夹。</p>'; // No folders left
                 }
            }


        } catch (error) {
            notesActionStatusSpan.textContent = `移动失败: ${error.message}`;
            // showMessage is handled by apiFetch
        }
    }

    // Event Listeners for Daily Notes
    if (saveNoteButton) saveNoteButton.addEventListener('click', saveNoteChanges);
    if (cancelEditNoteButton) cancelEditNoteButton.addEventListener('click', closeNoteEditor);
    if (moveSelectedNotesButton) moveSelectedNotesButton.addEventListener('click', moveSelectedNotesHandler);
    if (deleteSelectedNotesButton) deleteSelectedNotesButton.addEventListener('click', deleteSelectedNotesHandler); // 新增：删除按钮事件
    if (searchDailyNotesInput) searchDailyNotesInput.addEventListener('input', filterNotesBySearch);

    // --- RAG Tags Config Functions ---
    async function loadRagTagsConfig() {
        try {
            ragTagsData = await apiFetch(`${API_BASE_URL}/rag-tags`, {}, false);
            console.log('[RAGTags] Loaded RAG-Tags config:', ragTagsData);
        } catch (error) {
            console.error('[RAGTags] Failed to load RAG-Tags config:', error);
            ragTagsData = {};
        }
    }

    function displayRagTagsForFolder(folderName) {
        currentRagFolder = folderName;
        ragTagsFolderNameSpan.textContent = folderName;
        
        const folderConfig = ragTagsData[folderName] || {};
        const tags = folderConfig.tags || [];
        const threshold = folderConfig.threshold;
        
        // 设置阈值
        if (threshold !== undefined) {
            ragThresholdEnabledCheckbox.checked = true;
            ragThresholdValueSlider.value = threshold;
            ragThresholdValueSlider.disabled = false;
            ragThresholdDisplaySpan.textContent = threshold.toFixed(2);
        } else {
            ragThresholdEnabledCheckbox.checked = false;
            ragThresholdValueSlider.value = 0.7;
            ragThresholdValueSlider.disabled = true;
            ragThresholdDisplaySpan.textContent = '0.70';
        }
        
        // 清空并重新创建标签
        ragTagsContainer.innerHTML = '';
        tags.forEach((tagData) => {
            const tagValue = typeof tagData === 'string' ? tagData : (tagData.tag || '');
            addTagItem(tagValue);
        });
        
        // 显示配置区域
        ragTagsConfigAreaDiv.style.display = 'block';
        ragTagsStatusSpan.textContent = '';
    }

    function addTagItem(value = '') {
        const tagDiv = document.createElement('div');
        tagDiv.className = 'tag-item';
        
        const tagInput = document.createElement('input');
        tagInput.type = 'text';
        tagInput.className = 'tag-input';
        tagInput.value = value;
        tagInput.placeholder = '标签:权重(可选)';
        tagDiv.appendChild(tagInput);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-tag-btn';
        deleteBtn.textContent = '×';
        deleteBtn.onclick = () => tagDiv.remove();
        tagDiv.appendChild(deleteBtn);

        ragTagsContainer.appendChild(tagDiv);
        if (!value) {
            tagInput.focus();
        }
    }

    async function saveRagTagsConfigHandler() {
        if (!currentRagFolder) {
            showMessage('未选中知识库文件夹', 'error');
            return;
        }

        ragTagsStatusSpan.textContent = '保存中...';
        ragTagsStatusSpan.className = 'status-message';

        try {
            // 构建当前文件夹的配置
            const folderConfig = {};
            
            // 处理标签 - 从tag-item读取
            const tagInputs = ragTagsContainer.querySelectorAll('.tag-input');
            const tags = [];
            tagInputs.forEach(input => {
                const value = input.value.trim();
                if (value) {
                    tags.push(value);
                }
            });
            folderConfig.tags = tags;
            
            // 处理阈值
            if (ragThresholdEnabledCheckbox.checked) {
                folderConfig.threshold = parseFloat(ragThresholdValueSlider.value);
            }
            
            // 更新本地数据
            if (folderConfig.tags.length > 0 || folderConfig.threshold !== undefined) {
                ragTagsData[currentRagFolder] = folderConfig;
            } else {
                // 如果没有配置任何内容，则删除该条目
                delete ragTagsData[currentRagFolder];
            }
            
            // 保存到服务器
            await apiFetch(`${API_BASE_URL}/rag-tags`, {
                method: 'POST',
                body: JSON.stringify(ragTagsData)
            });

            ragTagsStatusSpan.textContent = '✓ 保存成功';
            ragTagsStatusSpan.className = 'status-message success';
            showMessage('RAG-Tags配置已保存', 'success');
            
            // 3秒后清空状态
            setTimeout(() => {
                ragTagsStatusSpan.textContent = '';
            }, 3000);

        } catch (error) {
            console.error('[RAGTags] Save failed:', error);
            ragTagsStatusSpan.textContent = '✗ 保存失败';
            ragTagsStatusSpan.className = 'status-message error';
            showMessage(`保存RAG-Tags配置失败: ${error.message}`, 'error');
        }
    }

    // RAG Tags 事件监听器
    if (ragThresholdEnabledCheckbox) {
        ragThresholdEnabledCheckbox.addEventListener('change', () => {
            ragThresholdValueSlider.disabled = !ragThresholdEnabledCheckbox.checked;
        });
    }
    
    if (ragThresholdValueSlider) {
        ragThresholdValueSlider.addEventListener('input', () => {
            ragThresholdDisplaySpan.textContent = parseFloat(ragThresholdValueSlider.value).toFixed(2);
        });
    }
    
    if (addRagTagButton) {
        addRagTagButton.addEventListener('click', () => {
            addTagItem();
        });
    }
    
    if (saveRagTagsConfigButton) {
        saveRagTagsConfigButton.addEventListener('click', saveRagTagsConfigHandler);
    }
    // --- End RAG Tags Config Functions ---


    // --- End Daily Notes Manager Functions ---

    // --- New Function for Deleting Selected Notes ---
    async function deleteSelectedNotesHandler() {
        if (selectedNotes.size === 0) {
            showMessage('没有选中的日记。', 'error');
            return;
        }

        if (!confirm(`您确定要删除选中的 ${selectedNotes.size} 个日记吗？此操作无法撤销。`)) {
            return;
        }

        const notesToDelete = Array.from(selectedNotes).map(noteId => {
            const [folder, file] = noteId.split('/');
            return { folder, file };
        });

        notesActionStatusSpan.textContent = '正在删除...';
        try {
            const response = await apiFetch(`${API_BASE_URL}/dailynotes/delete-batch`, {
                method: 'POST', // Changed to POST as per server.js implementation
                body: JSON.stringify({ notesToDelete })
            });
            showMessage(response.message || `${notesToDelete.length} 个日记已删除。`, response.errors && response.errors.length > 0 ? 'warning' : 'success');
            
            if (response.errors && response.errors.length > 0) {
                console.error('删除日记时发生错误:', response.errors);
                notesActionStatusSpan.textContent = `部分删除失败: ${response.errors.map(e => e.error).join(', ')}`;
            } else {
                notesActionStatusSpan.textContent = '';
            }

            const folderToReload = currentNotesFolder;
            selectedNotes.clear();
            updateMoveButtonStatus(); // This will disable buttons again

            // Refresh folder list (in case a folder becomes empty and might be handled differently by UI, though unlikely for delete)
            // and notes list for the current folder.
            await loadNotesFolders(); // Reloads all folders and their counts, re-populates move target

            // Try to reselect the previously active folder
            if (folderToReload) {
                const currentFolderLi = notesFolderListUl.querySelector(`li[data-folder-name="${folderToReload}"]`);
                if (currentFolderLi) {
                    currentFolderLi.click(); // This will trigger loadNotesForFolder
                } else if (notesFolderListUl.firstChild) { // If original folder gone (e.g., it was deleted), click first
                    notesFolderListUl.firstChild.click();
                } else { // No folders left
                    notesListViewDiv.innerHTML = '<p>请选择一个文件夹。</p>';
                }
            } else if (notesFolderListUl.firstChild) { // If no folder was current, click first
                 notesFolderListUl.firstChild.click();
            } else {
                notesListViewDiv.innerHTML = '<p>没有日记可以显示。</p>';
            }

        } catch (error) {
            notesActionStatusSpan.textContent = `删除失败: ${error.message}`;
            // showMessage is handled by apiFetch
        }
    }
    // --- End New Function ---

    // --- Agent Manager Functions ---
    let currentEditingAgentFile = null;
    let availableAgentFiles = []; // Cache available .txt files

    async function initializeAgentManager() {
        console.log('Initializing Agent Manager...');
        agentFileContentEditor.value = '';
        agentFileStatusSpan.textContent = '';
        agentMapStatusSpan.textContent = '';
        editingAgentFileDisplay.textContent = '未选择文件';
        saveAgentFileButton.disabled = true;
        currentEditingAgentFile = null;
        agentMapListDiv.innerHTML = '<p>正在加载 Agent 映射...</p>';

        try {
            // Fetch both map and available files concurrently
            const [mapData, filesData] = await Promise.all([
                apiFetch(`${API_BASE_URL}/agents/map`),
                apiFetch(`${API_BASE_URL}/agents`)
            ]);
            
            availableAgentFiles = filesData.files.sort((a, b) => a.localeCompare(b));
            renderAgentMap(mapData);

        } catch (error) {
            agentMapListDiv.innerHTML = `<p class="error-message">加载 Agent 数据失败: ${error.message}</p>`;
            showMessage(`加载 Agent 数据失败: ${error.message}`, 'error');
        }
    }

    function renderAgentMap(agentMap) {
        agentMapListDiv.innerHTML = ''; // Clear loading message
        if (Object.keys(agentMap).length === 0) {
            agentMapListDiv.innerHTML = '<p>没有定义任何 Agent。请点击“添加新 Agent”来创建一个。</p>';
        }

        for (const agentName in agentMap) {
            const fileName = agentMap[agentName];
            const entryDiv = createAgentMapEntryElement(agentName, fileName);
            agentMapListDiv.appendChild(entryDiv);
        }
    }

    function createAgentMapEntryElement(agentName, selectedFile) {
        const entryDiv = document.createElement('div');
        entryDiv.className = 'agent-map-entry';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = agentName;
        nameInput.className = 'agent-name-input';
        nameInput.placeholder = 'Agent 定义名';

        const fileSelect = document.createElement('select');
        fileSelect.className = 'agent-file-select';
        
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = '选择一个 .txt 文件...';
        fileSelect.appendChild(placeholderOption);

        availableAgentFiles.forEach(f => {
            const option = document.createElement('option');
            option.value = f;
            option.textContent = f;
            if (f === selectedFile) {
                option.selected = true;
            }
            fileSelect.appendChild(option);
        });

        const editFileButton = document.createElement('button');
        editFileButton.textContent = '编辑文件';
        editFileButton.className = 'edit-agent-file-btn';
        editFileButton.onclick = () => {
            const selectedValue = fileSelect.value;
            if (selectedValue) {
                loadAgentFileContent(selectedValue);
            } else {
                showMessage('请先为此 Agent 选择一个文件。', 'info');
            }
        };

        const deleteButton = document.createElement('button');
        deleteButton.textContent = '删除';
        deleteButton.className = 'delete-agent-map-btn';
        deleteButton.onclick = () => {
            if (confirm(`确定要删除 Agent "${nameInput.value || '(未命名)'}" 吗？`)) {
                entryDiv.remove();
            }
        };

        entryDiv.appendChild(nameInput);
        entryDiv.appendChild(document.createTextNode(' → '));
        entryDiv.appendChild(fileSelect);
        entryDiv.appendChild(editFileButton);
        entryDiv.appendChild(deleteButton);

        return entryDiv;
    }

    async function loadAgentFileContent(fileName) {
        if (!fileName) {
            agentFileContentEditor.value = '';
            agentFileStatusSpan.textContent = '';
            editingAgentFileDisplay.textContent = '未选择文件';
            saveAgentFileButton.disabled = true;
            currentEditingAgentFile = null;
            agentFileContentEditor.placeholder = '从左侧选择一个 Agent 以编辑其关联的 .txt 文件...';
            return;
        }
        agentFileStatusSpan.textContent = `正在加载 ${fileName}...`;
        try {
            const data = await apiFetch(`${API_BASE_URL}/agents/${fileName}`);
            agentFileContentEditor.value = data.content;
            agentFileStatusSpan.textContent = ``; // Clear loading message
            editingAgentFileDisplay.textContent = `正在编辑: ${fileName}`;
            saveAgentFileButton.disabled = false;
            currentEditingAgentFile = fileName;
        } catch (error) {
            agentFileStatusSpan.textContent = `加载文件 ${fileName} 失败。`;
            editingAgentFileDisplay.textContent = `加载失败: ${fileName}`;
            showMessage(`加载文件 ${fileName} 失败: ${error.message}`, 'error');
            agentFileContentEditor.value = `无法加载文件: ${fileName}\n\n错误: ${error.message}`;
            saveAgentFileButton.disabled = true;
            currentEditingAgentFile = null;
        }
    }

    async function saveAgentFileContent() {
        if (!currentEditingAgentFile) {
            showMessage('没有选择要保存的文件。', 'error');
            return;
        }
        const content = agentFileContentEditor.value;
        agentFileStatusSpan.textContent = `正在保存 ${currentEditingAgentFile}...`;
        saveAgentFileButton.disabled = true;

        try {
            await apiFetch(`${API_BASE_URL}/agents/${currentEditingAgentFile}`, {
                method: 'POST',
                body: JSON.stringify({ content })
            });
            showMessage(`Agent 文件 '${currentEditingAgentFile}' 已成功保存!`, 'success');
            agentFileStatusSpan.textContent = `Agent 文件 '${currentEditingAgentFile}' 已保存。`;
        } catch (error) {
            agentFileStatusSpan.textContent = `保存文件 ${currentEditingAgentFile} 失败。`;
            // showMessage is handled by apiFetch
        } finally {
            saveAgentFileButton.disabled = false;
        }
    }

    async function saveAgentMap() {
        agentMapStatusSpan.textContent = '正在保存...';
        agentMapStatusSpan.className = 'status-message info';
        const newMap = {};
        let isValid = true;

        agentMapListDiv.querySelectorAll('.agent-map-entry').forEach(entry => {
            const nameInput = entry.querySelector('.agent-name-input');
            const fileSelect = entry.querySelector('.agent-file-select');
            const agentName = nameInput.value.trim();
            const fileName = fileSelect.value;

            if (!agentName) {
                showMessage('Agent 定义名不能为空。', 'error');
                nameInput.focus();
                isValid = false;
                return;
            }
            if (newMap[agentName]) {
                showMessage(`Agent 定义名 "${agentName}" 重复。`, 'error');
                nameInput.focus();
                isValid = false;
                return;
            }
            if (!fileName) {
                showMessage(`Agent "${agentName}" 未选择 .txt 文件。`, 'error');
                fileSelect.focus();
                isValid = false;
                return;
            }
            newMap[agentName] = fileName;
        });

        if (!isValid) {
            agentMapStatusSpan.textContent = '保存失败，请检查错误。';
            agentMapStatusSpan.className = 'status-message error';
            return;
        }

        try {
            await apiFetch(`${API_BASE_URL}/agents/map`, {
                method: 'POST',
                body: JSON.stringify(newMap)
            });
            showMessage('Agent 映射表已成功保存!', 'success');
            agentMapStatusSpan.textContent = '保存成功!';
            agentMapStatusSpan.className = 'status-message success';
            // Reload to ensure consistency
            initializeAgentManager();
        } catch (error) {
            agentMapStatusSpan.textContent = `保存失败: ${error.message}`;
            agentMapStatusSpan.className = 'status-message error';
        }
    }

    function addNewAgentMapEntry() {
        const entryDiv = createAgentMapEntryElement('', '');
        agentMapListDiv.appendChild(entryDiv);
        entryDiv.querySelector('.agent-name-input').focus();
    }

    async function createNewAgentFileHandler() {
        let fileName = prompt("请输入要创建的新 .txt 文件名（无需包含 .txt 后缀）:", "");
        if (!fileName || !fileName.trim()) {
            showMessage('文件名不能为空。', 'info');
            return;
        }

        // 标准化文件名：如果用户添加了.txt，则删除它，然后再添加回来以确保格式正确。
        fileName = fileName.trim().replace(/\.txt$/i, '');
        const finalFileName = `${fileName}.txt`;

        if (availableAgentFiles.includes(finalFileName)) {
            showMessage(`文件 "${finalFileName}" 已存在。`, 'error');
            return;
        }

        if (!confirm(`确定要创建新的 Agent 文件 "${finalFileName}" 吗？`)) {
            return;
        }

        agentMapStatusSpan.textContent = `正在创建文件 ${finalFileName}...`;
        agentMapStatusSpan.className = 'status-message info';

        try {
            // 注意：这假设服务器上已创建新的 API 端点 POST /admin_api/agents/new-file
            await apiFetch(`${API_BASE_URL}/agents/new-file`, {
                method: 'POST',
                body: JSON.stringify({ fileName: finalFileName })
            });
            showMessage(`文件 "${finalFileName}" 已成功创建!`, 'success');
            agentMapStatusSpan.textContent = '文件创建成功!';
            agentMapStatusSpan.className = 'status-message success';
            
            // 刷新整个 agent 管理器以在列表中获取新文件
            await initializeAgentManager();

        } catch (error) {
            agentMapStatusSpan.textContent = `创建文件失败: ${error.message}`;
            agentMapStatusSpan.className = 'status-message error';
            // showMessage 由 apiFetch 处理
        }
    }


    // Event Listeners for Agent Manager
    if (saveAgentFileButton) {
        saveAgentFileButton.addEventListener('click', saveAgentFileContent);
    }
    if (saveAgentMapButton) {
        saveAgentMapButton.addEventListener('click', saveAgentMap);
    }
    if (addAgentMapEntryButton) {
        addAgentMapEntryButton.addEventListener('click', addNewAgentMapEntry);
    }
    if (createAgentFileButton) {
        createAgentFileButton.addEventListener('click', createNewAgentFileHandler);
    }

    // --- End Agent Manager Functions ---

    // --- TVS Files Editor Functions ---
    let currentEditingTvsFile = null;

    async function initializeTvsFilesEditor() {
        console.log('Initializing TVS Files Editor...');
        tvsFileContentEditor.value = '';
        tvsFileStatusSpan.textContent = '';
        saveTvsFileButton.disabled = true;
        currentEditingTvsFile = null;
        await loadTvsFilesList();
    }

    async function loadTvsFilesList() {
        try {
            const data = await apiFetch(`${API_BASE_URL}/tvsvars`);
            tvsFileSelect.innerHTML = '<option value="">请选择一个文件...</option>'; // Reset
            if (data.files && data.files.length > 0) {
                data.files.sort((a, b) => a.localeCompare(b)); // Sort alphabetically
                data.files.forEach(fileName => {
                    const option = document.createElement('option');
                    option.value = fileName;
                    option.textContent = fileName;
                    tvsFileSelect.appendChild(option);
                });
            } else {
                tvsFileSelect.innerHTML = '<option value="">没有找到变量文件</option>';
                tvsFileContentEditor.placeholder = '没有变量文件可供编辑。';
            }
        } catch (error) {
            tvsFileSelect.innerHTML = '<option value="">加载变量文件列表失败</option>';
            showMessage('加载变量文件列表失败: ' + error.message, 'error');
            tvsFileContentEditor.placeholder = '加载变量文件列表失败。';
        }
    }

    async function loadTvsFileContent(fileName) {
        if (!fileName) {
            tvsFileContentEditor.value = '';
            tvsFileStatusSpan.textContent = '请选择一个文件。';
            saveTvsFileButton.disabled = true;
            currentEditingTvsFile = null;
            tvsFileContentEditor.placeholder = '选择一个变量文件以编辑其内容...';
            return;
        }
        tvsFileStatusSpan.textContent = `正在加载 ${fileName}...`;
        try {
            const data = await apiFetch(`${API_BASE_URL}/tvsvars/${fileName}`);
            tvsFileContentEditor.value = data.content;
            tvsFileStatusSpan.textContent = `当前编辑: ${fileName}`;
            saveTvsFileButton.disabled = false;
            currentEditingTvsFile = fileName;
        } catch (error) {
            tvsFileStatusSpan.textContent = `加载文件 ${fileName} 失败。`;
            showMessage(`加载文件 ${fileName} 失败: ${error.message}`, 'error');
            tvsFileContentEditor.value = `无法加载文件: ${fileName}\n\n错误: ${error.message}`;
            saveTvsFileButton.disabled = true;
            currentEditingTvsFile = null;
        }
    }

    async function saveTvsFileContent() {
        if (!currentEditingTvsFile) {
            showMessage('没有选择要保存的文件。', 'error');
            return;
        }
        const content = tvsFileContentEditor.value;
        tvsFileStatusSpan.textContent = `正在保存 ${currentEditingTvsFile}...`;
        saveTvsFileButton.disabled = true;

        try {
            await apiFetch(`${API_BASE_URL}/tvsvars/${currentEditingTvsFile}`, {
                method: 'POST',
                body: JSON.stringify({ content })
            });
            showMessage(`变量文件 '${currentEditingTvsFile}' 已成功保存!`, 'success');
            tvsFileStatusSpan.textContent = `变量文件 '${currentEditingTvsFile}' 已保存。`;
        } catch (error) {
            tvsFileStatusSpan.textContent = `保存文件 ${currentEditingTvsFile} 失败。`;
            // showMessage is handled by apiFetch
        } finally {
            saveTvsFileButton.disabled = false;
        }
    }

    // Event Listeners for TVS Files Editor
    if (tvsFileSelect) {
        tvsFileSelect.addEventListener('change', (event) => {
            loadTvsFileContent(event.target.value);
        });
    }
    if (saveTvsFileButton) {
        saveTvsFileButton.addEventListener('click', saveTvsFileContent);
    }

    // --- End TVS Files Editor Functions ---

    // --- Server Log Viewer Functions ---
    async function initializeServerLogViewer() {
        console.log('Initializing Server Log Viewer...');
        // Clear any existing interval before starting a new one or performing the initial load
        if (serverLogIntervalId) {
            clearInterval(serverLogIntervalId);
            serverLogIntervalId = null;
            console.log('Cleared existing server log auto-refresh interval during initialization.');
        }

        if (!serverLogViewerSection) {
            console.error('Server Log Viewer section not found in DOM.');
            return;
        }
        serverLogPathDisplay.textContent = '';
        serverLogStatusSpan.textContent = '';
        serverLogContentPre.textContent = '正在加载日志...'; // Changed placeholder text

        await loadServerLog(); // Perform the initial load

        // Start polling after the initial load
        if (!serverLogIntervalId) {
            serverLogIntervalId = setInterval(loadServerLog, 2000); // Poll every 2 seconds
            console.log('Started server log auto-refresh interval.');
        }
    }

    async function loadServerLog() {
        if (!serverLogContentPre || !serverLogStatusSpan || !serverLogPathDisplay) {
            console.error('Server log display elements not found.');
            return;
        }
        serverLogStatusSpan.textContent = '正在加载日志...';
        serverLogStatusSpan.className = 'status-message info';
        try {
            const data = await apiFetch(`${API_BASE_URL}/server-log`);
            serverLogContentPre.textContent = data.content || '日志内容为空或加载失败。';
            serverLogPathDisplay.textContent = `当前日志文件: ${data.path || '未知'}`;
            serverLogStatusSpan.textContent = '日志已加载。';
            serverLogStatusSpan.className = 'status-message success';
            // Scroll to bottom
            serverLogContentPre.scrollTop = serverLogContentPre.scrollHeight;
        } catch (error) {
            serverLogContentPre.textContent = `加载服务器日志失败: ${error.message}\n\n(可能是因为服务器刚刚重启，日志文件路径已更改，或日志文件为空。)`;
            serverLogPathDisplay.textContent = `当前日志文件: 未知`;
            serverLogStatusSpan.textContent = `加载失败: ${error.message}`;
            serverLogStatusSpan.className = 'status-message error';
            // showMessage is handled by apiFetch
        }
    }

    // Event Listeners for Server Log Viewer
    if (copyServerLogButton) { // Changed from refreshServerLogButton
        copyServerLogButton.addEventListener('click', copyServerLogToClipboard);
    }

    async function copyServerLogToClipboard() {
        if (!serverLogContentPre) {
            showMessage('日志内容元素未找到。', 'error');
            return;
        }
        const logContent = serverLogContentPre.textContent;
        if (!logContent || logContent === '正在加载日志...' || logContent.startsWith('加载服务器日志失败')) {
            showMessage('没有可复制的日志内容。', 'info');
            return;
        }

        try {
            await navigator.clipboard.writeText(logContent);
            showMessage('日志内容已复制到剪贴板！', 'success');
            serverLogStatusSpan.textContent = '日志已复制!';
            serverLogStatusSpan.className = 'status-message success';
            setTimeout(() => {
                if (serverLogStatusSpan.textContent === '日志已复制!') {
                     serverLogStatusSpan.textContent = '日志已加载。'; // Revert after a few seconds
                }
            }, 3000);
        } catch (err) {
            console.error('无法自动复制日志: ', err);
            // Fallback: Try to select the text for manual copying
            try {
                serverLogContentPre.focus(); // Focus the element
                const range = document.createRange();
                range.selectNodeContents(serverLogContentPre);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                showMessage('自动复制失败。日志内容已选中，请按 Ctrl+C (或 Cmd+C) 手动复制。', 'info', 5000);
                serverLogStatusSpan.textContent = '请手动复制';
            } catch (selectErr) {
                console.error('选择文本以便手动复制失败: ', selectErr);
                showMessage('自动复制失败，也无法选中内容供手动复制。请尝试手动选择并复制。', 'error', 5000);
                serverLogStatusSpan.textContent = '复制失败';
            }
            serverLogStatusSpan.className = 'status-message error'; // Keep error class for status
        }
    }
    // --- End Server Log Viewer Functions ---

    // --- Preprocessor Order Manager Functions ---
    async function initializePreprocessorOrderManager() {
        const preprocessorListUl = document.getElementById('preprocessor-list');
        const preprocessorOrderStatusSpan = document.getElementById('preprocessor-order-status');

        if (!preprocessorListUl || !preprocessorOrderStatusSpan) {
            console.error('Preprocessor manager elements not found in the DOM.');
            return;
        }
        
        console.log('Initializing Preprocessor Order Manager...');
        preprocessorListUl.innerHTML = '<li>Loading...</li>';
        preprocessorOrderStatusSpan.textContent = '';
        try {
            const data = await apiFetch(`${API_BASE_URL}/preprocessors/order`);
            renderPreprocessorList(data.order, preprocessorListUl);
        } catch (error) {
            preprocessorListUl.innerHTML = `<li class="error-message">Failed to load preprocessor order: ${error.message}</li>`;
            showMessage(`Failed to load preprocessor order: ${error.message}`, 'error');
        }
    }

    function renderPreprocessorList(order, preprocessorListUl) {
        preprocessorListUl.innerHTML = '';
        if (order && order.length > 0) {
            order.forEach(plugin => {
                const li = document.createElement('li');
                li.draggable = true;
                li.dataset.pluginName = plugin.name;

                const infoDiv = document.createElement('div');
                infoDiv.className = 'plugin-info';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'plugin-name';
                nameSpan.textContent = plugin.displayName;
                infoDiv.appendChild(nameSpan);
                
                const descSpan = document.createElement('span');
                descSpan.className = 'plugin-description';
                descSpan.textContent = plugin.description;
                infoDiv.appendChild(descSpan);

                li.appendChild(infoDiv);

                // Drag and Drop Event Listeners
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
    
    // Moved event listeners to be attached once and checked for existence of elements
    const preprocessorListContainer = document.getElementById('preprocessor-list');
    if (preprocessorListContainer) {
        preprocessorListContainer.addEventListener('dragover', e => {
            e.preventDefault();
            const afterElement = getDragAfterElement(preprocessorListContainer, e.clientY);
            const dragging = document.querySelector('.dragging');
            if (dragging) {
                if (afterElement == null) {
                    preprocessorListContainer.appendChild(dragging);
                } else {
                    preprocessorListContainer.insertBefore(dragging, afterElement);
                }
            }
        });
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
    
    const savePreprocessorOrderButton = document.getElementById('save-preprocessor-order-button');
    if (savePreprocessorOrderButton) {
        savePreprocessorOrderButton.addEventListener('click', async () => {
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
                
                // Reload the latest order from server to ensure UI reflects the saved state
                const latestData = await apiFetch(`${API_BASE_URL}/preprocessors/order`);
                preprocessorOrderStatusSpan.textContent = 'Order saved and reloaded!';
                preprocessorOrderStatusSpan.className = 'status-message success';
                renderPreprocessorList(latestData.order, preprocessorListUl);
            } catch (error) {
                preprocessorOrderStatusSpan.textContent = `Error: ${error.message}`;
                preprocessorOrderStatusSpan.className = 'status-message error';
                // showMessage is handled by apiFetch
            }
        });
    }


    // --- Semantic Groups Editor Functions ---
    let semanticGroupsData = {}; // To hold the current state of groups data

    async function initializeSemanticGroupsEditor() {
        console.log('Initializing Semantic Groups Editor...');
        const container = document.getElementById('semantic-groups-container');
        const statusSpan = document.getElementById('semantic-groups-status');
        if (!container || !statusSpan) return;

        container.innerHTML = '<p>正在加载语义组...</p>';
        statusSpan.textContent = '';
        try {
            semanticGroupsData = await apiFetch(`${API_BASE_URL}/semantic-groups`);
            renderSemanticGroups(semanticGroupsData, container);
        } catch (error) {
            container.innerHTML = `<p class="error-message">加载语义组失败: ${error.message}</p>`;
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

        const summary = document.createElement('summary');
        summary.className = 'group-summary';
        
        const groupNameSpan = document.createElement('span');
        groupNameSpan.className = 'group-name-display';
        groupNameSpan.textContent = groupName;
        summary.appendChild(groupNameSpan);

        const deleteGroupBtn = document.createElement('button');
        deleteGroupBtn.textContent = '删除该组';
        deleteGroupBtn.className = 'delete-group-btn';
        deleteGroupBtn.onclick = (e) => {
            e.preventDefault();
            if (confirm(`确定要删除语义组 "${groupName}" 吗？`)) {
                details.remove();
                // The actual deletion from data happens on save
            }
        };
        summary.appendChild(deleteGroupBtn);
        details.appendChild(summary);

        const content = document.createElement('div');
        content.className = 'group-content';

        // Weight editor
        const weightGroup = document.createElement('div');
        weightGroup.className = 'form-group';
        const weightLabel = document.createElement('label');
        weightLabel.textContent = '权重 (Weight):';
        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.step = '0.1';
        weightInput.className = 'group-weight-input';
        weightInput.value = groupData.weight || 1.0;
        weightGroup.appendChild(weightLabel);
        weightGroup.appendChild(weightInput);
        content.appendChild(weightGroup);

        // Words editor
        const wordsGroup = document.createElement('div');
        wordsGroup.className = 'form-group';
        const wordsLabel = document.createElement('label');
        wordsLabel.textContent = '关键词 (Words):';
        const wordsContainer = document.createElement('div');
        wordsContainer.className = 'words-container';
        
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
                if (newWord && !allWords.includes(newWord)) {
                    const newWordTag = createWordTag(newWord, false);
                    wordsContainer.insertBefore(newWordTag, addWordInput);
                    addWordInput.value = '';
                    allWords.push(newWord); // Update local list to prevent duplicates in same session
                }
            }
        };
        wordsContainer.appendChild(addWordInput);
        wordsGroup.appendChild(wordsLabel);
        wordsGroup.appendChild(wordsContainer);
        content.appendChild(wordsGroup);

        details.appendChild(content);
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
            
            // Find original data to preserve stats
            const originalGroup = semanticGroupsData.groups[groupName] || {};

            newGroups[groupName] = {
                words,
                auto_learned,
                weight,
                vector: null, // Vector will be recalculated on the server
                last_activated: originalGroup.last_activated || null,
                activation_count: originalGroup.activation_count || 0,
                vector_id: originalGroup.vector_id || null // 关键修复：保留 vector_id
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
            // Reload to get fresh data from server (e.g., recalculated vectors info)
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
        
        // If it's the first group, clear the placeholder text
        if (!container.querySelector('.group-details')) {
            container.innerHTML = '';
        }

        const newGroupData = { words: [], auto_learned: [], weight: 1.0 };
        const newGroupElement = createGroupElement(normalizedGroupName, newGroupData);
        container.appendChild(newGroupElement);
        newGroupElement.scrollIntoView({ behavior: 'smooth' });
    }

    // Event Listeners for Semantic Groups Editor
    const saveSemanticGroupsButton = document.getElementById('save-semantic-groups-button');
    const addSemanticGroupButton = document.getElementById('add-semantic-group-button');

    if (saveSemanticGroupsButton) {
        saveSemanticGroupsButton.addEventListener('click', saveSemanticGroups);
    }
    if (addSemanticGroupButton) {
        addSemanticGroupButton.addEventListener('click', addNewSemanticGroup);
    }
    // --- End Semantic Groups Editor Functions ---
    });

