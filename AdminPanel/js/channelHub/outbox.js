/**
 * ChannelHub Outbox Management UI Module
 * 管理出站消息队列、重试、死信队列等
 * 
 * @file outbox.js
 * @description Delivery Outbox 管理界面交互逻辑
 */

(function(global) {
    'use strict';

    const OutboxUI = {
        // 当前状态
        state: {
            messages: [],
            stats: null,
            filters: {
                status: '',
                channel: '',
                adapterId: '',
                page: 1,
                limit: 20
            },
            loading: false,
            selectedMessages: new Set()
        },

        // 状态映射
        statusMap: {
            pending: { label: '待发送', class: 'status-pending', icon: '⏳' },
            processing: { label: '发送中', class: 'status-processing', icon: '🔄' },
            sent: { label: '已发送', class: 'status-sent', icon: '✅' },
            failed: { label: '发送失败', class: 'status-failed', icon: '❌' },
            dead_letter: { label: '死信', class: 'status-dead-letter', icon: '💀' }
        },

        /**
         * 初始化模块
         */
        init() {
            this.bindEvents();
            this.loadMessages();
            this.loadStats();
        },

        /**
         * 绑定事件
         */
        bindEvents() {
            // 刷新按钮
            const refreshBtn = document.getElementById('outbox-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => this.loadMessages());
            }

            // 筛选器
            const statusFilter = document.getElementById('outbox-status-filter');
            const channelFilter = document.getElementById('outbox-channel-filter');
            const adapterFilter = document.getElementById('outbox-adapter-filter');

            if (statusFilter) {
                statusFilter.addEventListener('change', (e) => {
                    this.state.filters.status = e.target.value;
                    this.state.filters.page = 1;
                    this.loadMessages();
                });
            }

            if (channelFilter) {
                channelFilter.addEventListener('change', (e) => {
                    this.state.filters.channel = e.target.value;
                    this.state.filters.page = 1;
                    this.loadMessages();
                });
            }

            if (adapterFilter) {
                adapterFilter.addEventListener('change', (e) => {
                    this.state.filters.adapterId = e.target.value;
                    this.state.filters.page = 1;
                    this.loadMessages();
                });
            }

            // 批量操作按钮
            const retrySelectedBtn = document.getElementById('outbox-retry-selected');
            const deleteSelectedBtn = document.getElementById('outbox-delete-selected');

            if (retrySelectedBtn) {
                retrySelectedBtn.addEventListener('click', () => this.retrySelected());
            }

            if (deleteSelectedBtn) {
                deleteSelectedBtn.addEventListener('click', () => this.deleteSelected());
            }

            // 全选复选框
            const selectAllCheckbox = document.getElementById('outbox-select-all');
            if (selectAllCheckbox) {
                selectAllCheckbox.addEventListener('change', (e) => {
                    this.toggleSelectAll(e.target.checked);
                });
            }
        },

        /**
         * 加载消息列表
         */
        async loadMessages() {
            this.state.loading = true;
            this.renderLoading();

            try {
                const response = await ChannelHubAPI.getOutboxMessages(this.state.filters);
                
                if (response.success) {
                    this.state.messages = response.data.messages || [];
                    this.renderMessages();
                    this.renderPagination(response.data.pagination);
                } else {
                    this.renderError(response.error);
                }
            } catch (error) {
                this.renderError(error.message);
            } finally {
                this.state.loading = false;
            }
        },

        /**
         * 加载统计数据
         */
        async loadStats() {
            try {
                const response = await ChannelHubAPI.getOutboxStats();
                
                if (response.success) {
                    this.state.stats = response.data;
                    this.renderStats();
                }
            } catch (error) {
                console.error('Failed to load outbox stats:', error);
            }
        },

        /**
         * 渲染统计信息
         */
        renderStats() {
            const statsContainer = document.getElementById('outbox-stats');
            if (!statsContainer || !this.state.stats) return;

            const stats = this.state.stats;
            statsContainer.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-item">
                        <span class="stat-label">总消息数</span>
                        <span class="stat-value">${stats.total || 0}</span>
                    </div>
                    <div class="stat-item status-pending">
                        <span class="stat-label">待发送</span>
                        <span class="stat-value">${stats.pending || 0}</span>
                    </div>
                    <div class="stat-item status-processing">
                        <span class="stat-label">发送中</span>
                        <span class="stat-value">${stats.processing || 0}</span>
                    </div>
                    <div class="stat-item status-sent">
                        <span class="stat-label">已发送</span>
                        <span class="stat-value">${stats.sent || 0}</span>
                    </div>
                    <div class="stat-item status-failed">
                        <span class="stat-label">失败</span>
                        <span class="stat-value">${stats.failed || 0}</span>
                    </div>
                    <div class="stat-item status-dead-letter">
                        <span class="stat-label">死信</span>
                        <span class="stat-value">${stats.deadLetter || 0}</span>
                    </div>
                </div>
            `;
        },

        /**
         * 渲染消息列表
         */
        renderMessages() {
            const container = document.getElementById('outbox-messages');
            if (!container) return;

            if (this.state.messages.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">📭</div>
                        <div class="empty-text">暂无消息记录</div>
                    </div>
                `;
                return;
            }

            const html = this.state.messages.map(msg => this.renderMessageItem(msg)).join('');
            container.innerHTML = `<div class="message-list">${html}</div>`;
        },

        /**
         * 渲染单个消息项
         * @param {Object} msg 消息对象
         * @returns {string} HTML字符串
         */
        renderMessageItem(msg) {
            const status = this.statusMap[msg.status] || this.statusMap.pending;
            const selected = this.state.selectedMessages.has(msg.messageId);

            return `
                <div class="message-item ${status.class}" data-id="${msg.messageId}">
                    <div class="message-checkbox">
                        <input type="checkbox" 
                               ${selected ? 'checked' : ''} 
                               onchange="OutboxUI.toggleSelect('${msg.messageId}')">
                    </div>
                    <div class="message-status">
                        <span class="status-icon">${status.icon}</span>
                        <span class="status-label">${status.label}</span>
                    </div>
                    <div class="message-info">
                        <div class="message-id">ID: ${msg.messageId}</div>
                        <div class="message-meta">
                            <span class="message-channel">渠道: ${msg.channel}</span>
                            <span class="message-adapter">适配器: ${msg.adapterId}</span>
                            <span class="message-target">目标: ${msg.targetId || '-'}</span>
                        </div>
                        <div class="message-type">类型: ${msg.messageType || 'text'}</div>
                    </div>
                    <div class="message-retry">
                        重试次数: ${msg.retryCount || 0}/${msg.maxRetries || 3}
                    </div>
                    <div class="message-time">
                        <div>创建: ${this.formatTime(msg.createdAt)}</div>
                        ${msg.lastAttemptAt ? `<div>最后尝试: ${this.formatTime(msg.lastAttemptAt)}</div>` : ''}
                        ${msg.nextRetryAt ? `<div>下次重试: ${this.formatTime(msg.nextRetryAt)}</div>` : ''}
                    </div>
                    <div class="message-actions">
                        ${this.renderActions(msg)}
                    </div>
                </div>
            `;
        },

        /**
         * 渲染操作按钮
         * @param {Object} msg 消息对象
         * @returns {string} HTML字符串
         */
        renderActions(msg) {
            const actions = [];

            if (msg.status === 'failed' || msg.status === 'pending') {
                actions.push(`<button class="btn-retry" onclick="OutboxUI.retryMessage('${msg.messageId}')">重试</button>`);
            }

            if (msg.status === 'dead_letter') {
                actions.push(`<button class="btn-retry" onclick="OutboxUI.retryMessage('${msg.messageId}')">重新发送</button>`);
            }

            actions.push(`<button class="btn-view" onclick="OutboxUI.viewMessage('${msg.messageId}')">查看</button>`);
            actions.push(`<button class="btn-delete" onclick="OutboxUI.deleteMessage('${msg.messageId}')">删除</button>`);

            return actions.join('');
        },

        /**
         * 渲染分页
         * @param {Object} pagination 分页信息
         */
        renderPagination(pagination) {
            const container = document.getElementById('outbox-pagination');
            if (!container || !pagination) return;

            const { page, totalPages, total } = pagination;
            
            if (totalPages <= 1) {
                container.innerHTML = `<div class="pagination-info">共 ${total} 条记录</div>`;
                return;
            }

            let html = `<div class="pagination-info">共 ${total} 条记录，第 ${page}/${totalPages} 页</div>`;
            html += '<div class="pagination-buttons">';

            if (page > 1) {
                html += `<button onclick="OutboxUI.goToPage(${page - 1})">上一页</button>`;
            }

            for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
                if (i === page) {
                    html += `<button class="active">${i}</button>`;
                } else {
                    html += `<button onclick="OutboxUI.goToPage(${i})">${i}</button>`;
                }
            }

            if (page < totalPages) {
                html += `<button onclick="OutboxUI.goToPage(${page + 1})">下一页</button>`;
            }

            html += '</div>';
            container.innerHTML = html;
        },

        /**
         * 渲染加载状态
         */
        renderLoading() {
            const container = document.getElementById('outbox-messages');
            if (container) {
                container.innerHTML = `
                    <div class="loading-state">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">加载中...</div>
                    </div>
                `;
            }
        },

        /**
         * 渲染错误状态
         * @param {string} error 错误信息
         */
        renderError(error) {
            const container = document.getElementById('outbox-messages');
            if (container) {
                container.innerHTML = `
                    <div class="error-state">
                        <div class="error-icon">⚠️</div>
                        <div class="error-text">加载失败: ${error}</div>
                        <button onclick="OutboxUI.loadMessages()">重试</button>
                    </div>
                `;
            }
        },

        /**
         * 切换选择
         * @param {string} messageId 消息ID
         */
        toggleSelect(messageId) {
            if (this.state.selectedMessages.has(messageId)) {
                this.state.selectedMessages.delete(messageId);
            } else {
                this.state.selectedMessages.add(messageId);
            }
            this.updateSelectionUI();
        },

        /**
         * 全选/取消全选
         * @param {boolean} checked 是否选中
         */
        toggleSelectAll(checked) {
            if (checked) {
                this.state.messages.forEach(msg => {
                    this.state.selectedMessages.add(msg.messageId);
                });
            } else {
                this.state.selectedMessages.clear();
            }
            this.renderMessages();
            this.updateSelectionUI();
        },

        /**
         * 更新选择状态UI
         */
        updateSelectionUI() {
            const count = this.state.selectedMessages.size;
            const countElement = document.getElementById('selected-count');
            if (countElement) {
                countElement.textContent = count > 0 ? `已选择 ${count} 条` : '';
            }

            const retryBtn = document.getElementById('outbox-retry-selected');
            const deleteBtn = document.getElementById('outbox-delete-selected');

            if (retryBtn) retryBtn.disabled = count === 0;
            if (deleteBtn) deleteBtn.disabled = count === 0;
        },

        /**
         * 跳转到指定页
         * @param {number} page 页码
         */
        goToPage(page) {
            this.state.filters.page = page;
            this.loadMessages();
        },

        /**
         * 重试单个消息
         * @param {string} messageId 消息ID
         */
        async retryMessage(messageId) {
            try {
                const response = await ChannelHubAPI.retryOutboxMessage(messageId);
                
                if (response.success) {
                    this.showNotification('消息已加入重试队列', 'success');
                    this.loadMessages();
                    this.loadStats();
                } else {
                    this.showNotification(`重试失败: ${response.error}`, 'error');
                }
            } catch (error) {
                this.showNotification(`重试失败: ${error.message}`, 'error');
            }
        },

        /**
         * 删除单个消息
         * @param {string} messageId 消息ID
         */
        async deleteMessage(messageId) {
            if (!confirm('确定要删除这条消息吗？此操作不可恢复。')) {
                return;
            }

            try {
                const response = await ChannelHubAPI.deleteOutboxMessage(messageId);
                
                if (response.success) {
                    this.showNotification('消息已删除', 'success');
                    this.loadMessages();
                    this.loadStats();
                } else {
                    this.showNotification(`删除失败: ${response.error}`, 'error');
                }
            } catch (error) {
                this.showNotification(`删除失败: ${error.message}`, 'error');
            }
        },

        /**
         * 查看消息详情
         * @param {string} messageId 消息ID
         */
        async viewMessage(messageId) {
            const msg = this.state.messages.find(m => m.messageId === messageId);
            if (!msg) return;

            const modal = document.getElementById('message-detail-modal');
            const content = document.getElementById('message-detail-content');
            
            if (!modal || !content) {
                alert(JSON.stringify(msg, null, 2));
                return;
            }

            content.innerHTML = `
                <div class="detail-section">
                    <h4>基本信息</h4>
                    <table class="detail-table">
                        <tr><td>消息ID</td><td>${msg.messageId}</td></tr>
                        <tr><td>状态</td><td>${this.statusMap[msg.status]?.label || msg.status}</td></tr>
                        <tr><td>渠道</td><td>${msg.channel}</td></tr>
                        <tr><td>适配器</td><td>${msg.adapterId}</td></tr>
                        <tr><td>目标ID</td><td>${msg.targetId || '-'}</td></tr>
                        <tr><td>消息类型</td><td>${msg.messageType || 'text'}</td></tr>
                    </table>
                </div>
                <div class="detail-section">
                    <h4>重试信息</h4>
                    <table class="detail-table">
                        <tr><td>重试次数</td><td>${msg.retryCount || 0}/${msg.maxRetries || 3}</td></tr>
                        <tr><td>下次重试</td><td>${msg.nextRetryAt ? this.formatTime(msg.nextRetryAt) : '-'}</td></tr>
                        <tr><td>最后尝试</td><td>${msg.lastAttemptAt ? this.formatTime(msg.lastAttemptAt) : '-'}</td></tr>
                    </table>
                </div>
                <div class="detail-section">
                    <h4>消息内容</h4>
                    <pre class="message-payload">${JSON.stringify(msg.payload || {}, null, 2)}</pre>
                </div>
                ${msg.lastError ? `
                <div class="detail-section error-section">
                    <h4>错误信息</h4>
                    <pre class="error-message">${msg.lastError}</pre>
                </div>
                ` : ''}
                <div class="detail-section">
                    <h4>时间信息</h4>
                    <table class="detail-table">
                        <tr><td>创建时间</td><td>${this.formatTime(msg.createdAt)}</td></tr>
                        <tr><td>更新时间</td><td>${this.formatTime(msg.updatedAt)}</td></tr>
                    </table>
                </div>
            `;

            modal.classList.add('show');
        },

        /**
         * 重试选中的消息
         */
        async retrySelected() {
            const ids = Array.from(this.state.selectedMessages);
            if (ids.length === 0) return;

            if (!confirm(`确定要重试选中的 ${ids.length} 条消息吗？`)) {
                return;
            }

            try {
                const response = await ChannelHubAPI.retryOutboxMessages(ids);
                
                if (response.success) {
                    this.showNotification(`${response.data.retried || ids.length} 条消息已加入重试队列`, 'success');
                    this.state.selectedMessages.clear();
                    this.loadMessages();
                    this.loadStats();
                } else {
                    this.showNotification(`批量重试失败: ${response.error}`, 'error');
                }
            } catch (error) {
                this.showNotification(`批量重试失败: ${error.message}`, 'error');
            }
        },

        /**
         * 删除选中的消息
         */
        async deleteSelected() {
            const ids = Array.from(this.state.selectedMessages);
            if (ids.length === 0) return;

            if (!confirm(`确定要删除选中的 ${ids.length} 条消息吗？此操作不可恢复。`)) {
                return;
            }

            try {
                const response = await ChannelHubAPI.deleteOutboxMessages(ids);
                
                if (response.success) {
                    this.showNotification(`${response.data.deleted || ids.length} 条消息已删除`, 'success');
                    this.state.selectedMessages.clear();
                    this.loadMessages();
                    this.loadStats();
                } else {
                    this.showNotification(`批量删除失败: ${response.error}`, 'error');
                }
            } catch (error) {
                this.showNotification(`批量删除失败: ${error.message}`, 'error');
            }
        },

        /**
         * 格式化时间
         * @param {string|number|Date} time 时间
         * @returns {string} 格式化后的时间字符串
         */
        formatTime(time) {
            if (!time) return '-';
            
            const date = new Date(time);
            if (isNaN(date.getTime())) return '-';

            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        },

        /**
         * 显示通知
         * @param {string} message 消息
         * @param {string} type 类型
         */
        showNotification(message, type = 'info') {
            // 使用全局通知函数或简单alert
            if (typeof ChannelHubUI !== 'undefined' && ChannelHubUI.showNotification) {
                ChannelHubUI.showNotification(message, type);
            } else {
                alert(message);
            }
        }
    };

    // 暴露到全局
    global.OutboxUI = OutboxUI;

})(typeof window !== 'undefined' ? window : this);