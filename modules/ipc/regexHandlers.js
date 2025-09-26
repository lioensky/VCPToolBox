// modules/ipc/regexHandlers.js
const { ipcMain, dialog } = require('electron');
const fs = require('fs-extra');
const path = require('path');

let AGENT_DIR_CACHE;

/**
 * Initializes regex management related IPC handlers.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 */
function initialize(context) {
    AGENT_DIR_CACHE = context.AGENT_DIR;

    ipcMain.handle('import-regex-rules', async (event, agentId) => {
        if (!agentId) {
            return { success: false, error: '没有提供Agent ID。' };
        }

        try {
            const { canceled, filePaths } = await dialog.showOpenDialog({
                title: '选择要导入的正则规则文件',
                filters: [{ name: 'JSON Files', extensions: ['json'] }],
                properties: ['openFile']
            });

            if (canceled || filePaths.length === 0) {
                return { success: false, error: '用户取消了文件选择。', canceled: true };
            }

            const filePath = filePaths[0];
            let importedRules;
            const importedData = await fs.readJson(filePath);

            // Check if it's SillyTavern format (single object with scriptName)
            if (typeof importedData === 'object' && !Array.isArray(importedData) && importedData.scriptName) {
                const st = importedData;
                const vcpRule = {
                    id: `rule_${Date.now()}`,
                    title: st.scriptName,
                    findPattern: st.findRegex,
                    replaceWith: st.replaceString,
                    applyToRoles: (st.placement || []).map(p => {
                        if (p === 1) return 'user';
                        if (p === 2) return 'assistant';
                        return null;
                    }).filter(Boolean),
                    applyToFrontend: st.markdownOnly !== undefined ? st.markdownOnly : true, // Default to true if undefined
                    applyToContext: st.promptOnly !== undefined ? st.promptOnly : false, // Default to false if undefined
                    minDepth: st.minDepth === null || st.minDepth === undefined ? 0 : st.minDepth,
                    maxDepth: st.maxDepth === null || st.maxDepth === undefined ? -1 : st.maxDepth,
                };
                importedRules = [vcpRule];
            }
            // Check if it's VCPChat native format (single object)
            else if (typeof importedData === 'object' && !Array.isArray(importedData) && importedData.title) {
                importedRules = [importedData];
            }
            // Check if it's a VCPChat rules array (for backward compatibility or other uses)
            else if (Array.isArray(importedData)) {
                 return { success: false, error: '不支持导入VCPChat正则数组，请导入单个正则文件。' };
            }
            else {
                return { success: false, error: '无法识别的正则文件格式。' };
            }

            const agentDir = path.join(AGENT_DIR_CACHE, agentId);
            const regexPath = path.join(agentDir, 'regex_rules.json');
            
            await fs.ensureDir(agentDir);

            // Read existing rules
            let existingRules = [];
            if (await fs.pathExists(regexPath)) {
                try {
                    existingRules = await fs.readJson(regexPath);
                    if (!Array.isArray(existingRules)) existingRules = [];
                } catch (e) {
                    console.warn(`Could not read or parse existing regex_rules.json for agent ${agentId}, starting fresh.`, e);
                    existingRules = [];
                }
            }

            // Merge and prevent duplicates based on a unique property, e.g., 'title' or 'id'
            const existingRuleIds = new Set(existingRules.map(rule => rule.id || rule.title));
            const newRules = importedRules.filter(rule => !existingRuleIds.has(rule.id || rule.title));

            if (newRules.length === 0) {
                return { success: true, rules: existingRules, message: '所有规则都已存在，未添加新规则。' };
            }

            const finalRules = [...existingRules, ...newRules];

            await fs.writeJson(regexPath, finalRules, { spaces: 2 });

            return { success: true, rules: finalRules };

        } catch (error) {
            console.error(`为 Agent ${agentId} 导入正则规则失败:`, error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initialize
};