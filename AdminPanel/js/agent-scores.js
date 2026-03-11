// AdminPanel/js/agent-scores.js
import { apiFetch, showMessage } from './utils.js';

export async function initializeAgentScores() {
    console.log('[AgentScores] Initializing...');
    const refreshBtn = document.getElementById('refresh-scores-button');
    if (refreshBtn) {
        // Remove existing listener to avoid duplicates if re-initialized
        refreshBtn.removeEventListener('click', fetchAndRenderScores);
        refreshBtn.addEventListener('click', fetchAndRenderScores);
    }
    
    await fetchAndRenderScores();
}

async function fetchAndRenderScores() {
    const tableBody = document.getElementById('agent-scores-body');
    const statusMsg = document.getElementById('scores-status');
    const refreshBtn = document.getElementById('refresh-scores-button');
    
    if (!tableBody) return;
    
    try {
        if (refreshBtn) refreshBtn.disabled = true;
        if (statusMsg) statusMsg.textContent = '获取中...';
        
        const data = await apiFetch('/admin_api/agent-assistant/scores');
        
        // Convert object to array and sort by totalPoints desc
        const agents = Object.entries(data).map(([baseName, info]) => ({
            baseName,
            ...info
        })).sort((a, b) => b.totalPoints - a.totalPoints);
        
        tableBody.innerHTML = '';
        
        if (agents.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px; opacity: 0.6;">暂无积分记录。</td></tr>`;
            return;
        }
        
        agents.forEach((agent, index) => {
            const lastEntry = agent.history && agent.history.length > 0 ? agent.history[agent.history.length - 1] : null;
            const row = document.createElement('tr');
            
            // Highlight top 3
            let rankClass = '';
            if (index === 0) rankClass = 'rank-gold';
            else if (index === 1) rankClass = 'rank-silver';
            else if (index === 2) rankClass = 'rank-bronze';
            
            const timeStr = lastEntry ? formatLocalTime(lastEntry.time) : '无记录';
            const reasonStr = lastEntry ? `+${lastEntry.pointsDelta} (${lastEntry.reason})` : '无动态';
            
            row.innerHTML = `
                <td><span class="rank-badge ${rankClass}">${index + 1}</span></td>
                <td>
                    <div class="agent-name-cell">
                        <strong>${agent.name || agent.baseName}</strong>
                        <span class="base-name">${agent.baseName}</span>
                    </div>
                </td>
                <td><span class="points-badge">${agent.totalPoints}</span></td>
                <td class="reason-cell" title="${lastEntry?.reason || ''}">${reasonStr}</td>
                <td class="time-cell">${timeStr}</td>
            `;
            tableBody.appendChild(row);
        });
        
        if (statusMsg) {
            statusMsg.textContent = `最后更新: ${new Date().toLocaleTimeString()}`;
            setTimeout(() => { if (statusMsg) statusMsg.textContent = ''; }, 3000);
        }
    } catch (error) {
        console.error('[AgentScores] Error fetching scores:', error);
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger-color); padding: 40px;">加载失败: ${error.message}</td></tr>`;
        if (statusMsg) statusMsg.textContent = '';
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

function formatLocalTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}
