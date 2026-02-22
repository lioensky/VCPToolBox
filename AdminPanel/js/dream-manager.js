// AdminPanel/js/dream-manager.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE = '/admin_api';

let currentLogs = [];

/**
 * 初始化梦境审批管理器
 */
export async function initializeDreamManager() {
    const container = document.getElementById('dream-manager-content');
    if (!container) return;
    container.innerHTML = '<p style="opacity:0.6">加载中...</p>';
    await loadDreamLogs();
}

/**
 * 加载梦日志列表
 */
async function loadDreamLogs() {
    const container = document.getElementById('dream-manager-content');
    if (!container) return;

    try {
        const data = await apiFetch(`${API_BASE}/dream-logs`);
        currentLogs = data.logs || [];

        if (currentLogs.length === 0) {
            container.innerHTML = `
                <div class="dream-empty-state">
                    <span class="material-symbols-outlined" style="font-size:48px;opacity:0.3">nights_stay</span>
                    <p>暂无梦操作日志</p>
                    <p style="font-size:0.85em;opacity:0.5">当 Agent 发起梦操作后，日志将出现在这里</p>
                </div>`;
            return;
        }

        container.innerHTML = '';
        for (const log of currentLogs) {
            container.appendChild(createLogCard(log));
        }
    } catch (err) {
        container.innerHTML = `<p class="error-message">加载失败: ${err.message}</p>`;
    }
}

/**
 * 创建单个梦日志卡片
 */
function createLogCard(log) {
    const card = document.createElement('div');
    card.className = 'dream-log-card';
    if (log.pendingCount > 0) card.classList.add('has-pending');

    const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleString('zh-CN') : '未知时间';

    const statusBadge = log.pendingCount > 0
        ? `<span class="dream-badge pending">${log.pendingCount} 待审批</span>`
        : `<span class="dream-badge done">已处理</span>`;

    card.innerHTML = `
        <div class="dream-log-header">
            <div class="dream-log-title">
                <span class="material-symbols-outlined">nights_stay</span>
                <strong>${escapeHtml(log.agentName)}</strong>
                ${statusBadge}
            </div>
            <div class="dream-log-meta">
                <span>${timeStr}</span>
                <span>${log.operationCount} 个操作</span>
            </div>
        </div>
        <div class="dream-log-ops-summary">
            ${(log.operationSummary || []).map(op => `
                <span class="dream-op-chip ${op.status}">${getOpTypeLabel(op.type)} · ${getStatusLabel(op.status)}</span>
            `).join('')}
        </div>
        <div class="dream-log-detail" style="display:none"></div>
    `;

    // 点击头部展开/折叠详情
    card.querySelector('.dream-log-header').addEventListener('click', () => {
        toggleDetail(card, log.filename);
    });

    return card;
}

/**
 * 展开/折叠梦日志详情
 */
async function toggleDetail(card, filename) {
    const detail = card.querySelector('.dream-log-detail');
    if (detail.style.display !== 'none') {
        detail.style.display = 'none';
        return;
    }

    detail.innerHTML = '<p style="opacity:0.6;padding:8px">加载详情...</p>';
    detail.style.display = 'block';

    try {
        const data = await apiFetch(`${API_BASE}/dream-logs/${encodeURIComponent(filename)}`);
        renderDetail(detail, data, filename);
    } catch (err) {
        detail.innerHTML = `<p class="error-message">加载失败: ${err.message}</p>`;
    }
}

/**
 * 渲染详情面板
 */
function renderDetail(detail, data, filename) {
    let html = '';

    // 梦叙事
    if (data.dreamNarrative) {
        html += `
            <div class="dream-narrative-block">
                <h4>🌙 梦境叙事</h4>
                <div class="dream-narrative-text">${marked.parse(data.dreamNarrative || '')}</div>
            </div>`;
    }

    // 操作列表
    const ops = data.operations || [];
    html += '<div class="dream-ops-list">';
    for (const op of ops) {
        html += renderOperation(op, filename);
    }
    html += '</div>';

    detail.innerHTML = html;

    // 绑定审批按钮事件
    detail.querySelectorAll('.dream-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const opId = btn.dataset.opId;
            await handleReview(filename, opId, action, card_ancestor(btn));
        });
    });
}

/**
 * 渲染单个操作
 */
function renderOperation(op, filename) {
    const statusClass = op.status;
    const isPending = op.status === 'pending_review';

    let contentHtml = '';

    switch (op.type) {
        case 'merge': {
            const sources = op.sourceDiaries || [];
            contentHtml = `
                <div class="dream-op-field">
                    <label>源日记 (${sources.length} 篇)</label>
                    <div class="dream-file-list">
                        ${sources.map(s => `<code class="dream-file-path">${escapeHtml(extractFileName(s))}</code>`).join('')}
                    </div>
                </div>
                <div class="dream-op-field">
                    <label>合并后内容</label>
                    <div class="dream-content-preview markdown-body">${marked.parse(op.newContent || '(空)')}</div>
                </div>`;

            // 源日记原始内容
            if (op.sourceContents && Object.keys(op.sourceContents).length > 0) {
                contentHtml += `<details class="dream-source-details"><summary>📄 查看源日记原文</summary>`;
                for (const [url, content] of Object.entries(op.sourceContents)) {
                    contentHtml += `
                        <div class="dream-source-item">
                            <strong>${escapeHtml(extractFileName(url))}</strong>
                            <div class="dream-content-preview markdown-body">${marked.parse(content || '')}</div>
                        </div>`;
                }
                contentHtml += '</details>';
            }
            break;
        }

        case 'delete': {
            contentHtml = `
                <div class="dream-op-field">
                    <label>目标日记</label>
                    <code class="dream-file-path">${escapeHtml(extractFileName(op.targetDiary || ''))}</code>
                </div>
                <div class="dream-op-field">
                    <label>删除理由</label>
                    <p>${escapeHtml(op.reason || '(无)')}</p>
                </div>`;

            if (op.targetContent) {
                contentHtml += `
                    <details class="dream-source-details"><summary>📄 查看待删除内容</summary>
                        <div class="dream-content-preview markdown-body">${marked.parse(op.targetContent || '')}</div>
                    </details>`;
            }
            break;
        }

        case 'insight': {
            contentHtml = `
                <div class="dream-op-field">
                    <label>参考日记 (${(op.referenceDiaries || []).length} 篇)</label>
                    <div class="dream-file-list">
                        ${(op.referenceDiaries || []).map(s => `<code class="dream-file-path">${escapeHtml(extractFileName(s))}</code>`).join('')}
                    </div>
                </div>
                <div class="dream-op-field">
                    <label>梦感悟内容</label>
                    <div class="dream-content-preview markdown-body">${marked.parse(op.insightContent || '(空)')}</div>
                </div>`;
            break;
        }

        default:
            contentHtml = `<pre>${escapeHtml(JSON.stringify(op, null, 2))}</pre>`;
    }

    const actionHtml = isPending
        ? `<div class="dream-op-actions">
               <button class="dream-action-btn approve" data-action="approve" data-op-id="${op.operationId}" data-filename="${filename}">✅ 批准执行</button>
               <button class="dream-action-btn reject" data-action="reject" data-op-id="${op.operationId}" data-filename="${filename}">❌ 拒绝</button>
           </div>`
        : (op.reviewedAt ? `<p class="dream-reviewed-info">审批时间: ${new Date(op.reviewedAt).toLocaleString('zh-CN')}</p>` : '');

    return `
        <div class="dream-op-card ${statusClass}">
            <div class="dream-op-header">
                <span class="dream-op-type">${getOpTypeIcon(op.type)} ${getOpTypeLabel(op.type)}</span>
                <span class="dream-op-status ${statusClass}">${getStatusLabel(op.status)}</span>
            </div>
            <div class="dream-op-body">
                ${contentHtml}
            </div>
            ${actionHtml}
        </div>`;
}

/**
 * 处理审批
 */
async function handleReview(filename, opId, action, cardElement) {
    const actionLabel = action === 'approve' ? '批准' : '拒绝';
    if (!confirm(`确定${actionLabel}此操作吗？${action === 'approve' ? '批准后将执行实际的文件操作。' : ''}`)) return;

    try {
        const result = await apiFetch(`${API_BASE}/dream-logs/${encodeURIComponent(filename)}/operations/${encodeURIComponent(opId)}`, {
            method: 'POST',
            body: JSON.stringify({ action })
        });
        showMessage(result.message || `操作已${actionLabel}`, 'success');
        // 刷新整个列表
        await loadDreamLogs();
    } catch (err) {
        showMessage(`${actionLabel}失败: ${err.message}`, 'error');
    }
}

// --- 辅助 ---

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractFileName(fileUrl) {
    if (!fileUrl) return '(未知)';
    const parts = fileUrl.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || fileUrl;
}

function getOpTypeLabel(type) {
    switch (type) {
        case 'merge': return '合并';
        case 'delete': return '删除';
        case 'insight': return '感悟';
        default: return type || '未知';
    }
}

function getOpTypeIcon(type) {
    switch (type) {
        case 'merge': return '🔀';
        case 'delete': return '🗑️';
        case 'insight': return '💡';
        default: return '❓';
    }
}

function getStatusLabel(status) {
    switch (status) {
        case 'pending_review': return '待审批';
        case 'approved': return '已批准';
        case 'rejected': return '已拒绝';
        case 'error': return '执行出错';
        default: return status || '未知';
    }
}

function card_ancestor(el) {
    while (el && !el.classList.contains('dream-log-card')) el = el.parentElement;
    return el;
}
