import { apiFetch, showMessage } from './utils.js';

let originalParams = null;

// 参数元数据定义：包含中文名、物理意义、调优逻辑和建议区间
const PARAM_METADATA = {
    "RAGDiaryPlugin": {
        "noise_penalty": {
            "name": "语义宽度惩罚",
            "meaning": "抵消“语义宽度 (S)”带来的噪音。当用户说话非常发散时，该值决定了我们要多大程度上抑制标签增强。",
            "logic": "调高：算法会变得非常“挑剔”，只有语义非常聚焦时才会触发强增强；调低：算法更宽容，即使对话发散也会尝试寻找关联。",
            "range": "建议区间: 0.01 ~ 0.20"
        },
        "tagWeightRange": {
            "name": "标签权重映射区间",
            "meaning": "决定了“标签语义”在最终检索向量中占据的最大能量比例。",
            "logic": "上限调高：检索结果极度向标签靠拢，感应准确时惊艳，偏差时跑题；上限调低：检索更稳健，更依赖原始文本向量。",
            "range": "建议区间: 下限 0.01~0.10；上限 0.30~0.60"
        },
        "tagTruncationBase": {
            "name": "标签截断基准",
            "meaning": "在感应阶段，保留前百分之多少的标签。",
            "logic": "调高：保留更多长尾标签，增加召回多样性但可能引入噪音；调低：极度精简，只保留核心标签，检索精度最高。",
            "range": "建议区间: 0.4 ~ 0.8"
        },
        "tagTruncationRange": {
            "name": "标签截断动态范围",
            "meaning": "标签截断的上下限范围。",
            "logic": "用于控制标签截断的动态调整空间。",
            "range": "建议区间: 0.5 ~ 0.9"
        }
    },
    "KnowledgeBaseManager": {
        "activationMultiplier": {
            "name": "金字塔激活增益",
            "meaning": "决定了残差金字塔发现的“新颖特征”对最终权重的贡献度。",
            "logic": "缩放值调高：对对话中的“新信息”反应更剧烈，检索结果迅速转向新出现的关键词；缩放值调低：算法更迟钝，倾向于维持长期语义重心。",
            "range": "建议区间: 基础值 0.2~0.8；缩放值 1.0~2.5"
        },
        "dynamicBoostRange": {
            "name": "动态增强修正",
            "meaning": "后端根据 EPA（逻辑深度/共振）分析结果，对前端传入权重的二次修正。",
            "logic": "上限调高：在逻辑严密或产生强烈共振时，允许标签权重突破天际；下限调低：在对话逻辑混乱时，几乎完全关闭标签增强。",
            "range": "建议区间: 下限 0.1~0.5；上限 1.5~3.0"
        },
        "coreBoostRange": {
            "name": "核心标签聚光灯",
            "meaning": "对用户手动指定的 coreTags 的额外能量加权。",
            "logic": "调高：给予手动标签“特权”，检索结果强行向该标签对齐；调低：手动标签仅作为参考，不破坏整体语义平衡。",
            "range": "建议区间: 1.10 ~ 2.00"
        },
        "deduplicationThreshold": {
            "name": "语义去重阈值",
            "meaning": "两个标签之间余弦相似度超过多少时合并。",
            "logic": "调高：几乎不去重，保留所有细微差别的词，标签云会很拥挤；调低：强力去重，语义接近的词会被大量合并，标签云更清爽。",
            "range": "建议区间: 0.80 ~ 0.95"
        },
        "techTagThreshold": {
            "name": "技术噪音门槛",
            "meaning": "英文/技术词汇在非技术语境下的生存门槛。",
            "logic": "调高：强力过滤，对话中偶尔出现的代码片段、文件名等不会干扰 RAG；调低：允许更多技术词汇参与检索。",
            "range": "建议区间: 0.02 ~ 0.20"
        },
        "normalTagThreshold": {
            "name": "普通标签门槛",
            "meaning": "普通词汇参与 RAG 增强的最低激活阈值。",
            "logic": "用于过滤低相关性的普通词汇。",
            "range": "建议区间: 0.01 ~ 0.05"
        },
        "languageCompensator": {
            "name": "语言补偿器",
            "meaning": "针对跨语言或领域不匹配时的惩罚系数，主要用于抑制非技术语境下的技术词汇噪音。",
            "logic": "值越小惩罚越重。penaltyUnknown 用于无法识别语境时；penaltyCrossDomain 用于语境明确但与标签领域冲突时。",
            "range": "建议区间: 0.01 ~ 0.50 (默认 0.05/0.10)"
        }
    }
};

/**
 * 初始化 RAG 调参页面
 */
export async function initializeRAGTuning() {
    const form = document.getElementById('rag-params-form');
    const contentArea = document.getElementById('rag-params-content');
    const resetBtn = document.getElementById('reset-rag-params');

    if (!form || !contentArea) return;

    // 加载参数
    await loadParams(contentArea);

    // 绑定事件
    form.onsubmit = handleSave;
    resetBtn.onclick = () => loadParams(contentArea);
}

/**
 * 从后端加载参数
 */
async function loadParams(container) {
    try {
        container.innerHTML = '<p class="loading-msg">正在加载参数...</p>';
        const params = await apiFetch('/admin_api/rag-params');
        originalParams = params;
        renderParams(container, params);
    } catch (error) {
        container.innerHTML = `<p class="error-message">加载参数失败: ${error.message}</p>`;
    }
}

/**
 * 渲染参数表单
 */
function renderParams(container, params) {
    container.innerHTML = '';
    
    for (const [groupName, groupParams] of Object.entries(params)) {
        const groupEl = document.createElement('div');
        groupEl.className = 'param-group';
        groupEl.innerHTML = `<h3><span class="material-symbols-outlined">settings_input_component</span> ${groupName}</h3>`;
        
        const gridContainer = document.createElement('div');
        gridContainer.className = 'param-grid-container';
        groupEl.appendChild(gridContainer);

        for (const [key, value] of Object.entries(groupParams)) {
            const meta = PARAM_METADATA[groupName]?.[key] || { name: key };
            const itemEl = document.createElement('div');
            itemEl.className = 'param-item';
            
            const labelRow = document.createElement('div');
            labelRow.className = 'param-label-row';
            labelRow.innerHTML = `
                <label for="param-${groupName}-${key}">${key}</label>
                <span class="param-chinese-name">${meta.name}</span>
            `;
            
            const infoBox = document.createElement('div');
            infoBox.className = 'param-info-box';
            infoBox.innerHTML = `
                ${meta.meaning ? `<div class="param-meaning">${meta.meaning}</div>` : ''}
                ${meta.logic ? `<div class="param-logic">${meta.logic}</div>` : ''}
                ${meta.range ? `<div class="param-range-hint">${meta.range}</div>` : ''}
            `;

            const inputRow = document.createElement('div');
            inputRow.className = 'param-input-row';
            
            if (Array.isArray(value)) {
                const rangeContainer = document.createElement('div');
                rangeContainer.className = 'param-range-inputs';
                value.forEach((val, index) => {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = '0.001';
                    input.value = val;
                    input.dataset.group = groupName;
                    input.dataset.key = key;
                    input.dataset.index = index;
                    rangeContainer.appendChild(input);
                });
                inputRow.appendChild(rangeContainer);
            } else if (typeof value === 'object' && value !== null) {
                const subGroup = document.createElement('div');
                subGroup.className = 'param-nested-group';
                
                for (const [subKey, subVal] of Object.entries(value)) {
                    const subItem = document.createElement('div');
                    subItem.className = 'sub-param-item';
                    subItem.innerHTML = `
                        <label>${subKey}</label>
                        <input type="number" step="0.001" value="${subVal}"
                               data-group="${groupName}" data-key="${key}" data-subkey="${subKey}">
                    `;
                    subGroup.appendChild(subItem);
                }
                inputRow.appendChild(subGroup);
            } else {
                const input = document.createElement('input');
                input.type = 'number';
                input.step = '0.001';
                input.id = `param-${groupName}-${key}`;
                input.value = value;
                input.dataset.group = groupName;
                input.dataset.key = key;
                inputRow.appendChild(input);
            }
            
            itemEl.appendChild(labelRow);
            itemEl.appendChild(infoBox);
            itemEl.appendChild(inputRow);
            gridContainer.appendChild(itemEl);
        }
        
        container.appendChild(groupEl);
    }
}

/**
 * 处理保存
 */
async function handleSave(event) {
    event.preventDefault();
    const form = event.target;
    const statusEl = document.getElementById('rag-params-status');
    
    const newParams = JSON.parse(JSON.stringify(originalParams));
    
    const inputs = form.querySelectorAll('input');
    inputs.forEach(input => {
        const { group, key, subkey, index } = input.dataset;
        const val = parseFloat(input.value);
        
        if (subkey) {
            newParams[group][key][subkey] = val;
        } else if (index !== undefined) {
            newParams[group][key][parseInt(index)] = val;
        } else {
            newParams[group][key] = val;
        }
    });
    
    try {
        statusEl.textContent = '正在保存...';
        await apiFetch('/admin_api/rag-params', {
            method: 'POST',
            body: JSON.stringify(newParams)
        });
        originalParams = newParams;
        showMessage('RAG 参数已成功保存！', 'success');
        statusEl.textContent = '';
    } catch (error) {
        showMessage(`保存失败: ${error.message}`, 'error');
        statusEl.textContent = '';
    }
}