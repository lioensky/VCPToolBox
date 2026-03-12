(function () {
  const API_BASE = '/AdminPanel/dailynote_api';

  // ------- 本地设置 -------

  const DEFAULT_SETTINGS = {
    blockedNotebooks: [],
    autoBlockClusters: false,
    themeMode: 'auto',          // auto | light | dark
    cardsColumns: 5,
    cardMaxLines: 5,
    pageSize: 100,
    sortMode: 'mtime-desc',     // mtime-desc | mtime-asc | name-asc | name-desc
    globalFontSize: 16          // 全局基础字体大小（px）
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem('DailyNotePanelSettings');
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (e) {
      console.warn('[DailyNotePanel] Failed to load settings:', e);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem('DailyNotePanelSettings', JSON.stringify(settings));
    } catch (e) {
      console.warn('[DailyNotePanel] Failed to save settings:', e);
    }
  }

  let settings = loadSettings();

  // ------- DOM 引用 -------

  const sidebar = document.getElementById('sidebar');
  const notebookList = document.getElementById('notebook-list');
  const notebookMiniList = document.getElementById('notebook-mini-list');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const openSettingsBtn = document.getElementById('open-settings');

  const topBarDefault = document.getElementById('top-bar-default');
  const topBarEditor = document.getElementById('top-bar-editor');
  const topBarSettings = document.getElementById('top-bar-settings');

  const searchInput = document.getElementById('search-input');
  const bulkMoveButton = document.getElementById('bulk-move-button');
  const bulkDeleteButton = document.getElementById('bulk-delete-button');

  const cardsView = document.getElementById('cards-view');
  const editorView = document.getElementById('editor-view');
  const settingsView = document.getElementById('settings-view');

  const cardsContainer = document.getElementById('cards-container');
  const cardsStatus = document.getElementById('cards-status');
  const prevPageBtn = document.getElementById('prev-page');
  const nextPageBtn = document.getElementById('next-page');
  const pageInfoSpan = document.getElementById('page-info');
  const workbenchEntry = document.getElementById('workbench-entry');
  const workbenchMiniEntry = document.getElementById('workbench-mini-entry');
  const workbenchEditorPane = document.getElementById('workbench-editor-pane');
  const workbenchPreviewPane = document.getElementById('workbench-preview-pane');
  const workbenchFilenameSpan = document.getElementById('workbench-filename');
  const workbenchDirtyIndicator = document.getElementById('workbench-dirty-indicator');
  const workbenchSaveButton = document.getElementById('workbench-save-button');
  const workbenchEditorEmpty = document.getElementById('workbench-editor-empty');
  const workbenchEditorTextarea = document.getElementById('workbench-editor-textarea');
  const workbenchPreviewEmpty = document.getElementById('workbench-preview-empty');
  const workbenchPreview = document.getElementById('workbench-preview');

  const deleteModalBackdrop = document.getElementById('delete-modal-backdrop');
  const deleteCountSpan = document.getElementById('delete-count');
  const deleteListContainer = document.getElementById('delete-list');
  const deleteCancelBtn = document.getElementById('delete-cancel');
  const deleteConfirmBtn = document.getElementById('delete-confirm');

  const moveModalBackdrop = document.getElementById('move-modal-backdrop');
  const moveCountSpan = document.getElementById('move-count');
  const moveListContainer = document.getElementById('move-list');
  const moveTargetSelect = document.getElementById('move-target-select');
  const moveTargetHint = document.getElementById('move-target-hint');
  const moveCancelBtn = document.getElementById('move-cancel');
  const moveConfirmBtn = document.getElementById('move-confirm');
  const unsavedModalBackdrop = document.getElementById('unsaved-modal-backdrop');
  const unsavedModalMessage = document.getElementById('unsaved-modal-message');
  const unsavedCancelBtn = document.getElementById('unsaved-cancel');
  const unsavedConfirmBtn = document.getElementById('unsaved-confirm');

  const backToCardsBtn = document.getElementById('back-to-cards');
  const editorFilenameSpan = document.getElementById('editor-filename');
  const editorModeToggle = document.getElementById('editor-mode-toggle');
  const saveNoteButton = document.getElementById('save-note-button');
  const editorTextarea = document.getElementById('editor-textarea');
  const editorPreview = document.getElementById('editor-preview');

  const backFromSettingsBtn = document.getElementById('back-from-settings');
  const blockedNotebooksContainer = document.getElementById('blocked-notebooks-container');
  const autoBlockClustersCheckbox = document.getElementById('auto-block-clusters');
  const themeModeSelect = document.getElementById('theme-mode-select');
  const cardsColumnsInput = document.getElementById('cards-columns');
  const cardMaxLinesInput = document.getElementById('card-max-lines');
  const pageSizeInput = document.getElementById('page-size');
  const sortModeSelect = document.getElementById('sort-mode');
  const globalFontSizeInput = document.getElementById('global-font-size');
  const settingsResetBtn = document.getElementById('settings-reset');
  const forceUpdateBtn = document.getElementById('force-update-btn');
  const settingsStatus = document.getElementById('settings-status');

  // ------- 运行时状态 -------

  const STREAM_NOTEBOOK = '__STREAM__';

  let notebooks = [];            // [{ name }]
  let currentNotebook = null;    // string | STREAM_NOTEBOOK
  let notes = [];                // 当前「源列表」（可能来自单本缓存或日记流聚合）
  let filteredNotes = [];        // 排序 + 过滤后的列表
  let bulkMode = false;          // 批量选择模式
  let bulkAction = null;         // null | move | delete
  let selectedSet = new Set();   // `folder/name` 形式
  let currentPage = 1;           // 简单分页
  let editorState = {
    folder: null,
    file: null,
    mode: 'edit'                 // edit | preview
  };
  let workbenchMode = false;
  let workbenchState = {
    folder: null,
    file: null,
    noteId: null
  };
  let workbenchDirty = false;
  let workbenchBaselineContent = '';
  let workbenchScrollSyncLock = false;
  let workbenchPreviewRaf = null;

  // 全局缓存：每个日记本自己的 notes 列表
  // key: folderName, value: notes[]
  let notebookCache = new Map();
  // 每个日记本的最新 mtime，用于侧边栏发光与日记流聚合
  // key: folderName, value: latestMtime(number)
  let notebookLatestMtime = new Map();

  // 指纹: 普通视图与日记流视图分开管理，避免模式切换时串扰
  let lastNotesFingerprint = null;
  let streamLastFingerprint = null;

  // 高亮定时器：key = `${folderName}/${note.name}`, value = { toYellow, clearAll }
  let highlightTimers = new Map();

  // 操作弹窗状态
  let pendingDeleteFiles = [];
  let pendingMoveFiles = [];
  let pendingMoveTargetFolder = null;
  let pendingUnsavedResolver = null;

  // 卡片区底部轻量反馈
  let cardsFeedbackMessage = '';
  let cardsFeedbackTimer = null;

  // Markdown 预览渲染器配置状态
  let markdownRendererConfigured = false;

  // ------- 工具函数 -------

  async function apiGet(path, options) {
    const res = await fetch(API_BASE + path, {
      headers: { 'Accept': 'application/json' },
      ...(options || {})
    });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  function syncBulkActionButtons() {
    if (bulkMoveButton) {
      bulkMoveButton.classList.toggle('move-active', bulkMode && bulkAction === 'move');
    }
    if (bulkDeleteButton) {
      bulkDeleteButton.classList.toggle('danger-active', bulkMode && bulkAction === 'delete');
    }
  }

  function collectFilesFromSelectedSet() {
    return Array.from(selectedSet).map(id => {
      const separatorIndex = id.indexOf('/');
      return {
        folder: separatorIndex >= 0 ? id.slice(0, separatorIndex) : '',
        file: separatorIndex >= 0 ? id.slice(separatorIndex + 1) : id
      };
    });
  }

  function buildOperationSummary(actionLabel, successCount, errorCount) {
    if (errorCount > 0) {
      return `已${actionLabel} ${successCount} 条，失败 ${errorCount} 条`;
    }
    return `已${actionLabel} ${successCount} 条`;
  }

  function extractStreamCardMaidFromPreview(previewText) {
    const text = String(previewText || '')
      .replace(/^\uFEFF/, '')
      .trimStart();

    if (!text.startsWith('[')) return null;

    const separatorIndex = text.indexOf('] - ');
    if (separatorIndex === -1) return null;

    const tail = text.slice(separatorIndex + 4).trimStart();
    if (!tail) return null;

    const firstSpaceIndex = tail.indexOf(' ');
    const maidName = firstSpaceIndex === -1 ? tail : tail.slice(0, firstSpaceIndex);

    return maidName.trim() || null;
  }

  function setCardsFeedback(message, durationMs) {
    cardsFeedbackMessage = message || '';
    if (cardsFeedbackTimer) {
      clearTimeout(cardsFeedbackTimer);
      cardsFeedbackTimer = null;
    }
    renderCardsStatus();
    if (cardsFeedbackMessage) {
      cardsFeedbackTimer = setTimeout(() => {
        cardsFeedbackMessage = '';
        cardsFeedbackTimer = null;
        renderCardsStatus();
      }, typeof durationMs === 'number' ? durationMs : 4000);
    }
  }

  function getSourceFoldersFromFiles(files) {
    return new Set((files || []).map(item => item.folder).filter(Boolean));
  }

  function normalizeFolderCollection(folders) {
    if (!folders) return [];
    const arr = Array.isArray(folders) ? folders : Array.from(folders);
    return Array.from(new Set(arr.filter(Boolean)));
  }

  function getMoveTargetCandidates(files) {
    const sourceFolders = getSourceFoldersFromFiles(files);
    return getVisibleNotebooks().filter(nb => !sourceFolders.has(nb.name));
  }

  function updateNotebookLatestMtimeFromCache(notebookName) {
    const list = notebookCache.get(notebookName) || [];
    const latest = list.reduce(
      (max, note) => ((note && note.mtime) > max ? note.mtime : max),
      0
    );
    notebookLatestMtime.set(notebookName, latest);
  }

  function getErroredNoteIdSet(errors) {
    const erroredIds = new Set();
    (errors || []).forEach(item => {
      if (!item) return;
      if (typeof item === 'string') {
        erroredIds.add(item);
        return;
      }
      if (item.note) {
        erroredIds.add(String(item.note));
      }
    });
    return erroredIds;
  }

  function applyLocalMovePatch(files, targetFolder) {
    if (!targetFolder) return 0;

    const targetList = (notebookCache.get(targetFolder) || []).slice();
    let patchedCount = 0;

    (files || []).forEach(item => {
      if (!item || !item.folder || !item.file) return;

      const sourceList = (notebookCache.get(item.folder) || []).slice();
      const sourceIndex = sourceList.findIndex(note => note && note.name === item.file);
      if (sourceIndex === -1) return;

      const [movedNote] = sourceList.splice(sourceIndex, 1);
      notebookCache.set(item.folder, sourceList);
      updateNotebookLatestMtimeFromCache(item.folder);

      const patchedNote = {
        ...movedNote,
        folderName: targetFolder
      };

      const targetIndex = targetList.findIndex(note => note && note.name === item.file);
      if (targetIndex >= 0) {
        targetList[targetIndex] = patchedNote;
      } else {
        targetList.push(patchedNote);
      }

      patchedCount += 1;
    });

    notebookCache.set(targetFolder, targetList);
    updateNotebookLatestMtimeFromCache(targetFolder);

    return patchedCount;
  }

  function renderModalList(container, files) {
    if (!container) return;
    container.innerHTML = '';
    (files || []).forEach(item => {
      const div = document.createElement('div');
      div.className = 'modal-list-item';
      div.textContent = `${item.folder}/${item.file}`;
      container.appendChild(div);
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdownFallback(text) {
    const escaped = escapeHtml(String(text || '')).replace(/\r\n?/g, '\n');
    return `<pre class="markdown-fallback">${escaped}</pre>`;
  }

  function isSafeMarkdownUrl(rawUrl, type) {
    if (typeof rawUrl !== 'string') return false;

    const url = rawUrl.trim();
    if (!url) return false;

    if (url.startsWith('#')) return true;
    if (url.startsWith('/')) return true;
    if (url.startsWith('./') || url.startsWith('../')) return true;

    const lowerUrl = url.toLowerCase();
    if (type === 'src' && lowerUrl.startsWith('data:image/')) {
      return true;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      const protocol = parsed.protocol.toLowerCase();

      if (type === 'href') {
        return (
          protocol === 'http:' ||
          protocol === 'https:' ||
          protocol === 'mailto:' ||
          protocol === 'tel:'
        );
      }

      if (type === 'src') {
        return (
          protocol === 'http:' ||
          protocol === 'https:' ||
          protocol === 'blob:'
        );
      }
    } catch (e) {
      return false;
    }

    return false;
  }

  function sanitizeMarkdownElement(root) {
    const allowedTags = new Set([
      'a', 'blockquote', 'br', 'code', 'del', 'em',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'img', 'input', 'li', 'ol', 'p', 'pre',
      'strong', 'table', 'tbody', 'td', 'th',
      'thead', 'tr', 'ul'
    ]);

    const globalAttrs = new Set(['class']);
    const perTagAttrs = {
      a: new Set(['href', 'title']),
      code: new Set(['class']),
      img: new Set(['src', 'alt', 'title']),
      input: new Set(['type', 'checked', 'disabled']),
      ol: new Set(['start']),
      td: new Set(['align']),
      th: new Set(['align'])
    };

    const nodes = Array.from(root.querySelectorAll('*'));
    nodes.forEach(node => {
      if (!node.parentNode) return;

      const tagName = node.tagName.toLowerCase();
      if (!allowedTags.has(tagName)) {
        node.replaceWith(document.createTextNode(node.outerHTML));
        return;
      }

      const allowedForTag = perTagAttrs[tagName] || new Set();
      Array.from(node.attributes).forEach(attr => {
        const attrName = attr.name.toLowerCase();

        if (attrName.startsWith('on')) {
          node.removeAttribute(attr.name);
          return;
        }

        if (!globalAttrs.has(attrName) && !allowedForTag.has(attrName)) {
          node.removeAttribute(attr.name);
        }
      });

      if (tagName === 'a') {
        const href = node.getAttribute('href') || '';
        if (!isSafeMarkdownUrl(href, 'href')) {
          node.replaceWith(document.createTextNode(node.outerHTML));
          return;
        }
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }

      if (tagName === 'img') {
        const src = node.getAttribute('src') || '';
        if (!isSafeMarkdownUrl(src, 'src')) {
          node.replaceWith(document.createTextNode(node.outerHTML));
          return;
        }
        node.setAttribute('loading', 'lazy');
        node.setAttribute('decoding', 'async');
        node.setAttribute('referrerpolicy', 'no-referrer');
      }

      if (tagName === 'input') {
        const type = (node.getAttribute('type') || '').toLowerCase();
        if (type !== 'checkbox') {
          node.replaceWith(document.createTextNode(node.outerHTML));
          return;
        }
        node.setAttribute('disabled', '');
        node.setAttribute('tabindex', '-1');
        if (node.hasAttribute('checked')) {
          node.setAttribute('checked', '');
        }
      }
    });

    Array.from(root.querySelectorAll('table')).forEach(table => {
      if (table.parentElement && table.parentElement.classList.contains('markdown-table-scroll')) {
        return;
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function sanitizeMarkdownHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    sanitizeMarkdownElement(template.content);
    return template.innerHTML;
  }

  function configureMarkdownRenderer() {
    if (markdownRendererConfigured) return;
    if (typeof marked === 'undefined' || !marked || typeof marked.setOptions !== 'function') {
      return;
    }

    marked.setOptions({
      gfm: true,
      breaks: true
    });

    markdownRendererConfigured = true;
  }

  function renderMarkdown(text) {
    const source = String(text || '');
    if (!source.trim()) return '';

    if (typeof marked === 'undefined' || !marked || typeof marked.parse !== 'function') {
      return renderMarkdownFallback(source);
    }

    try {
      configureMarkdownRenderer();
      return sanitizeMarkdownHtml(marked.parse(source));
    } catch (e) {
      console.warn('[DailyNotePanel] Markdown render failed, falling back to plain text:', e);
      return renderMarkdownFallback(source);
    }
  }

  function applyTheme() {
    const root = document.documentElement;
    const mode = settings.themeMode;
    if (mode === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (mode === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      const prefersDark = window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
  }

  function updateCardsGridColumns() {
    if (workbenchMode) {
      cardsContainer.style.gridTemplateColumns = 'minmax(0, 1fr)';
      return;
    }
    const cols = settings.cardsColumns;
    // 使用固定列数，而不是 auto-fill，让设置更直观
    cardsContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  }

  // 这里不再尝试用 CSS 的 -webkit-line-clamp 做“视觉行数”控制，
  // 而是仅用它做一个“最多 N 行”的软约束。真正的“多 / 少”感受，交给文本本身长度。
  function clampTextLines(element, maxLines) {
    if (!element) return;
    const raw = element.textContent || '';
    if (!raw) return;

    const max = Number(maxLines) || 5;
    const approxCharsPerLine = 40;
    const hardLimit = max * approxCharsPerLine;

    let truncated = raw;
    if (raw.length > hardLimit) {
      truncated = raw.slice(0, hardLimit) + ' …';
    }

    // 彻底不用任何 layout 相关的 CSS 限制，让浏览器老实按内容自然排版
    element.textContent = truncated;
    element.style.display = '';
    element.style.webkitBoxOrient = '';
    element.style.webkitLineClamp = '';
    element.style.overflow = '';
  }

  function sortedNotes(source) {
    const arr = [...source];
    const mode = settings.sortMode;
    arr.sort((a, b) => {
      if (mode === 'mtime-desc') {
        return b.mtime - a.mtime;
      } else if (mode === 'mtime-asc') {
        return a.mtime - b.mtime;
      } else if (mode === 'name-asc') {
        return a.name.localeCompare(b.name, 'zh-CN');
      } else if (mode === 'name-desc') {
        return b.name.localeCompare(a.name, 'zh-CN');
      }
      return 0;
    });
    return arr;
  }

  function applyGlobalFontSize() {
    // 优先使用显式配置；如果没有，则写入默认值并持久化，保证后续变更能生效
    if (
      typeof settings.globalFontSize !== 'number' ||
      Number.isNaN(settings.globalFontSize)
    ) {
      settings.globalFontSize = DEFAULT_SETTINGS.globalFontSize;
      saveSettings(settings);
    }
    const size = settings.globalFontSize;
    document.documentElement.style.fontSize = size + 'px';
  }

  function notebookVisible(name) {
    if (settings.blockedNotebooks.includes(name)) return false;
    if (settings.autoBlockClusters && name.endsWith('簇')) return false;
    return true;
  }

  function isStreamNotebook(name) {
    return name === STREAM_NOTEBOOK;
  }

  function getVisibleNotebooks() {
    return notebooks.filter(n => notebookVisible(n.name));
  }

  function getNoteId(folder, file) {
    return `${folder || ''}/${file || ''}`;
  }

  function hasWorkbenchOpenNote() {
    return !!workbenchState.noteId;
  }

  function doesFileCollectionContainNote(files, noteId) {
    if (!noteId) return false;
    return (files || []).some(item => getNoteId(item.folder, item.file) === noteId);
  }

  function getCurrentNotebookLabel() {
    if (isStreamNotebook(currentNotebook)) return '🔔 日记流';
    return currentNotebook || '当前日记本';
  }

  function updateWorkbenchToggleTitle() {
    const currentLabel = getCurrentNotebookLabel();
    const titleText = workbenchMode
      ? `退出工作台（当前来源：${currentLabel}）`
      : `进入工作台（当前来源：${currentLabel}）`;

    [workbenchEntry, workbenchMiniEntry].forEach(entry => {
      if (!entry) return;
      entry.title = titleText;
      entry.setAttribute('aria-label', titleText);
      entry.setAttribute('aria-pressed', workbenchMode ? 'true' : 'false');
    });
  }

  function updateBulkActionAvailability() {
    const disabled = !!workbenchMode;
    if (bulkMoveButton) {
      bulkMoveButton.disabled = disabled;
      bulkMoveButton.title = disabled
        ? '工作台模式首版暂不支持批量操作'
        : '批量选择转移';
    }
    if (bulkDeleteButton) {
      bulkDeleteButton.disabled = disabled;
      bulkDeleteButton.title = disabled
        ? '工作台模式首版暂不支持批量操作'
        : '批量选择删除';
    }
  }

  function updateWorkbenchDirtyUI() {
    const hasOpenNote = hasWorkbenchOpenNote();
    if (workbenchFilenameSpan) {
      workbenchFilenameSpan.textContent = hasOpenNote
        ? `${workbenchState.folder}/${workbenchState.file}`
        : '未打开日记';
    }
    if (workbenchDirtyIndicator) {
      workbenchDirtyIndicator.classList.toggle('hidden', !hasOpenNote || !workbenchDirty);
    }
    if (workbenchSaveButton) {
      workbenchSaveButton.disabled = !hasOpenNote;
    }
  }

  function setWorkbenchDirty(nextDirty) {
    workbenchDirty = !!nextDirty;
    updateWorkbenchDirtyUI();
  }

  function cancelWorkbenchPreviewUpdate() {
    if (workbenchPreviewRaf != null) {
      cancelAnimationFrame(workbenchPreviewRaf);
      workbenchPreviewRaf = null;
    }
  }

  function updateWorkbenchPreview() {
    if (!workbenchPreview || !workbenchPreviewEmpty) return;

    if (!hasWorkbenchOpenNote()) {
      workbenchPreview.innerHTML = '';
      workbenchPreview.classList.add('hidden');
      workbenchPreviewEmpty.classList.remove('hidden');
      return;
    }

    workbenchPreview.innerHTML = renderMarkdown(
      workbenchEditorTextarea ? workbenchEditorTextarea.value : ''
    );
    workbenchPreview.classList.remove('hidden');
    workbenchPreviewEmpty.classList.add('hidden');
  }

  function requestWorkbenchPreviewUpdate() {
    cancelWorkbenchPreviewUpdate();
    workbenchPreviewRaf = window.requestAnimationFrame(() => {
      workbenchPreviewRaf = null;
      updateWorkbenchPreview();
    });
  }

  function syncWorkbenchScroll(source, target) {
    if (!source || !target || workbenchScrollSyncLock) return;

    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = target.scrollHeight - target.clientHeight;
    if (sourceMax <= 0 || targetMax <= 0) return;

    const ratio = source.scrollTop / sourceMax;
    workbenchScrollSyncLock = true;
    target.scrollTop = ratio * targetMax;

    window.requestAnimationFrame(() => {
      workbenchScrollSyncLock = false;
    });
  }

  function populateWorkbenchWithNote(folder, file, content) {
    workbenchState.folder = folder;
    workbenchState.file = file;
    workbenchState.noteId = getNoteId(folder, file);
    workbenchBaselineContent = String(content || '');
    workbenchScrollSyncLock = false;
    cancelWorkbenchPreviewUpdate();

    if (workbenchEditorTextarea) {
      workbenchEditorTextarea.value = workbenchBaselineContent;
      workbenchEditorTextarea.scrollTop = 0;
      workbenchEditorTextarea.classList.remove('hidden');
    }
    if (workbenchEditorEmpty) {
      workbenchEditorEmpty.classList.add('hidden');
    }
    if (workbenchPreviewEmpty) {
      workbenchPreviewEmpty.classList.add('hidden');
    }
    if (workbenchPreview) {
      workbenchPreview.scrollTop = 0;
    }

    setWorkbenchDirty(false);
    updateWorkbenchPreview();
  }

  function clearWorkbenchState(options) {
    const opts = options || {};

    workbenchState.folder = null;
    workbenchState.file = null;
    workbenchState.noteId = null;
    workbenchBaselineContent = '';
    workbenchScrollSyncLock = false;
    cancelWorkbenchPreviewUpdate();

    if (workbenchEditorTextarea) {
      workbenchEditorTextarea.value = '';
      workbenchEditorTextarea.scrollTop = 0;
      workbenchEditorTextarea.classList.add('hidden');
    }
    if (workbenchPreview) {
      workbenchPreview.innerHTML = '';
      workbenchPreview.scrollTop = 0;
      workbenchPreview.classList.add('hidden');
    }
    if (workbenchEditorEmpty) {
      workbenchEditorEmpty.classList.remove('hidden');
    }
    if (workbenchPreviewEmpty) {
      workbenchPreviewEmpty.classList.remove('hidden');
    }

    setWorkbenchDirty(false);

    if (opts.renderCards !== false) {
      renderCards();
    }
  }

  function currentWorkbenchNoteExists() {
    if (!hasWorkbenchOpenNote()) return false;

    if (isStreamNotebook(currentNotebook)) {
      return getVisibleNotebooks().some(nb => {
        const list = notebookCache.get(nb.name) || [];
        return list.some(note => getNoteId(note.folderName || nb.name, note.name) === workbenchState.noteId);
      });
    }

    const list = notebookCache.get(currentNotebook) || [];
    return list.some(note => getNoteId(note.folderName || currentNotebook, note.name) === workbenchState.noteId);
  }

  function reconcileWorkbenchStateAfterListRefresh() {
    if (!workbenchMode || !hasWorkbenchOpenNote()) return;
    if (currentWorkbenchNoteExists()) return;

    if (workbenchDirty) {
      setCardsFeedback('当前工作台文档已不在左列中，已保留未保存内容', 4000);
      return;
    }

    clearWorkbenchState({ renderCards: false });
  }

  function updateWorkbenchLayout() {
    if (cardsView) {
      cardsView.classList.toggle('workbench-mode', workbenchMode);
    }
    if (workbenchEditorPane) {
      workbenchEditorPane.classList.toggle('hidden', !workbenchMode);
    }
    if (workbenchPreviewPane) {
      workbenchPreviewPane.classList.toggle('hidden', !workbenchMode);
    }
    if (workbenchEntry) {
      workbenchEntry.classList.toggle('active', workbenchMode);
    }
    if (workbenchMiniEntry) {
      workbenchMiniEntry.classList.toggle('active', workbenchMode);
    }

    updateBulkActionAvailability();
    updateCardsGridColumns();
    updateWorkbenchDirtyUI();
  }

  function confirmDiscardWorkbenchChanges(message) {
    if (!workbenchMode || !workbenchDirty) {
      return Promise.resolve(true);
    }

    const promptMessage = message || '当前日记还有未保存修改，确认离开并放弃这些内容吗？';

    if (!unsavedModalBackdrop || !unsavedModalMessage) {
      return Promise.resolve(window.confirm(promptMessage));
    }

    if (pendingUnsavedResolver) {
      const resolver = pendingUnsavedResolver;
      pendingUnsavedResolver = null;
      resolver(false);
    }

    unsavedModalMessage.textContent = promptMessage;
    unsavedModalBackdrop.classList.remove('hidden');

    return new Promise(resolve => {
      pendingUnsavedResolver = resolve;
    });
  }

  async function switchNotebook(notebookName) {
    const targetNotebook = notebookName || STREAM_NOTEBOOK;
    const isActualSwitch = targetNotebook !== currentNotebook;

    if (isActualSwitch && workbenchMode && workbenchDirty) {
      const ok = await confirmDiscardWorkbenchChanges(
        '切换日记本将放弃当前工作台中的未保存修改，确定继续吗？'
      );
      if (!ok) return;
    }

    if (isActualSwitch && workbenchMode) {
      clearWorkbenchState({ renderCards: false });
    }

    currentNotebook = targetNotebook;
    localStorage.setItem('DailyNotePanel_LastNotebook', currentNotebook);

    bulkMode = false;
    bulkAction = null;
    selectedSet.clear();
    syncBulkActionButtons();
    updateBulkActionAvailability();

    updateSidebarActiveState();
    showCardsView();
    currentPage = 1;
    refreshCurrentViewFromCache();
    updateSearchUIForCurrentNotebook();
    updateWorkbenchToggleTitle();
  }

  // ------- 侧边栏渲染 -------

  function updateSidebarActiveState() {
    // 更新展开列表
    const items = notebookList.querySelectorAll('.notebook-item');
    items.forEach(item => {
      if (item.dataset.notebook === currentNotebook) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // 更新折叠列表
    const minis = notebookMiniList.querySelectorAll('.notebook-mini-item');
    minis.forEach(item => {
      if (item.dataset.notebook === currentNotebook) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  function updateSidebarGlow() {
    const now = Date.now();
    
    // 辅助函数：处理单个 DOM 元素的 glow 类
    const applyGlow = (el, mtime) => {
      if (!mtime) {
        el.classList.remove('glow-green-side', 'glow-yellow-side');
        return;
      }
      const diff = now - mtime;
      const diffMin = diff / 60000;
      
      el.classList.remove('glow-green-side', 'glow-yellow-side');
      if (diffMin <= 10) {
        el.classList.add('glow-green-side');
      } else if (diffMin <= 30) {
        el.classList.add('glow-yellow-side');
      }
    };

    // 1. 处理普通日记本
    notebookLatestMtime.forEach((mtime, name) => {
      // 展开列表
      const item = notebookList.querySelector(`.notebook-item[data-notebook="${name}"]`);
      if (item) applyGlow(item, mtime);
      // 折叠列表
      const mini = notebookMiniList.querySelector(`.notebook-mini-item[data-notebook="${name}"]`);
      if (mini) applyGlow(mini, mtime);
    });

    // 2. 处理日记流（取所有可见日记本中最新的 mtime）
    // 日记流不再参与发光逻辑，仅普通日记本发光
  }

  function renderNotebookLists() {
    notebookList.innerHTML = '';
    notebookMiniList.innerHTML = '';

    const visibleNotebooks = getVisibleNotebooks();
    const activeName = currentNotebook;

    // 顶部插入「日记流」条目
    // 展开模式
    const streamItem = document.createElement('div');
    streamItem.className = 'notebook-item stream-item';
    streamItem.dataset.notebook = STREAM_NOTEBOOK;
    if (isStreamNotebook(activeName)) streamItem.classList.add('active');

    const streamDot = document.createElement('div');
    streamDot.className = 'notebook-dot stream-dot';

    const streamNameSpan = document.createElement('span');
    streamNameSpan.className = 'notebook-name';
    streamNameSpan.textContent = '🔔 日记流';

    streamItem.appendChild(streamDot);
    streamItem.appendChild(streamNameSpan);
    streamItem.addEventListener('click', () => {
      switchNotebook(STREAM_NOTEBOOK).catch(console.error);
    });
    notebookList.appendChild(streamItem);

    // 折叠模式
    const miniStream = document.createElement('div');
    miniStream.className = 'notebook-mini-item stream-mini-item';
    miniStream.dataset.notebook = STREAM_NOTEBOOK;
    if (isStreamNotebook(activeName)) miniStream.classList.add('active');
    miniStream.textContent = '🔔';
    miniStream.addEventListener('click', () => {
      switchNotebook(STREAM_NOTEBOOK).catch(console.error);
    });
    notebookMiniList.appendChild(miniStream);

    // 普通日记本
    visibleNotebooks.forEach(nb => {
      const li = document.createElement('div');
      li.className = 'notebook-item';
      li.dataset.notebook = nb.name;
      if (nb.name === activeName) li.classList.add('active');

      const dot = document.createElement('div');
      dot.className = 'notebook-dot';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'notebook-name';
      nameSpan.textContent = nb.name;

      li.appendChild(dot);
      li.appendChild(nameSpan);

      li.addEventListener('click', () => {
        switchNotebook(nb.name).catch(console.error);
      });

      notebookList.appendChild(li);
    });

    visibleNotebooks.forEach(nb => {
      const mini = document.createElement('div');
      mini.className = 'notebook-mini-item';
      mini.dataset.notebook = nb.name;
      if (nb.name === activeName) mini.classList.add('active');

      const firstChar = (nb.name || '').trim().charAt(0) || '?';
      mini.textContent = firstChar;

      mini.addEventListener('click', () => {
        switchNotebook(nb.name).catch(console.error);
      });

      notebookMiniList.appendChild(mini);
    });
  }

  // ------- 搜索 & 排序 -------

  async function refreshNotesUsingSearchIfNeeded() {
    if (!searchInput) {
      filteredNotes = sortedNotes(notes);
      return;
    }
    // 日记流中禁用搜索：直接使用当前 notes
    if (isStreamNotebook(currentNotebook)) {
      filteredNotes = sortedNotes(notes);
      return;
    }

    const q = (searchInput.value || '').trim();
    if (!q) {
      // 无搜索词时，notes 已由缓存或单本加载填充
      filteredNotes = sortedNotes(notes);
      return;
    }

    const params = new URLSearchParams();
    // 官方 API 使用 term 而不是 q
    params.set('term', q);
    if (currentNotebook) {
      params.set('folder', currentNotebook);
    }

    try {
      const data = await apiGet('/search?' + params.toString());
      // 官方 search 返回的 notes 带有 folderName/name/lastModified/preview
      notes = (data.notes || []).map(n => {
        const mtime =
          n.mtime != null
            ? n.mtime
            : n.lastModified
            ? new Date(n.lastModified).getTime()
            : 0;
        return {
          folderName: n.folderName || currentNotebook || '',
          name: n.name,
          mtime,
          size: n.size != null ? n.size : 0,
          preview: n.preview
        };
      });
      filteredNotes = sortedNotes(notes);
    } catch (e) {
      console.error('[DailyNotePanel] search error:', e);
      // 搜索失败时不改变原 notes，只前端退回空过滤
      filteredNotes = sortedNotes(notes);
    }
  }

  function computeFingerprint(list) {
    if (!list || list.length === 0) return '0:0:0';

    const total = list.length;
    let latest = 0;
    let hash = 0;

    list.forEach(note => {
      const mtime = Number(note && note.mtime) || 0;
      if (mtime > latest) latest = mtime;

      const key = `${note && note.folderName ? note.folderName : ''}/${note && note.name ? note.name : ''}@${mtime}`;
      for (let i = 0; i < key.length; i += 1) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
      }
    });

    return `${total}:${latest}:${hash}`;
  }

  // ------- 卡片渲染 -------

  async function recomputeAndRenderCards() {
    // 如果有搜索词，使用 /search；否则使用当前 notes
    await refreshNotesUsingSearchIfNeeded();
    currentPage = 1;
    renderCards();
  }

  function renderCards() {
    // 渲染前先清理所有旧的高亮定时器，避免内存泄漏和重复切换
    highlightTimers.forEach(timerObj => {
      if (timerObj.toYellow) clearTimeout(timerObj.toYellow);
      if (timerObj.clearAll) clearTimeout(timerObj.clearAll);
    });
    highlightTimers.clear();

    cardsContainer.innerHTML = '';
    const total = filteredNotes.length;
    const pageSize = settings.pageSize;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > maxPage) currentPage = maxPage;

    const start = (currentPage - 1) * pageSize;
    const end = Math.min(total, start + pageSize);
    const slice = filteredNotes.slice(start, end);

    const currentFingerprint = computeFingerprint(filteredNotes);
    if (isStreamNotebook(currentNotebook)) {
      streamLastFingerprint = currentFingerprint;
    } else {
      lastNotesFingerprint = currentFingerprint;
    }

    const now = Date.now();

    slice.forEach(note => {
      const card = document.createElement('div');
      card.className = 'note-card';

      const folderName = note.folderName || currentNotebook || '';
      const noteId = `${folderName}/${note.name}`;

      // 基于修改时间添加发光高亮，且注册后续状态切换定时器：
      // - 10 分钟内：绿色
      // - 10–30 分钟内：黄色
      // - 超过 30 分钟：无高亮
      if (note.mtime && typeof note.mtime === 'number') {
        const diffMs = now - note.mtime;
        const diffMinutes = diffMs / 60000;

        let toYellowTimer = null;
        let clearAllTimer = null;

        if (diffMinutes <= 10) {
          card.classList.add('glow-green');

          // 距离 10 分钟还有多久，届时从绿变黄
          const msToYellow = Math.max(0, 10 * 60000 - diffMs);
          toYellowTimer = setTimeout(() => {
            card.classList.remove('glow-green');
            card.classList.add('glow-yellow');
          }, msToYellow);

          // 距离 30 分钟还有多久，届时移除所有高亮
          const msToClear = Math.max(0, 30 * 60000 - diffMs);
          clearAllTimer = setTimeout(() => {
            card.classList.remove('glow-green');
            card.classList.remove('glow-yellow');
          }, msToClear);
        } else if (diffMinutes > 10 && diffMinutes <= 30) {
          card.classList.add('glow-yellow');

          // 距离 30 分钟还有多久，届时移除黄色高亮
          const msToClear = Math.max(0, 30 * 60000 - diffMs);
          clearAllTimer = setTimeout(() => {
            card.classList.remove('glow-yellow');
          }, msToClear);
        }

        if (toYellowTimer || clearAllTimer) {
          highlightTimers.set(noteId, {
            toYellow: toYellowTimer,
            clearAll: clearAllTimer
          });
        }
      }

      if (selectedSet.has(noteId)) card.classList.add('selected');
      if (workbenchMode && workbenchState.noteId === noteId) {
        card.classList.add('workbench-active');
      }

      const header = document.createElement('div');
      header.className = 'note-card-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'note-card-title-wrap';

      let checkbox = null;
      if (bulkMode) {
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'note-checkbox';
        checkbox.checked = selectedSet.has(noteId);
        checkbox.addEventListener('click', e => {
          e.stopPropagation();
          if (checkbox.checked) {
            selectedSet.add(noteId);
          } else {
            selectedSet.delete(noteId);
          }
          renderCardsStatus();
        });
        titleWrap.appendChild(checkbox);
      }

      const title = document.createElement('h3');
      title.className = 'note-filename';
      if (isStreamNotebook(currentNotebook)) {
        // 日记流标题：`日记本名 - maid名`
        // maid 仅从当前 preview 的首段解析，不再错误地回退成 notebook 名
        const maidName = extractStreamCardMaidFromPreview(note.preview) || '未知';

        title.innerHTML = `<strong>${folderName}</strong><span class="stream-card-title-maid"> - ${maidName}</span>`;
        title.classList.add('stream-card-title');
        // 动态设置字号：全局字号 + 1px
        const baseSize = settings.globalFontSize || 16;
        title.style.fontSize = (baseSize + 1) + 'px';
      } else {
        title.textContent = note.name;
      }
      titleWrap.appendChild(title);
      header.appendChild(titleWrap);

      if (!bulkMode) {
        const actions = document.createElement('div');
        actions.className = 'note-card-actions';

        const moveButton = document.createElement('button');
        moveButton.type = 'button';
        moveButton.className = 'note-action-button note-action-move';
        moveButton.title = '转移这条日记';
        moveButton.textContent = '⇄';
        moveButton.addEventListener('click', async e => {
          e.stopPropagation();
          if (workbenchMode && workbenchDirty && workbenchState.noteId === noteId) {
            const ok = await confirmDiscardWorkbenchChanges(
              '转移当前正在编辑的日记会放弃未保存修改，确定继续吗？'
            );
            if (!ok) return;
          }
          openMoveModal([{ folder: folderName, file: note.name }]);
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'note-action-button note-action-delete';
        deleteButton.title = '删除这条日记';
        deleteButton.textContent = '🗑';
        deleteButton.addEventListener('click', async e => {
          e.stopPropagation();
          if (workbenchMode && workbenchDirty && workbenchState.noteId === noteId) {
            const ok = await confirmDiscardWorkbenchChanges(
              '删除当前正在编辑的日记会放弃未保存修改，确定继续吗？'
            );
            if (!ok) return;
          }
          openDeleteModal([{ folder: folderName, file: note.name }]);
        });

        actions.appendChild(moveButton);
        actions.appendChild(deleteButton);
        header.appendChild(actions);
      }

      const meta = document.createElement('div');
      meta.className = 'note-meta';
      const d = new Date(note.mtime);
      meta.textContent = `修改于：${d.toLocaleString()}`;

      const preview = document.createElement('div');
      preview.className = 'note-preview';
      // 卡片预览使用纯文本，避免轻量 Markdown 渲染带来的兼容性和样式不稳定问题
      preview.textContent = note.preview || '';
      clampTextLines(preview, settings.cardMaxLines);

      card.appendChild(header);
      card.appendChild(meta);
      card.appendChild(preview);

      card.addEventListener('click', () => {
        if (bulkMode) {
          const exist = selectedSet.has(noteId);
          if (exist) {
            selectedSet.delete(noteId);
          } else {
            selectedSet.add(noteId);
          }
          renderCards();
          renderCardsStatus();
          return;
        }
        if (workbenchMode) {
          openWorkbenchNote(folderName, note.name).catch(console.error);
          return;
        }
        openEditor(folderName, note.name);
      });

      cardsContainer.appendChild(card);
    });

    renderCardsStatus();
  }

  function renderCardsStatus() {
    const total = filteredNotes.length;
    const pageSize = settings.pageSize;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const selectionCount = selectedSet.size;

    const bulkActionLabel =
      bulkAction === 'move'
        ? '批量转移模式'
        : bulkAction === 'delete'
        ? '批量删除模式'
        : '批量选择模式';

    cardsStatus.textContent =
      `共 ${total} 条日记` +
      (bulkMode ? ` | ${bulkActionLabel} | 已选中 ${selectionCount} 条` : '') +
      (cardsFeedbackMessage ? ` | ${cardsFeedbackMessage}` : '');

    if (pageInfoSpan) {
      pageInfoSpan.textContent = `第 ${currentPage}/${maxPage} 页`;
    }
    if (prevPageBtn) {
      prevPageBtn.disabled = currentPage <= 1;
    }
    if (nextPageBtn) {
      nextPageBtn.disabled = currentPage >= maxPage;
    }
  }

  // ------- 模式切换 -------

  function showCardsView() {
    cardsView.classList.remove('hidden');
    editorView.classList.add('hidden');
    settingsView.classList.add('hidden');

    topBarDefault.classList.remove('hidden');
    topBarEditor.classList.add('hidden');
    topBarSettings.classList.add('hidden');

    updateWorkbenchLayout();
    updateWorkbenchToggleTitle();
    updateWorkbenchDirtyUI();
  }

  function showEditorView() {
    cardsView.classList.add('hidden');
    editorView.classList.remove('hidden');
    settingsView.classList.add('hidden');

    topBarDefault.classList.add('hidden');
    topBarEditor.classList.remove('hidden');
    topBarSettings.classList.add('hidden');
  }

  function showSettingsView() {
    cardsView.classList.add('hidden');
    editorView.classList.add('hidden');
    settingsView.classList.remove('hidden');

    topBarDefault.classList.add('hidden');
    topBarEditor.classList.add('hidden');
    topBarSettings.classList.remove('hidden');
  }

  async function enterWorkbenchMode() {
    if (workbenchMode) return true;
    exitBulkModeImmediately();
    workbenchMode = true;
    updateWorkbenchLayout();
    updateWorkbenchToggleTitle();
    renderCards();
    return true;
  }

  async function exitWorkbenchMode() {
    if (!workbenchMode) return true;

    if (workbenchDirty) {
      const ok = await confirmDiscardWorkbenchChanges(
        '退出工作台将放弃当前未保存修改，确定继续吗？'
      );
      if (!ok) return false;
    }

    workbenchMode = false;
    clearWorkbenchState({ renderCards: false });
    updateWorkbenchLayout();
    updateWorkbenchToggleTitle();
    renderCards();
    return true;
  }

  async function toggleWorkbenchMode() {
    return workbenchMode ? exitWorkbenchMode() : enterWorkbenchMode();
  }

  // ------- 事件绑定 -------

  function updateBulkModeUI() {
    if (workbenchMode) {
      bulkMode = false;
      bulkAction = null;
      selectedSet.clear();
    } else if (!bulkMode) {
      selectedSet.clear();
      bulkAction = null;
    }
    syncBulkActionButtons();
    updateBulkActionAvailability();
    renderCards();
  }

  function exitBulkModeImmediately() {
    if (!bulkMode && !bulkAction && selectedSet.size === 0) {
      renderCardsStatus();
      return;
    }
    bulkMode = false;
    bulkAction = null;
    selectedSet.clear();
    updateBulkModeUI();
  }

  function handleBulkActionClick(action) {
    if (workbenchMode) {
      setCardsFeedback('工作台模式首版暂不支持批量操作');
      return;
    }

    const hasSelection = selectedSet.size > 0;

    if (!bulkMode) {
      bulkMode = true;
      bulkAction = action;
      updateBulkModeUI();
      return;
    }

    if (!hasSelection) {
      if (bulkAction === action) {
        bulkMode = false;
        updateBulkModeUI();
      } else {
        bulkAction = action;
        syncBulkActionButtons();
        updateBulkActionAvailability();
        renderCardsStatus();
      }
      return;
    }

    bulkAction = action;
    syncBulkActionButtons();
    updateBulkActionAvailability();
    const files = collectFilesFromSelectedSet();
    if (action === 'move') {
      openMoveModal(files);
    } else {
      openDeleteModal(files);
    }
  }

  function bindEvents() {
    if (toggleSidebarBtn) {
      toggleSidebarBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
      });
    }

    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        const total = filteredNotes.length;
        const pageSize = settings.pageSize;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        if (currentPage > 1) {
          currentPage -= 1;
          renderCards();
        }
      });
    }

    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        const total = filteredNotes.length;
        const pageSize = settings.pageSize;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        if (currentPage < maxPage) {
          currentPage += 1;
          renderCards();
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (isStreamNotebook(currentNotebook)) {
          // 日记流禁用搜索：清空输入并忽略
          searchInput.value = '';
          return;
        }
        recomputeAndRenderCards().catch(console.error);
      });
    }

    if (bulkMoveButton) {
      bulkMoveButton.addEventListener('click', () => {
        handleBulkActionClick('move');
      });
    }

    if (bulkDeleteButton) {
      bulkDeleteButton.addEventListener('click', () => {
        handleBulkActionClick('delete');
      });
    }

    [workbenchEntry, workbenchMiniEntry].forEach(entry => {
      if (!entry) return;

      entry.addEventListener('click', () => {
        toggleWorkbenchMode().catch(console.error);
      });

      entry.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleWorkbenchMode().catch(console.error);
      });
    });

    if (backToCardsBtn) {
      backToCardsBtn.addEventListener('click', () => {
        showCardsView();
      });
    }

    if (editorModeToggle) {
      editorModeToggle.addEventListener('click', () => {
        if (editorState.mode === 'edit') {
          editorState.mode = 'preview';
          editorTextarea.classList.add('hidden');
          editorPreview.classList.remove('hidden');
          editorPreview.innerHTML = renderMarkdown(editorTextarea.value);
        } else {
          editorState.mode = 'edit';
          editorTextarea.classList.remove('hidden');
          editorPreview.classList.add('hidden');
        }
      });
    }

    if (saveNoteButton) {
      saveNoteButton.addEventListener('click', async () => {
        if (!editorState.folder || !editorState.file) return;
        try {
          await apiPost(
            `/note/${editorState.folder}/${editorState.file}`,
            { content: editorTextarea.value }
          );

          // 保存成功后，刷新对应日记本缓存，并基于缓存重建当前视图
          await refreshSingleNotebookCache(editorState.folder);

          if (isStreamNotebook(currentNotebook)) {
            // 当前是日记流：使用最新缓存重新聚合所有可见日记本
            const visibleNow = getVisibleNotebooks();
            const allNotes = [];
            visibleNow.forEach(nb => {
              const list = notebookCache.get(nb.name);
              if (!Array.isArray(list) || list.length === 0) return;
              list.forEach(note => {
                allNotes.push({
                  ...note,
                  folderName: note.folderName || nb.name
                });
              });
            });
            allNotes.sort((a, b) => b.mtime - a.mtime);
            notes = allNotes;
            filteredNotes = allNotes;
            currentPage = 1;
            renderCards();
          } else if (currentNotebook === editorState.folder) {
            // 当前就在被编辑的日记本：从缓存重建该本视图
            const list = notebookCache.get(editorState.folder) || [];
            notes = list.slice();
            filteredNotes = sortedNotes(notes);
            currentPage = 1;
            renderCards();
          }
          showCardsView();
        } catch (e) {
          console.error('[DailyNotePanel] save error:', e);
        }
      });
    }

    if (workbenchSaveButton) {
      workbenchSaveButton.addEventListener('click', () => {
        saveWorkbenchNote().catch(console.error);
      });
    }

    if (workbenchEditorTextarea) {
      workbenchEditorTextarea.addEventListener('input', () => {
        if (!hasWorkbenchOpenNote()) return;
        setWorkbenchDirty(workbenchEditorTextarea.value !== workbenchBaselineContent);
        requestWorkbenchPreviewUpdate();
      });

      workbenchEditorTextarea.addEventListener('scroll', () => {
        syncWorkbenchScroll(workbenchEditorTextarea, workbenchPreview);
      });
    }

    if (workbenchPreview) {
      workbenchPreview.addEventListener('scroll', () => {
        syncWorkbenchScroll(workbenchPreview, workbenchEditorTextarea);
      });
    }

    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', async () => {
        if (workbenchMode && workbenchDirty) {
          const ok = await confirmDiscardWorkbenchChanges(
            '进入设置页将暂时离开当前工作台编辑界面，确定继续吗？'
          );
          if (!ok) return;
        }
        syncSettingsUI();
        showSettingsView();
      });
    }
    if (backFromSettingsBtn) {
      backFromSettingsBtn.addEventListener('click', () => {
        showCardsView();
      });
    }

    if (autoBlockClustersCheckbox) {
      autoBlockClustersCheckbox.addEventListener('change', () => {
        settings.autoBlockClusters = !!autoBlockClustersCheckbox.checked;
        saveSettings(settings);
        renderNotebookLists();
        recomputeAndRenderCards().catch(console.error);
      });
    }

    if (themeModeSelect) {
      themeModeSelect.addEventListener('change', () => {
        settings.themeMode = themeModeSelect.value;
        saveSettings(settings);
        applyTheme();
      });
    }

    if (cardsColumnsInput) {
      cardsColumnsInput.addEventListener('change', () => {
        const v = parseInt(cardsColumnsInput.value, 10);
        if (!isNaN(v) && v >= 1 && v <= 8) {
          settings.cardsColumns = v;
          saveSettings(settings);
          updateCardsGridColumns();
        }
      });
    }
    if (cardMaxLinesInput) {
      cardMaxLinesInput.addEventListener('change', () => {
        const v = parseInt(cardMaxLinesInput.value, 10);
        if (!isNaN(v) && v >= 1 && v <= 20) {
          settings.cardMaxLines = v;
          saveSettings(settings);
          renderCards();
        }
      });
    }
    if (pageSizeInput) {
      pageSizeInput.addEventListener('change', () => {
        const v = parseInt(pageSizeInput.value, 10);
        if (!isNaN(v) && v >= 10 && v <= 500) {
          settings.pageSize = v;
          saveSettings(settings);
          currentPage = 1;
          renderCards();
        }
      });
    }
    if (sortModeSelect) {
      sortModeSelect.addEventListener('change', () => {
        settings.sortMode = sortModeSelect.value;
        saveSettings(settings);
        filteredNotes = sortedNotes(filteredNotes);
        currentPage = 1;
        renderCards();
      });
    }
    if (globalFontSizeInput) {
      globalFontSizeInput.addEventListener('change', () => {
        const v = parseInt(globalFontSizeInput.value, 10);
        if (!isNaN(v) && v >= 10 && v <= 24) {
          settings.globalFontSize = v;
          saveSettings(settings);
          applyGlobalFontSize();
        } else {
          // 非法输入时，回退到当前有效值，避免出现“看起来改了但实际没效果”的错觉
          globalFontSizeInput.value =
            typeof settings.globalFontSize === 'number'
              ? settings.globalFontSize
              : DEFAULT_SETTINGS.globalFontSize;
        }
      });
    }

    if (settingsResetBtn) {
      settingsResetBtn.addEventListener('click', () => {
        settings = { ...DEFAULT_SETTINGS };
        saveSettings(settings);
        syncSettingsUI();
        applyTheme();
        updateCardsGridColumns();
        renderNotebookLists();
        applyGlobalFontSize();
        recomputeAndRenderCards().catch(console.error);
        settingsStatus.textContent = '已重置为默认设置';
        setTimeout(() => (settingsStatus.textContent = ''), 2000);
      });
    }

    if (forceUpdateBtn) {
      forceUpdateBtn.addEventListener('click', async () => {
        if (workbenchMode && workbenchDirty) {
          const ok = await confirmDiscardWorkbenchChanges(
            '强制刷新缓存会重新加载页面并丢失当前工作台中的未保存修改，确定继续吗？'
          );
          if (!ok) return;
        }

        if (!confirm('确定要清除所有缓存并强制刷新吗？\n这将注销 Service Worker 并重新加载最新版本。')) return;

        try {
          if (settingsStatus) {
            settingsStatus.textContent = '正在清理缓存与 Service Worker...';
          }

          // 注销当前域名下所有 Service Worker
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
              await registration.unregister();
            }
          }

          // 清除 Cache Storage
          if ('caches' in window) {
            const keys = await caches.keys();
            for (const key of keys) {
              await caches.delete(key);
            }
          }

          // 最后强制刷新页面
          window.location.reload();
        } catch (e) {
          console.error('[DailyNotePanel] force update failed:', e);
          if (settingsStatus) {
            settingsStatus.textContent = '强制刷新失败，请尝试手动清理浏览器缓存';
            setTimeout(() => (settingsStatus.textContent = ''), 3000);
          }
        }
      });
    }

    if (moveTargetSelect) {
      moveTargetSelect.addEventListener('change', () => {
        pendingMoveTargetFolder = moveTargetSelect.value || null;
        if (moveConfirmBtn) {
          moveConfirmBtn.disabled = !pendingMoveTargetFolder;
        }
      });
    }

    // 删除确认弹窗事件
    if (deleteCancelBtn) {
      deleteCancelBtn.addEventListener('click', () => {
        closeDeleteModal();
      });
    }
    if (deleteConfirmBtn) {
      deleteConfirmBtn.addEventListener('click', async () => {
        const filesToDelete = pendingDeleteFiles.slice();
        if (filesToDelete.length === 0) {
          closeDeleteModal();
          return;
        }

        let result;
        try {
          result = await apiPost('/delete-batch', { notesToDelete: filesToDelete });
        } catch (e) {
          console.error('[DailyNotePanel] delete error:', e);
          closeDeleteModal();
          setCardsFeedback('删除请求失败，请稍后重试');
          return;
        }

        const deletedCount = Array.isArray(result.deleted) ? result.deleted.length : 0;
        const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
        const erroredIds = getErroredNoteIdSet(result.errors);
        const currentWorkbenchNoteId = workbenchState.noteId;
        const affectsCurrentWorkbench =
          workbenchMode &&
          !!currentWorkbenchNoteId &&
          doesFileCollectionContainNote(filesToDelete, currentWorkbenchNoteId) &&
          !erroredIds.has(currentWorkbenchNoteId);
        const affectedFolders = new Set(
          filesToDelete.map(item => item.folder).filter(Boolean)
        );

        closeDeleteModal();
        if (bulkMode) {
          bulkMode = false;
          bulkAction = null;
          selectedSet.clear();
        }
        syncBulkActionButtons();

        await refreshFoldersAndRebuild(affectedFolders);
        if (affectsCurrentWorkbench) {
          clearWorkbenchState({ renderCards: false });
        }
        setCardsFeedback(buildOperationSummary('删除', deletedCount, errorCount));
      });
    }

    // 转移确认弹窗事件
    if (moveCancelBtn) {
      moveCancelBtn.addEventListener('click', () => {
        closeMoveModal();
      });
    }
    if (moveConfirmBtn) {
      moveConfirmBtn.addEventListener('click', async () => {
        const filesToMove = pendingMoveFiles.slice();
        const targetFolder = pendingMoveTargetFolder;
        if (filesToMove.length === 0 || !targetFolder) {
          return;
        }

        let result;
        try {
          result = await apiPost('/move', {
            sourceNotes: filesToMove,
            targetFolder
          });
        } catch (e) {
          console.error('[DailyNotePanel] move error:', e);
          closeMoveModal();
          setCardsFeedback('转移请求失败，请稍后重试');
          return;
        }

        const movedCount = Array.isArray(result.moved) ? result.moved.length : 0;
        const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
        const erroredIds = getErroredNoteIdSet(result.errors);
        const currentWorkbenchNoteId = workbenchState.noteId;
        const affectsCurrentWorkbench =
          workbenchMode &&
          !!currentWorkbenchNoteId &&
          doesFileCollectionContainNote(filesToMove, currentWorkbenchNoteId) &&
          !erroredIds.has(currentWorkbenchNoteId);
        const affectedFolders = new Set(
          filesToMove.map(item => item.folder).filter(Boolean)
        );
        affectedFolders.add(targetFolder);

        closeMoveModal();
        if (bulkMode) {
          bulkMode = false;
          bulkAction = null;
          selectedSet.clear();
        }
        syncBulkActionButtons();

        await refreshFoldersAndRebuild(affectedFolders);
        if (affectsCurrentWorkbench) {
          clearWorkbenchState({ renderCards: false });
        }
        setCardsFeedback(buildOperationSummary('转移', movedCount, errorCount));
      });
    }

    if (unsavedCancelBtn) {
      unsavedCancelBtn.addEventListener('click', () => {
        if (unsavedModalBackdrop) {
          unsavedModalBackdrop.classList.add('hidden');
        }
        if (pendingUnsavedResolver) {
          const resolver = pendingUnsavedResolver;
          pendingUnsavedResolver = null;
          resolver(false);
        }
      });
    }

    if (unsavedConfirmBtn) {
      unsavedConfirmBtn.addEventListener('click', () => {
        if (unsavedModalBackdrop) {
          unsavedModalBackdrop.classList.add('hidden');
        }
        if (pendingUnsavedResolver) {
          const resolver = pendingUnsavedResolver;
          pendingUnsavedResolver = null;
          resolver(true);
        }
      });
    }
  }

  // ------- 设置 UI 同步 -------

  function updateSearchUIForCurrentNotebook() {
    if (!searchInput) return;
    if (isStreamNotebook(currentNotebook)) {
      searchInput.disabled = true;
      searchInput.value = '';
      searchInput.placeholder = '日记流中不支持搜索，请在具体日记本中搜索';
    } else {
      searchInput.disabled = false;
      searchInput.placeholder = '搜索当前日记本 (支持多关键词 AND)';
    }
  }

  function syncSettingsUI() {
    autoBlockClustersCheckbox.checked = !!settings.autoBlockClusters;
    themeModeSelect.value = settings.themeMode;
    cardsColumnsInput.value = settings.cardsColumns;
    cardMaxLinesInput.value = settings.cardMaxLines;
    pageSizeInput.value = settings.pageSize;
    sortModeSelect.value = settings.sortMode;
    if (globalFontSizeInput) {
      globalFontSizeInput.value =
        typeof settings.globalFontSize === 'number'
          ? settings.globalFontSize
          : DEFAULT_SETTINGS.globalFontSize;
    }
 
    blockedNotebooksContainer.innerHTML = '';
    notebooks.forEach(nb => {
      const row = document.createElement('label');
      row.className = 'settings-row';

      const span = document.createElement('span');
      span.textContent = nb.name;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = settings.blockedNotebooks.includes(nb.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!settings.blockedNotebooks.includes(nb.name)) {
            settings.blockedNotebooks.push(nb.name);
          }
        } else {
          settings.blockedNotebooks = settings.blockedNotebooks.filter(x => x !== nb.name);
        }
        saveSettings(settings);
        renderNotebookLists();
        recomputeAndRenderCards().catch(console.error);
      });

      row.appendChild(span);
      row.appendChild(checkbox);
      blockedNotebooksContainer.appendChild(row);
    });
  }

  // ------- 操作确认弹窗 -------
  
  function openDeleteModal(files) {
    pendingDeleteFiles = Array.isArray(files) ? files.slice() : [];
    closeMoveModal();
    if (!deleteModalBackdrop) return;
    if (deleteCountSpan) {
      deleteCountSpan.textContent = String(pendingDeleteFiles.length);
    }
    renderModalList(deleteListContainer, pendingDeleteFiles);
    deleteModalBackdrop.classList.remove('hidden');
  }

  function closeDeleteModal() {
    pendingDeleteFiles = [];
    if (!deleteModalBackdrop) return;
    deleteModalBackdrop.classList.add('hidden');
  }

  function openMoveModal(files) {
    pendingMoveFiles = Array.isArray(files) ? files.slice() : [];
    pendingMoveTargetFolder = null;
    closeDeleteModal();
    if (!moveModalBackdrop) return;

    if (moveCountSpan) {
      moveCountSpan.textContent = String(pendingMoveFiles.length);
    }
    renderModalList(moveListContainer, pendingMoveFiles);

    const targetCandidates = getMoveTargetCandidates(pendingMoveFiles);
    const excludedCount = getSourceFoldersFromFiles(pendingMoveFiles).size;

    if (moveTargetSelect) {
      moveTargetSelect.innerHTML = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent =
        targetCandidates.length > 0 ? '请选择目标日记本' : '无可用目标日记本';
      moveTargetSelect.appendChild(placeholder);

      targetCandidates.forEach(nb => {
        const option = document.createElement('option');
        option.value = nb.name;
        option.textContent = nb.name;
        moveTargetSelect.appendChild(option);
      });

      moveTargetSelect.value = '';
      moveTargetSelect.disabled = targetCandidates.length === 0;
    }

    if (moveConfirmBtn) {
      moveConfirmBtn.disabled = true;
    }

    if (moveTargetHint) {
      if (targetCandidates.length === 0) {
        moveTargetHint.textContent = '无可用目标日记本，请先取消屏蔽或调整选择范围';
      } else if (excludedCount > 0) {
        moveTargetHint.textContent = `已自动排除 ${excludedCount} 个来源日记本，请选择目标日记本`;
      } else {
        moveTargetHint.textContent = '请选择目标日记本';
      }
    }

    moveModalBackdrop.classList.remove('hidden');
  }

  function closeMoveModal() {
    pendingMoveFiles = [];
    pendingMoveTargetFolder = null;
    if (moveTargetSelect) {
      moveTargetSelect.innerHTML = '';
      moveTargetSelect.disabled = false;
    }
    if (moveTargetHint) {
      moveTargetHint.textContent = '';
    }
    if (!moveModalBackdrop) return;
    moveModalBackdrop.classList.add('hidden');
  }

  // ------- 数据加载 -------

  async function loadNotebooks() {
    try {
      const data = await apiGet('/folders');
      notebooks = (data.folders || []).map(name => ({ name }));

      // 1. 先解析 URL 参数中的 notebook 指令
      const params = new URLSearchParams(window.location.search || '');
      const urlNotebook = params.get('notebook');
      if (urlNotebook) {
        if (urlNotebook === 'stream') {
          currentNotebook = STREAM_NOTEBOOK;
        } else {
          // 对于指定的普通日记本名，暂时只记录下来，后面统一做有效性校验
          currentNotebook = urlNotebook;
        }
      }

      // 2. 若 URL 中未指定 notebook，再尝试从 localStorage 恢复
      if (!currentNotebook) {
        currentNotebook = localStorage.getItem('DailyNotePanel_LastNotebook');
      }

      // 3. 验证当前选中的日记本是否有效：
      //    - STREAM_NOTEBOOK 永远视为有效（即日记流模式）
      //    - 普通日记本需要“存在且可见”
      let hasValidCurrent = false;
      if (currentNotebook === STREAM_NOTEBOOK) {
        hasValidCurrent = true;
      } else if (currentNotebook) {
        hasValidCurrent =
          notebooks.some(n => n.name === currentNotebook && notebookVisible(n.name));
      }

      // 4. 如果当前 notebook 无效，则回退到：
      //    - 第一个可见日记本；若没有，则回退到 STREAM_NOTEBOOK
      if (!hasValidCurrent) {
        const firstVisible = notebooks.find(n => notebookVisible(n.name));
        currentNotebook = firstVisible ? firstVisible.name : STREAM_NOTEBOOK;
      }

      // 5. 确认为有效值后，更新 localStorage（防止存的是无效值）
      if (currentNotebook) {
        localStorage.setItem('DailyNotePanel_LastNotebook', currentNotebook);
      }

      renderNotebookLists();
      syncSettingsUI();
      applyGlobalFontSize();
      updateSearchUIForCurrentNotebook();
      updateWorkbenchToggleTitle();
      updateWorkbenchLayout();
      updateWorkbenchDirtyUI();
      // 初次渲染先基于空缓存构建视图，真正数据交给 autoRefreshLoop 填充
      renderCards();
    } catch (e) {
      console.error('[DailyNotePanel] loadNotebooks error:', e);
    }
  }

  async function refreshSingleNotebookCache(notebookName) {
    try {
      const data = await apiGet('/folder/' + notebookName);
      const list = (data.notes || []).map(n => {
        const mtime =
          n.mtime != null
            ? n.mtime
            : n.lastModified
            ? new Date(n.lastModified).getTime()
            : 0;
        return {
          folderName: notebookName,
          name: n.name,
          mtime,
          size: n.size != null ? n.size : 0,
          preview: n.preview
        };
      });
      notebookCache.set(notebookName, list);
      const latest = list.reduce(
        (max, n) => (n.mtime > max ? n.mtime : max),
        0
      );
      notebookLatestMtime.set(notebookName, latest);
    } catch (e) {
      console.error('[DailyNotePanel] refreshSingleNotebookCache error:', e);
    }
  }

  async function rebuildCurrentViewAfterMutation() {
    if (!currentNotebook) {
      notes = [];
      filteredNotes = [];
      currentPage = 1;
      renderCards();
      return;
    }

    if (isStreamNotebook(currentNotebook)) {
      const visibleNow = getVisibleNotebooks();
      const allNotes = [];
      visibleNow.forEach(nb => {
        const list = notebookCache.get(nb.name);
        if (!Array.isArray(list) || list.length === 0) return;
        list.forEach(note => {
          allNotes.push({
            ...note,
            folderName: note.folderName || nb.name
          });
        });
      });
      allNotes.sort((a, b) => b.mtime - a.mtime);
      notes = allNotes;
      filteredNotes = allNotes;
    } else {
      const list = notebookCache.get(currentNotebook) || [];
      notes = list.slice();
      filteredNotes = sortedNotes(notes);
    }

    currentPage = 1;
    renderCards();
    reconcileWorkbenchStateAfterListRefresh();
  }

  async function refreshFoldersAndRebuild(folders) {
    const uniqueFolders = Array.from(new Set((folders || []).filter(Boolean)));
    for (const folder of uniqueFolders) {
      await refreshSingleNotebookCache(folder);
    }
    updateSidebarGlow();
    await rebuildCurrentViewAfterMutation();
  }

  function refreshCurrentViewFromCache() {
    if (!currentNotebook) {
      notes = [];
      filteredNotes = [];
      renderCards();
      reconcileWorkbenchStateAfterListRefresh();
      return;
    }

    if (isStreamNotebook(currentNotebook)) {
      const beforeFp = computeFingerprint(filteredNotes);
      const beforeStreamFp = streamLastFingerprint;

      const visibleNow = getVisibleNotebooks();
      const allNotes = [];
      visibleNow.forEach(nb => {
        const list = notebookCache.get(nb.name);
        if (!Array.isArray(list) || list.length === 0) return;
        list.forEach(note => {
          allNotes.push({
            ...note,
            folderName: note.folderName || nb.name
          });
        });
      });
      allNotes.sort((a, b) => b.mtime - a.mtime);
      notes = allNotes;
      filteredNotes = allNotes;

      const fp = computeFingerprint(filteredNotes);
      // 如果指纹变了，或者当前页面是空的（初始化状态），则刷新
      if (fp !== beforeStreamFp || fp !== beforeFp || cardsContainer.children.length === 0) {
        streamLastFingerprint = fp;
        // 只有当数据发生实质性变化时才重置页码，避免轮询打断用户翻页
        // 但如果是手动切换日记本导致的刷新，外部会重置 currentPage
        renderCards();
      }
    } else {
      const list = notebookCache.get(currentNotebook) || [];
      const fp = computeFingerprint(list);
      if (fp !== lastNotesFingerprint || cardsContainer.children.length === 0) {
        notes = list.slice();
        filteredNotes = sortedNotes(notes);
        renderCards();
      }
    }

    reconcileWorkbenchStateAfterListRefresh();
  }

  // ------- 编辑 -------

  async function openWorkbenchNote(folder, file) {
    const nextNoteId = getNoteId(folder, file);
    if (workbenchState.noteId === nextNoteId && hasWorkbenchOpenNote()) {
      return;
    }

    if (workbenchMode && workbenchDirty && workbenchState.noteId !== nextNoteId) {
      const ok = await confirmDiscardWorkbenchChanges(
        '切换到其他日记将放弃当前工作台中的未保存修改，确定继续吗？'
      );
      if (!ok) return;
    }

    try {
      const data = await apiGet('/note/' + folder + '/' + file);
      populateWorkbenchWithNote(folder, file, data.content || '');
      renderCards();
    } catch (e) {
      console.error('[DailyNotePanel] openWorkbenchNote error:', e);
    }
  }

  async function saveWorkbenchNote() {
    if (!hasWorkbenchOpenNote() || !workbenchEditorTextarea) return;

    try {
      await apiPost(
        `/note/${workbenchState.folder}/${workbenchState.file}`,
        { content: workbenchEditorTextarea.value }
      );

      workbenchBaselineContent = workbenchEditorTextarea.value;
      setWorkbenchDirty(false);

      await refreshSingleNotebookCache(workbenchState.folder);
      updateSidebarGlow();

      if (
        searchInput &&
        !isStreamNotebook(currentNotebook) &&
        currentNotebook === workbenchState.folder &&
        (searchInput.value || '').trim()
      ) {
        await refreshNotesUsingSearchIfNeeded();
        renderCards();
      } else {
        refreshCurrentViewFromCache();
      }

      setCardsFeedback('当前工作台日记已保存', 2000);
    } catch (e) {
      console.error('[DailyNotePanel] saveWorkbenchNote error:', e);
      setCardsFeedback('工作台保存失败，请稍后重试');
    }
  }

  async function openEditor(folder, file) {
    try {
      // 同样移除 encodeURIComponent
      const data = await apiGet(
        '/note/' + folder + '/' + file
      );
      editorState.folder = folder;
      editorState.file = file;
      editorState.mode = 'edit';
      editorFilenameSpan.textContent = `${folder}/${file}`;
      editorTextarea.value = data.content || '';
      editorTextarea.classList.remove('hidden');
      editorPreview.classList.add('hidden');
      showEditorView();
    } catch (e) {
      console.error('[DailyNotePanel] openEditor error:', e);
    }
  }

  // ------- 自动刷新（全局轮询版） -------

  async function autoRefreshLoop() {
    const INTERVAL = 10000; // 10 秒
    while (true) {
      try {
        // 1. 视图隐藏时，短轮询检查
        if (cardsView.classList.contains('hidden')) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // 2. 有搜索词时，暂停轮询（避免覆盖搜索结果），短轮询检查
        if (searchInput && (searchInput.value || '').trim()) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        const visible = getVisibleNotebooks();
        // 3. 如果还没有可见日记本（可能加载中），短轮询等待
        if (visible.length === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // 4. 并发刷新所有可见 notebook 的缓存
        await Promise.all(
          visible.map(nb => refreshSingleNotebookCache(nb.name))
        );

        updateSidebarGlow();

        // 5. 根据当前模式，从缓存重建视图
        refreshCurrentViewFromCache();

      } catch (e) {
        console.warn('[DailyNotePanel] autoRefreshLoop error:', e);
      }

      // 6. 执行完一轮后等待 INTERVAL，确保首次立即执行
      await new Promise(r => setTimeout(r, INTERVAL));
    }
  }

  // ------- 初始化 -------

  function init() {
    applyTheme();
    updateCardsGridColumns();
    bindEvents();
    window.addEventListener('beforeunload', event => {
      if (!workbenchMode || !workbenchDirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
    // 默认折叠侧边栏（刷新后自动收起）
    if (sidebar) {
      sidebar.classList.add('collapsed');
    }
    // 确保 loadNotebooks 完成（notebooks 列表就绪）后再启动轮询
    loadNotebooks().then(() => {
      autoRefreshLoop();
    }).catch(console.error);

    showCardsView();
    applyGlobalFontSize();
    updateWorkbenchToggleTitle();
    updateWorkbenchLayout();
    updateWorkbenchDirtyUI();

    // 注册 Service Worker（PWA）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/AdminPanel/DailyNotePanel/sw.js').catch(e => {
        console.warn('[DailyNotePanel] serviceWorker register failed:', e);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
