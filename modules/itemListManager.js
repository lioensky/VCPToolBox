// modules/itemListManager.js

window.itemListManager = (() => {
    // --- Private Variables ---
    let itemListUl;
    let electronAPI;
    let currentSelectedItemRef;
    let mainRendererFunctions; // To call back into renderer.js for actions like selectItem
    let wasSelectionListenerActive = false; // To store the state of the selection listener before dragging

    /**
     * Initializes the ItemListManager module.
     * @param {object} config - The configuration object.
     * @param {object} config.elements - DOM elements.
     * @param {HTMLElement} config.elements.itemListUl - The <ul> element for the item list.
     * @param {object} config.electronAPI - The preloaded electron API.
     * @param {object} config.refs - References to shared state.
     * @param {object} config.refs.currentSelectedItemRef - A ref to the current selected item object.
     * @param {object} config.mainRendererFunctions - Functions from the main renderer.
     * @param {function} config.mainRendererFunctions.selectItem - Function to select an item.
     * @param {object} config.uiHelper - The UI helper functions object.
     */
    function init(config) {
        // Check for necessary configurations
        if (!config.elements || !config.elements.itemListUl) {
            console.error('[ItemListManager] Missing required DOM element: itemListUl.');
            return;
        }
        if (!config.electronAPI) {
            console.error('[ItemListManager] Missing required configuration: electronAPI.');
            return;
        }
        if (!config.refs || !config.refs.currentSelectedItemRef) {
            console.error('[ItemListManager] Missing required ref: currentSelectedItemRef.');
            return;
        }
        if (!config.mainRendererFunctions || typeof config.mainRendererFunctions.selectItem !== 'function') {
            console.error('[ItemListManager] Missing required main renderer function: selectItem.');
            return;
        }
        if (!config.uiHelper) {
            console.error('[ItemListManager] Missing required configuration: uiHelper.');
            return;
        }

        itemListUl = config.elements.itemListUl;
        electronAPI = config.electronAPI;
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        mainRendererFunctions = config.mainRendererFunctions;
        uiHelper = config.uiHelper; // Store uiHelper

        console.log('[ItemListManager] Initialized successfully.');
    }

    /**
     * Highlights the active item in the list.
     * @param {string} itemId - The ID of the item to highlight.
     * @param {string} itemType - The type of the item ('agent' or 'group').
     */
    function highlightActiveItem(itemId, itemType) {
        if (!itemListUl) return;
        document.querySelectorAll('#agentList li').forEach(item => {
            item.classList.toggle('active', item.dataset.itemId === itemId && item.dataset.itemType === itemType);
        });
    }

    /**
     * Initializes the SortableJS functionality for the item list.
     */
    function initializeItemSortable() {
        if (!itemListUl) {
            console.warn("[ItemListManager] itemListUl element not found. Skipping Sortable initialization.");
            return;
        }
        if (itemListUl.sortableInstance) {
            itemListUl.sortableInstance.destroy();
        }
        itemListUl.sortableInstance = new Sortable(itemListUl, {
            animation: 150,
            ghostClass: 'sortable-ghost-main',
            chosenClass: 'sortable-chosen-main',
            dragClass: 'sortable-drag-main',
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

                const allListItems = Array.from(evt.to.children);
                const orderedItems = allListItems.map(item => ({
                    id: item.dataset.itemId,
                    type: item.dataset.itemType
                }));
                await saveItemOrder(orderedItems);
            }
        });
    }

    /**
     * Saves the new order of items to the settings file.
     * @param {Array<object>} orderedItemsWithTypes - An array of objects with id and type.
     */
    async function saveItemOrder(orderedItemsWithTypes) {
        console.log('[ItemListManager] Saving combined item order:', orderedItemsWithTypes);
        try {
            const result = await electronAPI.saveCombinedItemOrder(orderedItemsWithTypes);
            if (result && result.success) {
                // uiHelper.showToastNotification("项目顺序已保存。"); // Removed successful save notification
            } else {
                uiHelper.showToastNotification(`保存项目顺序失败: ${result?.error || '未知错误'}`, 'error');
                // Consider reloading items to revert to the last saved order if save failed
                // await loadItems();
            }
        } catch (error) {
            console.error('Error saving combined item order:', error);
            uiHelper.showToastNotification(`保存项目顺序出错: ${error.message}`, 'error');
        }
    }

    /**
     * Loads agents and groups, sorts them, and renders them in the list.
     */
    async function loadItems() {
        if (!itemListUl || !electronAPI) {
            console.error('[ItemListManager] Cannot load items. Module not initialized or missing dependencies.');
            return;
        }
        itemListUl.innerHTML = '<li><div class="loading-spinner-small"></div>加载列表中...</li>';
        const agentsResult = await electronAPI.getAgents();
        const groupsResult = await electronAPI.getAgentGroups();
        itemListUl.innerHTML = '';

        let items = [];
        if (agentsResult && !agentsResult.error) {
            items.push(...agentsResult.map(a => ({ ...a, type: 'agent', id: a.id, avatarUrl: a.avatarUrl || 'assets/default_avatar.png' })));
        } else if (agentsResult && agentsResult.error) {
            itemListUl.innerHTML += `<li>加载Agent失败: ${agentsResult.error}</li>`;
        }

        if (groupsResult && !groupsResult.error) {
            items.push(...groupsResult.map(g => ({ ...g, type: 'group', id: g.id, avatarUrl: g.avatarUrl || 'assets/default_group_avatar.png' })));
        } else if (groupsResult && groupsResult.error) {
            itemListUl.innerHTML += `<li>加载群组失败: ${groupsResult.error}</li>`;
        }

        let combinedOrderFromSettings = [];
        try {
            const settings = await electronAPI.loadSettings();
            if (settings && settings.combinedItemOrder && Array.isArray(settings.combinedItemOrder)) {
                combinedOrderFromSettings = settings.combinedItemOrder;
            }
        } catch (e) {
            console.warn("[ItemListManager] Could not load combinedItemOrder from settings:", e);
        }

        if (combinedOrderFromSettings.length > 0 && items.length > 0) {
            const itemMap = new Map(items.map(item => [`${item.type}_${item.id}`, item]));
            const orderedItems = [];
            combinedOrderFromSettings.forEach(orderedItemInfo => {
                const key = `${orderedItemInfo.type}_${orderedItemInfo.id}`;
                if (itemMap.has(key)) {
                    orderedItems.push(itemMap.get(key));
                    itemMap.delete(key);
                }
            });
            orderedItems.push(...itemMap.values());
            items = orderedItems;
        } else {
            items.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'group' ? -1 : 1;
                }
                return (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
            });
        }

        if (items.length === 0 && !(agentsResult && agentsResult.error) && !(groupsResult && groupsResult.error)) {
            itemListUl.innerHTML = '<li>没有找到Agent或群组。请创建一个。</li>';
        } else {
            items.forEach(item => {
                const li = document.createElement('li');
                li.dataset.itemId = item.id;
                li.dataset.itemType = item.type;

                const avatarImg = document.createElement('img');
                avatarImg.classList.add('avatar');
                avatarImg.src = item.avatarUrl ? `${item.avatarUrl}${item.avatarUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png');
                avatarImg.alt = `${item.name} 头像`;
                avatarImg.onerror = () => { avatarImg.src = (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_avatar.png'); };

                const nameSpan = document.createElement('span');
                nameSpan.classList.add('agent-name');
                nameSpan.textContent = item.name;
                if (item.type === 'group') {
                    nameSpan.textContent += " (群)";
                }

                li.appendChild(avatarImg);
                li.appendChild(nameSpan);
                li.addEventListener('click', () => {
                    if (mainRendererFunctions && typeof mainRendererFunctions.selectItem === 'function') {
                        mainRendererFunctions.selectItem(item.id, item.type, item.name, item.avatarUrl, item.config || item);
                    }
                });
                itemListUl.appendChild(li);
            });

            const currentSelectedItem = currentSelectedItemRef.get();
            if (currentSelectedItem && currentSelectedItem.id) {
                highlightActiveItem(currentSelectedItem.id, currentSelectedItem.type);
            }

            if (typeof Sortable !== 'undefined') {
                initializeItemSortable();
            } else {
                console.warn('[ItemListManager] SortableJS library not found. Item list drag-and-drop ordering will not be available.');
            }
        }
    }

    // --- Public API ---
    return {
        init,
        loadItems,
        highlightActiveItem
    };
})();