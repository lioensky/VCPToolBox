/**
 * MetricsCollector - ChannelHub 指标收集器
 * 
 * 职责：
 * - 收集各渠道的事件处理指标
 * - 统计消息吞吐量、延迟、错误率
 * - 提供指标查询接口供监控和告警使用
 * - 支持按时间窗口聚合指标数据
 */

const EventEmitter = require('events');

/**
 * @typedef {Object} MetricPoint
 * @property {number} timestamp - 时间戳
 * @property {number} value - 指标值
 * @property {Object} [labels] - 标签键值对
 */

/**
 * @typedef {Object} ChannelMetrics
 * @property {string} adapterId - 适配器ID
 * @property {string} channel - 渠道类型
 * @property {number} eventsReceived - 接收事件数
 * @property {number} eventsProcessed - 处理成功事件数
 * @property {number} eventsFailed - 处理失败事件数
 * @property {number} avgLatencyMs - 平均延迟（毫秒）
 * @property {number} p95LatencyMs - P95延迟
 * @property {number} p99LatencyMs - P99延迟
 */

/**
 * @typedef {Object} MetricsSummary
 * @property {number} totalEvents - 总事件数
 * @property {number} successRate - 成功率
 * @property {number} errorRate - 错误率
 * @property {Object} byChannel - 按渠道分组的指标
 * @property {Object} byAdapter - 按适配器分组的指标
 */

class MetricsCollector extends EventEmitter {
    /**
     * @param {Object} options - 配置选项
     * @param {number} [options.retentionMs=86400000] - 指标保留时间（默认24小时）
     * @param {number} [options.flushIntervalMs=60000] - 刷新间隔（默认1分钟）
     * @param {Object} [options.logger] - 日志器实例
     */
    constructor(options = {}) {
        super();
        
        this.retentionMs = options.retentionMs || 24 * 60 * 60 * 1000; // 24小时
        this.flushIntervalMs = options.flushIntervalMs || 60 * 1000; // 1分钟
        this.logger = options.logger || console;
        
        // 指标存储
        this.counters = new Map(); // 计数器
        this.gauges = new Map();   // 仪表盘
        this.histograms = new Map(); // 直方图
        
        // 时间序列数据
        this.timeSeries = {
            eventsReceived: [],
            eventsProcessed: [],
            eventsFailed: [],
            latency: []
        };
        
        // 渠道级指标
        this.channelMetrics = new Map();
        
        // 适配器级指标
        this.adapterMetrics = new Map();
        
        // 刷新定时器
        this.flushTimer = null;
    }
    
    /**
     * 初始化指标收集器
     * @returns {Promise<void>}
     */
    async initialize() {
        // 启动定期刷新
        this.flushTimer = setInterval(() => {
            this._flush();
        }, this.flushIntervalMs);
        
        this.logger.info('[MetricsCollector] Initialized');
    }
    
    /**
     * 关闭指标收集器
     * @returns {Promise<void>}
     */
    async shutdown() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        
        // 最终刷新
        this._flush();
        
        this.logger.info('[MetricsCollector] Shutdown complete');
    }
    
    // ==================== 计数器操作 ====================
    
    /**
     * 递增计数器
     * @param {string} name - 计数器名称
     * @param {number} [value=1] - 递增值
     * @param {Object} [labels] - 标签
     */
    incrementCounter(name, value = 1, labels = {}) {
        const key = this._makeKey(name, labels);
        const current = this.counters.get(key) || { name, labels, value: 0 };
        current.value += value;
        current.timestamp = Date.now();
        this.counters.set(key, current);
    }
    
    /**
     * 获取计数器值
     * @param {string} name - 计数器名称
     * @param {Object} [labels] - 标签
     * @returns {number}
     */
    getCounter(name, labels = {}) {
        const key = this._makeKey(name, labels);
        return this.counters.get(key)?.value || 0;
    }
    
    // ==================== 仪表盘操作 ====================
    
    /**
     * 设置仪表盘值
     * @param {string} name - 仪表盘名称
     * @param {number} value - 值
     * @param {Object} [labels] - 标签
     */
    setGauge(name, value, labels = {}) {
        const key = this._makeKey(name, labels);
        this.gauges.set(key, { name, labels, value, timestamp: Date.now() });
    }
    
    /**
     * 获取仪表盘值
     * @param {string} name - 仪表盘名称
     * @param {Object} [labels] - 标签
     * @returns {number|null}
     */
    getGauge(name, labels = {}) {
        const key = this._makeKey(name, labels);
        return this.gauges.get(key)?.value ?? null;
    }
    
    // ==================== 直方图操作 ====================
    
    /**
     * 记录直方图观测值
     * @param {string} name - 直方图名称
     * @param {number} value - 观测值
     * @param {Object} [labels] - 标签
     */
    observeHistogram(name, value, labels = {}) {
        const key = this._makeKey(name, labels);
        
        if (!this.histograms.has(key)) {
            this.histograms.set(key, {
                name,
                labels,
                observations: [],
                sum: 0,
                count: 0
            });
        }
        
        const histogram = this.histograms.get(key);
        histogram.observations.push(value);
        histogram.sum += value;
        histogram.count++;
        histogram.timestamp = Date.now();
        
        // 限制观测数量，保留最近的1000个
        if (histogram.observations.length > 1000) {
            const removed = histogram.observations.shift();
            histogram.sum -= removed;
            histogram.count--;
        }
    }
    
    /**
     * 获取直方图统计
     * @param {string} name - 直方图名称
     * @param {Object} [labels] - 标签
     * @returns {Object}
     */
    getHistogramStats(name, labels = {}) {
        const key = this._makeKey(name, labels);
        const histogram = this.histograms.get(key);
        
        if (!histogram || histogram.observations.length === 0) {
            return { count: 0, sum: 0, min: null, max: null, avg: null, p50: null, p95: null, p99: null };
        }
        
        const sorted = [...histogram.observations].sort((a, b) => a - b);
        const count = sorted.length;
        
        return {
            count,
            sum: histogram.sum,
            min: sorted[0],
            max: sorted[count - 1],
            avg: histogram.sum / count,
            p50: sorted[Math.floor(count * 0.5)],
            p95: sorted[Math.floor(count * 0.95)],
            p99: sorted[Math.floor(count * 0.99)]
        };
    }
    
    // ==================== 渠道指标记录 ====================
    
    /**
     * 记录事件接收
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道类型
     * @param {Object} [event] - 事件详情
     */
    recordEventReceived(adapterId, channel, event = {}) {
        // 更新计数器
        this.incrementCounter('events_received_total', 1, { adapterId, channel });
        this.incrementCounter('events_received_total', 1, { channel });
        
        // 更新时间序列
        this.timeSeries.eventsReceived.push({
            timestamp: Date.now(),
            adapterId,
            channel,
            eventType: event.eventType || 'unknown'
        });
        
        // 更新渠道指标
        this._updateChannelMetric(channel, 'eventsReceived', 1);
        
        // 更新适配器指标
        this._updateAdapterMetric(adapterId, channel, 'eventsReceived', 1);
    }
    
    /**
     * 记录事件处理成功
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道类型
     * @param {number} latencyMs - 处理延迟（毫秒）
     */
    recordEventProcessed(adapterId, channel, latencyMs) {
        // 更新计数器
        this.incrementCounter('events_processed_total', 1, { adapterId, channel });
        
        // 记录延迟直方图
        this.observeHistogram('event_latency_ms', latencyMs, { adapterId, channel });
        
        // 更新时间序列
        this.timeSeries.eventsProcessed.push({
            timestamp: Date.now(),
            adapterId,
            channel,
            latencyMs
        });
        
        // 更新延迟时间序列
        this.timeSeries.latency.push({
            timestamp: Date.now(),
            adapterId,
            channel,
            latencyMs
        });
        
        // 更新渠道指标
        this._updateChannelMetric(channel, 'eventsProcessed', 1);
        this._updateChannelMetricLatency(channel, latencyMs);
        
        // 更新适配器指标
        this._updateAdapterMetric(adapterId, channel, 'eventsProcessed', 1);
        this._updateAdapterMetricLatency(adapterId, channel, latencyMs);
    }
    
    /**
     * 记录事件处理失败
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道类型
     * @param {Error|string} error - 错误信息
     */
    recordEventFailed(adapterId, channel, error) {
        // 更新计数器
        this.incrementCounter('events_failed_total', 1, { adapterId, channel });
        
        // 更新时间序列
        this.timeSeries.eventsFailed.push({
            timestamp: Date.now(),
            adapterId,
            channel,
            error: typeof error === 'string' ? error : error.message
        });
        
        // 更新渠道指标
        this._updateChannelMetric(channel, 'eventsFailed', 1);
        
        // 更新适配器指标
        this._updateAdapterMetric(adapterId, channel, 'eventsFailed', 1);
    }
    
    /**
     * 记录出站消息
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道类型
     * @param {Object} [details] - 详情
     */
    recordOutboundMessage(adapterId, channel, details = {}) {
        this.incrementCounter('outbound_messages_total', 1, { adapterId, channel });
        
        if (details.parts) {
            this.incrementCounter('outbound_message_parts_total', details.parts, { adapterId, channel });
        }
        
        if (details.mediaCount) {
            this.incrementCounter('outbound_media_total', details.mediaCount, { adapterId, channel });
        }
    }
    
    // ==================== 指标查询 ====================
    
    /**
     * 获取渠道指标
     * @param {string} channel - 渠道类型
     * @returns {ChannelMetrics|null}
     */
    getChannelMetrics(channel) {
        return this.channelMetrics.get(channel) || null;
    }
    
    /**
     * 获取所有渠道指标
     * @returns {Map<string, ChannelMetrics>}
     */
    getAllChannelMetrics() {
        return new Map(this.channelMetrics);
    }
    
    /**
     * 获取适配器指标
     * @param {string} adapterId - 适配器ID
     * @returns {Object|null}
     */
    getAdapterMetrics(adapterId) {
        return this.adapterMetrics.get(adapterId) || null;
    }
    
    /**
     * 获取所有适配器指标
     * @returns {Map<string, Object>}
     */
    getAllAdapterMetrics() {
        return new Map(this.adapterMetrics);
    }
    
    /**
     * 获取指标汇总
     * @param {Object} [options] - 查询选项
     * @param {number} [options.since] - 起始时间戳
     * @returns {MetricsSummary}
     */
    getSummary(options = {}) {
        const since = options.since || Date.now() - 3600000; // 默认最近1小时
        
        // 计算汇总
        let totalEvents = 0;
        let totalProcessed = 0;
        let totalFailed = 0;
        const byChannel = {};
        const byAdapter = {};
        
        // 聚合时间序列数据
        const recentReceived = this.timeSeries.eventsReceived.filter(e => e.timestamp >= since);
        const recentProcessed = this.timeSeries.eventsProcessed.filter(e => e.timestamp >= since);
        const recentFailed = this.timeSeries.eventsFailed.filter(e => e.timestamp >= since);
        const recentLatency = this.timeSeries.latency.filter(e => e.timestamp >= since);
        
        totalEvents = recentReceived.length;
        totalProcessed = recentProcessed.length;
        totalFailed = recentFailed.length;
        
        // 按渠道聚合
        for (const channel of this.channelMetrics.keys()) {
            const metrics = this.channelMetrics.get(channel);
            byChannel[channel] = {
                eventsReceived: metrics.eventsReceived || 0,
                eventsProcessed: metrics.eventsProcessed || 0,
                eventsFailed: metrics.eventsFailed || 0,
                avgLatencyMs: metrics.latencySum && metrics.latencyCount 
                    ? Math.round(metrics.latencySum / metrics.latencyCount) 
                    : null
            };
        }
        
        // 按适配器聚合
        for (const adapterId of this.adapterMetrics.keys()) {
            const metrics = this.adapterMetrics.get(adapterId);
            byAdapter[adapterId] = {
                channel: metrics.channel,
                eventsReceived: metrics.eventsReceived || 0,
                eventsProcessed: metrics.eventsProcessed || 0,
                eventsFailed: metrics.eventsFailed || 0,
                avgLatencyMs: metrics.latencySum && metrics.latencyCount 
                    ? Math.round(metrics.latencySum / metrics.latencyCount) 
                    : null
            };
        }
        
        // 计算平均延迟
        const avgLatency = recentLatency.length > 0
            ? recentLatency.reduce((sum, e) => sum + e.latencyMs, 0) / recentLatency.length
            : null;
        
        return {
            windowStart: since,
            windowEnd: Date.now(),
            totalEvents,
            totalProcessed,
            totalFailed,
            successRate: totalEvents > 0 ? totalProcessed / totalEvents : null,
            errorRate: totalEvents > 0 ? totalFailed / totalEvents : null,
            avgLatencyMs: avgLatency ? Math.round(avgLatency) : null,
            byChannel,
            byAdapter
        };
    }

    /**
     * 向后兼容：admin 路由使用的扁平快照
     */
    snapshot() {
        const summary = this.getSummary({
            since: Date.now() - 60 * 60 * 1000
        });

        return {
            'inbound.events.total': summary.totalEvents || 0,
            'inbound.events.success': summary.totalProcessed || 0,
            'inbound.events.error': summary.totalFailed || 0,
            'inbound.events.duplicate': this.getCounter('events_deduplicated') || 0,
            'inbound.events.duration': summary.avgLatencyMs || 0,
            'outbound.jobs.total': this.getCounter('outbound_jobs_total') || 0,
            'outbound.jobs.success': this.getCounter('outbound_jobs_success') || 0,
            'outbound.jobs.error': this.getCounter('outbound_jobs_error') || 0
        };
    }
    
    /**
     * 获取时间序列数据
     * @param {string} metricName - 指标名称
     * @param {Object} [options] - 查询选项
     * @param {number} [options.since] - 起始时间戳
     * @param {number} [options.until] - 结束时间戳
     * @param {string} [options.adapterId] - 过滤适配器ID
     * @param {string} [options.channel] - 过滤渠道
     * @returns {MetricPoint[]}
     */
    getTimeSeries(metricName, options = {}) {
        const series = this.timeSeries[metricName];
        
        if (!series) {
            return [];
        }
        
        let filtered = series;
        
        if (options.since) {
            filtered = filtered.filter(e => e.timestamp >= options.since);
        }
        
        if (options.until) {
            filtered = filtered.filter(e => e.timestamp <= options.until);
        }
        
        if (options.adapterId) {
            filtered = filtered.filter(e => e.adapterId === options.adapterId);
        }
        
        if (options.channel) {
            filtered = filtered.filter(e => e.channel === options.channel);
        }
        
        return filtered;
    }
    
    /**
     * 获取所有计数器
     * @returns {Object[]}
     */
    getAllCounters() {
        return Array.from(this.counters.values());
    }
    
    /**
     * 获取所有仪表盘
     * @returns {Object[]}
     */
    getAllGauges() {
        return Array.from(this.gauges.values());
    }
    
    /**
     * 获取所有直方图统计
     * @returns {Object[]}
     */
    getAllHistogramStats() {
        const stats = [];
        
        for (const [key, histogram] of this.histograms) {
            stats.push({
                name: histogram.name,
                labels: histogram.labels,
                ...this.getHistogramStats(histogram.name, histogram.labels)
            });
        }
        
        return stats;
    }
    
    // ==================== 内部方法 ====================
    
    /**
     * 生成指标键
     * @param {string} name - 名称
     * @param {Object} labels - 标签
     * @returns {string}
     */
    _makeKey(name, labels) {
        const labelStr = Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
        
        return labelStr ? `${name}{${labelStr}}` : name;
    }
    
    /**
     * 更新渠道指标
     * @param {string} channel - 渠道
     * @param {string} field - 字段
     * @param {number} value - 值
     */
    _updateChannelMetric(channel, field, value) {
        if (!this.channelMetrics.has(channel)) {
            this.channelMetrics.set(channel, {
                channel,
                eventsReceived: 0,
                eventsProcessed: 0,
                eventsFailed: 0,
                latencySum: 0,
                latencyCount: 0,
                latencyValues: []
            });
        }
        
        const metrics = this.channelMetrics.get(channel);
        metrics[field] = (metrics[field] || 0) + value;
    }
    
    /**
     * 更新渠道延迟指标
     * @param {string} channel - 渠道
     * @param {number} latencyMs - 延迟
     */
    _updateChannelMetricLatency(channel, latencyMs) {
        const metrics = this.channelMetrics.get(channel);
        if (metrics) {
            metrics.latencySum = (metrics.latencySum || 0) + latencyMs;
            metrics.latencyCount = (metrics.latencyCount || 0) + 1;
            metrics.latencyValues = metrics.latencyValues || [];
            metrics.latencyValues.push(latencyMs);
            
            // 保留最近1000个延迟值用于百分位计算
            if (metrics.latencyValues.length > 1000) {
                metrics.latencyValues.shift();
            }
        }
    }
    
    /**
     * 更新适配器指标
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道
     * @param {string} field - 字段
     * @param {number} value - 值
     */
    _updateAdapterMetric(adapterId, channel, field, value) {
        if (!this.adapterMetrics.has(adapterId)) {
            this.adapterMetrics.set(adapterId, {
                adapterId,
                channel,
                eventsReceived: 0,
                eventsProcessed: 0,
                eventsFailed: 0,
                latencySum: 0,
                latencyCount: 0,
                latencyValues: []
            });
        }
        
        const metrics = this.adapterMetrics.get(adapterId);
        metrics[field] = (metrics[field] || 0) + value;
    }
    
    /**
     * 更新适配器延迟指标
     * @param {string} adapterId - 适配器ID
     * @param {string} channel - 渠道
     * @param {number} latencyMs - 延迟
     */
    _updateAdapterMetricLatency(adapterId, channel, latencyMs) {
        const metrics = this.adapterMetrics.get(adapterId);
        if (metrics) {
            metrics.latencySum = (metrics.latencySum || 0) + latencyMs;
            metrics.latencyCount = (metrics.latencyCount || 0) + 1;
            metrics.latencyValues = metrics.latencyValues || [];
            metrics.latencyValues.push(latencyMs);
            
            // 保留最近1000个延迟值
            if (metrics.latencyValues.length > 1000) {
                metrics.latencyValues.shift();
            }
        }
    }
    
    /**
     * 定期刷新，清理过期数据
     */
    _flush() {
        const cutoff = Date.now() - this.retentionMs;
        
        // 清理时间序列
        for (const key of Object.keys(this.timeSeries)) {
            this.timeSeries[key] = this.timeSeries[key].filter(e => e.timestamp >= cutoff);
        }
        
        // 发出刷新事件
        this.emit('flush', {
            timestamp: Date.now(),
            countersCount: this.counters.size,
            gaugesCount: this.gauges.size,
            histogramsCount: this.histograms.size
        });
    }
    
    /**
     * 重置所有指标
     */
    reset() {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
        
        this.timeSeries = {
            eventsReceived: [],
            eventsProcessed: [],
            eventsFailed: [],
            latency: []
        };
        
        this.channelMetrics.clear();
        this.adapterMetrics.clear();
        
        this.logger.info('[MetricsCollector] All metrics reset');
    }
}

module.exports = MetricsCollector;
