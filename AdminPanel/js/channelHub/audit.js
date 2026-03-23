/**
 * ChannelHub Audit Module
 * Responsibility: Request ID level full-link tracing UI
 * 
 * Features:
 *   - Query by requestId
 *   - Filter by adapter / channel / status
 *   - Display ingress -> route -> runtime -> delivery timeline
 */

// API base path
const AUDIT_API_BASE = '/admin_api/channelHub/audit-logs';

/**
 * Load audit logs with filters
 * @param {Object} filters - Query filters
 * @returns {Promise<Object>} - Audit logs response
 */
async function loadAuditLogs(filters = {}) {
    const params = new URLSearchParams();
    
    if (filters.adapterId) params.append('adapterId', filters.adapterId);
    if (filters.eventType) params.append('eventType', filters.eventType);
    if (filters.startTime) params.append('startTime', filters.startTime);
    if (filters.endTime) params.append('endTime', filters.endTime);
    if (filters.limit) params.append('limit', filters.limit);
    if (filters.offset) params.append('offset', filters.offset);
    if (filters.requestId) params.append('requestId', filters.requestId);
    
    const response = await fetch(`${AUDIT_API_BASE}?${params.toString()}`);
    return response.json();
}

/**
 * Get single audit trace by requestId
 * @param {string} requestId - Request ID to trace
 * @returns {Promise<Object>} - Full trace data
 */
async function getTraceByRequestId(requestId) {
    const response = await fetch(`${AUDIT_API_BASE}?requestId=${encodeURIComponent(requestId)}&limit=100`);
    const result = await response.json();
    
    if (!result.success) {
        throw new Error(result.error || 'Failed to fetch trace');
    }
    
    // Group by stage for timeline view
    return groupTraceByStage(result.data);
}

/**
 * Group audit records by processing stage
 * @param {Array} records - Raw audit records
 * @returns {Object} - Grouped trace data
 */
function groupTraceByStage(records) {
    const stages = {
        ingress: [],
        route: [],
        runtime: [],
        delivery: [],
        error: []
    };
    
    for (const record of records) {
        const stage = record.stage || record.eventType?.split('.')[0] || 'unknown';
        if (stages[stage]) {
            stages[stage].push(record);
        } else {
            stages.error.push(record);
        }
    }
    
    return {
        requestId: records[0]?.requestId,
        totalCount: records.length,
        stages,
        timeline: buildTimeline(records)
    };
}

/**
 * Build timeline from audit records
 * @param {Array} records - Audit records sorted by timestamp
 * @returns {Array} - Timeline events
 */
function buildTimeline(records) {
    return records
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .map(record => ({
            time: new Date(record.timestamp).toLocaleTimeString('zh-CN'),
            fullTime: new Date(record.timestamp).toISOString(),
            stage: record.stage || record.eventType?.split('.')[0] || 'unknown',
            event: record.eventType,
            status: record.status || 'unknown',
            duration: record.durationMs ? `${record.durationMs}ms` : '-',
            details: record.details || record.meta || {}
        }));
}

/**
 * Render audit logs table
 * @param {Array} logs - Audit log records
 * @param {HTMLElement} container - Table body container
 */
function renderAuditTable(logs, container) {
    if (!logs || logs.length === 0) {
        container.innerHTML = '<tr><td colspan="8" class="text-center text-muted">暂无审计记录</td></tr>';
        return;
    }
    
    container.innerHTML = logs.map(log => `
        <tr data-request-id="${log.requestId}">
            <td><code class="small">${log.requestId?.substring(0, 8) || '-'}</code></td>
            <td><span class="badge bg-secondary">${log.adapterId || '-'}</span></td>
            <td>${log.eventType || '-'}</td>
            <td>${formatAuditStatus(log.status)}</td>
            <td>${log.durationMs ? log.durationMs + 'ms' : '-'}</td>
            <td>${new Date(log.timestamp).toLocaleString('zh-CN')}</td>
            <td>
                <button class="btn btn-sm btn-outline-primary view-trace-btn" data-request-id="${log.requestId}">
                    <i class="bi bi-diagram-3"></i> 追踪
                </button>
            </td>
        </tr>
    `).join('');
    
    // Bind trace button events
    container.querySelectorAll('.view-trace-btn').forEach(btn => {
        btn.addEventListener('click', () => showTraceModal(btn.dataset.requestId));
    });
}

/**
 * Format audit status badge
 * @param {string} status - Status value
 * @returns {string} - HTML badge
 */
function formatAuditStatus(status) {
    const statusMap = {
        'success': '<span class="status-badge status-active">成功</span>',
        'failed': '<span class="status-badge status-error">失败</span>',
        'pending': '<span class="status-badge status-pending">处理中</span>',
        'duplicate': '<span class="status-badge status-inactive">重复</span>'
    };
    return statusMap[status] || `<span class="status-badge">${status || '-'}</span>`;
}

/**
 * Show trace modal for a specific requestId
 * @param {string} requestId - Request ID to trace
 */
async function showTraceModal(requestId) {
    const modal = document.getElementById('trace-modal');
    const content = document.getElementById('trace-content');
    
    if (!modal || !content) {
        console.error('Trace modal not found');
        return;
    }
    
    // Show loading state
    content.innerHTML = `
        <div class="text-center py-4">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">加载中...</span>
            </div>
            <p class="mt-2 text-muted">正在加载追踪数据...</p>
        </div>
    `;
    
    // Show modal
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
    
    try {
        const trace = await getTraceByRequestId(requestId);
        
        content.innerHTML = `
            <div class="trace-header mb-4">
                <h6>请求 ID: <code>${trace.requestId}</code></h6>
                <small class="text-muted">共 ${trace.totalCount} 条记录</small>
            </div>
            
            <div class="trace-timeline">
                ${renderTimeline(trace.timeline)}
            </div>
            
            <div class="trace-stages mt-4">
                <h6>阶段详情</h6>
                ${renderStageDetails(trace.stages)}
            </div>
        `;
    } catch (error) {
        content.innerHTML = `
            <div class="alert alert-danger">
                <i class="bi bi-exclamation-triangle"></i> 加载失败: ${error.message}
            </div>
        `;
    }
}

/**
 * Render timeline visualization
 * @param {Array} timeline - Timeline events
 * @returns {string} - HTML timeline
 */
function renderTimeline(timeline) {
    if (!timeline || timeline.length === 0) {
        return '<p class="text-muted">无时间线数据</p>';
    }
    
    return `
        <div class="list-group">
            ${timeline.map((event, index) => `
                <div class="list-group-item d-flex justify-content-between align-items-start">
                    <div class="me-auto">
                        <div class="fw-bold">
                            <span class="badge bg-primary me-2">${index + 1}</span>
                            ${event.event}
                        </div>
                        <small class="text-muted">
                            阶段: ${event.stage} | 状态: ${event.status} | 耗时: ${event.duration}
                        </small>
                    </div>
                    <small class="text-muted">${event.time}</small>
                </div>
            `).join('')}
        </div>
    `;
}

/**
 * Render stage details
 * @param {Object} stages - Stages object
 * @returns {string} - HTML stages
 */
function renderStageDetails(stages) {
    const stageNames = {
        ingress: '入站',
        route: '路由',
        runtime: '运行时',
        delivery: '投递',
        error: '错误'
    };
    
    return Object.entries(stages)
        .filter(([_, records]) => records.length > 0)
        .map(([stage, records]) => `
            <div class="stage-section mb-3">
                <h6 class="text-primary">
                    <i class="bi bi-${getStageIcon(stage)}"></i>
                    ${stageNames[stage] || stage}
                    <span class="badge bg-secondary">${records.length}</span>
                </h6>
                <div class="table-responsive">
                    <table class="table table-sm">
                        <tbody>
                            ${records.map(r => `
                                <tr>
                                    <td><code>${r.eventType}</code></td>
                                    <td>${formatAuditStatus(r.status)}</td>
                                    <td><pre class="mb-0 small">${JSON.stringify(r.details || {}, null, 2)}</pre></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `).join('');
}

/**
 * Get icon for stage
 * @param {string} stage - Stage name
 * @returns {string} - Bootstrap icon name
 */
function getStageIcon(stage) {
    const icons = {
        ingress: 'box-arrow-in-right',
        route: 'signpost-2',
        runtime: 'cpu',
        delivery: 'send',
        error: 'exclamation-triangle'
    };
    return icons[stage] || 'circle';
}

/**
 * Initialize audit module
 */
function initAuditModule() {
    // Bind search form
    const searchForm = document.getElementById('audit-search-form');
    if (searchForm) {
        searchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(searchForm);
            const filters = {
                requestId: formData.get('requestId'),
                adapterId: formData.get('adapterId'),
                eventType: formData.get('eventType'),
                startTime: formData.get('startTime'),
                endTime: formData.get('endTime')
            };
            
            // Remove empty filters
            Object.keys(filters).forEach(key => {
                if (!filters[key]) delete filters[key];
            });
            
            await loadAudit(filters);
        });
    }
    
    // Bind refresh button
    const refreshBtn = document.getElementById('refresh-audit');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadAudit());
    }
    
    // Bind export button
    const exportBtn = document.getElementById('export-audit');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportAuditLogs);
    }
}

/**
 * Load audit logs with current filters
 * @param {Object} filters - Optional filters
 */
async function loadAudit(filters = {}) {
    const tableBody = document.getElementById('audit-table');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">加载中...</td></tr>';
    
    try {
        const result = await loadAuditLogs({ limit: 100, ...filters });
        
        if (result.success) {
            renderAuditTable(result.data, tableBody);
            updateAuditPagination(result.pagination);
        } else {
            tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">${result.error}</td></tr>`;
        }
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">加载失败: ${error.message}</td></tr>`;
    }
}

/**
 * Update pagination info
 * @param {Object} pagination - Pagination data
 */
function updateAuditPagination(pagination) {
    const paginationEl = document.getElementById('audit-pagination');
    if (!paginationEl || !pagination) return;
    
    const { limit, offset, total } = pagination;
    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);
    
    paginationEl.innerHTML = `
        <span class="text-muted">
            第 ${currentPage} / ${totalPages} 页，共 ${total} 条记录
        </span>
    `;
}

/**
 * Export audit logs as JSON
 */
async function exportAuditLogs() {
    try {
        const result = await loadAuditLogs({ limit: 1000 });
        
        if (result.success) {
            const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('审计日志已导出', 'success');
        } else {
            showToast('导出失败: ' + result.error, 'danger');
        }
    } catch (error) {
        showToast('导出失败: ' + error.message, 'danger');
    }
}

// Export functions for use in channelHub.html
window.loadAudit = loadAudit;
window.initAuditModule = initAuditModule;
window.showTraceModal = showTraceModal;