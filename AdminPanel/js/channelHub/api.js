/**
 * ChannelHub Admin API Client
 *统一的API请求客户端，处理所有与后端的通信
 */

const ChannelHubAPI = (function() {
    'use strict';

    // API基础路径配置
    const API_BASE = '/admin_api/channelHub';

    /**
     * 发起API请求
     * @param {string} endpoint - API端点路径
     * @param {Object} options - fetch请求选项
     * @returns {Promise<Object>} 响应数据
     */
    async function request(endpoint, options = {}) {
        const url = `${API_BASE}${endpoint}`;
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const mergedOptions = {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...options.headers
            }
        };

        try {
            const response = await fetch(url, mergedOptions);
            const data = await response.json();

            if (!response.ok) {
                throw new APIError(data.message || '请求失败', response.status, data);
            }

            return data;
        } catch (error) {
            if (error instanceof APIError) {
                throw error;
            }
            throw new APIError(error.message || '网络错误', 0, {});
        }
    }

    /**
     * API错误类
     */
    class APIError extends Error {
        constructor(message, status, data) {
            super(message);
            this.name = 'APIError';
            this.status = status;
            this.data = data;
        }
    }

    // ==================== Adapter API ====================

    const AdapterAPI = {
        /**
         * 获取所有适配器列表
         */
        async list() {
            return request('/adapters');
        },

        /**
         * 获取单个适配器详情
         * @param {string} adapterId - 适配器ID
         */
        async get(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`);
        },

        /**
         * 创建新适配器
         * @param {Object} config - 适配器配置
         */
        async create(config) {
            return request('/adapters', {
                method: 'POST',
                body: JSON.stringify(config)
            });
        },

        /**
         * 更新适配器配置
         * @param {string} adapterId - 适配器ID
         * @param {Object} config - 更新的配置
         */
        async update(adapterId, config) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`, {
                method: 'PUT',
                body: JSON.stringify(config)
            });
        },

        /**
         * 删除适配器
         * @param {string} adapterId - 适配器ID
         */
        async delete(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`, {
                method: 'DELETE'
            });
        },

        /**
         * 测试适配器连接
         * @param {string} adapterId - 适配器ID
         */
        async testConnection(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}/test`, {
                method: 'POST'
            });
        },

        /**
         * 获取适配器健康状态
         * @param {string} adapterId - 适配器ID
         */
        async health(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}/health`);
        }
    };

    // ==================== Binding API ====================

    const BindingAPI = {
        /**
         * 获取所有会话绑定
         * @param {Object} filters - 过滤条件
         */
        async list(filters = {}) {
            const params = new URLSearchParams(filters);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/bindings${query}`);
        },

        /**
         * 获取单个绑定详情
         * @param {string} bindingId - 绑定ID
         */
        async get(bindingId) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`);
        },

        /**
         * 创建会话绑定
         * @param {Object} binding - 绑定信息
         */
        async create(binding) {
            return request('/bindings', {
                method: 'POST',
                body: JSON.stringify(binding)
            });
        },

        /**
         * 更新会话绑定
         * @param {string} bindingId - 绑定ID
         * @param {Object} binding - 更新的绑定信息
         */
        async update(bindingId, binding) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`, {
                method: 'PUT',
                body: JSON.stringify(binding)
            });
        },

        /**
         * 删除会话绑定
         * @param {string} bindingId - 绑定ID
         */
        async delete(bindingId) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`, {
                method: 'DELETE'
            });
        },

        /**
         * 按外部会话查找绑定
         * @param {string} adapterId - 适配器ID
         * @param {string} externalSessionKey - 外部会话键
         */
        async findByExternal(adapterId, externalSessionKey) {
            return request(`/bindings/by-external/${encodeURIComponent(adapterId)}/${encodeURIComponent(externalSessionKey)}`);
        }
    };

    // ==================== Metrics API ====================

    const MetricsAPI = {
        /**
         * 获取指标摘要
         */
        async summary() {
            return request('/metrics/summary');
        },

        /**
         * 获取渠道统计
         * @param {string} channel - 渠道类型
         * @param {Object} options - 时间范围等选项
         */
        async byChannel(channel, options = {}) {
            const params = new URLSearchParams(options);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/metrics/channel/${encodeURIComponent(channel)}${query}`);
        },

        /**
         * 获取适配器统计
         * @param {string} adapterId - 适配器ID
         * @param {Object} options - 时间范围等选项
         */
        async byAdapter(adapterId, options = {}) {
            const params = new URLSearchParams(options);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/metrics/adapter/${encodeURIComponent(adapterId)}${query}`);
        },

        /**
         * 获取事件类型分布
         */
        async eventDistribution() {
            return request('/metrics/events/distribution');
        },

        /**
         * 获取错误统计
         * @param {Object} options - 时间范围等选项
         */
        async errors(options = {}) {
            const params = new URLSearchParams(options);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/metrics/errors${query}`);
        },

        /**
         * 获取实时指标
         */
        async realtime() {
            return request('/metrics/realtime');
        }
    };

    // ==================== Outbox API ====================

    const OutboxAPI = {
        /**
         * 获取发件箱消息列表
         * @param {Object} filters - 过滤条件
         */
        async list(filters = {}) {
            const params = new URLSearchParams(filters);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/outbox${query}`);
        },

        /**
         * 获取单条消息详情
         * @param {string} messageId - 消息ID
         */
        async get(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}`);
        },

        /**
         * 重试发送消息
         * @param {string} messageId - 消息ID
         */
        async retry(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}/retry`, {
                method: 'POST'
            });
        },

        /**
         * 取消消息发送
         * @param {string} messageId - 消息ID
         */
        async cancel(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}/cancel`, {
                method: 'POST'
            });
        },

        /**
         * 批量重试失败消息
         * @param {Object} criteria - 筛选条件
         */
        async retryBatch(criteria = {}) {
            return request('/outbox/retry-batch', {
                method: 'POST',
                body: JSON.stringify(criteria)
            });
        },

        /**
         * 获取死信消息
         */
        async deadLetters() {
            return request('/outbox/dead-letters');
        },

        /**
         * 清理已完成消息
         * @param {Object} options - 清理选项
         */
        async cleanup(options = {}) {
            return request('/outbox/cleanup', {
                method: 'POST',
                body: JSON.stringify(options)
            });
        }
    };

    // ==================== Identity Mapping API ====================

    const IdentityAPI = {
        /**
         * 获取身份映射列表
         * @param {Object} filters - 过滤条件
         */
        async list(filters = {}) {
            const params = new URLSearchParams(filters);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/identities${query}`);
        },

        /**
         * 创建身份映射
         * @param {Object} mapping - 映射信息
         */
        async create(mapping) {
            return request('/identities', {
                method: 'POST',
                body: JSON.stringify(mapping)
            });
        },

        /**
         * 更新身份映射
         * @param {string} mappingId - 映射ID
         * @param {Object} mapping - 更新的映射信息
         */
        async update(mappingId, mapping) {
            return request(`/identities/${encodeURIComponent(mappingId)}`, {
                method: 'PUT',
                body: JSON.stringify(mapping)
            });
        },

        /**
         * 删除身份映射
         * @param {string} mappingId - 映射ID
         */
        async delete(mappingId) {
            return request(`/identities/${encodeURIComponent(mappingId)}`, {
                method: 'DELETE'
            });
        }
    };

    // ==================== Capability API ====================

    const CapabilityAPI = {
        /**
         * 获取所有平台能力矩阵
         */
        async listAll() {
            return request('/capabilities');
        },

        /**
         * 获取特定平台的能力矩阵
         * @param {string} channel - 渠道类型
         */
        async get(channel) {
            return request(`/capabilities/${encodeURIComponent(channel)}`);
        },

        /**
         * 更新平台能力配置
         * @param {string} channel - 渠道类型
         * @param {Object} capability - 能力配置
         */
        async update(channel, capability) {
            return request(`/capabilities/${encodeURIComponent(channel)}`, {
                method: 'PUT',
                body: JSON.stringify(capability)
            });
        }
    };

    // ==================== Health API ====================

    const HealthAPI = {
        /**
         * 获取ChannelHub整体健康状态
         */
        async check() {
            return request('/health');
        },

        /**
         * 获取详细健康报告
         */
        async detailed() {
            return request('/health/detailed');
        }
    };

    function parseQueryLike(input) {
        if (!input) return {};
        if (typeof input === 'string') {
            return Object.fromEntries(new URLSearchParams(input));
        }
        return input;
    }

    function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
    }

    // 导出公共API
    const api = {
        Adapter: AdapterAPI,
        adapters: AdapterAPI,
        Binding: BindingAPI,
        bindings: BindingAPI,
        Metrics: MetricsAPI,
        metrics: MetricsAPI,
        Outbox: OutboxAPI,
        outbox: OutboxAPI,
        Identity: IdentityAPI,
        identities: IdentityAPI,
        Capability: CapabilityAPI,
        capabilities: CapabilityAPI,
        Health: HealthAPI,
        health: HealthAPI,
        APIError,
        formatDate,

        async getAdapters() {
            return AdapterAPI.list();
        },

        async getBindings(filters = {}) {
            return BindingAPI.list(parseQueryLike(filters));
        },

        async createBinding(binding) {
            return request('/bindings', {
                method: 'POST',
                body: JSON.stringify(binding)
            });
        },

        async updateBinding(bindingId, binding) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`, {
                method: 'PUT',
                body: JSON.stringify(binding)
            });
        },

        async deleteBinding(bindingId) {
            return BindingAPI.delete(bindingId);
        },

        async getOutboxMessages(filters = {}) {
            const response = await OutboxAPI.list(filters);
            return {
                success: response.success,
                data: {
                    messages: response.data || [],
                    pagination: response.pagination || {
                        page: filters.page || 1,
                        totalPages: 1,
                        total: Array.isArray(response.data) ? response.data.length : 0
                    }
                }
            };
        },

        async getOutboxStats() {
            return request('/outbox/stats');
        },

        async retryOutboxMessage(messageId) {
            return OutboxAPI.retry(messageId);
        },

        async deleteOutboxMessage(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}`, {
                method: 'DELETE'
            });
        },

        async retryOutboxMessages(ids = []) {
            const results = await Promise.all(ids.map((id) => OutboxAPI.retry(id)));
            return {
                success: true,
                data: {
                    retried: results.length
                }
            };
        },

        async deleteOutboxMessages(ids = []) {
            const results = await Promise.all(ids.map((id) => request(`/outbox/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            })));
            return {
                success: true,
                data: {
                    deleted: results.length
                }
            };
        },

        async getMetrics(options = {}) {
            const response = await request('/metrics');
            const metrics = response.data || {};
            const byChannelEntries = Object.entries(metrics.byChannel || {});

            return {
                success: response.success,
                data: {
                    totalEvents: metrics.eventsReceived || 0,
                    successRate: metrics.eventsReceived ? (metrics.eventsProcessed || 0) / metrics.eventsReceived : 0,
                    avgLatency: metrics.avgProcessingTimeMs || 0,
                    activeAdapters: 0,
                    byChannel: byChannelEntries.map(([channel, stat]) => ({
                        channel,
                        eventCount: stat.eventsReceived || 0,
                        successRate: stat.eventsReceived ? (stat.eventsProcessed || 0) / stat.eventsReceived : 0,
                        avgLatency: stat.avgLatencyMs || 0,
                        errorCount: stat.eventsFailed || 0
                    })),
                    byEventType: [],
                    recentErrors: []
                }
            };
        },

        async getAuditLogs(filters = {}) {
            const params = new URLSearchParams(filters);
            const query = params.toString() ? `?${params.toString()}` : '';
            return request(`/audit-logs${query}`);
        }
    };

    return api;
})();

if (typeof window !== 'undefined') {
    window.ChannelHubAPI = ChannelHubAPI;
}

// 如果在Node.js环境，导出模块
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChannelHubAPI;
}
