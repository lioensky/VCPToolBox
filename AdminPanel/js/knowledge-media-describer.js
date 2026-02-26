(function () {
  const apiBase = '/admin_api/knowledge-media';

  let currentItems = [];

  function qs(selector) {
    return document.querySelector(selector);
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

  function renderTable(items) {
    const tbody = qs('#kms-table-body');
    if (!tbody) return;

    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无数据</td></tr>';
      return;
    }

    tbody.innerHTML = items.map((item, index) => {
      const tagsText = Array.isArray(item.tags) ? item.tags.join(', ') : '';
      return `
        <tr data-index="${index}">
          <td>${index + 1}</td>
          <td class="path-cell" title="${escapeHtml(item.relativePath)}">${escapeHtml(item.relativePath)}</td>
          <td>${escapeHtml(item.extension || '')}</td>
          <td>${Number(item.size || 0).toLocaleString()}</td>
          <td>${item.hasSidecar ? '✅' : '❌'}</td>
          <td>
            <input type="text" class="preset-input" value="${escapeHtml(item.presetName || '')}" placeholder="预设名（可选）">
          </td>
          <td>
            <textarea class="desc-input" rows="3" placeholder="描述信息">${escapeHtml(item.description || '')}</textarea>
            <div class="tags-row">
              <label>Tag:</label>
              <input type="text" class="tags-input" value="${escapeHtml(tagsText)}" placeholder="逗号分隔，如：去始末化, 逻辑惯性">
            </div>
          </td>
          <td class="actions-cell">
            <button class="btn-small save-one-btn">保存</button>
            <button class="btn-small regen-one-btn">重生成</button>
          </td>
        </tr>
      `;
    }).join('');
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

  async function loadList() {
    const keyword = qs('#kms-search-input')?.value?.trim() || '';
    const query = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
    setStatus('加载中...', 'info');

    try {
      const data = await apiFetch(`${apiBase}/list${query}`);
      currentItems = data.items || [];
      renderTable(currentItems);
      const countEl = qs('#kms-count');
      if (countEl) {
        countEl.textContent = `共 ${data.total || currentItems.length} 项`;
      }
      setStatus('加载完成', 'success');
    } catch (error) {
      setStatus(`加载失败：${error.message}`, 'error');
    }
  }

  async function saveOne(row) {
    const index = Number(row.dataset.index);
    const item = currentItems[index];
    if (!item) return;

    const presetName = row.querySelector('.preset-input')?.value || '';
    const description = row.querySelector('.desc-input')?.value || '';
    const tagsText = row.querySelector('.tags-input')?.value || '';

    try {
      await apiFetch(`${apiBase}/update`, {
        method: 'POST',
        body: JSON.stringify({
          mediaPath: item.mediaPath,
          presetName,
          description,
          tags: parseTags(tagsText)
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
    const item = currentItems[index];
    if (!item) return;

    try {
      await apiFetch(`${apiBase}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ mediaPath: item.mediaPath })
      });
      setStatus(`已重生成：${item.relativePath}`, 'success');
      await loadList();
    } catch (error) {
      setStatus(`重生成失败：${error.message}`, 'error');
    }
  }

  async function rebuildAll(regenerateExisting) {
    const message = regenerateExisting
      ? '将重建并覆盖已有描述，确定继续吗？'
      : '将只为缺失侧车文件的媒体创建描述，确定继续吗？';

    if (!window.confirm(message)) return;

    setStatus('重建中，请稍候...', 'info');
    try {
      const result = await apiFetch(`${apiBase}/rebuild`, {
        method: 'POST',
        body: JSON.stringify({ regenerateExisting })
      });
      setStatus(
        `重建完成：扫描 ${result.scanned || 0}，新建 ${result.created || 0}，更新 ${result.updated || 0}`,
        'success'
      );
      await loadList();
    } catch (error) {
      setStatus(`重建失败：${error.message}`, 'error');
    }
  }

  async function exportAll() {
    setStatus('导出中...', 'info');
    try {
      const response = await fetch(`${apiBase}/export`, { method: 'POST' });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(err || `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/i);
      const fileName = match ? match[1] : `knowledge_media_export_${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setStatus(`导出完成：${fileName}`, 'success');
    } catch (error) {
      setStatus(`导出失败：${error.message}`, 'error');
    }
  }

  function bindEvents() {
    const reloadBtn = qs('#kms-reload-btn');
    const rebuildMissingBtn = qs('#kms-rebuild-missing-btn');
    const rebuildAllBtn = qs('#kms-rebuild-all-btn');
    const exportBtn = qs('#kms-export-btn');
    const searchBtn = qs('#kms-search-btn');
    const searchInput = qs('#kms-search-input');
    const tableBody = qs('#kms-table-body');

    if (reloadBtn) reloadBtn.addEventListener('click', loadList);
    if (rebuildMissingBtn) rebuildMissingBtn.addEventListener('click', () => rebuildAll(false));
    if (rebuildAllBtn) rebuildAllBtn.addEventListener('click', () => rebuildAll(true));
    if (exportBtn) exportBtn.addEventListener('click', exportAll);
    if (searchBtn) searchBtn.addEventListener('click', loadList);

    if (searchInput) {
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadList();
        }
      });
    }

    if (tableBody) {
      tableBody.addEventListener('click', async (event) => {
        const row = event.target.closest('tr[data-index]');
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
    await loadList();
  });
})();