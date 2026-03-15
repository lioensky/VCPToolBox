import { apiFetch, showMessage } from './utils.js';

/**
 * 初始化工具调用审核管理功能
 */
export async function initializeToolApprovalManager() {
    const form = document.getElementById('tool-approval-config-form');
    const statusLabel = document.getElementById('tool-approval-status');
    const enabledInput = document.getElementById('tool-approval-enabled');
    const approveAllInput = document.getElementById('tool-approval-approve-all');
    const timeoutInput = document.getElementById('tool-approval-timeout');
    const listInput = document.getElementById('tool-approval-list');

    if (!form) return;

    // 加载现有配置
    try {
        const config = await apiFetch('/admin_api/tool-approval-config');
        
        enabledInput.checked = !!config.enabled;
        approveAllInput.checked = !!config.approveAll;
        timeoutInput.value = config.timeoutMinutes || 5;
        listInput.value = Array.isArray(config.approvalList) ? config.approvalList.join('\n') : '';
        
        console.log('[ToolApproval] Configuration loaded successfully.');
    } catch (error) {
        console.error('[ToolApproval] Failed to load config:', error);
        showMessage('加载审核配置失败。', 'error');
    }

    // 绑定提交事件
    form.onsubmit = async (e) => {
        e.preventDefault();
        
        const newConfig = {
            enabled: enabledInput.checked,
            approveAll: approveAllInput.checked,
            timeoutMinutes: parseInt(timeoutInput.value, 10),
            approvalList: listInput.value.split('\n').map(s => s.trim()).filter(s => s !== '')
        };

        try {
            statusLabel.textContent = '正在保存...';
            const response = await apiFetch('/admin_api/tool-approval-config', {
                method: 'POST',
                body: JSON.stringify({ config: newConfig })
            });

            if (response.success) {
                showMessage('审核配置已保存！', 'success');
                statusLabel.textContent = '';
            } else {
                throw new Error(response.error || 'Unknown error');
            }
        } catch (error) {
            console.error('[ToolApproval] Failed to save config:', error);
            showMessage('保存审核配置失败: ' + error.message, 'error');
            statusLabel.textContent = '保存失败';
        }
    };
}
