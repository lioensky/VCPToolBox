// Plugin/RAGDiaryPlugin/SemanticGroupManager.js

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class SemanticGroupManager {
    constructor(ragPlugin) {
        this.ragPlugin = ragPlugin; // 引用 RAGDiaryPlugin 实例
        this.groups = {};
        this.config = {};
        this.groupVectorCache = new Map(); // 使用 Map 存储向量缓存
        this.saveLock = false; // 添加保存锁以防止并发写入
        this.groupsFilePath = path.join(__dirname, 'semantic_groups.json');
        this.vectorsDirPath = path.join(__dirname, 'semantic_vectors');
        this.editFilePath = path.join(__dirname, 'semantic_groups.edit.json');
        this.initialize();
    }

    async initialize() {
        await fs.mkdir(this.vectorsDirPath, { recursive: true });
        await this.synchronizeFromEditFile();
        await this.loadGroups();
    }

    async synchronizeFromEditFile() {
        try {
            const editContent = await fs.readFile(this.editFilePath, 'utf-8');
            console.log('[SemanticGroup] 发现 .edit.json 文件，开始同步...');

            let mainContent = '';
            try {
                mainContent = await fs.readFile(this.groupsFilePath, 'utf-8');
            } catch (mainError) {
                if (mainError.code !== 'ENOENT') throw mainError;
                // 主文件不存在，直接同步
            }

            if (editContent.trim() !== mainContent.trim()) {
                console.log('[SemanticGroup] .edit.json 与主文件内容不同，正在执行覆盖...');
                await fs.writeFile(this.groupsFilePath, editContent, 'utf-8');
                console.log('[SemanticGroup] 同步完成。');
            } else {
                console.log('[SemanticGroup] .edit.json 与主文件内容相同，无需同步。');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[SemanticGroup] 同步 .edit.json 文件时出错:', error);
            }
            // 如果 .edit.json 不存在，则什么都不做
        }
    }

    async loadGroups() {
        try {
            const data = await fs.readFile(this.groupsFilePath, 'utf-8');
            const groupData = JSON.parse(data);
            this.config = groupData.config || {};
            this.groups = groupData.groups || {};
            console.log('[SemanticGroup] 语义组配置文件加载成功。');

            let needsResave = false;

            // 加载向量并处理旧格式迁移
            for (const [groupName, group] of Object.entries(this.groups)) {
                // 迁移逻辑：如果存在 vector 字段但不存在 vector_id
                if (group.vector && !group.vector_id) {
                    console.log(`[SemanticGroup] 检测到旧格式组 "${groupName}"，正在迁移向量...`);
                    const vectorId = crypto.randomUUID();
                    const vectorPath = path.join(this.vectorsDirPath, `${vectorId}.json`);
                    await fs.writeFile(vectorPath, JSON.stringify(group.vector));
                    
                    this.groupVectorCache.set(groupName, group.vector);
                    group.vector_id = vectorId;
                    delete group.vector; // 从主配置中删除向量
                    needsResave = true;
                } else if (group.vector_id) {
                    try {
                        const vectorPath = path.join(this.vectorsDirPath, `${group.vector_id}.json`);
                        const vectorData = await fs.readFile(vectorPath, 'utf-8');
                        this.groupVectorCache.set(groupName, JSON.parse(vectorData));
                    } catch (vecError) {
                        console.error(`[SemanticGroup] 加载组 "${groupName}" 的向量文件失败 (ID: ${group.vector_id}):`, vecError);
                        // 如果向量文件丢失，清除ID以便重新计算
                        delete group.vector_id;
                        needsResave = true;
                    }
                }
            }

            if (needsResave) {
                console.log('[SemanticGroup] 迁移或清理后，正在重新保存主配置文件...');
                await this.saveGroups();
            }

            await this.precomputeGroupVectors();
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[SemanticGroup] 加载语义组配置文件失败:', error);
            } else {
                console.log('[SemanticGroup] 未找到语义组配置文件，将创建新文件。');
            }
        }
    }

    async saveGroups() {
        if (this.saveLock) {
            const busyError = new Error('A save operation is already in progress. Please wait a moment and try again.');
            console.warn(`[SemanticGroup] ${busyError.message}`);
            throw busyError;
        }
        this.saveLock = true;

        const tempFilePath = this.groupsFilePath + `.${crypto.randomUUID()}.tmp`;
        try {
            // 创建一个不含实际向量数据的副本用于保存
            const groupsToSave = JSON.parse(JSON.stringify(this.groups));
            for (const group of Object.values(groupsToSave)) {
                delete group.vector; // 确保内存中的临时向量不被保存
            }

            const dataToSave = {
                config: this.config,
                groups: groupsToSave
            };
            
            // 1. 写入临时文件
            await fs.writeFile(tempFilePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
            
            // 2. 成功后，重命名临时文件以原子方式替换原文件
            await fs.rename(tempFilePath, this.groupsFilePath);
            
            console.log('[SemanticGroup] 语义组配置已通过原子写入操作更新并保存。');
        } catch (error) {
            console.error('[SemanticGroup] 保存语义组配置文件失败:', error);
            // 如果出错，尝试清理临时文件
            try {
                await fs.unlink(tempFilePath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    console.error(`[SemanticGroup] 清理临时文件 ${tempFilePath} 失败:`, cleanupError);
                }
            }
            throw error; // 将原始错误重新抛出，以便API路由可以捕获它
        } finally {
            this.saveLock = false;
        }
    }

    async updateGroupsData(newData) {
        try {
            const oldGroups = this.groups;
            this.config = newData.config || this.config;
            this.groups = newData.groups || this.groups;
            console.log('[SemanticGroup] 接收到来自管理面板的数据，内存已更新。');

            // 清理被删除的组的向量文件
            const oldVectorIds = new Set(Object.values(oldGroups).map(g => g.vector_id).filter(Boolean));
            const newVectorIds = new Set(Object.values(this.groups).map(g => g.vector_id).filter(Boolean));
            for (const vectorId of oldVectorIds) {
                if (!newVectorIds.has(vectorId)) {
                    try {
                        const vectorPath = path.join(this.vectorsDirPath, `${vectorId}.json`);
                        await fs.unlink(vectorPath);
                        console.log(`[SemanticGroup] 已删除孤立的向量文件: ${vectorId}.json`);
                    } catch (unlinkError) {
                        if (unlinkError.code !== 'ENOENT') {
                             console.error(`[SemanticGroup] 删除向量文件 ${vectorId}.json 失败:`, unlinkError);
                        }
                    }
                }
            }

            // 重新计算向量并保存所有更改
            await this.precomputeGroupVectors(); // 此函数现在会处理所有保存逻辑

        } catch (error) {
            console.error('[SemanticGroup] 更新并保存语义组数据失败:', error);
            throw error; // Re-throw the error to be caught by the route handler
        }
    }

    // ============ 核心功能：组激活 ============
    detectAndActivateGroups(text) {
        const activatedGroups = new Map();
        
        for (const [groupName, groupData] of Object.entries(this.groups)) {
            // 如果 auto_learned 不存在，提供一个空数组作为后备
            const autoLearnedWords = groupData.auto_learned || [];
            const allWords = [...groupData.words, ...autoLearnedWords];
            
            const matchedWords = allWords.filter(word => this.flexibleMatch(text, word));
            
            if (matchedWords.length > 0) {
                const activationStrength = matchedWords.length / allWords.length;
                activatedGroups.set(groupName, {
                    strength: activationStrength,
                    matchedWords: matchedWords,
                    allWords: allWords
                });
                
                this.updateGroupStats(groupName);
            }
        }
        
        return activatedGroups;
    }

    flexibleMatch(text, word) {
        const lowerText = text.toLowerCase();
        const lowerWord = word.toLowerCase();
        return lowerText.includes(lowerWord);
    }

    updateGroupStats(groupName) {
        if (this.groups[groupName]) {
            this.groups[groupName].last_activated = new Date().toISOString();
            this.groups[groupName].activation_count = (this.groups[groupName].activation_count || 0) + 1;
        }
    }

    // ============ 预计算组向量 ============
    async precomputeGroupVectors() {
        console.log('[SemanticGroup] 开始预计算所有组向量...');
        let changesMade = false;

        for (const [groupName, groupData] of Object.entries(this.groups)) {
            // 如果向量已在缓存中，则跳过
            if (this.groupVectorCache.has(groupName)) {
                continue;
            }

            const autoLearnedWords = groupData.auto_learned || [];
            const allWords = [...groupData.words, ...autoLearnedWords];
            
            if (allWords.length === 0) continue; // 跳过空组

            const groupDescription = `${groupName}相关主题：${allWords.join(', ')}`;
            
            const vector = await this.ragPlugin.getSingleEmbedding(groupDescription);
            if (vector) {
                const vectorId = groupData.vector_id || crypto.randomUUID();
                const vectorPath = path.join(this.vectorsDirPath, `${vectorId}.json`);
                
                await fs.writeFile(vectorPath, JSON.stringify(vector), 'utf-8');
                
                this.groupVectorCache.set(groupName, vector);
                this.groups[groupName].vector_id = vectorId; // 确保ID被设置
                delete this.groups[groupName].vector; // 清理内存中的向量数据
                changesMade = true;
                console.log(`[SemanticGroup] 已成功计算并保存 "${groupName}" 的组向量 (ID: ${vectorId})`);
            }
        }
        
        // 只要有任何向量被计算，就保存一次主配置文件
        // 或者，如果这是由 updateGroupsData 调用的，我们也需要保存
        // 为了简单起见，在计算后总是保存一次以捕获所有更改。
        await this.saveGroups();
        return changesMade;
    }

    // ============ 使用预计算向量的快速模式 ============
    async getEnhancedVector(originalQuery, activatedGroups) {
        const queryVector = await this.ragPlugin.getSingleEmbedding(originalQuery);
        
        if (!queryVector) {
            console.error('[SemanticGroup] 原始查询向量化失败，无法进行增强。');
            return null;
        }

        if (activatedGroups.size === 0) {
            return queryVector;
        }
        
        const vectors = [queryVector];
        const weights = [1.0]; // 原始查询权重
        
        for (const [groupName, data] of activatedGroups) {
            const groupVector = this.groupVectorCache.get(groupName);
            if (groupVector) {
                vectors.push(groupVector);
                // 权重可以根据激活强度和组的全局权重调整
                const groupWeight = (this.groups[groupName].weight || 1.0) * data.strength;
                weights.push(groupWeight); 
            }
        }
        
        if (vectors.length === 1) {
            return queryVector; // 没有有效的组向量被添加
        }

        const enhancedVector = this.weightedAverageVectors(vectors, weights);
        console.log(`[SemanticGroup] 已将查询向量与 ${activatedGroups.size} 个激活的语义组向量进行混合。`);
        return enhancedVector;
    }

    weightedAverageVectors(vectors, weights) {
        if (!vectors || vectors.length === 0) return null;
        
        const dim = vectors[0].length;
        const result = new Array(dim).fill(0);
        
        let totalWeight = 0;
        for (let i = 0; i < vectors.length; i++) {
            if (!vectors[i] || vectors[i].length !== dim) continue; // 跳过无效向量
            const weight = weights[i];
            totalWeight += weight;
            for (let j = 0; j < dim; j++) {
                result[j] += vectors[i][j] * weight;
            }
        }
        
        if (totalWeight === 0) return vectors[0]; // 如果总权重为0，返回原始向量

        for (let j = 0; j < dim; j++) {
            result[j] /= totalWeight;
        }
        
        return result;
    }
}

module.exports = SemanticGroupManager;