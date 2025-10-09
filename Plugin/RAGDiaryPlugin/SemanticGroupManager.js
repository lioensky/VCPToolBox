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
            const editData = JSON.parse(editContent);
            console.log('[SemanticGroup] 发现 .edit.json 文件，开始同步...');

            let mainData = null;
            try {
                const mainContent = await fs.readFile(this.groupsFilePath, 'utf-8');
                mainData = JSON.parse(mainContent);
            } catch (mainError) {
                if (mainError.code !== 'ENOENT') throw mainError;
                // 主文件不存在，将直接使用 editData 创建
            }

            // 比较核心数据是否发生变化
            const areDifferent = this._areCoreGroupDataDifferent(editData, mainData);

            if (areDifferent) {
                console.log('[SemanticGroup] .edit.json 与主文件核心内容不同，正在执行智能合并...');
                
                // 智能合并：使用 edit.json 的词元，保留 main.json 的 vector_id 等元数据
                const newMainData = this._mergeGroupData(editData, mainData);

                await fs.writeFile(this.groupsFilePath, JSON.stringify(newMainData, null, 2), 'utf-8');
                console.log('[SemanticGroup] 同步完成。');
            } else {
                console.log('[SemanticGroup] .edit.json 与主文件核心内容相同，无需同步。');
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                // .edit.json 不存在，什么都不做
                return;
            }
            if (error instanceof SyntaxError) {
                 console.error('[SemanticGroup] 解析 .edit.json 文件时出错，请检查JSON格式:', error);
            } else {
                 console.error('[SemanticGroup] 同步 .edit.json 文件时出错:', error);
            }
        }
    }

    // 新增辅助函数：比较核心数据
    _areCoreGroupDataDifferent(editData, mainData) {
        if (!mainData) return true; // 主文件不存在，肯定不同

        // 比较 config
        if (JSON.stringify(editData.config || {}) !== JSON.stringify(mainData.config || {})) {
            return true;
        }

        const editGroups = editData.groups || {};
        const mainGroups = mainData.groups || {};

        // 检查组名数量是否一致
        if (Object.keys(editGroups).length !== Object.keys(mainGroups).length) {
            return true;
        }

        // 逐个比较组的核心词元
        for (const groupName in editGroups) {
            if (!mainGroups[groupName]) return true; // 组不存在

            const editGroup = editGroups[groupName];
            const mainGroup = mainGroups[groupName];

            // 为了稳定比较，对词元数组排序
            const editWords = [...(editGroup.words || [])].sort();
            const mainWords = [...(mainGroup.words || [])].sort();
            if (JSON.stringify(editWords) !== JSON.stringify(mainWords)) return true;

            const editAutoLearned = [...(editGroup.auto_learned || [])].sort();
            const mainAutoLearned = [...(mainGroup.auto_learned || [])].sort();
            if (JSON.stringify(editAutoLearned) !== JSON.stringify(mainAutoLearned)) return true;
            
            // 比较权重
            if ((editGroup.weight || 1.0) !== (mainGroup.weight || 1.0)) return true;
        }

        return false;
    }

    // 新增辅助函数：合并数据
    _mergeGroupData(editData, mainData) {
        if (!mainData) {
            // 如果主数据不存在，直接返回编辑数据（它还没有元数据）
            return editData;
        }

        const newMainData = JSON.parse(JSON.stringify(mainData)); // 深拷贝主数据作为基础
        
        // 1. 更新 config
        newMainData.config = editData.config || {};

        const editGroups = editData.groups || {};
        const newMainGroups = {};

        // 2. 遍历 edit.json 中的组，这是最新的权威来源
        for (const groupName in editGroups) {
            const editGroup = editGroups[groupName];
            const existingGroup = newMainData.groups[groupName];

            if (existingGroup) {
                // 组存在，更新词元和权重，保留元数据
                existingGroup.words = editGroup.words || [];
                existingGroup.auto_learned = editGroup.auto_learned || [];
                existingGroup.weight = editGroup.weight || 1.0;
                newMainGroups[groupName] = existingGroup;
            } else {
                // 组是新增的，直接添加
                newMainGroups[groupName] = editGroup;
            }
        }
        
        newMainData.groups = newMainGroups;
        return newMainData;
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
    _getWordsHash(words) {
        if (!words || words.length === 0) {
            return null;
        }
        // Sort to ensure order doesn't matter, and join with a stable separator
        const sortedWords = [...words].sort();
        return crypto.createHash('sha256').update(JSON.stringify(sortedWords)).digest('hex');
    }

    async precomputeGroupVectors() {
        console.log('[SemanticGroup] 开始检查并预计算所有组向量...');
        let changesMade = false;

        for (const [groupName, groupData] of Object.entries(this.groups)) {
            const autoLearnedWords = groupData.auto_learned || [];
            const allWords = [...groupData.words, ...autoLearnedWords];
            
            if (allWords.length === 0) {
                if (groupData.vector_id) {
                    console.log(`[SemanticGroup] 组 "${groupName}" 词元为空，正在清理旧向量...`);
                    try {
                        const vectorPath = path.join(this.vectorsDirPath, `${groupData.vector_id}.json`);
                        await fs.unlink(vectorPath);
                        console.log(`[SemanticGroup] 已删除向量文件: ${groupData.vector_id}.json`);
                    } catch (e) {
                        if (e.code !== 'ENOENT') console.error(`[SemanticGroup] 删除旧向量文件失败: ${e.message}`);
                    }
                    delete this.groups[groupName].vector_id;
                    delete this.groups[groupName].words_hash;
                    this.groupVectorCache.delete(groupName);
                    changesMade = true;
                }
                continue;
            }

            const currentWordsHash = this._getWordsHash(allWords);
            const vectorExists = this.groupVectorCache.has(groupName);

            if (currentWordsHash !== groupData.words_hash || !vectorExists) {
                if (!vectorExists) {
                    console.log(`[SemanticGroup] 组 "${groupName}" 的向量不存在，开始计算...`);
                } else {
                    console.log(`[SemanticGroup] 组 "${groupName}" 的词元已改变，重新计算向量...`);
                }

                const groupDescription = `${groupName}相关主题：${allWords.join(', ')}`;
                const vector = await this.ragPlugin.getSingleEmbedding(groupDescription);

                if (vector) {
                    // If a vector existed before (even with a different ID), we should clean it up.
                    // This case is mostly for when words change.
                    if (groupData.vector_id) {
                         try {
                            const oldVectorPath = path.join(this.vectorsDirPath, `${groupData.vector_id}.json`);
                            await fs.unlink(oldVectorPath);
                         } catch (e) {
                            if (e.code !== 'ENOENT') console.error(`[SemanticGroup] 删除旧向量文件失败: ${e.message}`);
                         }
                    }

                    const vectorId = crypto.randomUUID();
                    const vectorPath = path.join(this.vectorsDirPath, `${vectorId}.json`);
                    await fs.writeFile(vectorPath, JSON.stringify(vector), 'utf-8');
                    
                    this.groupVectorCache.set(groupName, vector);
                    this.groups[groupName].vector_id = vectorId;
                    this.groups[groupName].words_hash = currentWordsHash;
                    delete this.groups[groupName].vector;
                    changesMade = true;
                    console.log(`[SemanticGroup] 已成功计算并保存 "${groupName}" 的新组向量 (ID: ${vectorId})`);
                }
            }
        }
        
        if (changesMade) {
            console.log('[SemanticGroup] 检测到向量变更，正在保存主配置文件...');
            await this.saveGroups();
        } else {
            console.log('[SemanticGroup] 所有组向量均是最新，无需更新。');
        }
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