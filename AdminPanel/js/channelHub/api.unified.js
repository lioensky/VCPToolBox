/**
 * ChannelHub Admin API Client
 */

const ChannelHubAPI = (function () {
    'use strict';

    const API_BASE = '/admin_api/channelHub';

    class APIError extends Error {
        constructor(message, status, data) {
            super(message);
            this.name = 'APIError';
            this.status = status;
            this.data = data;
        }
    }

    async function request(endpoint, options = {}) {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            ...options
        });

        let data = {};
        try {
            const rawText = await response.text();
            data = rawText ? JSON.parse(rawText) : {};
        } catch (error) {
            data = {};
        }

        if (!response.ok || data.success === false) {
            throw new APIError(
                data.error || data.message || 'Request failed',
                response.status,
                data
            );
        }

        return data;
    }

    function toQuery(filters = {}) {
        const params = new URLSearchParams();
        Object.entries(filters || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                params.append(key, value);
            }
        });
        const query = params.toString();
        return query ? `?${query}` : '';
    }

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

    const AdapterAPI = {
        list() {
            return request('/adapters');
        },
        get(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`);
        },
        create(config) {
            return request('/adapters', {
                method: 'POST',
                body: JSON.stringify(config)
            });
        },
        update(adapterId, config) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`, {
                method: 'PUT',
                body: JSON.stringify(config)
            });
        },
        delete(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}`, {
                method: 'DELETE'
            });
        },
        testConnection(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}/test`, {
                method: 'POST'
            });
        },
        health(adapterId) {
            return request(`/adapters/${encodeURIComponent(adapterId)}/health`);
        }
    };

    const BindingAPI = {
        list(filters = {}) {
            return request(`/bindings${toQuery(filters)}`);
        },
        get(bindingId) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`);
        },
        create(binding) {
            return request('/bindings', {
                method: 'POST',
                body: JSON.stringify(binding)
            });
        },
        update(bindingId, binding) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`, {
                method: 'PUT',
                body: JSON.stringify(binding)
            });
        },
        delete(bindingId) {
            return request(`/bindings/${encodeURIComponent(bindingId)}`, {
                method: 'DELETE'
            });
        },
        findByExternal(adapterId, externalSessionKey) {
            return request(`/bindings/by-external/${encodeURIComponent(adapterId)}/${encodeURIComponent(externalSessionKey)}`);
        }
    };

    const MetricsAPI = {
        summary() {
            return request('/metrics/summary');
        },
        byChannel(channel, options = {}) {
            return request(`/metrics/channel/${encodeURIComponent(channel)}${toQuery(options)}`);
        },
        byAdapter(adapterId, options = {}) {
            return request(`/metrics/adapter/${encodeURIComponent(adapterId)}${toQuery(options)}`);
        },
        eventDistribution() {
            return request('/metrics/events/distribution');
        },
        errors(options = {}) {
            return request(`/metrics/errors${toQuery(options)}`);
        },
        realtime() {
            return request('/metrics/realtime');
        }
    };

    const OutboxAPI = {
        list(filters = {}) {
            return request(`/outbox${toQuery(filters)}`);
        },
        get(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}`);
        },
        retry(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}/retry`, {
                method: 'POST'
            });
        },
        cancel(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}/cancel`, {
                method: 'POST'
            });
        },
        retryBatch(criteria = {}) {
            return request('/outbox/retry-batch', {
                method: 'POST',
                body: JSON.stringify(criteria)
            });
        },
        deadLetters(filters = {}) {
            return request(`/outbox/dead-letters${toQuery(filters)}`);
        },
        cleanup(options = {}) {
            return request('/outbox/cleanup', {
                method: 'POST',
                body: JSON.stringify(options)
            });
        },
        stats() {
            return request('/outbox/stats');
        },
        // 死信增强 API
        deadLetterStats() {
            return request('/dead-letter/stats');
        },
        deadLetterCleanup(retentionDays) {
            return request('/dead-letter/cleanup', {
                method: 'POST',
                body: JSON.stringify({ retentionDays })
            });
        },
        retryChannel(channel, limit) {
            return request('/dead-letter/retry-channel', {
                method: 'POST',
                body: JSON.stringify({ channel, limit })
            });
        }
    };

    const IdentityAPI = {
        list(filters = {}) {
            return request(`/identities${toQuery(filters)}`);
        },
        create(mapping) {
            return request('/identities', {
                method: 'POST',
                body: JSON.stringify(mapping)
            });
        },
        update(mappingId, mapping) {
            return request(`/identities/${encodeURIComponent(mappingId)}`, {
                method: 'PUT',
                body: JSON.stringify(mapping)
            });
        },
        delete(mappingId) {
            return request(`/identities/${encodeURIComponent(mappingId)}`, {
                method: 'DELETE'
            });
        }
    };

    const CapabilityAPI = {
        listAll() {
            return request('/capabilities');
        },
        get(channel) {
            return request(`/capabilities/${encodeURIComponent(channel)}`);
        },
        update(channel, capability) {
            return request(`/capabilities/${encodeURIComponent(channel)}`, {
                method: 'PUT',
                body: JSON.stringify(capability)
            });
        }
    };

    const HealthAPI = {
        check() {
            return request('/health');
        },
        detailed() {
            return request('/health/detailed');
        }
    };

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

        getAdapters() {
            return AdapterAPI.list();
        },

        getBindings(filters = {}) {
            return BindingAPI.list(parseQueryLike(filters));
        },

        createBinding(binding) {
            return BindingAPI.create(binding);
        },

        updateBinding(bindingId, binding) {
            return BindingAPI.update(bindingId, binding);
        },

        deleteBinding(bindingId) {
            return BindingAPI.delete(bindingId);
        },

        async getOutboxMessages(filters = {}) {
            const response = await OutboxAPI.list(filters);
            return {
                success: response.success,
                data: {
                    messages: response.data || [],
                    pagination: response.pagination || {
                        limit: filters.limit || 100,
                        offset: filters.offset || 0,
                        total: Array.isArray(response.data) ? response.data.length : 0
                    }
                }
            };
        },

        getOutboxStats() {
            return OutboxAPI.stats();
        },

        retryOutboxMessage(messageId) {
            return OutboxAPI.retry(messageId);
        },

        deleteOutboxMessage(messageId) {
            return request(`/outbox/${encodeURIComponent(messageId)}`, {
                method: 'DELETE'
            });
        },

        async retryOutboxMessages(ids = []) {
            const result = await OutboxAPI.retryBatch({ ids });
            return {
                success: result.success,
                data: result.data || { retried: ids.length }
            };
        },

        async deleteOutboxMessages(ids = []) {
            await Promise.all(ids.map((id) => request(`/outbox/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            })));
            return {
                success: true,
                data: {
                    deleted: ids.length
                }
            };
        },

        async getMetrics(options = {}) {
            const [metricsResponse, adaptersResponse, distributionResponse, errorsResponse] = await Promise.all([
                request(`/metrics${toQuery(options)}`),
                AdapterAPI.list().catch(() => ({ data: [] })),
                MetricsAPI.eventDistribution().catch(() => ({ data: {} })),
                MetricsAPI.errors(options).catch(() => ({ data: {} }))
            ]);

            const metrics = metricsResponse.data || {};
            const byChannelEntries = Object.entries(metrics.byChannel || {});
            const adapters = adaptersResponse.data || [];
            const distribution = distributionResponse.data || {};
            const errors = errorsResponse.data || {};
            const fallbackChannels = [...new Set(adapters.map((adapter) => adapter.channel).filter(Boolean))];
            const resolvedByChannel = byChannelEntries.length > 0
                ? byChannelEntries
                : fallbackChannels.map((channel) => [channel, {}]);

            return {
                success: metricsResponse.success,
                data: {
                    totalEvents: metrics.eventsReceived || 0,
                    successRate: metrics.eventsReceived ? (metrics.eventsProcessed || 0) / metrics.eventsReceived : 0,
                    avgLatency: metrics.avgProcessingTimeMs || 0,
                    activeAdapters: adapters.filter((adapter) => adapter.status === 'active').length,
                    byChannel: resolvedByChannel.map(([channel, stat]) => ({
                        channel,
                        eventCount: stat.eventsReceived || 0,
                        successRate: stat.eventsReceived ? (stat.eventsProcessed || 0) / stat.eventsReceived : 0,
                        avgLatency: stat.avgLatencyMs || 0,
                        errorCount: stat.eventsFailed || 0
                    })),
                    byEventType: Object.entries(distribution).map(([eventType, count]) => ({
                        eventType,
                        count,
                        avgProcessingTime: 0
                    })),
                    recentErrors: errors.total ? [{
                        timestamp: new Date().toISOString(),
                        message: `Inbound: ${errors.inbound || 0}, Outbound: ${errors.outbound || 0}`,
                        level: 'error'
                    }] : []
                }
            };
        },

        getAuditLogs(filters = {}) {
            return request(`/audit-logs${toQuery(filters)}`);
        }
    };

    return api;
})();

if (typeof window !== 'undefined') {
    window.ChannelHubAPI = ChannelHubAPI;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChannelHubAPI;
}
