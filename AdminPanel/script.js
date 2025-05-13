// script.js
document.addEventListener('DOMContentLoaded', () => {
    const pluginNavList = document.getElementById('plugin-nav').querySelector('ul');
    const configDetailsContainer = document.getElementById('config-details-container');
    const baseConfigForm = document.getElementById('base-config-form');
    const loadingOverlay = document.getElementById('loading-overlay');
    const messagePopup = document.getElementById('message-popup');
    const restartServerButton = document.getElementById('restart-server-button'); // Get restart button

    const API_BASE_URL = '/admin_api'; // Corrected API base path

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

    async function apiFetch(url, options = {}) {
        showLoading(true);
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
            showLoading(false);
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
                navigateTo(firstLink.dataset.target, firstLink.dataset.pluginName);
                firstLink.classList.add('active'); // Activate the first link
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
            // Clear existing plugin nav items (except base config)
            const existingNavItems = pluginNavList.querySelectorAll('li:not(:first-child)');
            existingNavItems.forEach(item => item.remove());
            // Clear existing plugin sections
            const existingPluginSections = configDetailsContainer.querySelectorAll('.config-section:not(#base-config-section)');
            existingPluginSections.forEach(sec => sec.remove());

            plugins.sort((a, b) => (a.manifest.displayName || a.manifest.name).localeCompare(b.manifest.displayName || b.manifest.name));

            plugins.forEach(plugin => {
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = plugin.manifest.displayName || plugin.manifest.name;
                a.dataset.target = `plugin-${plugin.manifest.name}-config`;
                a.dataset.pluginName = plugin.manifest.name;
                li.appendChild(a);
                pluginNavList.appendChild(li);

                const pluginSection = document.createElement('section');
                pluginSection.id = `plugin-${plugin.manifest.name}-config-section`;
                pluginSection.className = 'config-section';
                
                let descriptionHtml = plugin.manifest.description || '暂无描述';
                if (plugin.manifest.version) descriptionHtml += ` (版本: ${plugin.manifest.version})`;
                if (!plugin.enabled) descriptionHtml += ' <span class="plugin-disabled-badge">(已禁用)</span>';


                pluginSection.innerHTML = `<h2>${plugin.manifest.displayName || plugin.manifest.name} 配置 ${!plugin.enabled ? '<span class="plugin-disabled-badge-title">(已禁用)</span>':''}</h2>
                                           <p class="plugin-meta">${descriptionHtml}</p>`;
                
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
        const newConfigString = buildEnvStringForPlugin(form, currentPluginEntries);

        try {
            await apiFetch(`${API_BASE_URL}/plugins/${pluginName}/config`, {
                method: 'POST',
                body: JSON.stringify({ content: newConfigString })
            });
            showMessage(`${pluginName} 配置已保存！更改可能需要重启插件或服务生效。`, 'success');
            loadPluginConfig(pluginName); // Reload to reflect changes
        } catch (error) { /* Error handled by apiFetch */ }
    }

    function buildEnvStringForPlugin(formElement, originalParsedEntries) {
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
        if (input.type !== 'checkbox') { // Checkbox already appended inside switchContainer
            group.appendChild(input);
        }
        
        return group;
    }


    function navigateTo(targetId, pluginName = null) {
        document.querySelectorAll('.sidebar nav li a').forEach(link => link.classList.remove('active'));
        document.querySelectorAll('.config-section').forEach(section => section.classList.remove('active-section'));

        const activeLink = pluginNavList.querySelector(`a[data-target="${targetId}"]`);
        if (activeLink) activeLink.classList.add('active');

        const targetSection = document.getElementById(`${targetId}-section`);
        if (targetSection) {
            targetSection.classList.add('active-section');
            if (pluginName) {
                loadPluginConfig(pluginName).catch(err => console.error(`Failed to load config for ${pluginName}`, err));
            } else if (targetId === 'base-config') {
                // loadBaseConfig(); // Already loaded initially, and on save. Only reload if necessary.
            }
        }
    }

    pluginNavList.addEventListener('click', (event) => {
        const anchor = event.target.closest('a');
        if (anchor) {
            event.preventDefault();
            const targetId = anchor.dataset.target;
            const pluginName = anchor.dataset.pluginName;
            navigateTo(targetId, pluginName);
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
});