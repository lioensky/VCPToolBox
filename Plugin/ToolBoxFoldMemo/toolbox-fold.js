const fs = require('fs');
const path = require('path');

// 默认的配置文件路径，放在 TVStxt 目录下方便手机端编辑
const TVSTXT_DIR = process.env.TVSTXT_DIR_PATH || path.resolve(__dirname, '../../TVStxt');
const DOC_PATH = path.resolve(TVSTXT_DIR, 'MemoToolBox.txt');
// 匹配分隔符的正则表达式，支持新旧两种语法：
// [===vcp_fold:0.5===]
// [===vcp_fold:0.5::desc:记忆回顾===]
const FOLD_REGEX = /^\[===vcp_fold:\s*([0-9.]+)(?:\s*::desc:\s*(.*?)\s*)?===\]\s*$/;

function main() {
    let content = '';
    try {
        content = fs.readFileSync(DOC_PATH, 'utf-8');
    } catch (error) {
        // 如果文件不存在或读取失败，输出一个友好的默认折叠块
        const fallback = {
            vcp_dynamic_fold: true,
            dynamic_fold_strategy: "toolbox_block_similarity",
            plugin_description: "工具箱收纳折叠管理器，用于根据上下文动态展开或折叠 VCP 工具文档。",
            fold_blocks: [
                {
                    threshold: 0.0,
                    description: '',
                    content: `[ToolBoxFold] 无法读取配置文件 \`MemoToolBox.txt\`。请在 VCPToolBox/TVStxt 目录创建该文件。错误信息: ${error.message}`
                }
            ]
        };
        console.log(JSON.stringify(fallback, null, 2));
        process.exit(0);
    }

    // 解析文件内容
    const foldBlocks = [];
    let currentThreshold = 0.0; // 默认基础层的阈值为 0.0
    let currentDescription = '';
    let currentContent = [];
    let hasOpenedFoldBlock = false;

    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(FOLD_REGEX);
        if (match) {
            if (hasOpenedFoldBlock || currentContent.length > 0) {
                foldBlocks.push({
                    threshold: currentThreshold,
                    description: currentDescription,
                    content: currentContent.join('\n').trim()
                });
            }
            currentThreshold = parseFloat(match[1]);
            if (isNaN(currentThreshold)) currentThreshold = 0.0;
            currentDescription = typeof match[2] === 'string' ? match[2].trim() : '';
            currentContent = [];
            hasOpenedFoldBlock = true;
        } else {
            currentContent.push(line);
        }
    }

    if (hasOpenedFoldBlock || currentContent.length > 0) {
        foldBlocks.push({
            threshold: currentThreshold,
            description: currentDescription,
            content: currentContent.join('\n').trim()
        });
    }

    if (foldBlocks.length === 0) {
        foldBlocks.push({ threshold: 0.0, description: '', content: "配置文件中未找到有效内容。" });
    }

    const output = {
        vcp_dynamic_fold: true,
        dynamic_fold_strategy: "toolbox_block_similarity",
        plugin_description: "VCP 工具箱收纳折叠管理器。内部由用户配置的不同类型的工具按照重要程度分级收纳。当上下文聊到相关话题时，将动态展开隐藏的长尾工具列表。",
        fold_blocks: foldBlocks
    };

    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
}

main();
