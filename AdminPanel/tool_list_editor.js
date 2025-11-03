// tool_list_editor.js

(function() {
    'use strict';

    // API基础URL
    const API_BASE = '/admin_api';
    
    // 状态
    let allTools = []; // 所有可用工具
    let selectedTools = new Set(); // 已选择的工具名称
    let toolDescriptions = {}; // 自定义工具描述（工具名 -> 描述文本）
    let currentConfigFile = null; // 当前配置文件名
    let availableConfigs = []; // 可用的配置文件列表
    let toolItemsCache = new Map(); // DOM缓存：uniqueId -> DOM元素
    let visiblePlugins = new Set(); // 可见的插件名称

    // DOM元素
    const elements = {
        configSelect: document.getElementById('config-file-select'),
        newConfigInput: document.getElementById('new-config-name'),
        loadConfigBtn: document.getElementById('load-config-btn'),
        createConfigBtn: document.getElementById('create-config-btn'),
        deleteConfigBtn: document.getElementById('delete-config-btn'),
        saveConfigBtn: document.getElementById('save-config-btn'),
        exportTxtBtn: document.getElementById('export-txt-btn'),
        configStatus: document.getElementById('config-status'),
        
        toolSearch: document.getElementById('tool-search'),
        showSelectedOnly: document.getElementById('show-selected-only'),
        selectAllBtn: document.getElementById('select-all-btn'),
        deselectAllBtn: document.getElementById('deselect-all-btn'),
        
        toolsList: document.getElementById('tools-list'),
        toolCount: document.getElementById('tool-count'),
        
        includeHeader: document.getElementById('include-header'),
        includeExamples: document.getElementById('include-examples'),
        copyPreviewBtn: document.getElementById('copy-preview-btn'),
        previewOutput: document.getElementById('preview-output'),
        
        loadingOverlay: document.getElementById('loading-overlay')
    };

    // 初始化
    async function init() {
        showLoading(true);
        try {
            await loadAvailableTools();
            await loadAvailableConfigs();
            renderPluginFilterList();
            attachEventListeners();
            updateToolCount();
            updatePreview();
        } catch (error) {
            console.error('初始化失败:', error);
            showStatus('初始化失败: ' + error.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    // 加载所有可用工具
    async function loadAvailableTools() {
        try {
            const response = await fetch(`${API_BASE}/tool-list-editor/tools`);
            if (!response.ok) throw new Error('获取工具列表失败');
            const data = await response.json();
            allTools = data.tools || [];
            
            // 标记无效工具，但不过滤掉（方便用户检查）
            allTools.forEach((tool, index) => {
                if (!tool || !tool.pluginName || !tool.name) {
                    console.warn('发现无效工具数据:', tool);
                    tool.isInvalid = true;
                    // 为无效工具设置默认值
                    tool.pluginName = tool.pluginName || '未知插件';
                    tool.name = tool.name || `无效工具_${index}`;
                    tool.description = '⚠️ 此工具数据不完整，请检查插件配置';
                } else {
                    tool.isInvalid = false;
                }
            });
            
            // 为每个工具生成唯一ID，使用更稳定的方式
            // 使用计数器处理同插件同名的情况
            const nameCounters = new Map();
            allTools.forEach(tool => {
                const baseId = `${tool.pluginName}__${tool.name}`;
                const count = nameCounters.get(baseId) || 0;
                tool.uniqueId = count === 0 ? baseId : `${baseId}__${count}`;
                nameCounters.set(baseId, count + 1);
            });
            
            renderToolsList();
        } catch (error) {
            console.error('加载工具列表失败:', error);
            throw error;
        }
    }

    // 加载可用的配置文件列表
    async function loadAvailableConfigs() {
        try {
            const response = await fetch(`${API_BASE}/tool-list-editor/configs`);
            if (!response.ok) throw new Error('获取配置文件列表失败');
            const data = await response.json();
            availableConfigs = data.configs || [];
            renderConfigSelect();
        } catch (error) {
            console.error('加载配置文件列表失败:', error);
            // 非关键错误，不抛出
        }
    }

    // 渲染配置文件下拉列表
    function renderConfigSelect() {
        // 保留"新建"选项
        elements.configSelect.innerHTML = '<option value="">-- 新建配置文件 --</option>';
        availableConfigs.forEach(config => {
            const option = document.createElement('option');
            option.value = config;
            option.textContent = config;
            elements.configSelect.appendChild(option);
        });
    }

    // 渲染工具列表
    function renderToolsList() {
        elements.toolsList.innerHTML = '';
        toolItemsCache.clear(); // 清空DOM缓存
        
        if (allTools.length === 0) {
            elements.toolsList.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--text-color-secondary);">暂无可用工具</p>';
            return;
        }

        // 按插件分组工具，同时区分有效和无效工具
        const validToolsByPlugin = {};
        const invalidToolsByPlugin = {};
        
        allTools.forEach(tool => {
            const pluginName = tool.pluginName;
            const targetMap = tool.isInvalid ? invalidToolsByPlugin : validToolsByPlugin;
            
            if (!targetMap[pluginName]) {
                targetMap[pluginName] = [];
            }
            targetMap[pluginName].push(tool);
        });

        // 先显示有效插件（按插件名排序）
        const sortedValidPluginNames = Object.keys(validToolsByPlugin).sort((a, b) => a.localeCompare(b));
        sortedValidPluginNames.forEach(pluginName => {
            const pluginTools = validToolsByPlugin[pluginName];
            const pluginGroup = createPluginGroupElement(pluginName, pluginTools, false);
            elements.toolsList.appendChild(pluginGroup);
        });
        
        // 再显示无效插件（放在最后，方便用户检查）
        const sortedInvalidPluginNames = Object.keys(invalidToolsByPlugin).sort((a, b) => a.localeCompare(b));
        if (sortedInvalidPluginNames.length > 0) {
            // 添加分隔符
            const separator = document.createElement('div');
            separator.className = 'invalid-tools-separator';
            separator.innerHTML = '<span>⚠️ 以下工具数据不完整，请检查插件配置 ⚠️</span>';
            elements.toolsList.appendChild(separator);
            
            sortedInvalidPluginNames.forEach(pluginName => {
                const pluginTools = invalidToolsByPlugin[pluginName];
                const pluginGroup = createPluginGroupElement(pluginName, pluginTools, true);
                elements.toolsList.appendChild(pluginGroup);
            });
        }
    }

    // 创建插件分组元素
    function createPluginGroupElement(pluginName, tools, isInvalid = false) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'plugin-group' + (isInvalid ? ' invalid-plugin-group' : '');
        groupDiv.dataset.pluginName = pluginName;

        // 创建分组头部
        const header = document.createElement('div');
        header.className = 'plugin-group-header' + (isInvalid ? ' invalid-plugin-header' : '');
        
        // 插件名称 (使用第一个工具的displayName作为插件显示名)
        const pluginDisplayName = tools.length > 0 ? tools[0].displayName : pluginName;
        const icon = isInvalid ? '⚠️' : '📦';
        
        // 检查这个插件下所有工具是否都已选中
        const allSelected = tools.every(tool => selectedTools.has(tool.uniqueId));
        const someSelected = tools.some(tool => selectedTools.has(tool.uniqueId));
        
        header.innerHTML = `
            <span class="plugin-group-icon">${icon}</span>
            <span class="plugin-group-name">${pluginDisplayName}</span>
            <span class="plugin-group-original-name">(${pluginName})</span>
            <span class="plugin-group-count">${tools.length} 个工具</span>
            <button class="btn-select-all-plugin" data-plugin="${pluginName}" title="${allSelected ? '取消全选' : '全选此插件'}">
                ${allSelected ? '✓ 已全选' : (someSelected ? '◐ 部分选中' : '☐ 全选')}
            </button>
        `;
        
        // 创建工具列表容器
        const toolsContainer = document.createElement('div');
        toolsContainer.className = 'plugin-tools-container';
        
        // 为每个工具创建项目
        tools.forEach(tool => {
            const toolItem = createToolItemElement(tool);
            toolsContainer.appendChild(toolItem);
        });
        
        groupDiv.appendChild(header);
        groupDiv.appendChild(toolsContainer);
        
        return groupDiv;
    }

    // 创建工具项元素
    function createToolItemElement(tool) {
        const isSelected = selectedTools.has(tool.uniqueId);
        
        const div = document.createElement('div');
        div.className = 'tool-item' + (isSelected ? ' selected' : '');
        div.dataset.toolId = tool.uniqueId;
        div.dataset.toolName = tool.name; // 保留原始name作为备用
        
        // 缓存DOM元素
        toolItemsCache.set(tool.uniqueId, div);
        
        // 头部（复选框 + 工具名称）
        const header = document.createElement('div');
        header.className = 'tool-header';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'tool-checkbox';
        checkbox.checked = isSelected;
        checkbox.dataset.toolId = tool.uniqueId; // 存储uniqueId用于事件委托
        
        const info = document.createElement('div');
        info.className = 'tool-info';
        
        const name = document.createElement('div');
        name.className = 'tool-name';
        name.textContent = tool.displayName || tool.name;
        
        const pluginName = document.createElement('div');
        pluginName.className = 'tool-plugin-name';
        pluginName.textContent = `插件: ${tool.pluginName}`;
        
        info.appendChild(name);
        info.appendChild(pluginName);
        header.appendChild(checkbox);
        header.appendChild(info);
        
        // 描述区域
        const description = document.createElement('div');
        description.className = 'tool-description';
        const currentDesc = toolDescriptions[tool.name] || tool.description || '暂无描述';
        description.textContent = currentDesc.substring(0, 200) + (currentDesc.length > 200 ? '...' : '');
        
        // 操作按钮
        const actions = document.createElement('div');
        actions.className = 'tool-actions';
        
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-tool-btn';
        editBtn.textContent = '编辑说明';
        editBtn.dataset.toolId = tool.uniqueId; // 存储uniqueId用于事件委托
        
        const viewBtn = document.createElement('button');
        viewBtn.className = 'view-tool-btn';
        viewBtn.textContent = '查看完整说明';
        viewBtn.dataset.toolId = tool.uniqueId; // 存储uniqueId用于事件委托
        
        actions.appendChild(editBtn);
        actions.appendChild(viewBtn);
        
        div.appendChild(header);
        div.appendChild(description);
        div.appendChild(actions);
        
        return div;
    }

    // 切换工具选择
    function toggleToolSelection(uniqueId) {
        if (!uniqueId) {
            console.warn('toggleToolSelection: uniqueId 不能为空');
            return;
        }
        
        // 找到对应的工具对象，获取其插件名
        const tool = allTools.find(t => t.uniqueId === uniqueId);
        const pluginName = tool ? tool.pluginName : null;
        
        if (selectedTools.has(uniqueId)) {
            selectedTools.delete(uniqueId);
        } else {
            selectedTools.add(uniqueId);
        }
        
        // 使用缓存的DOM元素
        const toolItem = toolItemsCache.get(uniqueId);
        if (toolItem) {
            const checkbox = toolItem.querySelector('.tool-checkbox');
            if (checkbox) {
                checkbox.checked = selectedTools.has(uniqueId);
            }
            toolItem.classList.toggle('selected', selectedTools.has(uniqueId));
        }
        
        // 更新该插件的全选按钮状态
        if (pluginName) {
            updatePluginSelectButton(pluginName);
        }
        
        // 更新插件过滤列表中的选中数量
        updatePluginFilterCounts();
        
        updateToolCount();
        updatePreview();
        enableSaveButtons();
    }
    
    // 更新插件全选按钮的状态
    function updatePluginSelectButton(pluginName) {
        if (!pluginName) return;
        
        // 找到该插件的分组元素
        const pluginGroup = elements.toolsList.querySelector(`.plugin-group[data-plugin-name="${pluginName}"]`);
        if (!pluginGroup) return;
        
        // 找到该插件下的所有工具
        const pluginTools = allTools.filter(tool => tool.pluginName === pluginName);
        if (pluginTools.length === 0) return;
        
        // 检查选择状态
        const allSelected = pluginTools.every(tool => selectedTools.has(tool.uniqueId));
        const someSelected = pluginTools.some(tool => selectedTools.has(tool.uniqueId));
        
        // 更新按钮文本和title
        const button = pluginGroup.querySelector('.btn-select-all-plugin');
        if (button) {
            if (allSelected) {
                button.textContent = '✓ 已全选';
                button.title = '取消全选';
            } else if (someSelected) {
                button.textContent = '◐ 部分选中';
                button.title = '全选此插件';
            } else {
                button.textContent = '☐ 全选';
                button.title = '全选此插件';
            }
        }
    }
    
    // 切换插件下所有工具的选择状态
    function togglePluginSelection(pluginName) {
        if (!pluginName) {
            console.warn('togglePluginSelection: pluginName 不能为空');
            return;
        }
        
        // 找到该插件下的所有工具
        const pluginTools = allTools.filter(tool => tool.pluginName === pluginName);
        if (pluginTools.length === 0) {
            return;
        }
        
        // 检查是否全部已选中
        const allSelected = pluginTools.every(tool => selectedTools.has(tool.uniqueId));
        
        // 如果全部已选中，则取消全选；否则全选
        pluginTools.forEach(tool => {
            if (allSelected) {
                selectedTools.delete(tool.uniqueId);
            } else {
                selectedTools.add(tool.uniqueId);
            }
            
            // 更新DOM
            const toolItem = toolItemsCache.get(tool.uniqueId);
            if (toolItem) {
                const checkbox = toolItem.querySelector('.tool-checkbox');
                if (checkbox) {
                    checkbox.checked = selectedTools.has(tool.uniqueId);
                }
                toolItem.classList.toggle('selected', selectedTools.has(tool.uniqueId));
            }
        });
        
        // 重新渲染以更新按钮状态
        renderToolsList();
        updatePluginFilterCounts(); // 更新插件过滤列表的选中数量
        updateToolCount();
        updatePreview();
        enableSaveButtons();
    }

    // 编辑工具说明 - 修改为展开小窗形式
    function editToolDescription(tool) {
        if (!tool || !tool.uniqueId) {
            console.warn('editToolDescription: 无效的工具对象');
            return;
        }
        
        const toolItem = toolItemsCache.get(tool.uniqueId);
        if (!toolItem) {
            console.warn('editToolDescription: 未找到工具项DOM元素');
            return;
        }
        
        // 检查是否已经有编辑器展开
        let editor = toolItem.querySelector('.inline-editor-panel');
        if (editor) {
            // 如果已展开，则关闭
            editor.remove();
            return;
        }
        
        const currentDesc = toolDescriptions[tool.name] || tool.description || '';
        
        // 创建内联编辑器面板
        editor = document.createElement('div');
        editor.className = 'inline-editor-panel';
        
        const title = document.createElement('div');
        title.className = 'inline-editor-title';
        title.textContent = `✏️ 编辑工具说明: ${tool.displayName || tool.name}`;
        
        const textarea = document.createElement('textarea');
        textarea.className = 'inline-editor-textarea';
        textarea.value = currentDesc;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'inline-editor-actions';
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save-inline';
        saveBtn.textContent = '💾 保存';
        // 事件通过事件委托处理，不需要在这里添加监听器
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel-inline';
        cancelBtn.textContent = '✖ 取消';
        // 事件通过事件委托处理，不需要在这里添加监听器
        
        actionsDiv.appendChild(saveBtn);
        actionsDiv.appendChild(cancelBtn);
        
        editor.appendChild(title);
        editor.appendChild(textarea);
        editor.appendChild(actionsDiv);
        
        // 将编辑器插入到工具项中
        toolItem.appendChild(editor);
        textarea.focus();
        
        // 滚动到编辑器位置
        setTimeout(() => {
            editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }

    // 查看完整说明 - 修改为展开小窗形式
    function viewFullDescription(tool) {
        if (!tool || !tool.uniqueId) {
            console.warn('viewFullDescription: 无效的工具对象');
            return;
        }
        
        const toolItem = toolItemsCache.get(tool.uniqueId);
        if (!toolItem) {
            console.warn('viewFullDescription: 未找到工具项DOM元素');
            return;
        }
        
        // 检查是否已经有查看器展开
        let viewer = toolItem.querySelector('.inline-viewer-panel');
        if (viewer) {
            // 如果已展开，则关闭
            viewer.remove();
            return;
        }
        
        const currentDesc = toolDescriptions[tool.name] || tool.description || '暂无描述';
        
        // 创建内联查看器面板
        viewer = document.createElement('div');
        viewer.className = 'inline-viewer-panel';
        
        const title = document.createElement('div');
        title.className = 'inline-viewer-title';
        title.textContent = `📄 完整说明: ${tool.displayName || tool.name}`;
        
        const content = document.createElement('div');
        content.className = 'inline-viewer-content';
        content.textContent = currentDesc;
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close-inline';
        closeBtn.textContent = '✖ 关闭';
        // 事件通过事件委托处理，不需要在这里添加监听器
        
        viewer.appendChild(title);
        viewer.appendChild(content);
        viewer.appendChild(closeBtn);
        
        // 将查看器插入到工具项中
        toolItem.appendChild(viewer);
        
        // 滚动到查看器位置
        setTimeout(() => {
            viewer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }

    // 更新工具计数
    function updateToolCount() {
        const total = allTools.length;
        const selected = selectedTools.size;
        elements.toolCount.textContent = `(总计: ${total}, 已选择: ${selected})`;
    }

    // 更新预览
    function updatePreview() {
        if (selectedTools.size === 0) {
            elements.previewOutput.value = '请先从左侧选择要包含的工具...';
            return;
        }

        const includeHeader = elements.includeHeader.checked;
        const includeExamples = elements.includeExamples.checked;
        
        let output = '';
        
        // 添加头部说明
        if (includeHeader) {
            output += 'VCP工具调用格式与指南\n\n';
            output += '<<<[TOOL_REQUEST]>>>\n';
            output += 'maid:「始」你的署名「末」, //重要字段，以进行任务追踪\n';
            output += 'tool_name:「始」工具名「末」, //必要字段\n';
            output += 'arg:「始」工具参数「末」, //具体视不同工具需求而定\n';
            output += '<<<[END_TOOL_REQUEST]>>>\n\n';
            output += '使用「始」「末」包裹参数来兼容富文本识别。\n';
            output += '主动判断当前需求，灵活使用各类工具调用。\n\n';
            output += '========================================\n\n';
        }
        
        // 获取所有选中的工具
        const selectedToolsList = allTools.filter(tool => selectedTools.has(tool.uniqueId));
        
        // 按插件分组工具，以节省Tokens
        const toolsByPlugin = {};
        selectedToolsList.forEach(tool => {
            if (!toolsByPlugin[tool.pluginName]) {
                toolsByPlugin[tool.pluginName] = [];
            }
            toolsByPlugin[tool.pluginName].push(tool);
        });
        
        // 按插件名排序
        const sortedPluginNames = Object.keys(toolsByPlugin).sort((a, b) => a.localeCompare(b));
        
        // 为每个插件生成说明
        let pluginIndex = 0;
        sortedPluginNames.forEach(pluginName => {
            pluginIndex++;
            const pluginTools = toolsByPlugin[pluginName];
            
            // 获取插件显示名称（使用第一个工具的displayName）
            const pluginDisplayName = pluginTools[0].displayName || pluginName;
            
            // 如果该插件只有一个工具
            if (pluginTools.length === 1) {
                const tool = pluginTools[0];
                const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';
                
                output += `${pluginIndex}. ${pluginDisplayName} (${tool.name})\n`;
                output += `插件: ${pluginName}\n`;
                output += `说明: ${desc}\n`;
                
                if (includeExamples && tool.example) {
                    output += `\n示例:\n${tool.example}\n`;
                }
            } else {
                // 如果该插件有多个工具，合并显示
                output += `${pluginIndex}. ${pluginDisplayName}\n`;
                output += `插件: ${pluginName}\n`;
                output += `该插件包含 ${pluginTools.length} 个工具调用:\n\n`;
                
                pluginTools.forEach((tool, toolIdx) => {
                    const desc = toolDescriptions[tool.name] || tool.description || '暂无描述';
                    
                    output += `  ${pluginIndex}.${toolIdx + 1} ${tool.name}\n`;
                    
                    // 处理说明部分，保持原有的多行格式
                    const descLines = desc.split('\n');
                    descLines.forEach((line, lineIdx) => {
                        if (lineIdx === 0) {
                            output += `  说明: ${line}\n`;
                        } else {
                            output += `  ${line}\n`;
                        }
                    });
                    
                    if (includeExamples && tool.example) {
                        output += `\n`;
                        // 将示例内容缩进
                        const exampleLines = tool.example.split('\n');
                        exampleLines.forEach(line => {
                            output += `  ${line}\n`;
                        });
                    }
                    
                    if (toolIdx < pluginTools.length - 1) {
                        output += '\n';
                    }
                });
            }
            
            output += '\n' + '----------------------------------------' + '\n\n';
        });
        
        elements.previewOutput.value = output;
    }

    // 启用保存按钮
    function enableSaveButtons() {
        elements.saveConfigBtn.disabled = !currentConfigFile;
        elements.exportTxtBtn.disabled = selectedTools.size === 0;
    }

    // 附加事件监听器
    function attachEventListeners() {
        // 配置文件管理
        elements.configSelect.addEventListener('change', () => {
            const value = elements.configSelect.value;
            if (value === '') {
                elements.newConfigInput.style.display = 'inline-block';
                elements.deleteConfigBtn.disabled = true;
                currentConfigFile = null;
            } else {
                elements.newConfigInput.style.display = 'none';
                elements.deleteConfigBtn.disabled = false;
            }
            enableSaveButtons();
        });
        
        elements.loadConfigBtn.addEventListener('click', loadConfig);
        elements.createConfigBtn.addEventListener('click', createNewConfig);
        elements.deleteConfigBtn.addEventListener('click', deleteConfig);
        elements.saveConfigBtn.addEventListener('click', saveConfig);
        elements.exportTxtBtn.addEventListener('click', exportToTxt);
        
        // 过滤和搜索
        elements.toolSearch.addEventListener('input', filterTools);
        elements.showSelectedOnly.addEventListener('change', filterTools);
        elements.selectAllBtn.addEventListener('click', selectAll);
        elements.deselectAllBtn.addEventListener('click', deselectAll);
        
        // 预览控制
        elements.includeHeader.addEventListener('change', updatePreview);
        elements.includeExamples.addEventListener('change', updatePreview);
        elements.copyPreviewBtn.addEventListener('click', copyPreview);
        
        // 使用事件委托处理工具列表中的事件
        elements.toolsList.addEventListener('click', handleToolsListClick);
        elements.toolsList.addEventListener('change', handleToolsListChange);
    }
    
    // 处理工具列表的点击事件（事件委托）
    function handleToolsListClick(e) {
        const target = e.target;
        
        // 处理插件全选/取消全选按钮
        if (target.classList.contains('btn-select-all-plugin')) {
            const pluginName = target.dataset.plugin;
            if (pluginName) {
                togglePluginSelection(pluginName);
            }
            e.stopPropagation(); // 防止触发头部的其他事件
            return;
        }
        
        // 处理编辑按钮
        if (target.classList.contains('edit-tool-btn')) {
            const uniqueId = target.dataset.toolId;
            if (uniqueId) {
                const tool = allTools.find(t => t.uniqueId === uniqueId);
                if (tool) {
                    editToolDescription(tool);
                }
            }
            return;
        }
        
        // 处理查看按钮
        if (target.classList.contains('view-tool-btn')) {
            const uniqueId = target.dataset.toolId;
            if (uniqueId) {
                const tool = allTools.find(t => t.uniqueId === uniqueId);
                if (tool) {
                    viewFullDescription(tool);
                }
            }
            return;
        }
        
        // 处理内联编辑器的保存按钮
        if (target.classList.contains('btn-save-inline')) {
            const panel = target.closest('.inline-editor-panel');
            if (panel) {
                const toolItem = panel.closest('.tool-item');
                if (toolItem) {
                    const uniqueId = toolItem.dataset.toolId;
                    const tool = allTools.find(t => t.uniqueId === uniqueId);
                    if (tool) {
                        const textarea = panel.querySelector('.inline-editor-textarea');
                        toolDescriptions[tool.name] = textarea.value;
                        
                        // 更新工具项显示
                        const descDiv = toolItem.querySelector('.tool-description');
                        const newDesc = textarea.value;
                        descDiv.textContent = newDesc.substring(0, 200) + (newDesc.length > 200 ? '...' : '');
                        
                        panel.remove();
                        updatePreview();
                        enableSaveButtons();
                    }
                }
            }
            return;
        }
        
        // 处理取消按钮
        if (target.classList.contains('btn-cancel-inline') || target.classList.contains('btn-close-inline')) {
            const panel = target.closest('.inline-editor-panel, .inline-viewer-panel');
            if (panel) {
                panel.remove();
            }
            return;
        }
    }
    
    // 处理工具列表的change事件（事件委托）
    function handleToolsListChange(e) {
        const target = e.target;
        
        // 处理复选框变化
        if (target.classList.contains('tool-checkbox')) {
            const uniqueId = target.dataset.toolId;
            if (uniqueId) {
                toggleToolSelection(uniqueId);
            }
        }
    }

    // 加载配置
    async function loadConfig() {
        const configName = elements.configSelect.value;
        if (!configName) {
            showStatus('请选择一个配置文件', 'error');
            return;
        }

        showLoading(true);
        try {
            const response = await fetch(`${API_BASE}/tool-list-editor/config/${encodeURIComponent(configName)}`);
            if (!response.ok) throw new Error('加载配置失败');
            const data = await response.json();
            
            currentConfigFile = configName;
            
            // 将保存的tool names转换为uniqueIds
            const savedToolNames = new Set(data.selectedTools || []);
            selectedTools = new Set();
            allTools.forEach(tool => {
                if (savedToolNames.has(tool.name)) {
                    selectedTools.add(tool.uniqueId);
                }
            });
            
            toolDescriptions = data.toolDescriptions || {};
            
            // 重新渲染工具列表以反映选择状态
            renderToolsList();
            updatePluginFilterCounts(); // 更新插件过滤列表的选中数量
            updateToolCount();
            updatePreview();
            enableSaveButtons();
            
            showStatus('配置已加载', 'success');
        } catch (error) {
            console.error('加载配置失败:', error);
            showStatus('加载配置失败: ' + error.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    // 创建新配置 - 修改为展开小窗形式
    async function createNewConfig() {
        // 检查是否已经有表单展开
        let existingForm = document.querySelector('.inline-form-panel');
        if (existingForm) {
            existingForm.remove();
            return;
        }
        
        // 创建内联表单面板
        const formPanel = document.createElement('div');
        formPanel.className = 'inline-form-panel';
        
        const title = document.createElement('div');
        title.className = 'inline-form-title';
        title.textContent = '📝 创建新配置文件';
        
        const description = document.createElement('div');
        description.className = 'inline-form-description';
        description.textContent = '请输入配置文件名（只能包含字母、数字、下划线和横线）';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-form-input';
        input.placeholder = '例如: my_tools_config';
        input.maxLength = 50;
        
        const errorMsg = document.createElement('div');
        errorMsg.className = 'inline-form-error';
        errorMsg.style.display = 'none';
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'inline-form-actions';
        
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn-confirm-inline';
        confirmBtn.textContent = '✓ 创建';
        confirmBtn.addEventListener('click', async () => {
            const configName = input.value.trim();
            
            if (!configName) {
                errorMsg.textContent = '❌ 配置文件名不能为空';
                errorMsg.style.display = 'block';
                input.focus();
                return;
            }

            if (!/^[a-zA-Z0-9_-]+$/.test(configName)) {
                errorMsg.textContent = '❌ 配置文件名只能包含字母、数字、下划线和横线';
                errorMsg.style.display = 'block';
                input.focus();
                return;
            }
            
            // 检查是否已存在
            if (availableConfigs.includes(configName)) {
                // 显示覆盖确认
                errorMsg.textContent = `⚠️ 配置文件 "${configName}" 已存在`;
                errorMsg.style.display = 'block';
                errorMsg.style.color = '#f59e0b';
                
                // 如果确认按钮已经变成了覆盖按钮，则执行覆盖
                if (confirmBtn.dataset.confirmOverwrite === 'true') {
                    // 执行创建
                    executeCreateConfig(configName);
                    formPanel.remove();
                } else {
                    // 修改按钮为确认覆盖
                    confirmBtn.textContent = '⚠️ 确认覆盖';
                    confirmBtn.dataset.confirmOverwrite = 'true';
                    confirmBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
                }
                return;
            }

            // 执行创建
            executeCreateConfig(configName);
            formPanel.remove();
        });
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel-inline';
        cancelBtn.textContent = '✖ 取消';
        cancelBtn.addEventListener('click', () => {
            formPanel.remove();
        });
        
        // 输入框变化时重置错误状态和按钮
        input.addEventListener('input', () => {
            errorMsg.style.display = 'none';
            confirmBtn.textContent = '✓ 创建';
            confirmBtn.dataset.confirmOverwrite = 'false';
            confirmBtn.style.background = '';
        });
        
        // 回车键提交
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            }
        });
        
        actionsDiv.appendChild(confirmBtn);
        actionsDiv.appendChild(cancelBtn);
        
        formPanel.appendChild(title);
        formPanel.appendChild(description);
        formPanel.appendChild(input);
        formPanel.appendChild(errorMsg);
        formPanel.appendChild(actionsDiv);
        
        // 将表单插入到配置管理区域
        const configManager = document.querySelector('.config-manager');
        configManager.appendChild(formPanel);
        input.focus();
        
        // 滚动到表单位置
        setTimeout(() => {
            formPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }
    
    // 执行创建配置的实际操作
    function executeCreateConfig(configName) {
        currentConfigFile = configName;
        selectedTools = new Set();
        toolDescriptions = {};
        
        renderToolsList();
        updateToolCount();
        updatePreview();
        enableSaveButtons();
        
        // 更新下拉框显示当前配置
        if (!availableConfigs.includes(configName)) {
            availableConfigs.push(configName);
            renderConfigSelect();
        }
        elements.configSelect.value = configName;
        
        showStatus('已创建新配置: ' + configName + ' (请记得点击保存)', 'success');
    }

    // 删除配置 - 修改为展开小窗形式
    async function deleteConfig() {
        const configName = elements.configSelect.value;
        if (!configName) return;

        // 检查是否已经有确认面板展开
        let existingPanel = document.querySelector('.inline-confirm-panel');
        if (existingPanel) {
            existingPanel.remove();
            return;
        }
        
        // 创建内联确认面板
        const confirmPanel = document.createElement('div');
        confirmPanel.className = 'inline-confirm-panel';
        
        const title = document.createElement('div');
        title.className = 'inline-confirm-title';
        title.textContent = '⚠️ 确认删除配置';
        
        const message = document.createElement('div');
        message.className = 'inline-confirm-message';
        message.innerHTML = `您确定要删除配置文件 <strong>"${configName}"</strong> 吗？<br>此操作不可恢复！`;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'inline-confirm-actions';
        
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn-danger-confirm';
        confirmBtn.textContent = '🗑️ 确认删除';
        confirmBtn.addEventListener('click', async () => {
            confirmPanel.remove();
            await executeDeleteConfig(configName);
        });
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel-inline';
        cancelBtn.textContent = '✖ 取消';
        cancelBtn.addEventListener('click', () => {
            confirmPanel.remove();
        });
        
        actionsDiv.appendChild(confirmBtn);
        actionsDiv.appendChild(cancelBtn);
        
        confirmPanel.appendChild(title);
        confirmPanel.appendChild(message);
        confirmPanel.appendChild(actionsDiv);
        
        // 将确认面板插入到配置管理区域
        const configManager = document.querySelector('.config-manager');
        configManager.appendChild(confirmPanel);
        
        // 滚动到确认面板位置
        setTimeout(() => {
            confirmPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }
    
    // 执行删除配置的实际操作
    async function executeDeleteConfig(configName) {
        showLoading(true);
        try {
            const response = await fetch(`${API_BASE}/tool-list-editor/config/${encodeURIComponent(configName)}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('删除配置失败');
            
            await loadAvailableConfigs();
            
            // 重置当前状态
            if (currentConfigFile === configName) {
                currentConfigFile = null;
                selectedTools = new Set();
                toolDescriptions = {};
                renderToolsList();
                updateToolCount();
                updatePreview();
                enableSaveButtons();
            }
            
            elements.configSelect.value = '';
            elements.deleteConfigBtn.disabled = true;
            
            showStatus('配置已删除', 'success');
        } catch (error) {
            console.error('删除配置失败:', error);
            showStatus('删除配置失败: ' + error.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    // 保存配置
    async function saveConfig() {
        if (!currentConfigFile) {
            showStatus('请先选择或创建一个配置文件', 'error');
            return;
        }

        showLoading(true);
        try {
            // 将uniqueIds转换回tool names进行保存
            const selectedToolNames = [];
            selectedTools.forEach(uniqueId => {
                const tool = allTools.find(t => t.uniqueId === uniqueId);
                if (tool) {
                    selectedToolNames.push(tool.name);
                }
            });
            
            const configData = {
                selectedTools: selectedToolNames,
                toolDescriptions: toolDescriptions
            };

            const response = await fetch(`${API_BASE}/tool-list-editor/config/${encodeURIComponent(currentConfigFile)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
            
            if (!response.ok) throw new Error('保存配置失败');
            
            await loadAvailableConfigs();
            
            // 更新下拉列表选中项
            elements.configSelect.value = currentConfigFile;
            
            showStatus('配置已保存', 'success');
        } catch (error) {
            console.error('保存配置失败:', error);
            showStatus('保存配置失败: ' + error.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    // 导出为txt文件 - 修改为展开小窗形式
    async function exportToTxt() {
        if (selectedTools.size === 0) {
            showStatus('请先选择至少一个工具', 'error');
            return;
        }

        // 检查是否已经有表单展开
        let existingForm = document.querySelector('.inline-form-panel');
        if (existingForm) {
            existingForm.remove();
            return;
        }
        
        // 创建内联表单面板
        const formPanel = document.createElement('div');
        formPanel.className = 'inline-form-panel';
        
        const title = document.createElement('div');
        title.className = 'inline-form-title';
        title.textContent = '📤 导出工具列表到TXT';
        
        const description = document.createElement('div');
        description.className = 'inline-form-description';
        description.textContent = '请输入要导出的文件名（不含.txt后缀）';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-form-input';
        input.placeholder = '例如: ToolList';
        input.value = currentConfigFile || 'ToolList';
        input.maxLength = 50;
        
        const errorMsg = document.createElement('div');
        errorMsg.className = 'inline-form-error';
        errorMsg.style.display = 'none';
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'inline-form-actions';
        
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn-confirm-inline';
        confirmBtn.textContent = '📤 导出';
        confirmBtn.addEventListener('click', async () => {
            const fileName = input.value.trim();
            
            if (!fileName) {
                errorMsg.textContent = '❌ 文件名不能为空';
                errorMsg.style.display = 'block';
                input.focus();
                return;
            }

            if (!/^[a-zA-Z0-9_-]+$/.test(fileName)) {
                errorMsg.textContent = '❌ 文件名只能包含字母、数字、下划线和横线';
                errorMsg.style.display = 'block';
                input.focus();
                return;
            }
            
            // 检查文件是否存在
            try {
                const checkResponse = await fetch(`${API_BASE}/tool-list-editor/check-file/${encodeURIComponent(fileName)}`);
                if (!checkResponse.ok) {
                    throw new Error('检查文件失败');
                }
                const checkResult = await checkResponse.json();
                
                if (checkResult.exists) {
                    // 文件已存在，显示覆盖确认
                    errorMsg.textContent = `⚠️ 文件 "${fileName}.txt" 已存在`;
                    errorMsg.style.display = 'block';
                    errorMsg.style.color = '#f59e0b';
                    
                    // 如果确认按钮已经变成了覆盖按钮，则执行覆盖
                    if (confirmBtn.dataset.confirmOverwrite === 'true') {
                        // 执行导出
                        formPanel.remove();
                        await executeExportToTxt(fileName);
                    } else {
                        // 修改按钮为确认覆盖
                        confirmBtn.textContent = '⚠️ 确认覆盖';
                        confirmBtn.dataset.confirmOverwrite = 'true';
                        confirmBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
                    }
                    return;
                }
            } catch (checkError) {
                console.error('检查文件失败:', checkError);
                // 如果检查失败，继续导出（降级处理）
            }
            
            // 文件不存在，直接导出
            formPanel.remove();
            await executeExportToTxt(fileName);
        });
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel-inline';
        cancelBtn.textContent = '✖ 取消';
        cancelBtn.addEventListener('click', () => {
            formPanel.remove();
        });
        
        // 输入框变化时重置错误状态
        input.addEventListener('input', () => {
            errorMsg.style.display = 'none';
        });
        
        // 回车键提交
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            }
        });
        
        actionsDiv.appendChild(confirmBtn);
        actionsDiv.appendChild(cancelBtn);
        
        formPanel.appendChild(title);
        formPanel.appendChild(description);
        formPanel.appendChild(input);
        formPanel.appendChild(errorMsg);
        formPanel.appendChild(actionsDiv);
        
        // 将表单插入到预览区域
        const previewSection = document.querySelector('.preview-section');
        previewSection.insertBefore(formPanel, previewSection.firstChild);
        input.select(); // 选中默认文件名，方便直接修改
        
        // 滚动到表单位置
        setTimeout(() => {
            formPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }
    
    // 执行导出的实际操作
    async function executeExportToTxt(fileName) {
        showLoading(true);
        try {
            // 将uniqueIds转换回tool names
            const selectedToolNames = [];
            selectedTools.forEach(uniqueId => {
                const tool = allTools.find(t => t.uniqueId === uniqueId);
                if (tool) {
                    selectedToolNames.push(tool.name);
                }
            });
            
            const configData = {
                selectedTools: selectedToolNames,
                toolDescriptions: toolDescriptions,
                includeHeader: elements.includeHeader.checked,
                includeExamples: elements.includeExamples.checked
            };

            const response = await fetch(`${API_BASE}/tool-list-editor/export/${encodeURIComponent(fileName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
            
            if (!response.ok) throw new Error('导出失败');
            
            const result = await response.json();
            showStatus(`已导出到: ${result.filePath}`, 'success');
        } catch (error) {
            console.error('导出失败:', error);
            showStatus('导出失败: ' + error.message, 'error');
        } finally {
            showLoading(false);
        }
    }

    // 过滤工具
    function filterTools() {
        const searchTerm = elements.toolSearch.value.toLowerCase();
        const showSelectedOnly = elements.showSelectedOnly.checked;
        
        // 遍历所有插件分组
        const pluginGroups = elements.toolsList.querySelectorAll('.plugin-group');
        pluginGroups.forEach(pluginGroup => {
            const pluginName = pluginGroup.dataset.pluginName;
            
            // 检查插件是否被插件过滤器隐藏
            const pluginVisible = visiblePlugins.has(pluginName);
            
            if (!pluginVisible) {
                // 如果插件被过滤掉，直接隐藏整个分组
                pluginGroup.classList.add('hidden');
                return;
            }
            
            let hasVisibleTools = false;
            
            // 遍历该插件分组下的所有工具项
            const toolItems = pluginGroup.querySelectorAll('.tool-item');
            toolItems.forEach(item => {
                const toolId = item.dataset.toolId;
                const tool = allTools.find(t => t.uniqueId === toolId);
                if (!tool) return;
                
                const matchesSearch = !searchTerm || 
                    tool.name.toLowerCase().includes(searchTerm) ||
                    (tool.displayName && tool.displayName.toLowerCase().includes(searchTerm)) ||
                    (tool.pluginName && tool.pluginName.toLowerCase().includes(searchTerm)) ||
                    (tool.description && tool.description.toLowerCase().includes(searchTerm));
                
                const matchesSelection = !showSelectedOnly || selectedTools.has(toolId);
                
                const isVisible = matchesSearch && matchesSelection;
                item.classList.toggle('hidden', !isVisible);
                
                if (isVisible) {
                    hasVisibleTools = true;
                }
            });
            
            // 如果插件分组下没有可见的工具，隐藏整个分组
            pluginGroup.classList.toggle('hidden', !hasVisibleTools);
        });
    }

    // 全选
    function selectAll() {
        allTools.forEach(tool => selectedTools.add(tool.uniqueId));
        renderToolsList();
        updatePluginFilterCounts(); // 更新插件过滤列表的选中数量
        updateToolCount();
        updatePreview();
        enableSaveButtons();
        filterTools();
    }

    // 取消全选
    function deselectAll() {
        selectedTools.clear();
        renderToolsList();
        updatePluginFilterCounts(); // 更新插件过滤列表的选中数量
        updateToolCount();
        updatePreview();
        enableSaveButtons();
        filterTools();
    }

    // 复制预览内容
    function copyPreview() {
        elements.previewOutput.select();
        document.execCommand('copy');
        showStatus('已复制到剪贴板', 'success');
    }

    // 显示状态消息
    function showStatus(message, type = 'info') {
        elements.configStatus.textContent = message;
        elements.configStatus.className = 'status-message ' + type;
        
        setTimeout(() => {
            elements.configStatus.textContent = '';
            elements.configStatus.className = 'status-message';
        }, 5000);
    }

    // 显示/隐藏加载遮罩
    function showLoading(show) {
        elements.loadingOverlay.style.display = show ? 'flex' : 'none';
    }
    
    // ==================== 插件过滤功能 ====================
    
    // 渲染插件过滤列表
    function renderPluginFilterList() {
        const pluginFilterList = document.getElementById('plugin-filter-list');
        if (!pluginFilterList) return;
        
        pluginFilterList.innerHTML = '';
        
        // 获取所有唯一的插件名称并统计工具数量
        const pluginStats = {};
        allTools.forEach(tool => {
            if (!pluginStats[tool.pluginName]) {
                pluginStats[tool.pluginName] = {
                    displayName: tool.displayName || tool.pluginName,
                    totalCount: 0,
                    selectedCount: 0,
                    isInvalid: tool.isInvalid
                };
            }
            pluginStats[tool.pluginName].totalCount++;
            // 统计已选中的工具数量
            if (selectedTools.has(tool.uniqueId)) {
                pluginStats[tool.pluginName].selectedCount++;
            }
        });
        
        // 按插件名排序
        const sortedPluginNames = Object.keys(pluginStats).sort((a, b) => a.localeCompare(b));
        
        // 初始化所有插件为可见
        sortedPluginNames.forEach(pluginName => {
            visiblePlugins.add(pluginName);
        });
        
        // 为每个插件创建复选框项
        sortedPluginNames.forEach(pluginName => {
            const stats = pluginStats[pluginName];
            
            const item = document.createElement('div');
            item.className = 'plugin-filter-item';
            item.dataset.pluginName = pluginName; // 添加数据属性方便后续更新
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.dataset.pluginName = pluginName;
            
            const label = document.createElement('label');
            label.innerHTML = `
                <span class="plugin-icon">${stats.isInvalid ? '⚠️' : '📦'}</span>
                <span class="plugin-name">${stats.displayName}</span>
                <span class="tool-count">${stats.selectedCount > 0 ? `<span class="selected-count">${stats.selectedCount}</span>/` : ''}${stats.totalCount}</span>
            `;
            
            // 点击整个item也可以切换复选框
            item.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
            
            // 复选框变化时更新显示
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    visiblePlugins.add(pluginName);
                } else {
                    visiblePlugins.delete(pluginName);
                }
                applyPluginFilter();
            });
            
            item.appendChild(checkbox);
            item.appendChild(label);
            pluginFilterList.appendChild(item);
        });
        
        // 添加展开/收起按钮的事件监听
        const toggleBtn = document.getElementById('toggle-plugin-filter-btn');
        const panel = document.getElementById('plugin-filter-panel');
        
        if (toggleBtn && panel) {
            toggleBtn.addEventListener('click', () => {
                const isExpanded = panel.style.display !== 'none';
                panel.style.display = isExpanded ? 'none' : 'block';
                toggleBtn.classList.toggle('expanded', !isExpanded);
                
                // 如果是展开操作，更新选中数量
                if (!isExpanded) {
                    updatePluginFilterCounts();
                }
            });
        }
        
        // 全选/清空按钮事件
        const selectAllPluginsBtn = document.getElementById('plugin-select-all-btn');
        const deselectAllPluginsBtn = document.getElementById('plugin-deselect-all-btn');
        
        if (selectAllPluginsBtn) {
            selectAllPluginsBtn.addEventListener('click', () => {
                const checkboxes = pluginFilterList.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = true;
                    const pluginName = cb.dataset.pluginName;
                    if (pluginName) {
                        visiblePlugins.add(pluginName);
                    }
                });
                applyPluginFilter();
            });
        }
        
        if (deselectAllPluginsBtn) {
            deselectAllPluginsBtn.addEventListener('click', () => {
                const checkboxes = pluginFilterList.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = false;
                    const pluginName = cb.dataset.pluginName;
                    if (pluginName) {
                        visiblePlugins.delete(pluginName);
                    }
                });
                applyPluginFilter();
            });
        }
    }
    
    // 应用插件过滤
    function applyPluginFilter() {
        const pluginGroups = elements.toolsList.querySelectorAll('.plugin-group');
        
        pluginGroups.forEach(pluginGroup => {
            const pluginName = pluginGroup.dataset.pluginName;
            const isVisible = visiblePlugins.has(pluginName);
            
            if (isVisible) {
                pluginGroup.classList.remove('hidden');
            } else {
                pluginGroup.classList.add('hidden');
            }
        });
        
        // 同时应用搜索过滤
        filterTools();
    }
    
    // 更新插件过滤列表中的选中数量
    function updatePluginFilterCounts() {
        const pluginFilterList = document.getElementById('plugin-filter-list');
        if (!pluginFilterList) return;
        
        // 统计每个插件的已选中工具数量
        const pluginSelectedCounts = {};
        allTools.forEach(tool => {
            if (!pluginSelectedCounts[tool.pluginName]) {
                pluginSelectedCounts[tool.pluginName] = {
                    total: 0,
                    selected: 0
                };
            }
            pluginSelectedCounts[tool.pluginName].total++;
            if (selectedTools.has(tool.uniqueId)) {
                pluginSelectedCounts[tool.pluginName].selected++;
            }
        });
        
        // 更新每个插件过滤项的显示
        const items = pluginFilterList.querySelectorAll('.plugin-filter-item');
        items.forEach(item => {
            const pluginName = item.dataset.pluginName;
            if (!pluginName || !pluginSelectedCounts[pluginName]) return;
            
            const counts = pluginSelectedCounts[pluginName];
            const countSpan = item.querySelector('.tool-count');
            if (countSpan) {
                if (counts.selected > 0) {
                    countSpan.innerHTML = `<span class="selected-count">${counts.selected}</span>/${counts.total}`;
                } else {
                    countSpan.textContent = counts.total;
                }
            }
        });
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
