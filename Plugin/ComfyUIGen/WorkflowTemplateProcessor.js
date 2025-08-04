// ComfyUI工作流模板处理器
const fs = require('fs-extra');
const path = require('path');

class WorkflowTemplateProcessor {
    constructor() {
        // 节点类型到替换字段的映射
        this.nodeTypeMapping = {
            'KSampler': {
                replacements: {
                    'seed': '{{SEED}}',
                    'steps': '{{STEPS}}',
                    'cfg': '{{CFG}}',
                    'sampler_name': '{{SAMPLER}}',
                    'scheduler': '{{SCHEDULER}}',
                    'denoise': '{{DENOISE}}'
                }
            },
            'EmptyLatentImage': {
                replacements: {
                    'width': '{{WIDTH}}',
                    'height': '{{HEIGHT}}',
                    'batch_size': '{{BATCH_SIZE}}'
                }
            },
            'CheckpointLoaderSimple': {
                replacements: {
                    'ckpt_name': '{{MODEL}}'
                }
            },
            'easy comfyLoader': {
                replacements: {
                    'ckpt_name': '{{MODEL}}',
                    'lora_name': 'None',  // 我们通过提示词处理LoRA
                    'lora_model_strength': 0.7,
                    'lora_clip_strength': 1.0
                }
            },
            'WeiLinPromptToString': {
                replacements: {
                    'positive': '{{POSITIVE_PROMPT}}',
                    'negative': '{{NEGATIVE_PROMPT}}'
                }
            },
            'PrimitiveString': {
                // 需要根据title智能判断
                titleBasedReplacements: {
                    '别动': null,  // 不替换
                    '替换': '{{POSITIVE_PROMPT}}',  // 替换为正面提示词
                    '不替换': null,  // 不替换
                    '伪提示词': '{{PROMPT_INPUT}}',  // 替换为独立的提示词输入
                    '用户提示': '{{USER_PROMPT}}',  // 仅用户输入
                    'default': '{{POSITIVE_PROMPT}}'  // 默认替换
                }
            },
            'CLIPTextEncode': {
                replacements: {
                    'text': {
                        // 检查是否连接到正面或负面提示词
                        'positive': '{{POSITIVE_PROMPT}}',
                        'negative': '{{NEGATIVE_PROMPT}}'
                    }
                }
            }
        };

        // 不需要替换的节点（标记为保持原样）
        this.preserveNodes = [
            'VAEDecode',
            'SaveImage',
            'UpscaleModelLoader',
            'UltralyticsDetectorProvider',
            'SAMLoader',
            'FaceDetailer'
        ];

        // 标题/名称命中“不替换”语义的关键字（多语言/常见缩写）
        this.noReplaceTitleKeywords = [
            'no', 'not', 'none', 'skip', 'hold', 'keep',
            '别动', '不替换', '保持', '跳过', '保留'
        ];
 
        // 罕见/不常见/未知类型默认不替换（白名单外的 class_type）
        this.replaceWhitelistClassTypes = new Set(Object.keys(this.nodeTypeMapping));
 
        // 预编译路径缓存：key = `${absPath}::${mtimeMs}`，value = { paths: Array<PathEntry> }
        // PathEntry: { nodeId, classType, inputKey, placeholder }
        this._templatePathCache = new Map();
     }

    /**
     * 将ComfyUI工作流转换为模板
     * @param {Object} workflow - 原始工作流JSON
     * @param {Object} options - 转换选项
     * @returns {Object} 模板化的工作流
     */
    convertToTemplate(workflow, options = {}) {
        const template = JSON.parse(JSON.stringify(workflow)); // 深拷贝
        const metadata = {
            originalNodes: {},
            replacementsMade: [],
            preservedNodes: []
        };

        // 遍历所有节点
        for (const [nodeId, node] of Object.entries(template)) {
            if (!node.class_type) continue;

            const classType = node.class_type;
            
            // 检查是否需要保留原样（通过节点类型）
            if (this.preserveNodes.includes(classType)) {
                metadata.preservedNodes.push({
                    nodeId,
                    classType,
                    title: node._meta?.title || classType,
                    reason: 'preserve_node_type'
                });
                continue;
            }

            // 使用智能处理函数
            this.processNodeIntelligently(template[nodeId], nodeId, metadata);
        }

        // 添加模板元数据
        template._template_metadata = {
            version: '1.0',
            generatedAt: new Date().toISOString(),
            ...metadata
        };

        return template;
    }

    /**
     * 专门处理节点标识的函数
     * 根据节点的 _meta.title 来决定如何处理
     * @param {Object} node - 节点对象
     * @param {string} nodeId - 节点ID
     * @returns {Object|null} 处理指令，null表示不处理
     */
    analyzeNodeTitle(node, nodeId) {
        // 1) 标题判定
        const rawTitle = node._meta && node._meta.title ? String(node._meta.title) : '';
        const title = rawTitle.toLowerCase();

        // 2) 如果标题/名称包含“不替换”语义关键字，则强制跳过
        if (title) {
            const hitNoReplace = this.noReplaceTitleKeywords.some(kw => title.includes(kw));
            if (hitNoReplace) {
                return { action: 'preserve', reason: 'title_no_replace_keyword' };
            }
        }

        // 3) 特殊的提示词处理（优先级高于默认）
        if (title.includes('伪提示词')) {
            return { action: 'replace', target: 'prompt_input', placeholder: '{{PROMPT_INPUT}}' };
        }

        if (title.includes('用户提示')) {
            return { action: 'replace', target: 'user_prompt', placeholder: '{{USER_PROMPT}}' };
        }

        // 4) 明确的替换标识
        if (title.includes('替换') || title.includes('修改节点')) {
            return { action: 'replace', target: 'full' }; // 完整替换
        }

        // 5) 类型+标题组合判断
        if (node.class_type === 'PrimitiveString') {
            if (title.includes('提示词')) {
                return { action: 'replace', target: 'prompt_input', placeholder: '{{PROMPT_INPUT}}' };
            }
        }

        if (node.class_type === 'WeiLinPromptToString') {
            if (title.includes('lora') || title.includes('lora')) {
                return { action: 'preserve', reason: 'lora_handler' }; // LoRA处理节点保持原样
            }
        }

        // 6) 非修改节点
        if (title.includes('非修改节点')) {
            return { action: 'preserve', reason: 'explicit_no_modify' };
        }

        // 7) 默认根据节点类型处理
        return { action: 'default' };
    }

    /**
     * 智能处理节点替换
     * @param {Object} node - 节点对象
     * @param {string} nodeId - 节点ID
     * @param {Object} metadata - 元数据对象
     */
    processNodeIntelligently(node, nodeId, metadata) {
        const analysis = this.analyzeNodeTitle(node, nodeId);

        // 记录分析结果
        metadata.analysisResults = metadata.analysisResults || [];
        metadata.analysisResults.push({
            nodeId,
            classType: node.class_type,
            title: node._meta?.title,
            action: analysis.action,
            reason: analysis.reason
        });

        // 0) 若 class_type 不在白名单映射中（罕见/未知类型），默认不替换
        if (!this.replaceWhitelistClassTypes.has(node.class_type)) {
            metadata.preservedNodes.push({
                nodeId,
                classType: node.class_type,
                title: node._meta?.title || node.class_type,
                reason: 'unknown_class_type_default_preserve'
            });
            return;
        }

        if (analysis.action === 'preserve') {
            // 保持原样
            metadata.preservedNodes.push({
                nodeId,
                classType: node.class_type,
                title: node._meta?.title || node.class_type,
                reason: analysis.reason
            });
            return; // 不做任何修改
        }

        if (analysis.action === 'replace') {
            // 执行特定的替换
            if (analysis.target === 'prompt_input' && node.inputs && 'value' in node.inputs) {
                const originalValue = node.inputs.value;
                node.inputs.value = analysis.placeholder;
                metadata.replacementsMade.push({
                    nodeId,
                    classType: node.class_type,
                    inputKey: 'value',
                    originalValue,
                    replacement: analysis.placeholder,
                    reason: 'title_based_prompt_input'
                });
                return;
            }
        }

        // 默认处理 - 使用原有的节点类型映射
        const classType = node.class_type;
        if (this.nodeTypeMapping[classType]) {
            this.processNodeByType(node, this.nodeTypeMapping[classType], nodeId, metadata);
        }
    }

    /**
     * 按节点类型处理（原有逻辑）
     */
    processNodeByType(node, mapping, nodeId, metadata) {
        if (!node.inputs || !mapping.replacements) return;
        
        metadata.originalNodes[nodeId] = JSON.parse(JSON.stringify(node.inputs));
        
        for (const [inputKey, replacement] of Object.entries(mapping.replacements)) {
            if (node.inputs.hasOwnProperty(inputKey)) {
                const originalValue = node.inputs[inputKey];
                
                if (typeof replacement === 'string') {
                    node.inputs[inputKey] = replacement;
                    metadata.replacementsMade.push({
                        nodeId,
                        classType: node.class_type,
                        inputKey,
                        originalValue,
                        replacement,
                        reason: 'node_type_mapping'
                    });
                } else if (typeof replacement === 'object') {
                    node.inputs[inputKey] = this.processComplexReplacement(originalValue, replacement);
                }
            }
        }
    }

    /**
     * 处理复杂的替换逻辑
     */
    processComplexReplacement(originalValue, replacementRules) {
        // 根据上下文决定使用哪种替换
        // 这里可以扩展更复杂的逻辑
        return replacementRules.positive || replacementRules.default || originalValue;
    }

    /**
     * 使用配置填充模板 - 采用“预编译路径直达替换”，回落到递归替换
     * @param {Object} template - 模板工作流
     * @param {Object} config - 配置对象
     * @param {string} userPrompt - 用户提供的提示词
     * @param {Object} [options]
     * @param {string} [options.templatePath] - 若提供文件路径，将启用 mtime 缓存
     * @returns {Object} 填充后的工作流
     */
    async fillTemplate(template, config, userPrompt = '', options = {}) {
        const workflow = JSON.parse(JSON.stringify(template)); // 深拷贝
 
        // 构建所有占位符的替换映射
        const replacements = this.buildReplacementMap(config, userPrompt);
 
        try {
            // 尝试使用预编译路径
            const compiled = options.templatePath
                ? await this._getOrCreateCompiledPaths(options.templatePath, template)
                : this._precompileTemplatePaths(template);
 
            let appliedCount = 0;
            for (const entry of compiled.paths) {
                const { nodeId, inputKey, placeholder } = entry;
                if (!workflow[nodeId] || !workflow[nodeId].inputs) continue;
                if (!Object.prototype.hasOwnProperty.call(workflow[nodeId].inputs, inputKey)) continue;
 
                // 仅当目标字段当前仍为占位符或字符串包含该占位符时才替换，避免覆盖真实值
                const currentVal = workflow[nodeId].inputs[inputKey];
                const repVal = replacements[placeholder];
                if (typeof repVal === 'undefined') continue;
 
                if (typeof currentVal === 'string') {
                    if (currentVal === placeholder) {
                        workflow[nodeId].inputs[inputKey] = repVal;
                        appliedCount++;
                    } else if (currentVal.includes(placeholder)) {
                        workflow[nodeId].inputs[inputKey] = currentVal.replace(
                            new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'),
                            repVal
                        );
                        appliedCount++;
                    }
                }
            }
 
            // 若一个都没命中，回退到递归替换（兼容旧模板或映射外字段）
            if (appliedCount === 0) {
                this.replaceInObject(workflow, replacements);
            }
        } catch (e) {
            // 任意异常回退到递归替换，保证稳态
            this.replaceInObject(workflow, replacements);
        }
 
        // 移除模板元数据
        delete workflow._template_metadata;
 
        return workflow;
    }

    /**
     * 通过名称/标题快速判断是否“不替换”
     * 命中返回 true
     */
    isNoReplaceByNameOrTitle(node) {
        const rawTitle = node._meta && node._meta.title ? String(node._meta.title) : '';
        const title = rawTitle.toLowerCase();
        if (!title) return false;
        return this.noReplaceTitleKeywords.some(kw => title.includes(kw));
    }

    /**
     * 构建完整的占位符替换映射（与 ComfyUIGen.js 的语义保持一致：SEED 可为 -1，后端运行时再解析为随机）
     * @param {Object} config - 配置对象
     * @param {string} userPrompt - 用户提示词
     * @returns {Object} 替换映射
     */
    buildReplacementMap(config, userPrompt) {
        const replacements = {
            // 基础参数占位符
            '{{MODEL}}': config.defaultModel || 'sd_xl_base_1.0.safetensors',
            '{{WIDTH}}': config.defaultWidth || 1024,
            '{{HEIGHT}}': config.defaultHeight || 1024,
            '{{STEPS}}': config.defaultSteps || 30,
            '{{CFG}}': config.defaultCfg || 7.5,
            '{{SAMPLER}}': config.defaultSampler || 'dpmpp_2m',
            '{{SCHEDULER}}': config.defaultScheduler || 'normal',
            '{{SEED}}': typeof config.defaultSeed === 'number' ? config.defaultSeed : -1,
            '{{DENOISE}}': config.defaultDenoise || 1.0,
            '{{BATCH_SIZE}}': config.defaultBatchSize || 1,
            '{{NEGATIVE_PROMPT}}': config.negativePrompt || '',
            
            // 组合型占位符
            '{{USER_PROMPT}}': userPrompt || '',
            '{{LORAS}}': this.buildLoRAsString(config.loras || []),
            '{{QUALITY_TAGS}}': config.qualityTags || '',
            
            // 自定义占位符
            ...(config.customPlaceholders || {})
        };
        
        // 处理正面提示词模板
        if (config.positivePromptTemplate) {
            const positivePrompt = this.processTemplate(config.positivePromptTemplate, replacements);
            replacements['{{POSITIVE_PROMPT}}'] = positivePrompt;
        } else {
            // 降级到简单拼接
            const parts = [
                replacements['{{USER_PROMPT}}'],
                replacements['{{LORAS}}'],
                replacements['{{QUALITY_TAGS}}']
            ].filter(part => part && part.trim());
            
            replacements['{{POSITIVE_PROMPT}}'] = parts.join(', ');
        }
        
        // 处理独立的提示词输入
        if (config.promptInputTemplate) {
            const promptInput = this.processTemplate(config.promptInputTemplate, replacements);
            replacements['{{PROMPT_INPUT}}'] = promptInput;
        } else {
            // 默认只使用用户提示词
            replacements['{{PROMPT_INPUT}}'] = replacements['{{USER_PROMPT}}'];
        }
        
        return replacements;
    }

    /**
     * 构建LoRA字符串
     * @param {Array} loras - LoRA配置数组
     * @returns {string} LoRA字符串
     */
    buildLoRAsString(loras) {
        if (!Array.isArray(loras)) return '';
        
        return loras
            .filter(lora => lora.enabled && lora.name)
            .map(lora => {
                const strength = lora.strength || 1.0;
                const clipStrength = lora.clipStrength || lora.strength || 1.0;
                return `<lora:${lora.name}:${strength}:${clipStrength}>`;
            })
            .join(', ');
    }

    /**
     * 处理模板字符串中的占位符
     * @param {string} template - 模板字符串
     * @param {Object} replacements - 替换映射
     * @returns {string} 处理后的字符串
     */
    processTemplate(template, replacements) {
        let result = template;
        
        // 替换所有占位符
        for (const [placeholder, value] of Object.entries(replacements)) {
            if (placeholder !== '{{POSITIVE_PROMPT}}') { // 避免循环引用
                const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g');
                result = result.replace(regex, value || '');
            }
        }
        
        // 清理多余的逗号和空格
        result = result
            .split(',')
            .map(part => part.trim())
            .filter(part => part)
            .join(', ');
        
        return result;
    }

    /**
     * 在对象中递归替换占位符
     * @param {Object} obj - 要处理的对象
     * @param {Object} replacements - 替换映射
     */
    replaceInObject(obj, replacements) {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                
                if (typeof value === 'string') {
                    // 替换字符串中的占位符
                    let newValue = value;
                    for (const [placeholder, replacement] of Object.entries(replacements)) {
                        newValue = newValue.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), replacement);
                    }
                    obj[key] = newValue;
                } else if (typeof value === 'object' && value !== null) {
                    // 递归处理对象和数组
                    this.replaceInObject(value, replacements);
                }
            }
        }
    }

    /**
     * 保存模板到文件
     * @param {Object} template - 模板工作流
     * @param {string} templatePath - 保存路径
     */
    async saveTemplate(template, templatePath) {
        try {
            await fs.ensureDir(path.dirname(templatePath));
            await fs.writeJson(templatePath, template, { spaces: 2 });
            console.log(`[WorkflowTemplateProcessor] Template saved to: ${templatePath}`);
            return { success: true };
        } catch (error) {
            console.error(`[WorkflowTemplateProcessor] Failed to save template:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 从文件加载模板
     * @param {string} templatePath - 模板文件路径
     * @returns {Object} 模板工作流
     */
    async loadTemplate(templatePath) {
        try {
            const template = await fs.readJson(templatePath);
            console.log(`[WorkflowTemplateProcessor] Template loaded from: ${templatePath}`);
            return template;
        } catch (error) {
            console.error(`[WorkflowTemplateProcessor] Failed to load template:`, error);
            throw error;
        }
    }

    /**
     * 验证模板的有效性
     * @param {Object} template - 模板工作流
     * @returns {Object} 验证结果
     */
    validateTemplate(template) {
        const errors = [];
        const warnings = [];

        // 检查是否有模板元数据
        if (!template._template_metadata) {
            warnings.push('Template does not have metadata');
        }

        // 检查是否有必要的占位符
        const templateString = JSON.stringify(template);
        const requiredPlaceholders = ['{{MODEL}}', '{{POSITIVE_PROMPT}}'];
        
        for (const placeholder of requiredPlaceholders) {
            if (!templateString.includes(placeholder)) {
                errors.push(`Missing required placeholder: ${placeholder}`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * 获取模板中的所有占位符
     * @param {Object} template - 模板工作流
     * @returns {Array} 占位符列表
     */
    getTemplatePlaceholders(template) {
        const templateString = JSON.stringify(template);
        const placeholderRegex = /\{\{([^}]+)\}\}/g;
        const placeholders = new Set();
        let match;

        while ((match = placeholderRegex.exec(templateString)) !== null) {
            placeholders.add(match[0]);
        }

        return Array.from(placeholders);
    }
}

module.exports = WorkflowTemplateProcessor;