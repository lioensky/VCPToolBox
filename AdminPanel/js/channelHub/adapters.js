/**
 * ChannelHub Adapter Management UI Module
 * 
 * Handles adapter registration, configuration, status monitoring,
 * and health check operations.
 * 
 * @module AdminPanel/js/channelHub/adapters
 */

(function(global) {
    'use strict';

    const ChannelHubAPI = global.ChannelHubAPI;
    const adapterApi = ChannelHubAPI?.adapters || ChannelHubAPI?.Adapter;

    /**
     * Adapter Management UI Controller
     */
    class AdapterManager {
        constructor(options = {}) {
            this.container = options.container || document.getElementById('adapters-container');
            this.adapters = [];
            this.selectedAdapter = null;
            this.refreshInterval = null;
            this.onAdapterSelect = options.onAdapterSelect || null;
        }

        /**
         * Initialize the adapter manager
         */
        async init() {
            await this.loadAdapters();
            this.render();
            this.startAutoRefresh();
        }

        /**
         * Load adapters from API
         */
        async loadAdapters() {
            try {
                const response = await adapterApi.list();
                this.adapters = response.data || [];
            } catch (error) {
                console.error('Failed to load adapters:', error);
                this.showError('加载适配器列表失败');
            }
        }

        /**
         * Render the adapter management UI
         */
        render() {
            if (!this.container) return;

            this.container.innerHTML = `
                <div class="adapter-manager">
                    <div class="adapter-toolbar">
                        <button class="btn btn-primary" id="btn-add-adapter">
                            <i class="icon-plus"></i> 添加适配器
                        </button>
                        <button class="btn btn-secondary" id="btn-refresh-adapters">
                            <i class="icon-refresh"></i> 刷新
                        </button>
                    </div>
                    
                    <div class="adapter-list" id="adapter-list">
                        ${this.renderAdapterList()}
                    </div>
                    
                    <div class="adapter-detail" id="adapter-detail" style="display: none;">
                        ${this.renderAdapterDetail()}
                    </div>
                </div>
            `;

            this.bindEvents();
        }

        /**
         * Render adapter list
         */
        renderAdapterList() {
            if (this.adapters.length === 0) {
                return `
                    <div class="empty-state">
                        <p>暂无适配器</p>
                        <p class="hint">点击"添加适配器"开始配置</p>
                    </div>
                `;
            }

            return this.adapters.map(adapter => `
                <div class="adapter-card ${adapter.status}" 
                     data-adapter-id="${adapter.adapterId}"
                     onclick="adapterManager.selectAdapter('${adapter.adapterId}')">
                    <div class="adapter-header">
                        <span class="adapter-name">${adapter.name}</span>
                        <span class="adapter-status status-${adapter.status}">
                            ${this.getStatusText(adapter.status)}
                        </span>
                    </div>
                    <div class="adapter-info">
                        <span class="adapter-channel">${this.getChannelLabel(adapter.channel)}</span>
                        <span class="adapter-type">${adapter.type || 'default'}</span>
                    </div>
                    <div class="adapter-meta">
                        <span class="adapter-last-seen">
                            最后活跃: ${this.formatLastSeen(adapter.lastSeenAt)}
                        </span>
                    </div>
                </div>
            `).join('');
        }

        /**
         * Render adapter detail panel
         */
        renderAdapterDetail() {
            if (!this.selectedAdapter) {
                return '<p class="hint">选择一个适配器查看详情</p>';
            }

            const adapter = this.selectedAdapter;
            return `
                <div class="detail-header">
                    <h3>${adapter.name}</h3>
                    <div class="detail-actions">
                        <button class="btn btn-sm btn-secondary" onclick="adapterManager.editAdapter()">
                            编辑
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="adapterManager.deleteAdapter()">
                            删除
                        </button>
                    </div>
                </div>
                
                <div class="detail-tabs">
                    <button class="tab active" data-tab="config">配置</button>
                    <button class="tab" data-tab="health">健康状态</button>
                    <button class="tab" data-tab="metrics">指标</button>
                    <button class="tab" data-tab="logs">日志</button>
                </div>
                
                <div class="detail-content" id="detail-content">
                    ${this.renderConfigTab(adapter)}
                </div>
            `;
        }

        /**
         * Render config tab content
         */
        renderConfigTab(adapter) {
            return `
                <div class="config-section">
                    <h4>基本信息</h4>
                    <div class="config-grid">
                        <div class="config-item">
                            <label>适配器ID</label>
                            <span class="value">${adapter.adapterId}</span>
                        </div>
                        <div class="config-item">
                            <label>渠道类型</label>
                            <span class="value">${this.getChannelLabel(adapter.channel)}</span>
                        </div>
                        <div class="config-item">
                            <label>状态</label>
                            <span class="value status-${adapter.status}">${this.getStatusText(adapter.status)}</span>
                        </div>
                        <div class="config-item">
                            <label>创建时间</label>
                            <span class="value">${this.formatDate(adapter.createdAt)}</span>
                        </div>
                    </div>
                </div>
                
                <div class="config-section">
                    <h4>能力矩阵</h4>
                    <div class="capability-grid">
                        ${this.renderCapabilities(adapter.capabilities)}
                    </div>
                </div>
                
                <div class="config-section">
                    <h4>认证配置</h4>
                    <div class="auth-config">
                        <div class="config-item">
                            <label>认证类型</label>
                            <span class="value">${adapter.auth?.type || 'N/A'}</span>
                        </div>
                        <div class="config-item">
                            <label>签名算法</label>
                            <span class="value">${adapter.auth?.signatureAlgorithm || 'N/A'}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render capabilities display
         */
        renderCapabilities(capabilities) {
            const caps = capabilities || {};
            const capabilityList = [
                { key: 'supportsText', label: '文本消息' },
                { key: 'supportsImage', label: '图片消息' },
                { key: 'supportsAudio', label: '语音消息' },
                { key: 'supportsVideo', label: '视频消息' },
                { key: 'supportsFile', label: '文件消息' },
                { key: 'supportsCard', label: '卡片消息' },
                { key: 'supportsMarkdown', label: 'Markdown' },
                { key: 'supportsEmoji', label: 'Emoji' },
                { key: 'supportsReply', label: '回复消息' },
                { key: 'supportsEdit', label: '编辑消息' },
                { key: 'supportsDelete', label: '删除消息' },
                { key: 'supportsReaction', label: '消息反应' }
            ];

            return capabilityList.map(cap => `
                <div class="capability-item ${caps[cap.key] ? 'enabled' : 'disabled'}">
                    <i class="icon-${caps[cap.key] ? 'check' : 'times'}"></i>
                    <span>${cap.label}</span>
                </div>
            `).join('');
        }

        /**
         * Bind event handlers
         */
        bindEvents() {
            // Add adapter button
            const addBtn = document.getElementById('btn-add-adapter');
            if (addBtn) {
                addBtn.addEventListener('click', () => this.showAddAdapterDialog());
            }

            // Refresh button
            const refreshBtn = document.getElementById('btn-refresh-adapters');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => this.refresh());
            }

            const saveBtn = document.getElementById('save-adapter');
            if (saveBtn && !saveBtn.dataset.bound) {
                saveBtn.dataset.bound = 'true';
                saveBtn.addEventListener('click', () => this.saveAdapter());
            }

            const form = document.getElementById('adapter-form');
            if (form && !form.dataset.bound) {
                form.dataset.bound = 'true';
                form.addEventListener('submit', (event) => {
                    event.preventDefault();
                    this.saveAdapter();
                });
            }

            // Tab buttons
            const tabs = document.querySelectorAll('.detail-tabs .tab');
            tabs.forEach(tab => {
                tab.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
            });
        }

        /**
         * Select an adapter
         */
        selectAdapter(adapterId) {
            this.selectedAdapter = this.adapters.find(a => a.adapterId === adapterId);
            
            // Update UI selection
            document.querySelectorAll('.adapter-card').forEach(card => {
                card.classList.remove('selected');
            });
            const selectedCard = document.querySelector(`[data-adapter-id="${adapterId}"]`);
            if (selectedCard) {
                selectedCard.classList.add('selected');
            }

            // Show detail panel
            const detailPanel = document.getElementById('adapter-detail');
            if (detailPanel) {
                detailPanel.style.display = 'block';
                detailPanel.innerHTML = this.renderAdapterDetail();
                this.bindEvents();
            }

            if (this.onAdapterSelect) {
                this.onAdapterSelect(this.selectedAdapter);
            }
        }

        /**
         * Switch detail tab
         */
        switchTab(tabName) {
            // Update tab buttons
            document.querySelectorAll('.detail-tabs .tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.tab === tabName);
            });

            // Update content
            const content = document.getElementById('detail-content');
            if (!content || !this.selectedAdapter) return;

            switch (tabName) {
                case 'config':
                    content.innerHTML = this.renderConfigTab(this.selectedAdapter);
                    break;
                case 'health':
                    this.loadHealthTab();
                    break;
                case 'metrics':
                    this.loadMetricsTab();
                    break;
                case 'logs':
                    this.loadLogsTab();
                    break;
            }
        }

        /**
         * Load health tab content
         */
        async loadHealthTab() {
            const content = document.getElementById('detail-content');
            if (!content) return;

            content.innerHTML = '<div class="loading">加载中...</div>';

            try {
                const response = await adapterApi.health(this.selectedAdapter.adapterId);
                const health = response.data;

                content.innerHTML = `
                    <div class="health-section">
                        <div class="health-status ${health.healthy ? 'healthy' : 'unhealthy'}">
                            <i class="icon-${health.healthy ? 'check-circle' : 'times-circle'}"></i>
                            <span>${health.healthy ? '健康' : '异常'}</span>
                        </div>
                        
                        <div class="health-details">
                            <div class="health-item">
                                <label>最后检查</label>
                                <span>${this.formatDate(health.lastCheck)}</span>
                            </div>
                            <div class="health-item">
                                <label>响应时间</label>
                                <span>${health.responseTime || 'N/A'}ms</span>
                            </div>
                            <div class="health-item">
                                <label>错误次数</label>
                                <span class="${health.errorCount > 0 ? 'error' : ''}">${health.errorCount || 0}</span>
                            </div>
                        </div>
                        
                        ${health.issues && health.issues.length > 0 ? `
                            <div class="health-issues">
                                <h4>问题列表</h4>
                                <ul>
                                    ${health.issues.map(issue => `
                                        <li class="issue-${issue.severity}">
                                            <span class="issue-message">${issue.message}</span>
                                            <span class="issue-time">${this.formatDate(issue.timestamp)}</span>
                                        </li>
                                    `).join('')}
                                </ul>
                            </div>
                        ` : ''}
                    </div>
                `;
            } catch (error) {
                content.innerHTML = '<div class="error">加载健康状态失败</div>';
            }
        }

        /**
         * Load metrics tab content
         */
        async loadMetricsTab() {
            const content = document.getElementById('detail-content');
            if (!content) return;

            content.innerHTML = '<div class="loading">加载中...</div>';

            try {
                const response = await ChannelHubAPI?.Metrics?.byAdapter(this.selectedAdapter.adapterId);
                const metrics = response.data;

                content.innerHTML = `
                    <div class="metrics-section">
                        <div class="metrics-grid">
                            <div class="metric-card">
                                <div class="metric-value">${metrics.eventsReceived || 0}</div>
                                <div class="metric-label">接收事件</div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-value">${metrics.eventsProcessed || 0}</div>
                                <div class="metric-label">处理成功</div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-value">${metrics.eventsFailed || 0}</div>
                                <div class="metric-label">处理失败</div>
                            </div>
                            <div class="metric-card">
                                <div class="metric-value">${metrics.avgProcessingTime || 0}ms</div>
                                <div class="metric-label">平均处理时间</div>
                            </div>
                        </div>
                        
                        <div class="metrics-chart" id="adapter-metrics-chart">
                            <!-- Chart placeholder -->
                        </div>
                    </div>
                `;
            } catch (error) {
                content.innerHTML = '<div class="error">加载指标失败</div>';
            }
        }

        /**
         * Load logs tab content
         */
        async loadLogsTab() {
            const content = document.getElementById('detail-content');
            if (!content) return;

            content.innerHTML = '<div class="loading">加载中...</div>';

            try {
                const response = await global.fetch(`/admin_api/channelHub/audit-logs?adapterId=${encodeURIComponent(this.selectedAdapter.adapterId)}&limit=100`)
                    .then(r => r.json());
                const logs = response.data || [];

                content.innerHTML = `
                    <div class="logs-section">
                        <div class="logs-filter">
                            <select id="log-level-filter">
                                <option value="">所有级别</option>
                                <option value="debug">Debug</option>
                                <option value="info">Info</option>
                                <option value="warn">Warn</option>
                                <option value="error">Error</option>
                            </select>
                        </div>
                        <div class="logs-list">
                            ${logs.map(log => `
                                <div class="log-entry log-${log.level}">
                                    <span class="log-time">${this.formatDate(log.timestamp)}</span>
                                    <span class="log-level">${log.level.toUpperCase()}</span>
                                    <span class="log-message">${log.message}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            } catch (error) {
                content.innerHTML = '<div class="error">加载日志失败</div>';
            }
        }

        /**
         * Show add adapter dialog
         */
        showAddAdapterDialog() {
            // Clear form
            const form = document.getElementById('adapter-form');
            if (form) form.reset();
            
            // Show modal using Bootstrap
            const modal = new bootstrap.Modal(document.getElementById('adapter-modal'));
            modal.show();
        }

        /**
         * Save adapter (create or update)
         */
        async saveAdapter() {
            const form = document.getElementById('adapter-form');
            if (!form) return;

            const formData = new FormData(form);
            const config = {
                adapterId: formData.get('adapterId')?.trim(),
                channel: formData.get('channel')?.trim(),
                name: formData.get('name')?.trim(),
                config: this.parseConfig(formData.get('config'))
            };

            // Validate
            if (!config.adapterId) {
                showToast('适配器 ID 不能为空', 'danger');
                return;
            }
            if (!config.channel) {
                showToast('渠道类型不能为空', 'danger');
                return;
            }
            if (!config.name) {
                showToast('名称不能为空', 'danger');
                return;
            }

            try {
                // Check if adapter exists (for update)
                const existing = this.adapters.find(a => a.adapterId === config.adapterId);
                
                if (existing) {
                    // Update existing
                    await adapterApi.update(config.adapterId, config);
                    showToast('适配器已更新', 'success');
                } else {
                    // Create new
                    await adapterApi.create(config);
                    showToast('适配器已创建', 'success');
                }

                // Close modal
                const modal = bootstrap.Modal.getInstance(document.getElementById('adapter-modal'));
                if (modal) modal.hide();

                // Refresh list
                await this.refresh();

            } catch (error) {
                console.error('Failed to save adapter:', error);
                showToast(`保存失败：${error.message}`, 'danger');
            }
        }

        /**
         * Parse config JSON string
         */
        parseConfig(configStr) {
            if (!configStr || configStr.trim() === '') {
                return {};
            }
            try {
                return JSON.parse(configStr);
            } catch (e) {
                throw new Error('配置必须是有效的 JSON 格式');
            }
        }

        /**
         * Edit selected adapter
         */
        editAdapter() {
            if (!this.selectedAdapter) return;
            // TODO: Implement edit dialog
            console.log('Edit adapter:', this.selectedAdapter.adapterId);
        }

        /**
         * Delete selected adapter
         */
        async deleteAdapter() {
            if (!this.selectedAdapter) return;

            if (!confirm(`确定要删除适配器 "${this.selectedAdapter.name}" 吗？`)) {
                return;
            }

            try {
                await adapterApi.delete(this.selectedAdapter.adapterId);
                this.adapters = this.adapters.filter(a => a.adapterId !== this.selectedAdapter.adapterId);
                this.selectedAdapter = null;
                this.render();
            } catch (error) {
                console.error('Failed to delete adapter:', error);
                alert('删除适配器失败');
            }
        }

        /**
         * Refresh adapter list
         */
        async refresh() {
            await this.loadAdapters();
            this.render();
        }

        /**
         * Start auto refresh
         */
        startAutoRefresh(interval = 30000) {
            this.stopAutoRefresh();
            this.refreshInterval = setInterval(() => this.refresh(), interval);
        }

        /**
         * Stop auto refresh
         */
        stopAutoRefresh() {
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
                this.refreshInterval = null;
            }
        }

        /**
         * Show error message
         */
        showError(message) {
            // TODO: Implement toast notification
            console.error(message);
        }

        /**
         * Get status text
         */
        getStatusText(status) {
            const statusMap = {
                'active': '运行中',
                'inactive': '未激活',
                'error': '异常',
                'pending': '等待中',
                'disabled': '已禁用'
            };
            return statusMap[status] || status;
        }

        /**
         * Get channel label
         */
        getChannelLabel(channel) {
            const channelMap = {
                'dingtalk': '钉钉',
                'wecom': '企业微信',
                'feishu': '飞书',
                'qq': 'QQ',
                'wechat': '微信',
                'telegram': 'Telegram',
                'discord': 'Discord',
                'slack': 'Slack'
            };
            return channelMap[channel] || channel;
        }

        /**
         * Format last seen time
         */
        formatLastSeen(timestamp) {
            if (!timestamp) return '未知';
            const date = new Date(timestamp);
            const now = new Date();
            const diff = now - date;

            if (diff < 60000) return '刚刚';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
            return this.formatDate(timestamp);
        }

        /**
         * Format date
         */
        formatDate(timestamp) {
            if (!timestamp) return 'N/A';
            return new Date(timestamp).toLocaleString('zh-CN');
        }

        /**
         * Destroy the manager
         */
        destroy() {
            this.stopAutoRefresh();
        }
    }

    // Export to global
    global.AdapterManager = AdapterManager;
    global.adapterManager = null;

    function renderStatusBadge(status) {
        const statusClass = {
            active: 'status-active',
            inactive: 'status-inactive',
            pending: 'status-pending',
            error: 'status-error',
            disabled: 'status-inactive'
        }[status] || 'status-inactive';
        return `<span class="status-badge ${statusClass}">${status || 'inactive'}</span>`;
    }

    function renderAdaptersTable(adapters) {
        const tbody = document.getElementById('adapters-table');
        if (!tbody) return;

        if (!Array.isArray(adapters) || adapters.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-muted">暂无适配器</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = adapters.map((adapter) => `
            <tr>
                <td>${adapter.adapterId || '-'}</td>
                <td>${adapter.channel || '-'}</td>
                <td>${adapter.name || '-'}</td>
                <td>${renderStatusBadge(adapter.status)}</td>
                <td><code>${adapter.config?.webhookUrl || '-'}</code></td>
                <td>
                    <button type="button" class="btn btn-sm btn-outline-danger btn-delete-adapter" data-adapter-id="${adapter.adapterId}">
                        删除
                    </button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.btn-delete-adapter').forEach((button) => {
            button.addEventListener('click', async () => {
                const adapterId = button.dataset.adapterId;
                if (!adapterId) return;
                if (!confirm(`确定删除适配器 "${adapterId}" 吗？`)) return;

                try {
                    await adapterApi.delete(adapterId);
                    showToast('适配器已删除', 'success');
                    await global.loadAdapters();
                } catch (error) {
                    console.error('Failed to delete adapter:', error);
                    showToast(`删除失败：${error.message}`, 'danger');
                }
            });
        });
    }

    global.loadAdapters = async function loadAdapters() {
        if (!adapterApi) {
            console.error('ChannelHub adapter API is not available');
            showToast('适配器 API 未初始化', 'danger');
            return;
        }

        try {
            const response = await adapterApi.list();
            const adapters = response.data || [];
            renderAdaptersTable(adapters);
        } catch (error) {
            console.error('Failed to load adapters:', error);
            showToast(`加载适配器失败：${error.message}`, 'danger');
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        const saveBtn = document.getElementById('save-adapter');
        if (saveBtn && !saveBtn.dataset.globalBound) {
            saveBtn.dataset.globalBound = 'true';
            saveBtn.addEventListener('click', async () => {
                const form = document.getElementById('adapter-form');
                if (!form) return;

                const formData = new FormData(form);
                const configText = formData.get('config');
                let parsedConfig = {};

                try {
                    parsedConfig = configText && String(configText).trim()
                        ? JSON.parse(String(configText))
                        : {};
                } catch (error) {
                    showToast(`配置 JSON 无效：${error.message}`, 'danger');
                    return;
                }

                const payload = {
                    adapterId: String(formData.get('adapterId') || '').trim(),
                    channel: String(formData.get('channel') || '').trim(),
                    name: String(formData.get('name') || '').trim(),
                    config: parsedConfig
                };

                if (!payload.adapterId || !payload.channel || !payload.name) {
                    showToast('请完整填写适配器 ID、渠道类型和名称', 'danger');
                    return;
                }

                try {
                    await adapterApi.create(payload);
                    showToast('适配器已创建', 'success');

                    const modalEl = document.getElementById('adapter-modal');
                    const modal = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
                    if (modal) modal.hide();
                    form.reset();
                    await global.loadAdapters();
                } catch (error) {
                    console.error('Failed to save adapter:', error);
                    showToast(`保存失败：${error.message}`, 'danger');
                }
            });
        }
    });

})(typeof window !== 'undefined' ? window : global);
