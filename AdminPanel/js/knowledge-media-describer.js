(function () {
  const apiBase = '/admin_api/knowledge-media';
  const presetApi = '/admin_api/multimedia-presets?type=cognito';

  let currentItems = [];
  let filteredItems = [];
  let presetNames = [];

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg']);
  const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg']);
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);
  const DOC_EXTS = new Set(['.pdf']);

  function qs(selector) {
    return document.querySelector(selector);
  }

  function formatSize(size) {
    const value = Number(size || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function classifyType(ext) {
    const lower = String(ext || '').toLowerCase();
    if (IMAGE_EXTS.has(lower)) return 'image';
    if (AUDIO_EXTS.has(lower)) return 'audio';
    if (VIDEO_EXTS.has(lower)) return 'video';
    if (DOC_EXTS.has(lower)) return 'document';
    return 'other';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#039;');
  }

  function setStatus(message, type = 'info') {
    const statusEl = qs('#kms-status');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = `status-message ${type}`;
  }

  function parseTags(tagsText) {
    return String(tagsText || '')
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  function ensurePresetDatalist() {
    let datalist = qs('#kms-preset-suggestions');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'kms-preset-suggestions';
      document.body.appendChild(datalist);
    }
    datalist.innerHTML = presetNames.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  }

  function updateStats() {
    const total = currentItems.length;
    const shown = filteredItems.length;
    const hasSidecar = currentItems.filter(item => item.hasSidecar).length;
    const missingSidecar = total - hasSidecar;

    const countEl = qs('#kms-count');
    const sidecarCountEl = qs('#kms-sidecar-count');
    const missingCountEl = qs('#kms-missing-count');

    if (countEl) countEl.textContent = `显示 ${shown} / 共 ${total} 项`;
    if (sidecarCountEl) sidecarCountEl.textContent = `有侧车 ${hasSidecar} 项`;
    if (missingCountEl) missingCountEl.textContent = `缺侧车 ${missingSidecar} 项`;
  }

  function renderList(items) {
    const list = qs('#kms-list');
    if (!list) return;

    if (!items || items.length === 0) {
      list.innerHTML = '<div class="kms-empty">暂无匹配项</div>';
      return;
    }

    list.innerHTML = items.map((item, index) => {
      const tagsText = Array.isArray(item.tags) ? item.tags.join(', ') : '';
      const itemType = classifyType(item.extension);
      const modifiedText = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : '-';

      return `
        <div class="kms-item" data-index="${index}">
          <div class="kms-main">
            <div class="kms-main-top">
              <div class="kms-path" title="${escapeHtml(item.relativePath)}">${escapeHtml(item.relativePath)}</div>
              <div class="kms-badges">
                <span class="badge">${escapeHtml(itemType)}</span>
                <span class="badge">${escapeHtml(item.extension || '')}</span>
                <span class="badge ${item.hasSidecar ? 'ok' : 'warn'}">${item.hasSidecar ? '有侧车' : '缺侧车'}</span>
              </div>
            </div>
            <textarea class="kms-textarea desc-input" placeholder="描述信息">${escapeHtml(item.description || '')}</textarea>
            <div class="kms-inline-grid">
              <input type="text" class="kms-input tags-input" value="${escapeHtml(tagsText)}" placeholder="Tag（逗号分隔）">
              <input type="text" class="kms-input agent-signature-input" value="${escapeHtml(item.agentSignature || '')}" placeholder="Agent署名（可选）">
            </div>
          </div>
          <div class="kms-right">
            <input type="text" class="kms-input preset-input" list="kms-preset-suggestions" value="${escapeHtml(item.presetName || '')}" placeholder="重生成预设">
          </div>
          <div class="kms-size">
            <div>${escapeHtml(formatSize(item.size))}</div>
            <div>${escapeHtml(modifiedText)}</div>
          </div>
          <div class="kms-actions">
            <button class="kms-btn save-one-btn">保存</button>
            <button class="kms-btn regen regen-one-btn">重生成</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function applyFilters() {
    const typeFilter = qs('#kms-type-filter')?.value || 'all';
    const sidecarFilter = qs('#kms-sidecar-filter')?.value || 'all';
    const sortValue = qs('#kms-sort-select')?.value || 'modified_desc';

    let next = [...currentItems];

    if (typeFilter !== 'all') {
      next = next.filter(item => classifyType(item.extension) === typeFilter);
    }

    if (sidecarFilter === 'has') {
      next = next.filter(item => !!item.hasSidecar);
    } else if (sidecarFilter === 'missing') {
      next = next.filter(item => !item.hasSidecar);
    }

    next.sort((a, b) => {
      switch (sortValue) {
        case 'modified_asc':
          return new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
        case 'size_desc':
          return Number(b.size || 0) - Number(a.size || 0);
        case 'size_asc':
          return Number(a.size || 0) - Number(b.size || 0);
        case 'path_asc':
          return String(a.relativePath || '').localeCompare(String(b.relativePath || ''), 'zh-Hans-CN');
        case 'modified_desc':
        default:
          return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      }
    });

    filteredItems = next;
    renderList(filteredItems);
    updateStats();
  }

  async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { error: text || 'Invalid JSON response' };
    }

    if (!response.ok) {
      const message = data.error || data.details || `HTTP ${response.status}`;
      throw new Error(message);
    }

    return data;
  }

  async function loadPresets() {
    try {
      const data = await apiFetch(presetApi);
      const items = Array.isArray(data.items) ? data.items : [];
      presetNames = items
        .map(item => (typeof item?.name === 'string' ? item.name.trim() : ''))
        .filter(Boolean);
      ensurePresetDatalist();
    } catch (_) {
      presetNames = [];
      ensurePresetDatalist();
    }
  }

  async function loadList() {
    const keyword = qs('#kms-search-input')?.value?.trim() || '';
    const query = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
    setStatus('加载中...', 'info');

    try {
      const data = await apiFetch(`${apiBase}/list${query}`);
      currentItems = Array.isArray(data.items) ? data.items : [];
      applyFilters();
      setStatus('加载完成', 'success');
    } catch (error) {
      currentItems = [];
      filteredItems = [];
      renderList([]);
      updateStats();
      setStatus(`加载失败：${error.message}`, 'error');
    }
  }

  async function saveOne(row) {
    const index = Number(row.dataset.index);
    const item = filteredItems[index];
    if (!item) return;

    const presetName = row.querySelector('.preset-input')?.value || '';
    const description = row.querySelector('.desc-input')?.value || '';
    const tagsText = row.querySelector('.tags-input')?.value || '';
    const agentSignature = row.querySelector('.agent-signature-input')?.value || '';

    try {
      await apiFetch(`${apiBase}/update`, {
        method: 'POST',
        body: JSON.stringify({
          mediaPath: item.mediaPath,
          presetName,
          description,
          tags: parseTags(tagsText),
          agentSignature
        })
      });
      setStatus(`已保存：${item.relativePath}`, 'success');
      await loadList();
    } catch (error) {
      setStatus(`保存失败：${error.message}`, 'error');
    }
  }

  async function regenerateOne(row) {
    const index = Number(row.dataset.index);
    const item = filteredItems[index];
    if (!item) return;

    const presetName = row.querySelector('.preset-input')?.value || '';
    try {
      await apiFetch(`${apiBase}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({
          mediaPath: item.mediaPath,
          presetName
        })
      });
      setStatus(`已重生成：${item.relativePath}`, 'success');
      await loadList();
    } catch (error) {
      setStatus(`重生成失败：${error.message}`, 'error');
    }
  }

  function bindEvents() {
    const reloadBtn = qs('#kms-reload-btn');
    const searchBtn = qs('#kms-search-btn');
    const searchInput = qs('#kms-search-input');
    const typeFilter = qs('#kms-type-filter');
    const sidecarFilter = qs('#kms-sidecar-filter');
    const sortSelect = qs('#kms-sort-select');
    const list = qs('#kms-list');

    if (reloadBtn) reloadBtn.addEventListener('click', loadList);
    if (searchBtn) searchBtn.addEventListener('click', loadList);

    if (searchInput) {
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadList();
        }
      });
    }

    if (typeFilter) typeFilter.addEventListener('change', applyFilters);
    if (sidecarFilter) sidecarFilter.addEventListener('change', applyFilters);
    if (sortSelect) sortSelect.addEventListener('change', applyFilters);

    if (list) {
      list.addEventListener('click', async (event) => {
        const row = event.target.closest('.kms-item[data-index]');
        if (!row) return;

        if (event.target.classList.contains('save-one-btn')) {
          await saveOne(row);
        } else if (event.target.classList.contains('regen-one-btn')) {
          await regenerateOne(row);
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadPresets();
    await loadList();
  });
})();