/**
 * ChannelHub Metrics Dashboard Module
 * 渠道中间件指标仪表板模块
 */

const ChannelHubMetrics = {
    /**
     * 初始化指标仪表板
     */
    init() {
        this.container = document.getElementById('metrics-container');
        if (!this.container) {
            console.error('Metrics container not found');
            return;
        }
        
        this.render();
        this.loadMetrics();
        this.startAutoRefresh();
    },

    /**
     * 渲染指标仪表板结构
     */
    render() {
        this.container.innerHTML = `
            <div class="metrics-header">
                <h3>渠道指标监控</h3>
                <div class="metrics-actions">
                    <button class="btn btn-sm btn-outline-secondary" onclick="ChannelHubMetrics.refresh()">
                        🔄 刷新
                    </button>
                    <select id="metrics-time-range" class="form-select form-select-sm" style="width: auto;" onchange="ChannelHubMetrics.loadMetrics()">
                        <option value="1h">最近1小时</option>
                        <option value="24h" selected>最近24小时</option>
                        <option value="7d">最近7天</option>
                        <option value="30d">最近30天</option>
                    </select>
                </div>
            </div>
            
            <div class="metrics-overview">
                <div class="metric-card" id="metric-events">
                    <div class="metric-icon">📨</div>
                    <div class="metric-content">
                        <div class="metric-value">-</div>
                        <div class="metric-label">事件总数</div>
                    </div>
                </div>
                
                <div class="metric-card" id="metric-success-rate">
                    <div class="metric-icon">✅</div>
                    <div class="metric-content">
                        <div class="metric-value">-</div>
                        <div class="metric-label">成功率</div>
                    </div>
                </div>
                
                <div class="metric-card" id="metric-avg-latency">
                    <div class="metric-icon">⚡</div>
                    <div class="metric-content">
                        <div class="metric-value">-</div>
                        <div class="metric-label">平均延迟</div>
                    </div>
                </div>
                
                <div class="metric-card" id="metric-active-adapters">
                    <div class="metric-icon">🔌</div>
                    <div class="metric-content">
                        <div class="metric-value">-</div>
                        <div class="metric-label">活跃适配器</div>
                    </div>
                </div>
            </div>
            
            <div class="metrics-charts">
                <div class="chart-container">
                    <h4>事件趋势</h4>
                    <div id="events-chart" class="chart-placeholder">
                        <canvas id="events-chart-canvas"></canvas>
                    </div>
                </div>
                
                <div class="chart-container">
                    <h4>渠道分布</h4>
                    <div id="channel-chart" class="chart-placeholder">
                        <canvas id="channel-chart-canvas"></canvas>
                    </div>
                </div>
            </div>
            
            <div class="metrics-tables">
                <div class="table-container">
                    <h4>按渠道统计</h4>
                    <table class="table table-sm">
                        <thead>
                            <tr>
                                <th>渠道</th>
                                <th>事件数</th>
                                <th>成功率</th>
                                <th>平均延迟</th>
                                <th>错误数</th>
                            </tr>
                        </thead>
                        <tbody id="channel-stats-body">
                            <tr><td colspan="5" class="text-center">加载中...</td></tr>
                        </tbody>
                    </table>
                </div>
                
                <div class="table-container">
                    <h4>按事件类型统计</h4>
                    <table class="table table-sm">
                        <thead>
                            <tr>
                                <th>事件类型</th>
                                <th>数量</th>
                                <th>占比</th>
                                <th>平均处理时间</th>
                            </tr>
                        </thead>
                        <tbody id="event-type-stats-body">
                            <tr><td colspan="4" class="text-center">加载中...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
            
            <div class="metrics-errors">
                <h4>最近错误 <span class="badge bg-danger" id="error-count">0</span></h4>
                <div id="recent-errors" class="error-list">
                    <div class="text-center text-muted">加载中...</div>
                </div>
            </div>
        `;
    },

    /**
     * 加载指标数据
     */
    async loadMetrics() {
        const timeRange = document.getElementById('metrics-time-range')?.value || '24h';
        
        try {
            const response = await ChannelHubAPI.getMetrics({ timeRange });
            
            if (response.success) {
                this.updateMetrics(response.data);
            } else {
                console.error('Failed to load metrics:', response.error);
                this.showError('加载指标失败');
            }
        } catch (error) {
            console.error('Error loading metrics:', error);
            this.showError('加载指标时发生错误');
        }
    },

    /**
     * 更新指标显示
     * @param {Object} data - 指标数据
     */
    updateMetrics(data) {
        // 更新概览卡片
        this.updateMetricCard('metric-events', data.totalEvents?.toLocaleString() || '0');
        this.updateMetricCard('metric-success-rate', `${(data.successRate * 100).toFixed(1)}%`);
        this.updateMetricCard('metric-avg-latency', `${data.avgLatency?.toFixed(0) || 0}ms`);
        this.updateMetricCard('metric-active-adapters', data.activeAdapters || 0);
        
        // 更新渠道统计表
        this.updateChannelStats(data.byChannel || []);
        
        // 更新事件类型统计表
        this.updateEventTypeStats(data.byEventType || []);
        
        // 更新错误列表
        this.updateRecentErrors(data.recentErrors || []);
        
        // 更新图表（如果有图表库）
        this.updateCharts(data);
    },

    /**
     * 更新指标卡片
     * @param {string} elementId - 元素ID
     * @param {string} value - 显示值
     */
    updateMetricCard(elementId, value) {
        const element = document.querySelector(`#${elementId} .metric-value`);
        if (element) {
            element.textContent = value;
        }
    },

    /**
     * 更新渠道统计表
     * @param {Array} stats - 渠道统计数据
     */
    updateChannelStats(stats) {
        const tbody = document.getElementById('channel-stats-body');
        if (!tbody) return;
        
        if (stats.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">暂无数据</td></tr>';
            return;
        }
        
        tbody.innerHTML = stats.map(stat => `
            <tr>
                <td><span class="badge bg-primary">${this.getChannelName(stat.channel)}</span></td>
                <td>${stat.eventCount?.toLocaleString() || 0}</td>
                <td class="${stat.successRate >= 0.95 ? 'text-success' : stat.successRate >= 0.8 ? 'text-warning' : 'text-danger'}">
                    ${(stat.successRate * 100).toFixed(1)}%
                </td>
                <td>${stat.avgLatency?.toFixed(0) || 0}ms</td>
                <td class="text-danger">${stat.errorCount || 0}</td>
            </tr>
        `).join('');
    },

    /**
     * 更新事件类型统计表
     * @param {Array} stats - 事件类型统计数据
     */
    updateEventTypeStats(stats) {
        const tbody = document.getElementById('event-type-stats-body');
        if (!tbody) return;
        
        if (stats.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">暂无数据</td></tr>';
            return;
        }
        
        const total = stats.reduce((sum, s) => sum + s.count, 0);
        
        tbody.innerHTML = stats.map(stat => `
            <tr>
                <td><code>${stat.eventType}</code></td>
                <td>${stat.count?.toLocaleString() || 0}</td>
                <td>${((stat.count / total) * 100).toFixed(1)}%</td>
                <td>${stat.avgProcessingTime?.toFixed(0) || 0}ms</td>
            </tr>
        `).join('');
    },

    /**
     * 更新最近错误列表
     * @param {Array} errors - 错误列表
     */
    updateRecentErrors(errors) {
        const container = document.getElementById('recent-errors');
        const countBadge = document.getElementById('error-count');
        
        if (countBadge) {
            countBadge.textContent = errors.length;
        }
        
        if (!container) return;
        
        if (errors.length === 0) {
            container.innerHTML = '<div class="text-center text-muted">暂无错误</div>';
            return;
        }
        
        container.innerHTML = errors.slice(0, 10).map(error => `
            <div class="error-item">
                <div class="error-time">${new Date(error.timestamp).toLocaleString()}</div>
                <div class="error-channel"><span class="badge bg-secondary">${this.getChannelName(error.channel)}</span></div>
                <div class="error-message text-danger">${this.escapeHtml(error.message)}</div>
                <div class="error-event-id"><small class="text-muted">${error.eventId}</small></div>
            </div>
        `).join('');
    },

    /**
     * 更新图表
     * @param {Object} data - 图表数据
     */
    updateCharts(data) {
        // 简单的占位符实现
        // 实际项目中应使用 Chart.js 或其他图表库
        
        const eventsCanvas = document.getElementById('events-chart-canvas');
        if (eventsCanvas && data.eventsTrend) {
            // 绘制简单的事件趋势图
            this.drawSimpleLineChart(eventsCanvas, data.eventsTrend);
        }
        
        const channelCanvas = document.getElementById('channel-chart-canvas');
        if (channelCanvas && data.byChannel) {
            // 绘制简单的渠道分布图
            this.drawSimpleBarChart(channelCanvas, data.byChannel);
        }
    },

    /**
     * 绘制简单折线图
     * @param {HTMLCanvasElement} canvas - Canvas元素
     * @param {Array} data - 数据点
     */
    drawSimpleLineChart(canvas, data) {
        const ctx = canvas.getContext('2d');
        const width = canvas.parentElement.clientWidth;
        const height = 200;
        
        canvas.width = width;
        canvas.height = height;
        
        // 清空画布
        ctx.clearRect(0, 0, width, height);
        
        if (!data || data.length === 0) {
            ctx.fillStyle = '#999';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无数据', width / 2, height / 2);
            return;
        }
        
        const max = Math.max(...data.map(d => d.value));
        const padding = 40;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;
        
        // 绘制网格线
        ctx.strokeStyle = '#eee';
        ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
            const y = padding + (chartHeight / 4) * i;
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
        }
        ctx.stroke();
        
        // 绘制折线
        ctx.strokeStyle = '#007bff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        data.forEach((point, index) => {
            const x = padding + (chartWidth / (data.length - 1)) * index;
            const y = padding + chartHeight - (point.value / max) * chartHeight;
            
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        ctx.stroke();
        
        // 绘制数据点
        ctx.fillStyle = '#007bff';
        data.forEach((point, index) => {
            const x = padding + (chartWidth / (data.length - 1)) * index;
            const y = padding + chartHeight - (point.value / max) * chartHeight;
            
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        });
    },

    /**
     * 绘制简单柱状图
     * @param {HTMLCanvasElement} canvas - Canvas元素
     * @param {Array} data - 数据
     */
    drawSimpleBarChart(canvas, data) {
        const ctx = canvas.getContext('2d');
        const width = canvas.parentElement.clientWidth;
        const height = 200;
        
        canvas.width = width;
        canvas.height = height;
        
        // 清空画布
        ctx.clearRect(0, 0, width, height);
        
        if (!data || data.length === 0) {
            ctx.fillStyle = '#999';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无数据', width / 2, height / 2);
            return;
        }
        
        const max = Math.max(...data.map(d => d.eventCount));
        const padding = 40;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;
        const barWidth = (chartWidth / data.length) * 0.8;
        const barGap = (chartWidth / data.length) * 0.2;
        
        const colors = ['#007bff', '#28a745', '#ffc107', '#dc3545', '#17a2b8', '#6f42c1'];
        
        data.forEach((item, index) => {
            const x = padding + (chartWidth / data.length) * index + barGap / 2;
            const barHeight = (item.eventCount / max) * chartHeight;
            const y = padding + chartHeight - barHeight;
            
            // 绘制柱子
            ctx.fillStyle = colors[index % colors.length];
            ctx.fillRect(x, y, barWidth, barHeight);
            
            // 绘制标签
            ctx.fillStyle = '#333';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.getChannelName(item.channel), x + barWidth / 2, height - 10);
        });
    },

    /**
     * 获取渠道显示名称
     * @param {string} channel - 渠道标识
     * @returns {string} 显示名称
     */
    getChannelName(channel) {
        const names = {
            'dingtalk': '钉钉',
            'wecom': '企业微信',
            'feishu': '飞书',
            'qq': 'QQ',
            'wechat': '微信',
            'webhook': 'Webhook'
        };
        return names[channel] || channel;
    },

    /**
     * HTML转义
     * @param {string} text - 原始文本
     * @returns {string} 转义后文本
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * 显示错误
     * @param {string} message - 错误消息
     */
    showError(message) {
        const overview = this.container.querySelector('.metrics-overview');
        if (overview) {
            overview.innerHTML = `
                <div class="alert alert-danger" role="alert">
                    ${message}
                    <button class="btn btn-sm btn-outline-danger ms-2" onclick="ChannelHubMetrics.loadMetrics()">
                        重试
                    </button>
                </div>
            `;
        }
    },

    /**
     * 刷新指标
     */
    refresh() {
        this.loadMetrics();
    },

    /**
     * 启动自动刷新
     */
    startAutoRefresh() {
        // 每60秒自动刷新
        this.refreshInterval = setInterval(() => {
            this.loadMetrics();
        }, 60000);
    },

    /**
     * 停止自动刷新
     */
    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    },

    /**
     * 销毁模块
     */
    destroy() {
        this.stopAutoRefresh();
    }
};

// 导出到全局
window.ChannelHubMetrics = ChannelHubMetrics;