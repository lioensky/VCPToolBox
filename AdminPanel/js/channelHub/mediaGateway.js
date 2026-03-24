/**
 * ChannelHub MediaGateway Management UI Module
 * 管理媒体网关：媒体文件、签名URL、缓存等
 */

(function(global) {
    'use strict';

    const MediaGatewayUI = {
        state: {
            mediaList: [],
            stats: null,
            filters: {
                adapterId: '',
                type: '',
                page: 1,
                limit: 50
            },
            loading: false
        },

        init() {
            this.bindEvents();
            this.loadStats();
            this.loadMedia();
        },

        bindEvents() {
            const refreshBtn = document.getElementById('media-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => {
                    this.loadStats();
                    this.loadMedia();
                });
            }

            const cleanupBtn = document.getElementById('media-cleanup');
            if (cleanupBtn) {
                cleanupBtn.addEventListener('click', () => this.cleanup());
            }
        },

        async loadStats() {
            try {
                const response = await fetch('/admin_api/mediaGateway/stats');
                const result = await response.json();
                if (result.success) {
                    this.state.stats = result.data;
                    this.renderStats();
                }
            } catch (error) {
                console.error('Failed to load media stats:', error);
            }
        },

        renderStats() {
            if (!this.state.stats) return;

            const totalEl = document.getElementById('media-total');
            const imageEl = document.getElementById('media-image');
            const audioEl = document.getElementById('media-audio');
            const fileEl = document.getElementById('media-file');

            if (totalEl) totalEl.textContent = this.state.stats.total || 0;
            if (imageEl) imageEl.textContent = this.state.stats.byType?.image || 0;
            if (audioEl) audioEl.textContent = this.state.stats.byType?.audio || 0;
            if (fileEl) fileEl.textContent = this.state.stats.byType?.file || 0;
        },

        async loadMedia() {
            const tbody = document.getElementById('media-table');
            if (!tbody) return;

            tbody.innerHTML = '<tr><td colspan="7" class="text-center">加载中...</td></tr>';

            try {
                const params = new URLSearchParams(this.state.filters);
                const response = await fetch(`/admin_api/mediaGateway/media?${params}`);
                const result = await response.json();

                if (result.success) {
                    this.state.mediaList = result.data || [];
                    this.renderMedia();
                } else {
                    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">加载失败: ${result.error}</td></tr>`;
                }
            } catch (error) {
                console.error('Failed to load media:', error);
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">加载失败: ${error.message}</td></tr>`;
            }
        },

        renderMedia() {
            const tbody = document.getElementById('media-table');
            if (!tbody) return;

            if (this.state.mediaList.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">暂无媒体文件</td></tr>';
                return;
            }

            tbody.innerHTML = this.state.mediaList.map(media => `
                <tr>
                    <td><code>${media.mediaId?.substring(0, 12)}...</code></td>
                    <td>${media.filename || '-'}</td>
                    <td><span class="badge bg-secondary">${media.mediaType || 'unknown'}</span></td>
                    <td>${media.adapterId || '-'}</td>
                    <td>${this.formatSize(media.size)}</td>
                    <td>${this.formatDate(media.createdAt)}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary" onclick="MediaGatewayUI.viewMedia('${media.mediaId}')" title="查看">
                            <i class="bi bi-eye"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-success" onclick="MediaGatewayUI.getSignedUrl('${media.mediaId}')" title="获取签名URL">
                            <i class="bi bi-link-45deg"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="MediaGatewayUI.deleteMedia('${media.mediaId}')" title="删除">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
        },

        async viewMedia(mediaId) {
            try {
                const response = await fetch(`/admin_api/mediaGateway/media/${encodeURIComponent(mediaId)}`);
                const result = await response.json();
                if (result.success) {
                    alert(JSON.stringify(result.data, null, 2));
                }
            } catch (error) {
                alert('获取媒体信息失败: ' + error.message);
            }
        },

        async getSignedUrl(mediaId) {
            try {
                const response = await fetch(`/admin_api/mediaGateway/signed-url/${encodeURIComponent(mediaId)}?expiresIn=3600`);
                const result = await response.json();
                if (result.success) {
                    prompt('签名URL:', result.data.url);
                }
            } catch (error) {
                alert('获取签名URL失败: ' + error.message);
            }
        },

        async deleteMedia(mediaId) {
            if (!confirm('确定要删除这个媒体文件吗？')) return;

            try {
                const response = await fetch(`/admin_api/mediaGateway/media/${encodeURIComponent(mediaId)}`, {
                    method: 'DELETE'
                });
                const result = await response.json();
                if (result.success) {
                    alert('删除成功');
                    this.loadMedia();
                } else {
                    alert('删除失败: ' + result.error);
                }
            } catch (error) {
                alert('删除失败: ' + error.message);
            }
        },

        async cleanup() {
            const maxAge = prompt('请输入媒体保留天数 (默认7天):', '7');
            if (maxAge === null) return;

            try {
                const response = await fetch('/admin_api/mediaGateway/cleanup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ maxAge: parseInt(maxAge) })
                });
                const result = await response.json();
                if (result.success) {
                    alert(`清理完成: 删除了 ${result.data?.deleted || 0} 个文件`);
                    this.loadStats();
                    this.loadMedia();
                }
            } catch (error) {
                alert('清理失败: ' + error.message);
            }
        },

        formatSize(bytes) {
            if (!bytes) return '-';
            const units = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            while (bytes >= 1024 && i < units.length - 1) {
                bytes /= 1024;
                i++;
            }
            return `${bytes.toFixed(1)} ${units[i]}`;
        },

        formatDate(dateStr) {
            if (!dateStr) return '-';
            return new Date(dateStr).toLocaleString('zh-CN');
        }
    };

    global.MediaGatewayUI = MediaGatewayUI;
})(window);