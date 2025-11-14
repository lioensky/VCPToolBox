// AdminPanel/js/dashboard.js
import { apiFetch } from './utils.js';

const MONITOR_API_BASE_URL = '/admin_api/system-monitor';
const API_BASE_URL = '/admin_api';

let monitorIntervalId = null;
let activityDataPoints = new Array(60).fill(0);
let lastLogCheckTime = null;

/**
 * 初始化仪表盘，设置定时器并加载初始数据。
 */
export function initializeDashboard() {
    console.log('Initializing Dashboard...');
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
    }
    updateDashboardData();
    
    updateActivityChart().then(() => {
        drawActivityChart();
    });

    monitorIntervalId = setInterval(() => {
        updateDashboardData();
        updateActivityChart().then(() => {
             drawActivityChart();
        });
    }, 5000);
}

/**
 * 停止仪表盘的数据轮询。
 */
export function stopDashboardUpdates() {
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
        console.log('Dashboard monitoring stopped.');
    }
}

/**
 * 更新仪表盘上的所有数据。
 */
async function updateDashboardData() {
    const cpuProgress = document.getElementById('cpu-progress');
    const cpuUsageText = document.getElementById('cpu-usage-text');
    const cpuInfoText = document.getElementById('cpu-info-text');
    const memProgress = document.getElementById('mem-progress');
    const memUsageText = document.getElementById('mem-usage-text');
    const memInfoText = document.getElementById('mem-info-text');
    const pm2ProcessList = document.getElementById('pm2-process-list');
    const nodeInfoList = document.getElementById('node-info-list');
    const userAuthCodeDisplay = document.getElementById('user-auth-code-display');

    try {
        const [resources, processes, authCodeData] = await Promise.all([
            apiFetch(`${MONITOR_API_BASE_URL}/system/resources`, {}, false),
            apiFetch(`${MONITOR_API_BASE_URL}/pm2/processes`, {}, false),
            apiFetch(`${API_BASE_URL}/user-auth-code`, {}, false).catch(err => {
                console.warn('Failed to fetch user auth code:', err.message);
                return { success: false, code: 'N/A (Error)' };
            })
        ]);
        
        if (userAuthCodeDisplay) {
            userAuthCodeDisplay.textContent = authCodeData.success ? authCodeData.code : (authCodeData.code || 'N/A (未运行)');
        }

        if (cpuProgress && cpuUsageText && cpuInfoText) {
            const cpuUsage = resources.system.cpu.usage.toFixed(1);
            updateProgressCircle(cpuProgress, cpuUsageText, cpuUsage);
            cpuInfoText.innerHTML = `平台: ${resources.system.nodeProcess.platform} <br> 架构: ${resources.system.nodeProcess.arch}`;
        }

        if (memProgress && memUsageText && memInfoText) {
            const memUsed = resources.system.memory.used;
            const memTotal = resources.system.memory.total;
            const memUsage = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : 0;
            updateProgressCircle(memProgress, memUsageText, memUsage);
            memInfoText.innerHTML = `已用: ${(memUsed / 1024 / 1024 / 1024).toFixed(2)} GB <br> 总共: ${(memTotal / 1024 / 1024 / 1024).toFixed(2)} GB`;
        }
        
        if (pm2ProcessList) {
            pm2ProcessList.innerHTML = '';
            if (processes.success && processes.processes.length > 0) {
                processes.processes.forEach(proc => {
                    const procEl = document.createElement('div');
                    procEl.className = 'process-item';
                    procEl.innerHTML = `
                        <strong>${proc.name}</strong> (PID: ${proc.pid})
                        <span class="status ${proc.status}">${proc.status}</span> <br>
                        CPU: ${proc.cpu}% | RAM: ${(proc.memory / 1024 / 1024).toFixed(1)} MB
                    `;
                    pm2ProcessList.appendChild(procEl);
                });
            } else {
                pm2ProcessList.innerHTML = '<p>没有正在运行的 PM2 进程。</p>';
            }
        }

        if (nodeInfoList) {
            const nodeInfo = resources.system.nodeProcess;
            const uptimeSeconds = nodeInfo.uptime;
            const uptimeHours = Math.floor(uptimeSeconds / 3600);
            const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
            nodeInfoList.innerHTML = `
                <div class="node-info-item"><strong>PID:</strong> ${nodeInfo.pid}</div>
                <div class="node-info-item"><strong>Node.js 版本:</strong> ${nodeInfo.version}</div>
                <div class="node-info-item"><strong>内存占用:</strong> ${(nodeInfo.memory.rss / 1024 / 1024).toFixed(2)} MB</div>
                <div class="node-info-item"><strong>运行时间:</strong> ${uptimeHours}h ${uptimeMinutes}m</div>
            `;
        }

    } catch (error) {
        console.error('Failed to update dashboard data:', error);
        if (pm2ProcessList) pm2ProcessList.innerHTML = `<p class="error-message">加载 PM2 数据失败: ${error.message}</p>`;
        if (nodeInfoList) nodeInfoList.innerHTML = `<p class="error-message">加载系统数据失败: ${error.message}</p>`;
    }
}

/**
 * 更新圆形进度条。
 * @param {HTMLElement} circleElement - SVG 元素
 * @param {HTMLElement} textElement - 显示百分比的文本元素
 * @param {number} percentage - 百分比
 */
function updateProgressCircle(circleElement, textElement, percentage) {
    const radius = 54;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    
    const progressBar = circleElement.querySelector('.progress-bar');
    if (progressBar) {
        progressBar.style.strokeDashoffset = offset;
    }
    if (textElement) {
        textElement.textContent = `${percentage}%`;
    }
}

/**
 * 从服务器日志更新活动图表的数据。
 */
async function updateActivityChart() {
    const activityChartCanvas = document.getElementById('activity-chart-canvas');
    if (!activityChartCanvas) return;

    try {
        const logData = await apiFetch(`${API_BASE_URL}/server-log`, {}, false);
        const logLines = logData.content.split('\n');
        
        let newLogsCount = 0;
        let latestTimeInThisBatch = null;

        const regex = /\[(\d{4}\/\d{1,2}\/\d{1,2}\s\d{1,2}:\d{2}:\d{2})\]/;
        for (const line of logLines) {
            const match = line.match(regex);
            if (match && match[1]) {
                const timestamp = new Date(match[1]);
                if (isNaN(timestamp.getTime())) continue;

                if (lastLogCheckTime && timestamp > lastLogCheckTime) {
                    newLogsCount++;
                }

                if (!latestTimeInThisBatch || timestamp > latestTimeInThisBatch) {
                    latestTimeInThisBatch = timestamp;
                }
            }
        }
        
        if (latestTimeInThisBatch) {
            lastLogCheckTime = latestTimeInThisBatch;
        }
        
        activityDataPoints.push(newLogsCount);
        if (activityDataPoints.length > 60) {
            activityDataPoints.shift();
        }

    } catch (error) {
        console.error('Failed to update activity chart data:', error);
        activityDataPoints.push(0);
        if (activityDataPoints.length > 60) {
            activityDataPoints.shift();
        }
    }
}

/**
 * 绘制服务器活动图表。
 */
function drawActivityChart() {
    const activityChartCanvas = document.getElementById('activity-chart-canvas');
    if (!activityChartCanvas) return;
    const canvas = activityChartCanvas;
    const ctx = canvas.getContext('2d');
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;

    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const lineColor = theme === 'dark' ? 'rgba(138, 180, 248, 0.8)' : 'rgba(26, 115, 232, 0.8)';
    const fillColor = theme === 'dark' ? 'rgba(138, 180, 248, 0.15)' : 'rgba(26, 115, 232, 0.15)';
    const gridColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    
    const maxCount = Math.max(5, ...activityDataPoints);
    const padding = 10;

    ctx.clearRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 5; i++) {
        const y = height / 5 * i + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Draw the line and area fill
    ctx.beginPath();
    
    const points = activityDataPoints.map((d, i) => {
        const x = (i / (activityDataPoints.length - 1)) * (width - padding * 2) + padding;
        const y = height - (d / maxCount) * (height - padding * 2) - padding;
        return { x, y };
    });

    if (points.length > 0) {
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
    }
    
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Area fill
    if (points.length > 1) {
        ctx.lineTo(points[points.length - 1].x, height - padding);
        ctx.lineTo(points[0].x, height - padding);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
    }
}