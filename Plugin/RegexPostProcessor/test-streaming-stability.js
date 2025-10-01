// 测试流式处理稳定性的脚本
// 用于验证修复后的RegexPostProcessor在不同模型速率下的稳定性

const fs = require('fs').promises;
const path = require('path');

async function testStreamingStability() {
    console.log('🧪 开始测试RegexPostProcessor流式处理稳定性...\n');

    try {
        // 动态导入RegexPostProcessor
        const RegexPostProcessor = require('./regex-post-processor.js');

        // 初始化插件
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });

        console.log('✅ RegexPostProcessor初始化成功');

        // 测试场景1：模拟快速模型（小chunk，高频率）
        console.log('\n📊 测试场景1：快速模型（小chunk，高频率）');
        await testFastModelScenario(RegexPostProcessor);

        // 测试场景2：模拟慢速模型（大chunk，低频率）
        console.log('\n📊 测试场景2：慢速模型（大chunk，低频率）');
        await testSlowModelScenario(RegexPostProcessor);

        // 测试场景3：模拟同步插件调用场景
        console.log('\n📊 测试场景3：同步插件调用场景');
        await testSyncPluginScenario(RegexPostProcessor);

        // 测试场景4：模拟边界情况（空chunk、特殊字符等）
        console.log('\n📊 测试场景4：边界情况处理');
        await testEdgeCases(RegexPostProcessor);

        console.log('\n🎉 所有测试完成！');

        // 显示最终状态
        const status = RegexPostProcessor.getStatus();
        console.log('\n📈 最终状态统计：');
        console.log(`- 处理队列长度: ${status.queueState.processingQueueLength}`);
        console.log(`- 平均chunk大小: ${status.adaptiveMetrics.averageChunkSize}`);
        console.log(`- 自适应chunk阈值: ${status.adaptiveMetrics.adaptiveChunkThreshold}`);
        console.log(`- 当前状态机状态: ${status.streamingState}`);

    } catch (error) {
        console.error('❌ 测试过程中出错:', error);
    }
}

// 测试快速模型场景
async function testFastModelScenario(processor) {
    const chunks = [
        '这是一',
        '个快速模',
        '型的测试',
        '<<<[TOOL_REQUEST]>>>\n',
        'tool_name:『始』SciCalculator『末』,\n',
        'expression:『始』2+2『末』\n',
        '<<<[END_TOOL_REQUEST]>>>\n',
        '计算结',
        '果是4'
    ];

    console.log(`  模拟${chunks.length}个快速chunk...`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            const result = await processor.processStreamingChunk(chunk);
            console.log(`  ✓ Chunk ${i + 1}: ${chunk.length} chars -> ${result.length} chars`);

            // 模拟小延迟
            await new Promise(resolve => setTimeout(resolve, 10));
        } catch (error) {
            console.error(`  ✗ Chunk ${i + 1}处理失败:`, error.message);
        }
    }
}

// 测试慢速模型场景
async function testSlowModelScenario(processor) {
    const chunks = [
        '这是一个慢速模型的测试，chunk较大，发送频率较低。',
        '<<<[TOOL_REQUEST]>>>\n',
        'tool_name:『始』SciCalculator『末』,\n',
        'expression:『始』integral(\'x^2\', 0, 1)『末』\n',
        '<<<[END_TOOL_REQUEST]>>>\n',
        '这是一个很长的chunk，用于测试慢速模型的处理能力，包含复杂的数学表达式和详细的计算过程。'
    ];

    console.log(`  模拟${chunks.length}个慢速chunk...`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            const result = await processor.processStreamingChunk(chunk);
            console.log(`  ✓ Chunk ${i + 1}: ${chunk.length} chars -> ${result.length} chars`);

            // 模拟大延迟
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`  ✗ Chunk ${i + 1}处理失败:`, error.message);
        }
    }
}

// 测试同步插件调用场景
async function testSyncPluginScenario(processor) {
    console.log('  模拟同步插件调用场景...');

    // 首先发送一些普通内容
    const normalChunks = [
        '用户请求计算数学表达式。',
        '系统正在准备调用科学计算器。',
        '<<<[TOOL_REQUEST]>>>\n',
        'tool_name:『始』SciCalculator『末』,\n',
        'expression:『始』sqrt(16)『末』\n',
        '<<<[END_TOOL_REQUEST]>>>\n'
    ];

    for (const chunk of normalChunks) {
        await processor.processStreamingChunk(chunk);
    }

    // 模拟同步插件调用开始
    console.log('  🔄 模拟同步插件调用开始...');
    await processor.onSyncPluginStart();

    // 同步插件调用期间的chunks应该被正确保留
    const syncChunks = [
        '计算正在进行中...',
        '请稍候，'
    ];

    for (const chunk of syncChunks) {
        const result = await processor.processStreamingChunk(chunk);
        console.log(`  ✓ Sync chunk: "${chunk}" -> "${result}"`);
    }

    // 模拟同步插件调用完成
    console.log('  ✅ 模拟同步插件调用完成...');
    await processor.onSyncPluginComplete();
}

// 测试边界情况
async function testEdgeCases(processor) {
    const edgeCases = [
        '', // 空chunk
        '   ', // 空白chunk
        '<<<[TOOL_REQUEST]>>>', // 不完整的开始标记
        '<<<[END_TOOL_REQUEST]>>>', // 不完整的结束标记
        '特殊字符：!@#$%^&*()_+-=[]{}|;\':",./<>?', // 特殊字符
        '多字节字符：中文、日本語、한국어、🚀🌟💻', // 多字节字符
        '<<<[TOOL_REQUEST]>>>\nmalformed_content\n<<<[END_TOOL_REQUEST]>>>\n', // 格式错误的结构化块
    ];

    console.log(`  测试${edgeCases.length}种边界情况...`);

    for (let i = 0; i < edgeCases.length; i++) {
        const chunk = edgeCases[i];
        try {
            const result = await processor.processStreamingChunk(chunk);
            console.log(`  ✓ Edge case ${i + 1}: "${chunk.substring(0, 20)}..." -> ${result.length} chars`);
        } catch (error) {
            console.error(`  ✗ Edge case ${i + 1}处理失败:`, error.message);
        }
    }
}

// 如果直接运行此脚本，则执行测试
if (require.main === module) {
    testStreamingStability().catch(console.error);
}

module.exports = { testStreamingStability };