// modelRedirectHandler.js
const fs = require('fs').promises;
const path = require('path');

class ModelRedirectHandler {
    constructor() {
        this.modelRedirectMap = new Map(); // 公开名 -> 内部名
        this.reverseRedirectMap = new Map(); // 内部名 -> 公开名
        this.modelRedirectEnabled = false;
        this.debugMode = false;
    }

    // 设置调试模式
    setDebugMode(debugMode) {
        this.debugMode = debugMode;
    }

    // 检测并加载模型重定向配置
    async loadModelRedirectConfig(configPath = null) {
        const redirectConfigPath = configPath || path.join(process.cwd(), 'ModelRedirect.json');
        
        try {
            // 检查文件是否存在
            await fs.access(redirectConfigPath);
            
            // 读取并解析配置文件
            const configContent = await fs.readFile(redirectConfigPath, 'utf-8');
            const redirectConfig = JSON.parse(configContent);
            
            // 验证配置格式
            if (typeof redirectConfig === 'object' && redirectConfig !== null && !Array.isArray(redirectConfig)) {
                const entries = Object.entries(redirectConfig);
                if (entries.length > 0) {
                    // 清空现有映射并加载新的
                    this.modelRedirectMap.clear();
                    this.reverseRedirectMap.clear();
                    
                    entries.forEach(([publicModel, internalModel]) => {
                        if (typeof publicModel === 'string' && typeof internalModel === 'string') {
                            this.modelRedirectMap.set(publicModel, internalModel); // 公开名 -> 内部名
                            this.reverseRedirectMap.set(internalModel, publicModel); // 内部名 -> 公开名
                        }
                    });
                    
                    this.modelRedirectEnabled = true;
                    console.log(`[ModelRedirect] 模型重定向已启用，加载了 ${this.modelRedirectMap.size} 条重定向规则：`);
                    for (const [publicModel, internalModel] of this.modelRedirectMap.entries()) {
                        console.log(`[ModelRedirect]   客户端请求 '${publicModel}' -> 后端使用 '${internalModel}'`);
                    }
                } else {
                    this.modelRedirectEnabled = false;
                    console.log('[ModelRedirect] ModelRedirect.json 文件为空，模型重定向功能未启用。');
                }
            } else {
                this.modelRedirectEnabled = false;
                console.warn('[ModelRedirect] ModelRedirect.json 格式无效，模型重定向功能未启用。');
            }
        } catch (error) {
            this.modelRedirectEnabled = false;
            if (error.code === 'ENOENT') {
                console.log('[ModelRedirect] 未找到 ModelRedirect.json 文件，模型重定向功能未启用。');
            } else if (error instanceof SyntaxError) {
                console.error('[ModelRedirect] ModelRedirect.json 文件格式错误，模型重定向功能未启用：', error.message);
            } else {
                console.error('[ModelRedirect] 加载 ModelRedirect.json 时出错，模型重定向功能未启用：', error.message);
            }
        }
    }

    // 将客户端请求的公开模型名重定向为内部模型名
    redirectModelForBackend(requestedModel) {
        if (!this.modelRedirectEnabled || !requestedModel) {
            return requestedModel;
        }
        
        const redirectedModel = this.modelRedirectMap.get(requestedModel);
        if (redirectedModel) {
            if (this.debugMode) {
                console.log(`[ModelRedirect] 客户端请求模型重定向: ${requestedModel} -> ${redirectedModel}`);
            }
            return redirectedModel;
        }
        
        return requestedModel;
    }

    // 将后端返回的内部模型名重定向为公开模型名
    redirectModelForClient(internalModel) {
        if (!this.modelRedirectEnabled || !internalModel) {
            return internalModel;
        }
        
        const publicModel = this.reverseRedirectMap.get(internalModel);
        if (publicModel) {
            if (this.debugMode) {
                console.log(`[ModelRedirect] 后端模型名重定向: ${internalModel} -> ${publicModel}`);
            }
            return publicModel;
        }
        
        return internalModel;
    }

    // 处理 /v1/models 端点的响应
    async handleModelsResponse(apiResponse, debugMode = false) {
        if (!this.modelRedirectEnabled || !apiResponse.ok) {
            return null; // 返回 null 表示不需要处理，使用原始响应
        }

        try {
            const responseText = await apiResponse.text();
            const modelsData = JSON.parse(responseText);
            
            // 替换模型列表中的内部模型名为公开模型名
            if (modelsData.data && Array.isArray(modelsData.data)) {
                modelsData.data = modelsData.data.map(model => {
                    if (model.id) {
                        const publicModelName = this.redirectModelForClient(model.id);
                        if (publicModelName !== model.id) {
                            if (debugMode) {
                                console.log(`[ModelRedirect] 模型列表重定向: ${model.id} -> ${publicModelName}`);
                            }
                            return { ...model, id: publicModelName };
                        }
                    }
                    return model;
                });
            }
            
            return modelsData;
        } catch (parseError) {
            console.warn('[ModelRedirect] 解析模型列表响应失败，使用原始响应:', parseError.message);
            return null; // 返回 null 表示解析失败，使用原始响应
        }
    }

    // 获取重定向状态
    isEnabled() {
        return this.modelRedirectEnabled;
    }

    // 获取重定向规则数量
    getRulesCount() {
        return this.modelRedirectMap.size;
    }

    // 获取所有重定向规则（用于调试或管理）
    getAllRules() {
        const rules = {};
        for (const [publicModel, internalModel] of this.modelRedirectMap.entries()) {
            rules[publicModel] = internalModel;
        }
        return rules;
    }
}

module.exports = ModelRedirectHandler;