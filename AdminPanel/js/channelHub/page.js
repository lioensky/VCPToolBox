/**
 * ChannelHub Page Controller
 * 统一管理 ChannelHub AdminPanel 页面导航、数据加载和表单提交。
 */

(function(global) {
    'use strict';

    const ChannelHubPage = {
        currentSection: 'dashboard',

        init() {
            this.bindNavigation();
            this.bindActions();
            this.showSection('dashboard');
        },

        bindNavigation() {
            document.querySelectorAll('.nav-link[data-section]').forEach((link) => {
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    this.showSection(link.dataset.section);
                });
            });
        },

        bindActions() {
            const saveAdapterBtn = document.getElementById('save-adapter');
            if (saveAdapterBtn) {
                saveAdapterBtn.addEventListener('click', () => this.saveAdapter());
            }

            const saveBindingBtn = document.getElementById('save-binding');
            if (saveBindingBtn) {
                saveBindingBtn.addEventListener('click', () => this.saveBinding());
            }

            const refreshOutboxBtn = document.getElementById('refresh-outbox');
            if (refreshOutboxBtn) {
                refreshOutboxBtn.addEventListener('click', () => this.loadOutbox());
            }

            const refreshAuditBtn = document.getElementById('refresh-audit');
            if (refreshAuditBtn) {
                refreshAuditBtn.addEventListener('click', () => this.loadAudit());
            }

            const auditFilterForm = document.getElementById('audit-filter-form');
            if (auditFilterForm) {
                auditFilterForm.addEventListener('submit', (event) => {
                    event.preventDefault();
                    this.loadAudit(this.collectAuditFilters());
                });
            }
        },

        async showSection(section) {
            this.currentSection = section;

            document.querySelectorAll('.nav-link').forEach((link) => {
                link.classList.toggle('active', link.dataset.section === section);
            });

            document.querySelectorAll('.section').forEach((node) => {
                node.classList.toggle('active', node.id === section);
            });

            switch (section) {
                case 'dashboard':
                    await this.loadDashboard();
                    break;
                case 'adapters':
                    await this.loadAdapters();
                    break;
                case 'bindings':
                    await this.loadBindings();
                    break;
                case 'outbox':
                    await this.loadOutbox();
                    break;
                case 'metrics':
                    await this.loadMetrics();
                    break;
                case 'audit':
                    await this.loadAudit();
                    break;
                default:
                    break;
            }
        },

        async loadDashboard() {
            try {
                const [adaptersResp, bindingsResp, metricsResp] = await Promise.all([
                    global.ChannelHubAPI.getAdapters(),
                    global.ChannelHubAPI.getBindings(),
                    global.ChannelHubAPI.getMetrics()
                ]);

                const adapters = adaptersResp.data || [];
                const bindings = bindingsResp.data || [];
                const metrics = metricsResp.data || {};

                this.setText('metric-adapters', adapters.length);
                this.setText('metric-bindings', bindings.length);
                this.setText('metric-events', metrics.totalEvents || 0);
                this.setText('metric-messages', metrics.totalEvents || 0);

                const tbody = document.getElementById('dashboard-adapters-table');
                if (tbody) {
                    tbody.innerHTML = adapters.length
                        ? adapters.map((adapter) => `
                            <tr>
                                <td>${this.escape(adapter.adapterId)}</td>
                                <td>${this.escape(adapter.channel || '-')}</td>
                                <td>${this.renderStatus(adapter.status)}</td>
                                <td>${adapter.lastSeenAt ? global.ChannelHubAPI.formatDate(adapter.lastSeenAt) : '-'}</td>
                            </tr>
                        `).join('')
                        : '<tr><td colspan="4" class="text-center text-muted">暂无数据</td></tr>';
                }
            } catch (error) {
                console.error('Failed to load dashboard:', error);
                this.toast(`加载仪表盘失败: ${error.message}`, 'danger');
            }
        },

        async loadAdapters() {
            try {
                const response = await global.ChannelHubAPI.getAdapters();
                const adapters = response.data || [];
                const tbody = document.getElementById('adapters-table');

                if (!tbody) return;

                tbody.innerHTML = adapters.length
                    ? adapters.map((adapter) => `
                        <tr>
                            <td>${this.escape(adapter.adapterId)}</td>
                            <td>${this.escape(adapter.channel || '-')}</td>
                            <td>${this.escape(adapter.name || '-')}</td>
                            <td>${this.renderStatus(adapter.status)}</td>
                            <td><code>${this.escape(adapter.config?.webhookUrl || '-')}</code></td>
                            <td>
                                <button type="button" class="btn btn-sm btn-outline-danger" data-delete-adapter="${this.escape(adapter.adapterId)}">
                                    删除
                                </button>
                            </td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="6" class="text-center text-muted">暂无适配器</td></tr>';

                tbody.querySelectorAll('[data-delete-adapter]').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const adapterId = button.dataset.deleteAdapter;
                        if (!confirm(`确定删除适配器 "${adapterId}" 吗？`)) {
                            return;
                        }

                        try {
                            await global.ChannelHubAPI.adapters.delete(adapterId);
                            this.toast('适配器已删除', 'success');
                            await this.loadAdapters();
                            await this.loadDashboard();
                        } catch (error) {
                            console.error('Failed to delete adapter:', error);
                            this.toast(`删除失败: ${error.message}`, 'danger');
                        }
                    });
                });
            } catch (error) {
                console.error('Failed to load adapters:', error);
                this.toast(`加载适配器失败: ${error.message}`, 'danger');
            }
        },

        async saveAdapter() {
            const form = document.getElementById('adapter-form');
            if (!form) return;

            const formData = new FormData(form);
            let parsedConfig = {};

            try {
                const rawConfig = String(formData.get('config') || '').trim();
                parsedConfig = rawConfig ? JSON.parse(rawConfig) : {};
            } catch (error) {
                this.toast(`配置 JSON 无效: ${error.message}`, 'danger');
                return;
            }

            const payload = {
                adapterId: String(formData.get('adapterId') || '').trim(),
                channel: String(formData.get('channel') || '').trim(),
                name: String(formData.get('name') || '').trim(),
                config: parsedConfig
            };

            if (!payload.adapterId || !payload.channel || !payload.name) {
                this.toast('请完整填写适配器 ID、渠道类型和名称', 'danger');
                return;
            }

            try {
                await global.ChannelHubAPI.adapters.create(payload);
                this.toast('适配器已创建', 'success');
                this.hideModal('adapter-modal');
                form.reset();
                await this.loadAdapters();
                await this.loadDashboard();
            } catch (error) {
                console.error('Failed to save adapter:', error);
                this.toast(`保存失败: ${error.message}`, 'danger');
            }
        },

        async loadBindings() {
            try {
                const response = await global.ChannelHubAPI.getBindings();
                const bindings = response.data || [];
                const tbody = document.getElementById('bindings-table');
                const adapterSelect = document.querySelector('#binding-form select[name="adapterId"]');

                if (tbody) {
                    tbody.innerHTML = bindings.length
                        ? bindings.map((binding) => `
                            <tr>
                                <td><code>${this.escape(binding.bindingKey || '-')}</code></td>
                                <td>${this.escape(binding.adapterId || '-')}</td>
                                <td>${this.escape(binding.externalSessionKey || '-')}</td>
                                <td>${this.escape(binding.conversationId || '-')}</td>
                                <td>${this.escape(binding.agentId || '-')}</td>
                                <td>${binding.createdAt ? global.ChannelHubAPI.formatDate(binding.createdAt) : '-'}</td>
                                <td>
                                    <button type="button" class="btn btn-sm btn-outline-danger" data-delete-binding="${this.escape(binding.bindingKey)}">
                                        删除
                                    </button>
                                </td>
                            </tr>
                        `).join('')
                        : '<tr><td colspan="7" class="text-center text-muted">暂无绑定</td></tr>';

                    tbody.querySelectorAll('[data-delete-binding]').forEach((button) => {
                        button.addEventListener('click', async () => {
                            const bindingKey = button.dataset.deleteBinding;
                            if (!confirm(`确定删除绑定 "${bindingKey}" 吗？`)) {
                                return;
                            }

                            try {
                                await global.ChannelHubAPI.deleteBinding(bindingKey);
                                this.toast('绑定已删除', 'success');
                                await this.loadBindings();
                                await this.loadDashboard();
                            } catch (error) {
                                console.error('Failed to delete binding:', error);
                                this.toast(`删除失败: ${error.message}`, 'danger');
                            }
                        });
                    });
                }

                if (adapterSelect) {
                    const adaptersResp = await global.ChannelHubAPI.getAdapters();
                    const adapters = adaptersResp.data || [];
                    adapterSelect.innerHTML = `
                        <option value="">请选择...</option>
                        ${adapters.map((adapter) => `<option value="${this.escape(adapter.adapterId)}">${this.escape(adapter.name || adapter.adapterId)}</option>`).join('')}
                    `;
                }
            } catch (error) {
                console.error('Failed to load bindings:', error);
                this.toast(`加载绑定失败: ${error.message}`, 'danger');
            }
        },

        async saveBinding() {
            const form = document.getElementById('binding-form');
            if (!form) return;

            const formData = new FormData(form);
            const payload = {
                adapterId: String(formData.get('adapterId') || '').trim(),
                externalSessionKey: String(formData.get('externalSessionKey') || '').trim(),
                conversationId: String(formData.get('vcpSessionId') || '').trim(),
                agentId: String(formData.get('agentId') || '').trim()
            };

            if (!payload.adapterId || !payload.externalSessionKey || !payload.agentId) {
                this.toast('请完整填写适配器、外部会话 Key 和 Agent ID', 'danger');
                return;
            }

            payload.bindingKey = `${payload.adapterId}:${payload.externalSessionKey}`;

            try {
                await global.ChannelHubAPI.createBinding(payload);
                this.toast('绑定已创建', 'success');
                this.hideModal('binding-modal');
                form.reset();
                await this.loadBindings();
                await this.loadDashboard();
            } catch (error) {
                console.error('Failed to save binding:', error);
                this.toast(`保存失败: ${error.message}`, 'danger');
            }
        },

        async loadOutbox() {
            try {
                const response = await global.ChannelHubAPI.getOutboxMessages({ limit: 100 });
                const messages = response.data?.messages || [];
                const tbody = document.getElementById('outbox-table');

                if (!tbody) return;

                tbody.innerHTML = messages.length
                    ? messages.map((message) => `
                        <tr>
                            <td>${this.escape(message.jobId || message.messageId || '-')}</td>
                            <td>${this.escape(message.adapterId || '-')}</td>
                            <td>${this.escape(message.target?.conversationId || message.targetId || '-')}</td>
                            <td>${this.escape(message.channel || '-')}</td>
                            <td>${this.renderStatus(message.status)}</td>
                            <td>${message.retryCount || message.attempts || 0}</td>
                            <td>${message.createdAt ? global.ChannelHubAPI.formatDate(message.createdAt) : '-'}</td>
                            <td>
                                <button type="button" class="btn btn-sm btn-outline-primary" data-retry-outbox="${this.escape(message.jobId || message.messageId || '')}">
                                    重试
                                </button>
                            </td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="8" class="text-center text-muted">暂无消息</td></tr>';

                tbody.querySelectorAll('[data-retry-outbox]').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const jobId = button.dataset.retryOutbox;
                        if (!jobId) return;

                        try {
                            await global.ChannelHubAPI.retryOutboxMessage(jobId);
                            this.toast('出站任务已加入重试队列', 'success');
                            await this.loadOutbox();
                        } catch (error) {
                            console.error('Failed to retry outbox job:', error);
                            this.toast(`重试失败: ${error.message}`, 'danger');
                        }
                    });
                });
            } catch (error) {
                console.error('Failed to load outbox:', error);
                this.toast(`加载发件箱失败: ${error.message}`, 'danger');
            }
        },

        async loadMetrics() {
            try {
                const response = await global.ChannelHubAPI.getMetrics();
                const metrics = response.data || {};
                const tbody = document.getElementById('channel-metrics-table');
                const rows = metrics.byChannel || [];

                if (tbody) {
                    tbody.innerHTML = rows.length
                        ? rows.map((row) => `
                            <tr>
                                <td>${this.escape(row.channel || '-')}</td>
                                <td>${row.eventCount || 0}</td>
                                <td>${row.eventCount || 0}</td>
                                <td>${((row.successRate || 0) * 100).toFixed(1)}%</td>
                                <td>${row.avgLatency || 0}ms</td>
                            </tr>
                        `).join('')
                        : '<tr><td colspan="5" class="text-center text-muted">暂无指标</td></tr>';
                }
            } catch (error) {
                console.error('Failed to load metrics:', error);
                this.toast(`加载指标失败: ${error.message}`, 'danger');
            }
        },

        async loadAudit(filters = {}) {
            try {
                const response = await global.ChannelHubAPI.getAuditLogs(filters);
                const logs = response.data || [];
                const tbody = document.getElementById('audit-table');

                if (!tbody) return;

                tbody.innerHTML = logs.length
                    ? logs.map((log) => `
                        <tr>
                            <td>${log.timestamp ? new Date(log.timestamp).toLocaleString('zh-CN') : '-'}</td>
                            <td><code>${this.escape(log.requestId || log.traceId || '-')}</code></td>
                            <td>${this.escape(log.adapterId || '-')}</td>
                            <td>${this.escape(log.eventType || log.type || '-')}</td>
                            <td>${this.escape(log.status || log.level || '-')}</td>
                            <td>${log.durationMs ? `${log.durationMs}ms` : '-'}</td>
                            <td>-</td>
                        </tr>
                    `).join('')
                    : '<tr><td colspan="7" class="text-center text-muted">暂无审计记录</td></tr>';
            } catch (error) {
                console.error('Failed to load audit:', error);
                this.toast(`加载审计记录失败: ${error.message}`, 'danger');
            }
        },

        collectAuditFilters() {
            const form = document.getElementById('audit-filter-form');
            if (!form) return {};
            const formData = new FormData(form);
            return Object.fromEntries(Array.from(formData.entries()).filter(([, value]) => value));
        },

        hideModal(id) {
            const modalEl = document.getElementById(id);
            if (!modalEl) return;
            const modal = global.bootstrap?.Modal?.getInstance(modalEl);
            if (modal) {
                modal.hide();
            }
        },

        renderStatus(status) {
            const normalized = status || 'inactive';
            const classMap = {
                active: 'status-active',
                delivered: 'status-active',
                success: 'status-active',
                pending: 'status-pending',
                processing: 'status-pending',
                inactive: 'status-inactive',
                failed: 'status-error',
                error: 'status-error'
            };

            return `<span class="status-badge ${classMap[normalized] || 'status-inactive'}">${this.escape(normalized)}</span>`;
        },

        setText(id, value) {
            const node = document.getElementById(id);
            if (node) {
                node.textContent = value;
            }
        },

        toast(message, type) {
            if (typeof global.showToast === 'function') {
                global.showToast(message, type);
            } else {
                console.error(message);
            }
        },

        escape(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }
    };

    global.ChannelHubPage = ChannelHubPage;
})(typeof window !== 'undefined' ? window : global);
