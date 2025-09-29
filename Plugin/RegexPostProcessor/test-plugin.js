// Plugin/RegexPostProcessor/test-plugin.js
// 测试RegexPostProcessor插件的简单脚本

const RegexPostProcessor = require('./regex-post-processor.js');
const fs = require('fs').promises;
const path = require('path');

async function testPlugin() {
    console.log('=== RegexPostProcessor 插件测试 ===\n');

    try {
        // 测试初始化
        console.log('1. 测试插件初始化...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 测试非流式处理
        console.log('2. 测试非流式处理...');
        const testContent = '我是一个AI助手，我可以帮助您解决问题。';
        console.log(`原始内容: "${testContent}"`);

        const processedContent = await RegexPostProcessor.processResponse(testContent, {}, false);
        console.log(`处理后内容: "${processedContent}"`);
        console.log('✓ 非流式处理测试完成\n');

        // 测试流式处理
        console.log('3. 测试流式处理...');
        const streamingContent = '我是一';
        console.log(`流式内容块: "${streamingContent}"`);

        const processedStreamingContent = await RegexPostProcessor.processResponse(streamingContent, {}, true, '我是一');
        console.log(`处理后流式内容: "${processedStreamingContent}"`);
        console.log('✓ 流式处理测试完成\n');

        // 测试插件状态
        console.log('4. 测试插件状态...');
        const status = RegexPostProcessor.getStatus();
        console.log('插件状态:', JSON.stringify(status, null, 2));
        console.log('✓ 状态查询测试完成\n');

        // 测试规则更新
        console.log('5. 测试规则更新...');
        const updateResult = await RegexPostProcessor.updateRules({
            rules: [
                {
                    pattern: '测试',
                    replacement: '验证',
                    flags: 'g',
                    description: '测试规则更新'
                }
            ]
        });
        console.log('规则更新结果:', JSON.stringify(updateResult, null, 2));

        const newProcessedContent = await RegexPostProcessor.processResponse('这是一个测试内容', {}, false);
        console.log(`新规则处理结果: "${newProcessedContent}"`);
        console.log('✓ 规则更新测试完成\n');

        // 测试规则重新加载
        console.log('6. 测试规则重新加载...');
        const reloadResult = await RegexPostProcessor.reloadRules();
        console.log('规则重新加载结果:', JSON.stringify(reloadResult, null, 2));

        // 验证重新加载后的规则是否生效
        const reloadedProcessedContent = await RegexPostProcessor.processResponse('这是一个测试内容', {}, false);
        console.log(`重新加载后处理结果: "${reloadedProcessedContent}"`);
        console.log('✓ 规则重新加载测试完成\n');

        // 测试规则文件内容
        console.log('7. 测试规则文件内容...');
        try {
            const rulesFilePath = path.join(__dirname, 'regex-rules.json');
            const rulesContent = await fs.readFile(rulesFilePath, 'utf-8');
            const rulesData = JSON.parse(rulesContent);
            console.log(`规则文件包含 ${rulesData.rules.length} 条规则`);
            console.log('规则文件内容预览:', JSON.stringify(rulesData, null, 2).substring(0, 200) + '...');
        } catch (error) {
            console.error('读取规则文件失败:', error);
        }
        console.log('✓ 规则文件内容测试完成\n');

        console.log('=== 所有测试完成 ===');
        console.log('RegexPostProcessor插件工作正常！');

    } catch (error) {
        console.error('测试失败:', error);
        process.exit(1);
    }
}

// 运行测试
testPlugin();