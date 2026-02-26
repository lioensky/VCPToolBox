(function () {
  const API_BASE = '/admin_api/multimedia-presets';

  const state = {
    items: [],
    currentFileName: '',
    loadedSnapshot: null
  };

  function qs(selector) {
    return document.querySelector(selector);
  }

  function setStatus(message, type = 'info') {
    const el = qs('#mpe-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = `status-message ${type}`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#039;');
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
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { error: text || `HTTP ${response.status}` };
    }

    if (!response.ok) {
      throw new Error(data.error || data.details || `HTTP ${response.status}`);
    }
    return data;
  }

  function normalizeFileName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    return raw.toLowerCase().endsWith('.json') ? raw : `${raw}.json`;
  }

  function parseOptionalNumber(inputId, asInteger = false) {
    const raw = String(qs(inputId)?.value || '').trim();
    if (!raw) return undefined;
    const num = asInteger ? parseInt(raw, 10) : parseFloat(raw);
    if (Number.isNaN(num)) return undefined;
    return num;
  }

  function clearRulesList() {
    const list = qs('#mpe-rules-list');
    if (list) list.innerHTML = '';
  }

  function createRuleCard(rule = {}) {
    const list = qs('#mpe-rules-list');
    if (!list) return;

    const card = document.createElement('div');
    card.className = 'rule-card';
    card.innerHTML = `
      <div class="rule-grid">
        <div class="form-group">
          <label>pattern</label>
          <input type="text" class="rule-pattern" value="${escapeHtml(rule.pattern || '')}" placeholder="正则表达式">
        </div>
        <div class="form-group">
          <label>flags</label>
          <input type="text" class="rule-flags" value="${escapeHtml(rule.flags || '')}" placeholder="如 g / gi">
        </div>
      </div>
      <div class="form-group">
        <label>replace</label>
        <textarea class="rule-replace" rows="2" placeholder="替换内容">${escapeHtml(rule.replace || '')}</textarea>
      </div>
      <div class="rule-actions">
        <button type="button" class="rule-delete-btn">删除规则</button>
      </div>
    `;

    card.querySelector('.rule-delete-btn')?.addEventListener('click', () => {
      card.remove();
    });

    list.appendChild(card);
  }

  function getRulesFromEditor() {
    const list = qs('#mpe-rules-list');
    if (!list) return [];

    const cards = Array.from(list.querySelectorAll('.rule-card'));
    return cards
      .map(card => ({
        pattern: String(card.querySelector('.rule-pattern')?.value || '').trim(),
        flags: String(card.querySelector('.rule-flags')?.value || '').trim(),
        replace: String(card.querySelector('.rule-replace')?.value || '')
      }))
      .filter(rule => rule.pattern);
  }

  function toggleTypeUI(type) {
    const isRegex = type === 'regexRule';
    const promptGroup = qs('#mpe-prompt-group');
    const rulesBlock = qs('#mpe-rules-block');

    if (promptGroup) {
      promptGroup.style.display = isRegex ? 'none' : '';
    }
    if (rulesBlock) {
      rulesBlock.style.display = isRegex ? '' : 'none';
    }
  }

  function fillEditor(fileName, presetData) {
    const data = presetData && typeof presetData === 'object' ? presetData : {};
    const type = data.type === 'regexRule' ? 'regexRule' : 'cognito';
    const requestParams = data.requestParams && typeof data.requestParams === 'object'
      ? data.requestParams
      : {};

    qs('#mpe-file-name').value = fileName || '';
    qs('#mpe-type').value = type;
    qs('#mpe-name').value = data.name || '';
    qs('#mpe-description').value = data.description || '';
    qs('#mpe-prompt').value = data.prompt || '';

    qs('#mpe-model').value = requestParams.model || data.model || '';
    qs('#mpe-temperature').value = requestParams.temperature ?? data.temperature ?? '';
    qs('#mpe-top-p').value = requestParams.top_p ?? data.top_p ?? '';
    qs('#mpe-top-k').value = requestParams.top_k ?? data.top_k ?? '';

    clearRulesList();
    const rules = Array.isArray(data.rules) ? data.rules : [];
    if (rules.length > 0) {
      rules.forEach(rule => createRuleCard(rule));
    }

    toggleTypeUI(type);

    state.currentFileName = fileName || '';
    state.loadedSnapshot = JSON.parse(JSON.stringify(data));
  }

  function clearEditor(type = 'cognito') {
    qs('#mpe-file-name').value = '';
    qs('#mpe-type').value = type;
    qs('#mpe-name').value = '';
    qs('#mpe-description').value = '';
    qs('#mpe-prompt').value = '';
    qs('#mpe-model').value = '';
    qs('#mpe-temperature').value = '';
    qs('#mpe-top-p').value = '';
    qs('#mpe-top-k').value = '';
    clearRulesList();
    if (type === 'regexRule') {
      createRuleCard({ pattern: '', flags: 'g', replace: '' });
    }
    toggleTypeUI(type);
    state.currentFileName = '';
    state.loadedSnapshot = null;
  }

  function collectPayload() {
    const type = qs('#mpe-type').value === 'regexRule' ? 'regexRule' : 'cognito';
    const name = String(qs('#mpe-name')?.value || '').trim();
    const description = String(qs('#mpe-description')?.value || '').trim();

    const payload = {
      name: name || '',
      type,
      description
    };

    if (type === 'regexRule') {
      payload.rules = getRulesFromEditor();
    } else {
      payload.prompt = String(qs('#mpe-prompt')?.value || '');
    }

    const requestParams = {};
    const model = String(qs('#mpe-model')?.value || '').trim();
    if (model) requestParams.model = model;

    const temperature = parseOptionalNumber('#mpe-temperature');
    const topP = parseOptionalNumber('#mpe-top-p');
    const topK = parseOptionalNumber('#mpe-top-k', true);

    if (typeof temperature === 'number') requestParams.temperature = temperature;
    if (typeof topP === 'number') requestParams.top_p = topP;
    if (typeof topK === 'number') requestParams.top_k = topK;

    if (Object.keys(requestParams).length > 0) {
      payload.requestParams = requestParams;
    }

    return payload;
  }

  async function loadList() {
    const filter = String(qs('#mpe-type-filter')?.value || 'all');
    const search = String(qs('#mpe-search-input')?.value || '').trim().toLowerCase();

    setStatus('加载预设列表中...', 'info');
    try {
      const query = filter !== 'all' ? `?type=${encodeURIComponent(filter)}` : '';
      const data = await apiFetch(`${API_BASE}${query}`);
      const items = Array.isArray(data.items) ? data.items : [];

      state.items = items.filter(item => {
        if (!search) return true;
        const haystack = `${item.fileName || ''}\n${item.name || ''}\n${item.description || ''}`.toLowerCase();
        return haystack.includes(search);
      });

      renderList();
      setStatus(`已加载 ${state.items.length} 个预设`, 'success');
    } catch (error) {
      setStatus(`加载失败：${error.message}`, 'error');
    }
  }

  function renderList() {
    const listEl = qs('#mpe-preset-list');
    if (!listEl) return;

    if (!state.items.length) {
      listEl.innerHTML = '<li class="empty-tip">没有匹配的预设</li>';
      return;
    }

    listEl.innerHTML = state.items.map(item => {
      const active = item.fileName === state.currentFileName ? 'active' : '';
      return `
        <li class="preset-item ${active}" data-file-name="${escapeHtml(item.fileName || '')}">
          <div class="name">${escapeHtml(item.name || item.fileName || '')}</div>
          <div class="meta">
            <span>${escapeHtml(item.type || '')}</span>
            <span>${escapeHtml(item.fileName || '')}</span>
          </div>
        </li>
      `;
    }).join('');
  }

  async function loadPreset(fileName) {
    if (!fileName) return;
    setStatus(`加载 ${fileName} ...`, 'info');
    try {
      const data = await apiFetch(`${API_BASE}/${encodeURIComponent(fileName)}`);
      fillEditor(fileName, data.data || {});
      renderList();
      setStatus(`已加载 ${fileName}`, 'success');
    } catch (error) {
      setStatus(`读取失败：${error.message}`, 'error');
    }
  }

  async function savePreset() {
    const fileName = normalizeFileName(qs('#mpe-file-name')?.value);
    if (!fileName) {
      setStatus('请填写文件名（.json）', 'error');
      return;
    }

    const payload = collectPayload();
    if (payload.type === 'regexRule' && (!Array.isArray(payload.rules) || payload.rules.length === 0)) {
      setStatus('RegexRule 至少需要一条规则（pattern）', 'error');
      return;
    }
    if (payload.type === 'cognito' && !String(payload.prompt || '').trim()) {
      setStatus('Cognito 预设需要 prompt 内容', 'error');
      return;
    }

    setStatus(`保存 ${fileName} 中...`, 'info');
    try {
      await apiFetch(`${API_BASE}/${encodeURIComponent(fileName)}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.currentFileName = fileName;
      state.loadedSnapshot = JSON.parse(JSON.stringify(payload));

      await loadList();
      renderList();
      setStatus(`保存成功：${fileName}`, 'success');
    } catch (error) {
      setStatus(`保存失败：${error.message}`, 'error');
    }
  }

  async function deletePreset() {
    const fileName = normalizeFileName(qs('#mpe-file-name')?.value || state.currentFileName);
    if (!fileName) {
      setStatus('请先选择或填写要删除的文件名', 'error');
      return;
    }

    if (!window.confirm(`确定删除预设 ${fileName} 吗？`)) return;

    setStatus(`删除 ${fileName} 中...`, 'info');
    try {
      await apiFetch(`${API_BASE}/${encodeURIComponent(fileName)}`, { method: 'DELETE' });

      if (state.currentFileName === fileName) {
        clearEditor('cognito');
      }
      await loadList();
      setStatus(`已删除：${fileName}`, 'success');
    } catch (error) {
      setStatus(`删除失败：${error.message}`, 'error');
    }
  }

  function resetEditor() {
    if (!state.loadedSnapshot) {
      setStatus('当前没有可重置的已加载内容', 'info');
      return;
    }
    fillEditor(state.currentFileName, state.loadedSnapshot);
    setStatus('已重置为已加载内容', 'success');
  }

  function bindEvents() {
    qs('#mpe-refresh-btn')?.addEventListener('click', loadList);
    qs('#mpe-search-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadList();
      }
    });
    qs('#mpe-type-filter')?.addEventListener('change', loadList);

    qs('#mpe-type')?.addEventListener('change', (event) => {
      toggleTypeUI(event.target.value);
    });

    qs('#mpe-add-rule-btn')?.addEventListener('click', () => {
      createRuleCard({ pattern: '', flags: 'g', replace: '' });
    });

    qs('#mpe-new-cognito-btn')?.addEventListener('click', () => {
      clearEditor('cognito');
      setStatus('已创建 Cognito 草稿，请填写并保存', 'info');
    });

    qs('#mpe-new-regex-btn')?.addEventListener('click', () => {
      clearEditor('regexRule');
      setStatus('已创建 RegexRule 草稿，请填写并保存', 'info');
    });

    qs('#mpe-save-btn')?.addEventListener('click', savePreset);
    qs('#mpe-delete-btn')?.addEventListener('click', deletePreset);
    qs('#mpe-reset-btn')?.addEventListener('click', resetEditor);

    qs('#mpe-preset-list')?.addEventListener('click', async (event) => {
      const item = event.target.closest('.preset-item');
      if (!item) return;
      const fileName = item.dataset.fileName || '';
      await loadPreset(fileName);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    clearEditor('cognito');
    await loadList();
  });
})();