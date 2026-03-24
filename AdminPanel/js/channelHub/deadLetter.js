/**
 * ChannelHub Dead Letter Management UI Module
 * 管理死信队列：统计、清理、批量重试
 */

(function(global) {
    'use strict';

    const DeadLetterUI = {
        state: {
            deadLetters: [],
            stats: null,
            loading: false,
            selectedIds: new Set()
        },

        init() {
            this.bindEvents();
            this.loadStats();
            this.loadDeadLetters();
        },

        bindEvents() {
            const refreshBtn = document.getElementById('dead-letter-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => {
                    this.loadStats();
                    this.loadDeadLetters();
                });
            }

            const cleanupBtn = document.getElementById('dead-letter-cleanup');
            if (cleanupBtn) {
                cleanupBtn.addEventListener('click', () => this.cleanup());
            }

            const retryAllBtn = document.getElementById('dead-letter-retry-all');
            if (retryAllBtn) {
                retryAllBtn.addEventListener('click', () => this.retryBatch());
            }

            const selectAll = document.getElementById('dl-select-all');
            if (selectAll) {
                selectAll.addEventListener('change', (e) => {
                    const checkboxes = document.querySelectorAll('.dl-checkbox');
                    checkboxes.forEach(cb => {
                        cb.checked = e.target.checked;
                        if (e.target.checked) {
                            this.state.selectedIds.add(cb.dataset.id);
                        } else {
                            this.state.selectedIds.clear();
                        }
                    });
                });
            }
        },

        async loadStats() {
            try {
                const response = await fetch('/admin_api/channelHub/dead-letter/stats');
                const result = await response.json();
                if (result.success) {
                    this.state.stats = result.data;
                    this.renderStats();
                }
            } catch (error) {
                console.error('Failed to load dead letter stats:', error);
            }
        },

        renderStats() {
            if (!this.state.stats) return;

            const totalEl = document.getElementById('dl-total');
            const expiredEl = document.getElementById('dl-expired');
            const oldestEl = document.getElementById('dl-oldest');
            const newestEl = document.getElementById('dl-newest');

            if (totalEl) totalEl.textContent = this.state.stats.total || 0;
            if (expiredEl) expiredEl.textContent = this.state.stats.expiredCount || 0;
            if (oldestEl) oldestEl.textContent = this.state.stats.oldest
                ? new Date(this.state.stats.oldest).toLocaleString('zh-CN')
                : '-';
            if (newestEl) newestEl.textContent = this.state.stats.newest
                ? new Date(this.state.stats.newest).toLocaleString('zh-CN')
                : '-';
        },

        async loadDeadLetters() {
            const tbody = document.getElementById('dead-letter-table');
            if (!tbody) return;

            tbody.innerHTML = '<tr><td colspan="7" class="text-center">加载中...</td></tr>';

            try {
                const response = await fetch('/admin_api/channelHub/outbox/dead-letters?limit=100');
                const result = await response.json();

                if (result.success) {
                    this.state.deadLetters = result.data || [];
                    this.render();
                } else {
                    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">加载失败: ${result.error}</td></tr>`;
                }
            } catch (error) {
                console.error('Failed to load dead letters:', error);
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">加载失败: ${error.message}</td></tr>`;
            }
        },

        render() {
            const tbody = document.getElementById('dead-letter-table');
            if (!tbody) return;

            if (this.state.deadLetters.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">暂无死信</td></tr>';
                return;
            }

            tbody.innerHTML = this.state.deadLetters.map(dl => `
                <tr>
                    <td><input type="checkbox" class="dl-checkbox" data-id="${dl.jobId}"></td>
                    <td><code>${dl.jobId?.substring(0, 12)}...</code></td>
                    <td>${dl.adapterId || '-'}</td>
                    <td>${this.escapeHtml(dl.lastError || dl.error || '-')}</td>
                    <td>${dl.retryCount || 0}</td>
                    <td>${dl.deadLetterAt ? new Date(dl.deadLetterAt).toLocaleString('zh-CN') : '-'}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary" onclick="DeadLetterUI.retry('${dl.jobId}')" title="重试">
                            <i class="bi bi-arrow-repeat"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="DeadLetterUI.delete('${dl.jobId}')" title="删除">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        },

        async retry(jobId) {
            try {
                const response = await fetch(`/admin_api/channelHub/outbox/${encodeURIComponent(jobId)}/retry`, {
                    method: 'POST'
                });
                const result = await response.json();
                if (result.success) {
                    alert('已加入重试队列');
                    this.loadDeadLetters();
                } else {
                    alert('重试失败: ' + result.error);
                }
            } catch (error) {
                alert('重试失败: ' + error.message);
            }
        },

        async delete(jobId) {
            if (!confirm('确定要删除这个死信吗？')) return;

            try {
                const response = await fetch(`/admin_api/channelHub/outbox/${encodeURIComponent(jobId)}`, {
                    method: 'DELETE'
                });
                const result = await response.json();
                if (result.success) {
                    alert('删除成功');
                    this.loadDeadLetters();
                } else {
                    alert('删除失败: ' + result.error);
                }
            } catch (error) {
                alert('删除失败: ' + error.message);
            }
        },

        async cleanup() {
            const retentionDays = prompt('请输入死信保留天数 (默认7天):', '7');
            if (retentionDays === null) return;

            try {
                const response = await fetch('/admin_api/channelHub/dead-letter/cleanup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ retentionDays: parseInt(retentionDays) })
                });
                const result = await response.json();
                if (result.success) {
                    alert(`清理完成`);
                    this.loadStats();
                    this.loadDeadLetters();
                } else {
                    alert('清理失败: ' + result.error);
                }
            } catch (error) {
                alert('清理失败: ' + error.message);
            }
        },

        async retryBatch() {
            const checkboxes = document.querySelectorAll('.dl-checkbox:checked');
            if (checkboxes.length === 0) {
                alert('请先选择要重试的死信');
                return;
            }

            const ids = Array.from(checkboxes).map(cb => cb.dataset.id);

            try {
                const response = await fetch('/admin_api/channelHub/outbox/retry-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids })
                });
                const result = await response.json();
                if (result.success) {
                    alert(`已加入重试队列: ${result.data?.retried || ids.length} 个`);
                    this.loadDeadLetters();
                } else {
                    alert('批量重试失败: ' + result.error);
                }
            } catch (error) {
                alert('批量重试失败: ' + error.message);
            }
        }
    };

    global.DeadLetterUI = DeadLetterUI;
})(window);