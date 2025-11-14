// AdminPanel/js/notes-manager.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';

let currentNotesFolder = null;
let selectedNotes = new Set();
let easyMDE = null;
let ragTagsData = {};
let currentRagFolder = null;

/**
 * 初始化日记管理器。
 */
export async function initializeDailyNotesManager() {
    console.log('Initializing Daily Notes Manager...');
    const notesListViewDiv = document.getElementById('notes-list-view');
    const noteEditorAreaDiv = document.getElementById('note-editor-area');
    const ragTagsConfigAreaDiv = document.getElementById('rag-tags-config-area');
    const notesActionStatusSpan = document.getElementById('notes-action-status');
    const moveSelectedNotesButton = document.getElementById('move-selected-notes');
    const deleteSelectedNotesButton = document.getElementById('delete-selected-notes-button');
    const searchDailyNotesInput = document.getElementById('search-daily-notes');

    if (notesListViewDiv) notesListViewDiv.innerHTML = '';
    if (noteEditorAreaDiv) noteEditorAreaDiv.style.display = 'none';
    if (ragTagsConfigAreaDiv) ragTagsConfigAreaDiv.style.display = 'none';
    if (notesActionStatusSpan) notesActionStatusSpan.textContent = '';
    if (moveSelectedNotesButton) moveSelectedNotesButton.disabled = true;
    if (deleteSelectedNotesButton) deleteSelectedNotesButton.disabled = true;
    if (searchDailyNotesInput) searchDailyNotesInput.value = '';
    
    setupEventListeners();
    await loadRagTagsConfig();
    await loadNotesFolders();
}

/**
 * 设置日记管理器部分的事件监听器。
 */
function setupEventListeners() {
    const saveNoteButton = document.getElementById('save-note-content');
    const cancelEditNoteButton = document.getElementById('cancel-edit-note');
    const moveSelectedNotesButton = document.getElementById('move-selected-notes');
    const deleteSelectedNotesButton = document.getElementById('delete-selected-notes-button');
    const searchDailyNotesInput = document.getElementById('search-daily-notes');
    const ragThresholdEnabledCheckbox = document.getElementById('rag-threshold-enabled');
    const ragThresholdValueSlider = document.getElementById('rag-threshold-value');
    const addRagTagButton = document.getElementById('add-rag-tag-button');
    const saveRagTagsConfigButton = document.getElementById('save-rag-tags-config');

    if (saveNoteButton && !saveNoteButton.dataset.listenerAttached) {
        saveNoteButton.addEventListener('click', saveNoteChanges);
        saveNoteButton.dataset.listenerAttached = 'true';
    }
    if (cancelEditNoteButton && !cancelEditNoteButton.dataset.listenerAttached) {
        cancelEditNoteButton.addEventListener('click', closeNoteEditor);
        cancelEditNoteButton.dataset.listenerAttached = 'true';
    }
    if (moveSelectedNotesButton && !moveSelectedNotesButton.dataset.listenerAttached) {
        moveSelectedNotesButton.addEventListener('click', moveSelectedNotesHandler);
        moveSelectedNotesButton.dataset.listenerAttached = 'true';
    }
    if (deleteSelectedNotesButton && !deleteSelectedNotesButton.dataset.listenerAttached) {
        deleteSelectedNotesButton.addEventListener('click', deleteSelectedNotesHandler);
        deleteSelectedNotesButton.dataset.listenerAttached = 'true';
    }
    if (searchDailyNotesInput && !searchDailyNotesInput.dataset.listenerAttached) {
        searchDailyNotesInput.addEventListener('input', filterNotesBySearch);
        searchDailyNotesInput.dataset.listenerAttached = 'true';
    }
    if (ragThresholdEnabledCheckbox && !ragThresholdEnabledCheckbox.dataset.listenerAttached) {
        ragThresholdEnabledCheckbox.addEventListener('change', () => {
            if(ragThresholdValueSlider) ragThresholdValueSlider.disabled = !ragThresholdEnabledCheckbox.checked;
        });
        ragThresholdEnabledCheckbox.dataset.listenerAttached = 'true';
    }
    if (ragThresholdValueSlider && !ragThresholdValueSlider.dataset.listenerAttached) {
        ragThresholdValueSlider.addEventListener('input', () => {
            const ragThresholdDisplaySpan = document.getElementById('rag-threshold-display');
            if(ragThresholdDisplaySpan) ragThresholdDisplaySpan.textContent = parseFloat(ragThresholdValueSlider.value).toFixed(2);
        });
        ragThresholdValueSlider.dataset.listenerAttached = 'true';
    }
    if (addRagTagButton && !addRagTagButton.dataset.listenerAttached) {
        addRagTagButton.addEventListener('click', () => addTagItem());
        addRagTagButton.dataset.listenerAttached = 'true';
    }
    if (saveRagTagsConfigButton && !saveRagTagsConfigButton.dataset.listenerAttached) {
        saveRagTagsConfigButton.addEventListener('click', saveRagTagsConfigHandler);
        saveRagTagsConfigButton.dataset.listenerAttached = 'true';
    }
}


async function loadNotesFolders() {
    const notesFolderListUl = document.getElementById('notes-folder-list');
    const moveTargetFolderSelect = document.getElementById('move-target-folder');
    const notesListViewDiv = document.getElementById('notes-list-view');
    if (!notesFolderListUl || !moveTargetFolderSelect || !notesListViewDiv) return;

    try {
        const data = await apiFetch(`${API_BASE_URL}/dailynotes/folders`);
        notesFolderListUl.innerHTML = '';
        moveTargetFolderSelect.innerHTML = '<option value="">选择目标文件夹...</option>';

        if (data.folders && data.folders.length > 0) {
            data.folders.forEach(folder => {
                const li = document.createElement('li');
                li.textContent = folder;
                li.dataset.folderName = folder;
                li.addEventListener('click', () => {
                    loadNotesForFolder(folder);
                    notesFolderListUl.querySelectorAll('li').forEach(item => item.classList.remove('active'));
                    li.classList.add('active');
                });
                notesFolderListUl.appendChild(li);

                const option = document.createElement('option');
                option.value = folder;
                option.textContent = folder;
                moveTargetFolderSelect.appendChild(option);
            });
            if (!currentNotesFolder || !data.folders.includes(currentNotesFolder)) {
                if (notesFolderListUl.firstChild) {
                     notesFolderListUl.firstChild.click();
                }
            } else {
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
    const notesListViewDiv = document.getElementById('notes-list-view');
    const noteEditorAreaDiv = document.getElementById('note-editor-area');
    const searchDailyNotesInput = document.getElementById('search-daily-notes');
    if (!notesListViewDiv || !noteEditorAreaDiv) return;

    currentNotesFolder = folderName;
    selectedNotes.clear();
    updateActionButtonStatus();
    notesListViewDiv.innerHTML = '<p>正在加载日记...</p>';
    noteEditorAreaDiv.style.display = 'none';
    if(searchDailyNotesInput) searchDailyNotesInput.value = '';

    try {
        const data = await apiFetch(`${API_BASE_URL}/dailynotes/folder/${folderName}`);
        notesListViewDiv.innerHTML = '';
        if (data.notes && data.notes.length > 0) {
            data.notes.forEach(note => {
                const card = renderNoteCard(note, folderName);
                notesListViewDiv.appendChild(card);
            });
        } else {
            notesListViewDiv.innerHTML = `<p>文件夹 "${folderName}" 中没有日记。</p>`;
        }
        displayRagTagsForFolder(folderName);
    } catch (error) {
        notesListViewDiv.innerHTML = `<p>加载文件夹 "${folderName}" 中的日记失败。</p>`;
        showMessage(`加载日记失败: ${error.message}`, 'error');
    }
}

async function filterNotesBySearch() {
    const searchDailyNotesInput = document.getElementById('search-daily-notes');
    const notesListViewDiv = document.getElementById('notes-list-view');
    if (!searchDailyNotesInput || !notesListViewDiv) return;

    const searchTerm = searchDailyNotesInput.value.trim();

    if (searchTerm === '') {
        if (currentNotesFolder) {
            loadNotesForFolder(currentNotesFolder);
        } else {
            notesListViewDiv.innerHTML = '<p>请输入搜索词或选择一个文件夹。</p>';
        }
        return;
    }

    notesListViewDiv.innerHTML = '<p>正在搜索日记...</p>';
    try {
        const searchUrl = currentNotesFolder
            ? `${API_BASE_URL}/dailynotes/search?term=${encodeURIComponent(searchTerm)}&folder=${encodeURIComponent(currentNotesFolder)}`
            : `${API_BASE_URL}/dailynotes/search?term=${encodeURIComponent(searchTerm)}`;

        const data = await apiFetch(searchUrl);
        notesListViewDiv.innerHTML = '';

        if (data.notes && data.notes.length > 0) {
            data.notes.forEach(note => {
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

function renderNoteCard(note, folderName) {
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
        updateActionButtonStatus();
    });

    card.innerHTML = `
        <p class="note-card-filename">${note.name}</p>
        <p class="note-card-preview">${note.preview || `修改于: ${new Date(note.lastModified).toLocaleString()}`}</p>
        <div class="note-card-actions">
            <button class="edit-note-btn">编辑</button>
        </div>
    `;
    card.insertBefore(checkbox, card.firstChild);

    card.querySelector('.edit-note-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteForEditing(folderName, note.name);
    });

    card.addEventListener('click', (e) => {
        if (e.target !== checkbox && !e.target.closest('.note-card-actions')) {
             openNoteForEditing(folderName, note.name);
        }
    });
    return card;
}

function updateActionButtonStatus() {
    const moveSelectedNotesButton = document.getElementById('move-selected-notes');
    const moveTargetFolderSelect = document.getElementById('move-target-folder');
    const deleteSelectedNotesButton = document.getElementById('delete-selected-notes-button');
    const hasSelection = selectedNotes.size > 0;
    if (moveSelectedNotesButton) moveSelectedNotesButton.disabled = !hasSelection;
    if (moveTargetFolderSelect) moveTargetFolderSelect.disabled = !hasSelection;
    if (deleteSelectedNotesButton) deleteSelectedNotesButton.disabled = !hasSelection;
}

async function openNoteForEditing(folderName, fileName) {
    const notesActionStatusSpan = document.getElementById('notes-action-status');
    const editingNoteFolderInput = document.getElementById('editing-note-folder');
    const editingNoteFileInput = document.getElementById('editing-note-file');
    const noteContentEditorTextarea = document.getElementById('note-content-editor');
    const noteEditorAreaDiv = document.getElementById('note-editor-area');
    const noteEditorStatusSpan = document.getElementById('note-editor-status');

    if (notesActionStatusSpan) notesActionStatusSpan.textContent = '';
    try {
        const data = await apiFetch(`${API_BASE_URL}/dailynotes/note/${folderName}/${fileName}`);
        if (editingNoteFolderInput) editingNoteFolderInput.value = folderName;
        if (editingNoteFileInput) editingNoteFileInput.value = fileName;
        
        if (easyMDE) {
            easyMDE.toTextArea();
            easyMDE = null;
        }
        
        if (noteContentEditorTextarea) {
            noteContentEditorTextarea.value = data.content;
            easyMDE = new EasyMDE({
                element: noteContentEditorTextarea,
                spellChecker: false,
                status: ['lines', 'words', 'cursor'],
                minHeight: "500px",
                maxHeight: "800px"
            });
        }

        document.getElementById('notes-list-view').style.display = 'none';
        document.querySelector('.notes-sidebar').style.display = 'none';
        document.querySelector('.notes-toolbar').style.display = 'none';
        document.querySelector('.notes-content-area').style.display = 'none';
        if (noteEditorAreaDiv) noteEditorAreaDiv.style.display = 'block';
        if (noteEditorStatusSpan) noteEditorStatusSpan.textContent = `正在编辑: ${folderName}/${fileName}`;
    } catch (error) {
        showMessage(`打开日记 ${fileName} 失败: ${error.message}`, 'error');
    }
}

async function saveNoteChanges() {
    const editingNoteFolderInput = document.getElementById('editing-note-folder');
    const editingNoteFileInput = document.getElementById('editing-note-file');
    const noteEditorStatusSpan = document.getElementById('note-editor-status');

    const folderName = editingNoteFolderInput.value;
    const fileName = editingNoteFileInput.value;
    const content = easyMDE.value();

    if (!folderName || !fileName) {
        showMessage('无法保存日记，缺少文件信息。', 'error');
        return;
    }
    if (noteEditorStatusSpan) noteEditorStatusSpan.textContent = '正在保存...';
    try {
        await apiFetch(`${API_BASE_URL}/dailynotes/note/${folderName}/${fileName}`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        showMessage(`日记 ${fileName} 已成功保存!`, 'success');
        closeNoteEditor();
        if (currentNotesFolder === folderName) {
            loadNotesForFolder(folderName);
        }
    } catch (error) {
        if (noteEditorStatusSpan) noteEditorStatusSpan.textContent = `保存失败: ${error.message}`;
    }
}

function closeNoteEditor() {
    const noteEditorAreaDiv = document.getElementById('note-editor-area');
    if (easyMDE) {
        easyMDE.toTextArea();
        easyMDE = null;
    }
    if (noteEditorAreaDiv) noteEditorAreaDiv.style.display = 'none';
    
    document.getElementById('editing-note-folder').value = '';
    document.getElementById('editing-note-file').value = '';
    document.getElementById('note-content-editor').value = '';
    document.getElementById('note-editor-status').textContent = '';
    
    document.getElementById('notes-list-view').style.display = 'grid';
    document.querySelector('.notes-sidebar').style.display = 'block';
    document.querySelector('.notes-toolbar').style.display = 'flex';
    document.querySelector('.notes-content-area').style.display = 'flex';
}

async function moveSelectedNotesHandler() {
    const moveTargetFolderSelect = document.getElementById('move-target-folder');
    const notesActionStatusSpan = document.getElementById('notes-action-status');
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

    if (notesActionStatusSpan) notesActionStatusSpan.textContent = '正在移动...';
    try {
        const response = await apiFetch(`${API_BASE_URL}/dailynotes/move`, {
            method: 'POST',
            body: JSON.stringify({ sourceNotes: notesToMove, targetFolder })
        });
        showMessage(response.message || `${notesToMove.length} 个日记已移动。`, response.errors?.length > 0 ? 'error' : 'success');
        if (response.errors?.length > 0) {
            console.error('移动日记时发生错误:', response.errors);
            if (notesActionStatusSpan) notesActionStatusSpan.textContent = `部分移动失败: ${response.errors.map(e => e.error).join(', ')}`;
        } else {
             if (notesActionStatusSpan) notesActionStatusSpan.textContent = '';
        }
        
        const folderToReload = currentNotesFolder;
        selectedNotes.clear();
        updateActionButtonStatus();
        await loadNotesFolders();
        
        if (folderToReload) {
             const currentFolderLi = document.querySelector(`#notes-folder-list li[data-folder-name="${folderToReload}"]`);
             if (currentFolderLi) {
                currentFolderLi.click();
             } else if (document.querySelector('#notes-folder-list li')) {
                document.querySelector('#notes-folder-list li').click();
             } else {
                document.getElementById('notes-list-view').innerHTML = '<p>请选择一个文件夹。</p>';
             }
        }
    } catch (error) {
        if (notesActionStatusSpan) notesActionStatusSpan.textContent = `移动失败: ${error.message}`;
    }
}

async function deleteSelectedNotesHandler() {
    const notesActionStatusSpan = document.getElementById('notes-action-status');
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

    if (notesActionStatusSpan) notesActionStatusSpan.textContent = '正在删除...';
    try {
        const response = await apiFetch(`${API_BASE_URL}/dailynotes/delete-batch`, {
            method: 'POST',
            body: JSON.stringify({ notesToDelete })
        });
        showMessage(response.message || `${notesToDelete.length} 个日记已删除。`, response.errors?.length > 0 ? 'warning' : 'success');
        
        if (response.errors?.length > 0) {
            console.error('删除日记时发生错误:', response.errors);
            if (notesActionStatusSpan) notesActionStatusSpan.textContent = `部分删除失败: ${response.errors.map(e => e.error).join(', ')}`;
        } else {
            if (notesActionStatusSpan) notesActionStatusSpan.textContent = '';
        }

        const folderToReload = currentNotesFolder;
        selectedNotes.clear();
        updateActionButtonStatus();
        await loadNotesFolders();

        if (folderToReload) {
            const currentFolderLi = document.querySelector(`#notes-folder-list li[data-folder-name="${folderToReload}"]`);
            if (currentFolderLi) {
                currentFolderLi.click();
            } else if (document.querySelector('#notes-folder-list li')) {
                document.querySelector('#notes-folder-list li').click();
            } else {
                document.getElementById('notes-list-view').innerHTML = '<p>请选择一个文件夹。</p>';
            }
        } else if (document.querySelector('#notes-folder-list li')) {
             document.querySelector('#notes-folder-list li').click();
        } else {
            document.getElementById('notes-list-view').innerHTML = '<p>没有日记可以显示。</p>';
        }
    } catch (error) {
        if (notesActionStatusSpan) notesActionStatusSpan.textContent = `删除失败: ${error.message}`;
    }
}

// --- RAG Tags Config Functions ---
async function loadRagTagsConfig() {
    try {
        ragTagsData = await apiFetch(`${API_BASE_URL}/rag-tags`, {}, false);
    } catch (error) {
        console.error('[RAGTags] Failed to load RAG-Tags config:', error);
        ragTagsData = {};
    }
}

function displayRagTagsForFolder(folderName) {
    const ragTagsConfigAreaDiv = document.getElementById('rag-tags-config-area');
    const ragTagsFolderNameSpan = document.getElementById('rag-tags-folder-name');
    const ragThresholdEnabledCheckbox = document.getElementById('rag-threshold-enabled');
    const ragThresholdValueSlider = document.getElementById('rag-threshold-value');
    const ragThresholdDisplaySpan = document.getElementById('rag-threshold-display');
    const ragTagsContainer = document.getElementById('rag-tags-container');
    const ragTagsStatusSpan = document.getElementById('rag-tags-status');

    currentRagFolder = folderName;
    if (ragTagsFolderNameSpan) ragTagsFolderNameSpan.textContent = folderName;
    
    const folderConfig = ragTagsData[folderName] || {};
    const tags = folderConfig.tags || [];
    const threshold = folderConfig.threshold;
    
    if (ragThresholdEnabledCheckbox) {
        if (threshold !== undefined) {
            ragThresholdEnabledCheckbox.checked = true;
            if (ragThresholdValueSlider) ragThresholdValueSlider.value = threshold;
            if (ragThresholdValueSlider) ragThresholdValueSlider.disabled = false;
            if (ragThresholdDisplaySpan) ragThresholdDisplaySpan.textContent = threshold.toFixed(2);
        } else {
            ragThresholdEnabledCheckbox.checked = false;
            if (ragThresholdValueSlider) ragThresholdValueSlider.value = 0.7;
            if (ragThresholdValueSlider) ragThresholdValueSlider.disabled = true;
            if (ragThresholdDisplaySpan) ragThresholdDisplaySpan.textContent = '0.70';
        }
    }
    
    if (ragTagsContainer) {
        ragTagsContainer.innerHTML = '';
        tags.forEach((tagData) => {
            const tagValue = typeof tagData === 'string' ? tagData : (tagData.tag || '');
            addTagItem(tagValue);
        });
    }
    
    if (ragTagsConfigAreaDiv) ragTagsConfigAreaDiv.style.display = 'block';
    if (ragTagsStatusSpan) ragTagsStatusSpan.textContent = '';
}

function addTagItem(value = '') {
    const ragTagsContainer = document.getElementById('rag-tags-container');
    if (!ragTagsContainer) return;

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
    const ragTagsStatusSpan = document.getElementById('rag-tags-status');
    const ragTagsContainer = document.getElementById('rag-tags-container');
    const ragThresholdEnabledCheckbox = document.getElementById('rag-threshold-enabled');
    const ragThresholdValueSlider = document.getElementById('rag-threshold-value');

    if (!currentRagFolder) {
        showMessage('未选中知识库文件夹', 'error');
        return;
    }

    if (ragTagsStatusSpan) {
        ragTagsStatusSpan.textContent = '保存中...';
        ragTagsStatusSpan.className = 'status-message info';
    }

    try {
        const folderConfig = {};
        
        const tagInputs = ragTagsContainer.querySelectorAll('.tag-input');
        const tags = Array.from(tagInputs).map(input => input.value.trim()).filter(Boolean);
        folderConfig.tags = tags;
        
        if (ragThresholdEnabledCheckbox.checked) {
            folderConfig.threshold = parseFloat(ragThresholdValueSlider.value);
        }
        
        if (folderConfig.tags.length > 0 || folderConfig.threshold !== undefined) {
            ragTagsData[currentRagFolder] = folderConfig;
        } else {
            delete ragTagsData[currentRagFolder];
        }
        
        await apiFetch(`${API_BASE_URL}/rag-tags`, {
            method: 'POST',
            body: JSON.stringify(ragTagsData)
        });

        if (ragTagsStatusSpan) {
            ragTagsStatusSpan.textContent = '✓ 保存成功';
            ragTagsStatusSpan.className = 'status-message success';
        }
        showMessage('RAG-Tags配置已保存', 'success');
        
        setTimeout(() => {
            if (ragTagsStatusSpan) ragTagsStatusSpan.textContent = '';
        }, 3000);

    } catch (error) {
        console.error('[RAGTags] Save failed:', error);
        if (ragTagsStatusSpan) {
            ragTagsStatusSpan.textContent = '✗ 保存失败';
            ragTagsStatusSpan.className = 'status-message error';
        }
        showMessage(`保存RAG-Tags配置失败: ${error.message}`, 'error');
    }
}