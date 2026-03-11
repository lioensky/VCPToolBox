const fs = require('fs');
const path = require('path');

// 默认的配置文件路径，放在 TVStxt 目录下方便手机端编辑
const DOC_PATH = path.resolve(__dirname, '../../TVStxt/MemoToolBox.txt');
// 匹配分隔符的正则表达式，支持任意阈值，例如 [===vcp_fold:0.5===]
const FOLD_REGEX = /^\[===vcp_fold:\s*([0-9.]+)\s*===\]\s*$/m;

function main() {
    let content = '';
    try {
        content = fs.readFileSync(DOC_PATH, 'utf-8');
    } catch (error) {
        // 如果文件不存在或读取失败，输出一个友好的默认折叠块
        const fallback = {
            vcp_dynamic_fold: true,
            plugin_description: "工具箱收纳折叠管理器，用于根据上下文动态展开或折叠 VCP 工具文档。",
            fold_blocks: [
                {
                    threshold: 0.0,
                    content: `[ToolBoxFold] 无法读取配置文件 \`MemoToolBox.txt\`。请在 VCPToolBox/TVStxt 目录创建该文件。错误信息: ${error.message}`
                }
            ]
        };
        console.log(JSON.stringify(fallback, null, 2));
        process.exit(0);
    }

    // 解析文件内容
    const blocks = [];
    let currentThreshold = 0.0; // 默认基础层的阈值为 0.0
    let currentContent = [];

    const lines = content.split('\n');
    for (const line of lines) {
        const match = line.match(FOLD_REGEX);
        if (match) {
            // 遇到新的分隔符，保存上一段内容
            if (currentContent.length > 0 || currentThreshold === 0.0) {
                blocks.push({
                    threshold: currentThreshold,
                    content: currentContent.join('\n').trim()
                });
            }
            // 开始新的一段
            currentThreshold = parseFloat(match[1]);
            if (isNaN(currentThreshold)) currentThreshold = 0.0;
            currentContent = [];
        } else {
            currentContent.push(line);
        }
    }
    // 保存最后一段内容
    if (currentContent.length > 0) {
        blocks.push({
            threshold: currentThreshold,
            content: currentContent.join('\n').trim()
        });
    }

    // 收集所有出现过的独特阈值，并按降序排列 (例如: 0.8, 0.5, 0.0)
    const uniqueThresholds = [...new Set(blocks.map(b => b.threshold))].sort((a, b) => b - a);

    // 如果没有任何块，提供默认兜底
    if (uniqueThresholds.length === 0) {
        uniqueThresholds.push(0.0);
        blocks.push({ threshold: 0.0, content: "配置文件中未找到有效内容。" });
    }

    const foldBlocks = [];

    // 为每个阈值构建展开内容
    // 规则：在阈值 T 展开时，包含所有声明阈值 <= T 的块。
    for (let i = 0; i < uniqueThresholds.length; i++) {
        const t = uniqueThresholds[i];

        // 提取所有应该包含在这个阈值级别下的块
        const includedBlocks = blocks.filter(b => b.threshold <= t);
        // 算出未被包含在当前层级的块的数量（也就是被折叠收纳的块）
        const hiddenBlocksCount = blocks.filter(b => b.threshold > t).length;

        let combinedContent = includedBlocks.map(b => b.content).filter(c => c).join('\n\n---\n\n');

        // 如果当前级别不是最高级别（即还有块被折叠），则在末尾添加提示
        if (hiddenBlocksCount > 0) {
            combinedContent += `\n\n*(提示：当前上下文中还隐藏收纳了另外 ${hiddenBlocksCount} 个工具模块分组，您可以通过明确提问或强调相关语境来获得展开。)*`;
        }

        foldBlocks.push({
            threshold: t,
            content: combinedContent
        });
    }

    const output = {
        vcp_dynamic_fold: true,
        plugin_description: "VCP 工具箱收纳折叠管理器。内部由用户配置的不同类型的工具按照重要程度分级收纳。当上下文聊到相关话题时，将动态展开隐藏的长尾工具列表。",
        fold_blocks: foldBlocks
    };

    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
}

main();
