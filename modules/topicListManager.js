// modules/topicListManager.js

window.topicListManager = (() => {
    // --- Private Variables ---
    let topicListContainer;
    let electronAPI;
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let uiHelper;
    let mainRendererFunctions;
    let wasSelectionListenerActive = false; // To store the state of the selection listener before dragging

    /**
     * Initializes the TopicListManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        if (!config.elements || !config.elements.topicListContainer) {
            console.error('[TopicListManager] Missing required DOM element: topicListContainer.');
            return;
        }
        if (!config.electronAPI || !config.refs || !config.uiHelper || !config.mainRendererFunctions) {
            console.error('[TopicListManager] Missing required configuration parameters.');
            return;
        }

        topicListContainer = config.elements.topicListContainer;
        electronAPI = config.electronAPI;
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        currentTopicIdRef = config.refs.currentTopicIdRef;
        uiHelper = config.uiHelper;
        mainRendererFunctions = config.mainRendererFunctions;

        console.log('[TopicListManager] Initialized successfully.');
    }

    async function loadTopicList() {
        if (!topicListContainer) {
            console.error("Topic list container (tabContentTopics) not found.");
            return;
        }

        let topicListUl = topicListContainer.querySelector('.topic-list');
        if (topicListUl) {
            topicListUl.innerHTML = '';
        } else {
            const topicsHeader = topicListContainer.querySelector('.topics-header') || document.createElement('div');
            if (!topicsHeader.classList.contains('topics-header')) {
                topicsHeader.className = 'topics-header';
                topicsHeader.innerHTML = `<h2>话题列表</h2><div class="topic-search-container"><input type="text" id="topicSearchInput" placeholder="搜索话题..." class="topic-search-input"></div>`;
                topicListContainer.prepend(topicsHeader);
                const newTopicSearchInput = topicsHeader.querySelector('#topicSearchInput');
                if (newTopicSearchInput) setupTopicSearchListener(newTopicSearchInput);
            }
            
            topicListUl = document.createElement('ul');
            topicListUl.className = 'topic-list';
            topicListUl.id = 'topicList';
            topicListContainer.appendChild(topicListUl);
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        if (!currentSelectedItem.id) {
            topicListUl.innerHTML = '<li><p>请先在“助手与群组”列表选择一个项目以查看其相关话题。</p></li>';
            return;
        }

        const itemNameForLoading = currentSelectedItem.name || '当前项目';
        const searchInput = document.getElementById('topicSearchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        let itemConfigFull;

        if (!searchTerm) {
            topicListUl.innerHTML = `<li><div class="loading-spinner-small"></div>正在加载 ${itemNameForLoading} 的话题...</li>`;
        } else {
            topicListUl.innerHTML = '';
        }
        
        if (currentSelectedItem.type === 'agent') {
            itemConfigFull = await electronAPI.getAgentConfig(currentSelectedItem.id);
        } else if (currentSelectedItem.type === 'group') {
            itemConfigFull = await electronAPI.getAgentGroupConfig(currentSelectedItem.id);
        }
        
        if (itemConfigFull && !itemConfigFull.error) {
            mainRendererFunctions.updateCurrentItemConfig(itemConfigFull);
        }
        
        if (!itemConfigFull || itemConfigFull.error) {
            topicListUl.innerHTML = `<li><p>无法加载 ${itemNameForLoading} 的配置信息: ${itemConfigFull?.error || '未知错误'}</p></li>`;
        } else {
            let topicsToProcess = itemConfigFull.topics || [];
            if (currentSelectedItem.type === 'agent' && topicsToProcess.length === 0) {
                 const defaultAgentTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
                 topicsToProcess.push(defaultAgentTopic);
            }

            topicsToProcess.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            
            if (searchTerm) {
                let frontendFilteredTopics = topicsToProcess.filter(topic => {
                    const nameMatch = topic.name.toLowerCase().includes(searchTerm);
                    let dateMatch = false;
                    if (topic.createdAt) {
                        const date = new Date(topic.createdAt);
                        const fullDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        const shortDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                        dateMatch = fullDateStr.toLowerCase().includes(searchTerm) || shortDateStr.toLowerCase().includes(searchTerm);
                    }
                    return nameMatch || dateMatch;
                });

                let contentMatchedTopicIds = [];
                try {
                    const contentSearchResult = await electronAPI.searchTopicsByContent(currentSelectedItem.id, currentSelectedItem.type, searchTerm);
                    if (contentSearchResult && contentSearchResult.success && Array.isArray(contentSearchResult.matchedTopicIds)) {
                        contentMatchedTopicIds = contentSearchResult.matchedTopicIds;
                    } else if (contentSearchResult && !contentSearchResult.success) {
                        console.warn("Topic content search failed:", contentSearchResult.error);
                    }
                } catch (e) {
                    console.error("Error calling searchTopicsByContent:", e);
                }

                const finalFilteredTopicIds = new Set(frontendFilteredTopics.map(t => t.id));
                contentMatchedTopicIds.forEach(id => finalFilteredTopicIds.add(id));
                
                topicsToProcess = topicsToProcess.filter(topic => finalFilteredTopicIds.has(topic.id));
            }

            if (topicsToProcess.length === 0) {
                topicListUl.innerHTML = `<li><p>${itemNameForLoading} 还没有任何话题${searchTerm ? '匹配当前搜索' : ''}。您可以点击上方的“新建${currentSelectedItem.type === 'group' ? '群聊话题' : '聊天话题'}”按钮创建一个。</p></li>`;
            } else {
                topicListUl.innerHTML = '';
                const currentTopicId = currentTopicIdRef.get();
                for (const topic of topicsToProcess) {
                    const li = document.createElement('li');
                    li.classList.add('topic-item');
                    li.dataset.itemId = currentSelectedItem.id;
                    li.dataset.itemType = currentSelectedItem.type;
                    li.dataset.topicId = topic.id;
                    const isCurrentActiveTopic = topic.id === currentTopicId;
                    li.classList.toggle('active', isCurrentActiveTopic);
                    li.classList.toggle('active-topic-glowing', isCurrentActiveTopic);

                    const avatarImg = document.createElement('img');
                    avatarImg.classList.add('avatar');
                    avatarImg.src = currentSelectedItem.avatarUrl ? `${currentSelectedItem.avatarUrl}${currentSelectedItem.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
                    avatarImg.alt = `${currentSelectedItem.name} - ${topic.name}`;
                    avatarImg.onerror = () => { avatarImg.src = (currentSelectedItem.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

                    const topicTitleDisplay = document.createElement('span');
                    topicTitleDisplay.classList.add('topic-title-display');
                    topicTitleDisplay.textContent = topic.name || `话题 ${topic.id}`;

                    const messageCountSpan = document.createElement('span');
                    messageCountSpan.classList.add('message-count');
                    messageCountSpan.textContent = '...';

                    li.appendChild(avatarImg);
                    li.appendChild(topicTitleDisplay);
                    li.appendChild(messageCountSpan);

                    let historyPromise;
                    if (currentSelectedItem.type === 'agent') {
                        historyPromise = electronAPI.getChatHistory(currentSelectedItem.id, topic.id);
                    } else if (currentSelectedItem.type === 'group') {
                        historyPromise = electronAPI.getGroupChatHistory(currentSelectedItem.id, topic.id);
                    }
                    if (historyPromise) {
                        historyPromise.then(historyResult => {
                            if (historyResult && !historyResult.error && Array.isArray(historyResult)) {
                                messageCountSpan.textContent = `${historyResult.length}`;
                            } else {
                                messageCountSpan.textContent = 'N/A';
                            }
                        }).catch(() => messageCountSpan.textContent = 'ERR');
                    }

                    li.addEventListener('click', async () => {
                        if (currentTopicIdRef.get() !== topic.id) {
                            mainRendererFunctions.selectTopic(topic.id);
                        }
                    });

                    li.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        showTopicContextMenu(e, li, itemConfigFull, topic, currentSelectedItem.type);
                    });
                    topicListUl.appendChild(li);
                }
            }
            if (currentSelectedItem.id && topicsToProcess && topicsToProcess.length > 0 && typeof Sortable !== 'undefined') {
               initializeTopicSortable(currentSelectedItem.id, currentSelectedItem.type);
            }
        }
    }

    function setupTopicSearch() {
        let searchInput = document.getElementById('topicSearchInput');
        if (searchInput) {
            setupTopicSearchListener(searchInput);
        }
    }

    function setupTopicSearchListener(inputElement) {
        inputElement.addEventListener('input', filterTopicList);
        inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                filterTopicList();
            }
        });
    }

    function filterTopicList() {
        loadTopicList();
    }

    function initializeTopicSortable(itemId, itemType) {
        const topicListUl = document.getElementById('topicList');
        if (!topicListUl) {
            console.warn("[TopicListManager] topicListUl element not found. Skipping Sortable initialization.");
            return;
        }

        if (topicListUl.sortableInstance) {
            topicListUl.sortableInstance.destroy();
        }

        topicListUl.sortableInstance = new Sortable(topicListUl, {
            animation: 150,
            ghostClass: 'sortable-ghost-topic',
            chosenClass: 'sortable-chosen-topic',
            dragClass: 'sortable-drag-topic',
            onStart: async function(evt) {
                // Check original state, store it, and then disable if it was active.
                if (window.electronAPI && window.electronAPI.getSelectionListenerStatus) {
                    wasSelectionListenerActive = await window.electronAPI.getSelectionListenerStatus();
                    if (wasSelectionListenerActive) {
                        window.electronAPI.toggleSelectionListener(false);
                    }
                }
            },
            onEnd: async function (evt) {
                // Re-enable selection hook only if it was active before the drag.
                if (window.electronAPI && window.electronAPI.toggleSelectionListener) {
                    if (wasSelectionListenerActive) {
                        window.electronAPI.toggleSelectionListener(true);
                    }
                    wasSelectionListenerActive = false; // Reset state
                }

                const topicItems = Array.from(evt.to.children);
                const orderedTopicIds = topicItems.map(item => item.dataset.topicId);
                try {
                    let result;
                    if (itemType === 'agent') {
                        result = await electronAPI.saveTopicOrder(itemId, orderedTopicIds);
                    } else if (itemType === 'group') {
                        result = await electronAPI.saveGroupTopicOrder(itemId, orderedTopicIds);
                    }

                    if (result && result.success) {
                        // UI reflects sort.
                    } else {
                        console.error(`Failed to save topic order for ${itemType} ${itemId}:`, result?.error);
                        uiHelper.showToastNotification(`保存话题顺序失败: ${result?.error || '未知错误'}`, 'error');
                        loadTopicList();
                    }
                } catch (error) {
                    console.error(`Error calling saveTopicOrder for ${itemType} ${itemId}:`, error);
                    uiHelper.showToastNotification(`调用保存话题顺序API时出错: ${error.message}`, 'error');
                    loadTopicList();
                }
            }
        });
    }

    function showTopicContextMenu(event, topicItemElement, itemFullConfig, topic, itemType) {
        // closeContextMenu(); // This function is not available in this module
        closeTopicContextMenu();

        const menu = document.createElement('div');
        menu.id = 'topicContextMenu';
        menu.classList.add('context-menu');
        menu.style.top = `${event.clientY}px`;
        menu.style.left = `${event.clientX}px`;

        const editTitleOption = document.createElement('div');
        editTitleOption.classList.add('context-menu-item');
        editTitleOption.innerHTML = `<i class="fas fa-edit"></i> 编辑话题标题`;
        editTitleOption.onclick = () => {
            closeTopicContextMenu();
            const titleDisplayElement = topicItemElement.querySelector('.topic-title-display');
            if (!titleDisplayElement) return;

            const originalTitle = topic.name;
            titleDisplayElement.style.display = 'none';

            const inputWrapper = document.createElement('div');
            inputWrapper.style.display = 'flex';
            inputWrapper.style.alignItems = 'center';

            const inputField = document.createElement('input');
            inputField.type = 'text';
            inputField.value = originalTitle;
            inputField.classList.add('topic-title-edit-input');
            inputField.style.flexGrow = '1';
            inputField.onclick = (e) => e.stopPropagation();

            const confirmButton = document.createElement('button');
            confirmButton.innerHTML = '✓';
            confirmButton.classList.add('topic-title-edit-confirm');
            confirmButton.onclick = async (e) => {
                e.stopPropagation();
                const newTitle = inputField.value.trim();
                if (newTitle && newTitle !== originalTitle) {
                    let saveResult;
                    if (itemType === 'agent') {
                        saveResult = await electronAPI.saveAgentTopicTitle(itemFullConfig.id, topic.id, newTitle);
                    } else if (itemType === 'group') {
                        saveResult = await electronAPI.saveGroupTopicTitle(itemFullConfig.id, topic.id, newTitle);
                    }
                    if (saveResult && saveResult.success) {
                        topic.name = newTitle;
                        titleDisplayElement.textContent = newTitle;
                        if (itemFullConfig.topics) {
                            const topicInFullConfig = itemFullConfig.topics.find(t => t.id === topic.id);
                            if (topicInFullConfig) topicInFullConfig.name = newTitle;
                        }
                    } else {
                        uiHelper.showToastNotification(`更新话题标题失败: ${saveResult?.error || '未知错误'}`, 'error');
                    }
                }
                titleDisplayElement.style.display = '';
                inputWrapper.replaceWith(titleDisplayElement);
            };

            const cancelButton = document.createElement('button');
            cancelButton.innerHTML = '✗';
            cancelButton.classList.add('topic-title-edit-cancel');
            cancelButton.onclick = (e) => {
                e.stopPropagation();
                titleDisplayElement.style.display = '';
                inputWrapper.replaceWith(titleDisplayElement);
            };

            inputWrapper.appendChild(inputField);
            inputWrapper.appendChild(confirmButton);
            inputWrapper.appendChild(cancelButton);
            topicItemElement.insertBefore(inputWrapper, titleDisplayElement.nextSibling);
            inputField.focus();
            inputField.select();

            inputField.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    confirmButton.click();
                } else if (e.key === 'Escape') {
                    cancelButton.click();
                }
            });
        };
        menu.appendChild(editTitleOption);

        const deleteTopicPermanentlyOption = document.createElement('div');
        deleteTopicPermanentlyOption.classList.add('context-menu-item', 'danger-item');
        deleteTopicPermanentlyOption.innerHTML = `<i class="fas fa-trash-alt"></i> 删除此话题`;
        deleteTopicPermanentlyOption.onclick = async () => {
            closeTopicContextMenu();
            if (confirm(`确定要永久删除话题 "${topic.name}" 吗？此操作不可撤销。`)) {
                let result;
                if (itemType === 'agent') {
                    result = await electronAPI.deleteTopic(itemFullConfig.id, topic.id);
                } else if (itemType === 'group') {
                    result = await electronAPI.deleteGroupTopic(itemFullConfig.id, topic.id);
                }

                if (result && result.success) {
                    if (currentTopicIdRef.get() === topic.id) {
                        mainRendererFunctions.handleTopicDeletion(result.remainingTopics);
                    }
                    loadTopicList();
                } else {
                    uiHelper.showToastNotification(`删除话题 "${topic.name}" 失败: ${result ? result.error : '未知错误'}`, 'error');
                }
            }
        };
        menu.appendChild(deleteTopicPermanentlyOption);

        const exportTopicOption = document.createElement('div');
        exportTopicOption.classList.add('context-menu-item');
        exportTopicOption.innerHTML = `<i class="fas fa-file-export"></i> 导出此话题`;
        exportTopicOption.onclick = () => {
            closeTopicContextMenu();
            handleExportTopic(itemFullConfig.id, itemType, topic.id, topic.name);
        };
        menu.appendChild(exportTopicOption);
        

        document.body.appendChild(menu);
        document.addEventListener('click', closeTopicContextMenuOnClickOutside, true);
    }

    function closeTopicContextMenu() {
        const existingMenu = document.getElementById('topicContextMenu');
        if (existingMenu) {
            existingMenu.remove();
            document.removeEventListener('click', closeTopicContextMenuOnClickOutside, true);
        }
    }

    function closeTopicContextMenuOnClickOutside(event) {
        const menu = document.getElementById('topicContextMenu');
        if (menu && !menu.contains(event.target)) {
            closeTopicContextMenu();
        }
    }

    async function handleExportTopic(itemId, itemType, topicId, topicName) {
        const currentTopicId = currentTopicIdRef.get();
        if (topicId !== currentTopicId) {
            uiHelper.showToastNotification('请先点击并加载此话题，然后再导出。', 'info');
            return;
        }

        console.log(`[TopicListManager] Exporting currently visible topic: ${topicName} (ID: ${topicId})`);

        try {
            const chatMessagesDiv = document.getElementById('chatMessages');
            if (!chatMessagesDiv) {
                console.error('[Export Debug] chatMessagesDiv not found!');
                uiHelper.showToastNotification('错误：找不到聊天内容容器。', 'error');
                return;
            }

            const messageItems = chatMessagesDiv.querySelectorAll('.message-item');
            console.log(`[Export Debug] Found ${messageItems.length} message items.`);
            if (messageItems.length === 0) {
                uiHelper.showToastNotification('此话题没有可见的聊天内容可导出。', 'info');
                return;
            }

            let markdownContent = `# 话题: ${topicName}\n\n`;
            let extractedCount = 0;

            messageItems.forEach((item, index) => {
                if (item.classList.contains('system') || item.classList.contains('thinking')) {
                    console.log(`[Export Debug] Skipping system/thinking message at index ${index}.`);
                    return;
                }

                const senderElement = item.querySelector('.sender-name');
                const contentElement = item.querySelector('.md-content');

                if (senderElement && contentElement) {
                    const sender = senderElement.textContent.trim().replace(':', '');
                    let content = contentElement.innerText || contentElement.textContent || "";
                    content = content.trim();

                    if (sender && content) {
                        markdownContent += `**${sender}**: ${content}\n\n---\n\n`;
                        extractedCount++;
                    } else {
                        console.log(`[Export Debug] Skipping message at index ${index} due to empty sender or content. Sender: "${sender}", Content: "${content}"`);
                    }
                } else {
                    console.log(`[Export Debug] Skipping message at index ${index} because sender or content element was not found.`);
                }
            });

            console.log(`[Export Debug] Extracted ${extractedCount} messages. Final markdown length: ${markdownContent.length}`);

            if (extractedCount === 0) {
                uiHelper.showToastNotification('未能从当前话题中提取任何有效对话内容。', 'warning');
                return;
            }

            const result = await electronAPI.exportTopicAsMarkdown({
                topicName: topicName,
                markdownContent: markdownContent
            });

            if (result.success) {
                uiHelper.showToastNotification(`话题 "${topicName}" 已成功导出到: ${result.path}`);
            } else {
                uiHelper.showToastNotification(`导出话题失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error(`[TopicListManager] 导出话题时发生错误:`, error);
            uiHelper.showToastNotification(`导出话题时发生前端错误: ${error.message}`, 'error');
        }
    }

    // --- Public API ---
    return {
        init,
        loadTopicList,
        setupTopicSearch,
        showTopicContextMenu
    };
})();