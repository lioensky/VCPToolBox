import { apiFetch, showMessage } from './utils.js';

let originalParams = null;

// 参数元数据定义：包含中文名、物理意义、调优逻辑和建议区间
const PARAM_METADATA = {
    "ContextFoldingV2": {
        "thresholdBase": {
            "name": "折叠阈值基准",
            "meaning": "上下文语义折叠V2的相似度判定基准线。相似度低于此值的远距离AI输出会被折叠为摘要。",
            "logic": "调高（如0.60）：更激进地折叠，只有高度相关的内容才保留原文；调低（如0.40）：更保守，大部分内容保留原文。",
            "range": "建议区间: 0.35 ~ 0.65"
        },
        "thresholdRange": {
            "name": "折叠阈值动态范围",
            "meaning": "阈值受逻辑深度(L)和语义宽度(S)调节后的上下限范围。",
            "logic": "下限越低越保守（语义宽泛时保留更多）；上限越高越激进（逻辑聚焦时折叠更多）。",
            "range": "建议区间: [0.30, 0.70]"
        },
        "lWeight": {
            "name": "逻辑深度(L)系数",
            "meaning": "逻辑深度对阈值的调节力度。L高表示对话逻辑聚焦，阈值会升高以更激进地折叠无关内容。",
            "logic": "调高：L对阈值的影响更大，聚焦对话时折叠更激进；调低：L影响减弱，对话焦点变化不会显著改变折叠行为。",
            "range": "建议区间: 0.02 ~ 0.15"
        },
        "sWeight": {
            "name": "语义宽度(S)系数",
            "meaning": "语义宽度对阈值的调节力度。S高表示对话语义宽泛，阈值会降低以保守保留更多上下文。",
            "logic": "调高：S对阈值的影响更大，宽泛对话时折叠更保守；调低：S影响减弱，语义宽度变化不会显著改变折叠行为。",
            "range": "建议区间: 0.02 ~ 0.15"
        }
    },
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
        },
        "timeDecay": {
            "name": "时间衰减控制",
            "meaning": "实现“近因效应”，让越久的记忆权重衰减越快。",
            "logic": "halfLifeDays (半衰期)：记忆分数减半的天数。支持精准衰减：::TimeDecay[天数]/[最小分数]/[目标Tags]，仅包含目标标签的内容（如Box）才会衰减，其余（如Wiki）保持原分。",
            "range": "建议区间: 半衰期 15~90 天；最小分数 0.5。此处仅作为全局回退值。"
        },
        "mainSearchWeights": {
            "name": "主搜索权重分配",
            "meaning": "决定了主对话搜索时，用户输入和 AI 意图在最终向量中的占比。",
            "logic": "第一个值是用户权重，第二个是 AI 权重。调高用户权重会让检索更贴合当前问题；调高 AI 权重则更贴合 AI 的上下文意图。",
            "range": "建议区间: [0.7, 0.3] 或 [0.8, 0.2]"
        },
        "refreshWeights": {
            "name": "流内刷新权重分配",
            "meaning": "工具调用刷新日记区块时，用户、AI 和工具结果的占比。",
            "logic": "依次为 [用户, AI, 工具]。调高工具权重会让刷新内容更贴合刚执行完的任务结果。",
            "range": "建议区间: [0.5, 0.35, 0.15]"
        },
        "metaThinkingWeights": {
            "name": "元思考递归权重",
            "meaning": "元思考链推理时，原始查询与上一轮推理结果的融合比例。",
            "logic": "第一个值是原始查询权重，第二个是推理结果权重。调高推理结果权重会增强递归深度，但可能导致语义漂移。",
            "range": "建议区间: [0.8, 0.2]"
        }
    },
    "KnowledgeBaseManager": {
        "geodesicRerank": {
            "name": "测地线重排 (V8)",
            "meaning": "复用 Spike 距离场对 KNN 候选做基于 Tag 地形的二次重排。通过 ::TagMemo+ 修饰符激活。",
            "logic": "V8 核心引擎，让被语义山峰挡住的相关记忆通过 Tag 拓扑关联浮出。三层防御链保证最坏情况=无改动。",
            "range": "包含 2 个子参数，见下方详细说明。"
        },
        "geodesicRerank.alpha": {
            "name": "测地线混合权重 (α)",
            "meaning": "测地线分数在最终排序中的占比。0=纯KNN余弦距离，1=纯测地线Tag地形距离。",
            "logic": "调高：更信任 Tag 拓扑关联，被语义山峰遮挡的记忆更容易浮出；调低：更保守，主要依赖原始向量相似度。",
            "range": "建议区间: 0.1 ~ 0.5 (默认 0.3)"
        },
        "geodesicRerank.minGeoSamples": {
            "name": "最小采样密度门槛",
            "meaning": "一个 chunk 在距离场上至少需要命中多少个 Tag 才有资格参与测地线评估。低于此值退化为纯 KNN。",
            "logic": "调高：更严格，只有 Tag 密度高的 chunk 才会被测地线影响；调低：更宽松，但可能因采样不足导致估计不可靠。莱恩建议 4 作为基准。",
            "range": "建议区间: 2 ~ 8 (整数，默认 4)"
        },
        "activationMultiplier": {
            "name": "金字塔激活增益",
            "meaning": "决定了残差金字塔发现的“新颖特征”对最终权重的贡献度。",
            "logic": "缩放值调高：对对话中的“新信息”反应更剧烈，检索结果迅速转向新出现的关键词；缩放值调低：算法更迟钝，倾向于维持长期语义重心。",
            "range": "建议区间: 基础值 0.2~0.8；缩放值 1.0~2.5"
        },
        "spikeRouting": {
            "name": "虫洞脉冲路由 (V7)",
            "meaning": "控制认知拓扑网络中电信号传播的路径、动量和虫洞触发。",
            "logic": "V7 核心引擎，负责处理节点动量衰减与穿透。",
            "range": "包含 8 个子参数，见下方详细说明。"
        },
        "spikeRouting.maxSafeHops": {
            "name": "最高安全跳数",
            "meaning": "限制网络中任何一条脉冲路径绝对能够行进的最大边数，作为防止图环路死循环的最终安全阀。",
            "logic": "设得过低（如 1 或 2）会截断虫洞的长距穿透；设得过高但在 baseMomentum 用尽前也是无害的，但如果触发了连续虫洞，可能会导致算力消耗。",
            "range": "建议区间: 3 ~ 6 (整数)"
        },
        "spikeRouting.maxEmergentNodes": {
            "name": "极值截断节点数",
            "meaning": "在经历了所有脉冲扩散后，最终允许“涌现”并重新注入召回阶段的无搜索源标签上限（防止污染搜索空间）。",
            "logic": "按聚合能量排序后的 Top K 截断。调大增加多样性，调小增加纯净度。",
            "range": "建议区间: 10 ~ 100 (默认 50)"
        },
        "spikeRouting.maxNeighborsPerNode": {
            "name": "最大突触扇出",
            "meaning": "任何节点向下放电时，最多向关联最紧密的 N 个邻居传播。",
            "logic": "决定了网络的“宽度”与“发散规模”。调大找得多但杂点多且慢。",
            "range": "建议区间: 10 ~ 40 (默认 20)"
        },
        "spikeRouting.baseMomentum": {
            "name": "初始起跳动量 (TTL)",
            "meaning": "查询命中原始种子标签时赋予的传播点数 (Time-to-Live)。",
            "logic": "常规传播每次扣除 1.0 点动量。设为 2.0 意味着稠密区只能传两步。如果你希望它只能传一步就枯竭，设置 1.0。虫洞跳跃不扣除该点数。",
            "range": "建议区间: 1.0 ~ 5.0"
        },
        "spikeRouting.tensionThreshold": {
            "name": "触发虫洞张力阈值",
            "meaning": "张力 = 边权 (coocWeight) * 目标节点的残差 (neighborResidual)。当目标节点新颖度极高时达到该阈值。",
            "logic": "这个参数最关键。调高(>1.5)会导致极难触发跨域跳跃，算法变成乖宝宝；调低(<0.6)会导致遍地都是虫洞，系统过度脑补、疯狂漂移发散。",
            "range": "建议区间: 0.5 ~ 3.0 (高风险参数)"
        },
        "spikeRouting.firingThreshold": {
            "name": "底层放电阈值",
            "meaning": "节点能够向下传递电波所需的最低内部能量门槛。",
            "logic": "防止末端极其微弱的信号继续占用算力做无意义衍生。",
            "range": "建议区间: 0.05 ~ 0.20"
        },
        "spikeRouting.baseDecay": {
            "name": "常规稠密区衰减",
            "meaning": "在相同话题的同质化集群内传播时，能量的折损倍率（保留比例）。",
            "logic": "数值越小衰减越快（0.25指剩下25%）。为了压制稠密区的无限回声，必须设得很低（< 0.4）。代表“剥削 (Exploitation)”。",
            "range": "建议区间: 0.10 ~ 0.40"
        },
        "spikeRouting.wormholeDecay": {
            "name": "特权虫洞区衰减",
            "meaning": "脉冲刺透语义屏障进入高新颖度、高残差节点时采取的衰减策略（保留比例）。",
            "logic": "数值设定应明显高于 baseDecay。让这股冲破稠密陷阱的脉冲保留大部分能量。代表“探索 (Exploration)”。",
            "range": "建议区间: 0.60 ~ 0.90"
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
            let metaKey = key;
            if (groupName === 'KnowledgeBaseManager' && typeof value === 'object' && value !== null && key !== 'languageCompensator') {
                // 原有的嵌套逻辑保持，但对于 spikeRouting 内部的渲染已经在 handleSave 等逻辑中处理
                // 这里我们要修改的是 renderParams 循环内部对 subKey 的元数据关联
            }

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
                subGroup.className = 'param-nested-group-grid';
                
                for (const [subKey, subVal] of Object.entries(value)) {
                    const subMetaKey = `${key}.${subKey}`;
                    const subMeta = PARAM_METADATA[groupName]?.[subMetaKey] || { name: subKey };
                    
                    // 智能推断步长与范围
                    let min = 0, max = 100, step = 1;
                    const subKeyLower = subKey.toLowerCase();
                    if (subKeyLower === 'alpha') {
                        min = 0; max = 1; step = 0.01; // 🌟 V8: 测地线混合权重
                    } else if (subKeyLower.includes('samples')) {
                        min = 1; max = 20; step = 1; // 🌟 V8: 最小采样密度门槛
                    } else if (subKeyLower.includes('decay') || subKeyLower.includes('threshold')) {
                        min = 0; max = subKey.includes('tension') ? 5 : 1; step = 0.01;
                    } else if (subKeyLower.includes('hops') || subKeyLower.includes('nodes') || subKeyLower.includes('neighbors')) {
                        min = 1; max = subKey.includes('nodes') ? 200 : 20; step = 1;
                    } else if (subKeyLower.includes('momentum')) {
                        min = 1; max = 10; step = 0.1;
                    } else if (subKeyLower.includes('penalty') || subKeyLower.includes('score') || subKeyLower.includes('min')) {
                        // 🛠️ 修复：语言补偿器和时间衰减的浮点参数
                        min = 0; max = 1; step = 0.01;
                    } else if (subKeyLower.includes('half') || subKeyLower.includes('days')) {
                        // 🛠️ 修复：半衰期等天数参数
                        min = 1; max = 365; step = 1;
                    } else if (typeof subVal === 'number' && !Number.isInteger(subVal)) {
                        // 🛠️ 修复：兜底逻辑 — 如果值本身是浮点数，自动使用小数步长
                        step = 0.01;
                        max = Math.max(10, Math.ceil(subVal * 20));
                    }

                    const subItem = document.createElement('div');
                    subItem.className = 'sub-param-card';
                    subItem.innerHTML = `
                        <div class="sub-param-header">
                            <span class="sub-param-name">${subKey}</span>
                            <span class="sub-param-label">${subMeta.name}</span>
                            ${subMeta.meaning ? `<div class="sub-param-help" title="${subMeta.meaning}\n\n建议区间：${subMeta.range || 'N/A'}">
                                <span class="material-symbols-outlined">help_outline</span>
                            </div>` : ''}
                        </div>
                        <div class="sub-param-controls">
                            <input type="range" class="sub-range-slider" min="${min}" max="${max}" step="${step}" value="${subVal}">
                            <input type="number" class="sub-number-input" step="${step}" value="${subVal}"
                                   data-group="${groupName}" data-key="${key}" data-subkey="${subKey}">
                        </div>
                    `;

                    // 双向绑定逻辑
                    const slider = subItem.querySelector('.sub-range-slider');
                    const numberInput = subItem.querySelector('.sub-number-input');
                    
                    slider.addEventListener('input', (e) => {
                        numberInput.value = e.target.value;
                    });
                    numberInput.addEventListener('input', (e) => {
                        slider.value = e.target.value;
                    });

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
        // 跳过没有 data-group 的 input（如范围滑块 sub-range-slider）
        if (!group || !key) return;
        const val = parseFloat(input.value);
        if (isNaN(val)) return;
        
        if (subkey) {
            if (newParams[group] && newParams[group][key]) {
                newParams[group][key][subkey] = val;
            }
        } else if (index !== undefined) {
            if (newParams[group] && Array.isArray(newParams[group][key])) {
                newParams[group][key][parseInt(index)] = val;
            }
        } else {
            if (newParams[group]) {
                newParams[group][key] = val;
            }
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