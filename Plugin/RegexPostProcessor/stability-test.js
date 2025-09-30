// Plugin/RegexPostProcessor/stability-test.js
// 稳定性测试脚本 - 测试不同模型速率下的chunk处理稳定性

const RegexPostProcessor = require('./regex-post-processor.js');

class StabilityTester {
    constructor() {
        this.processor = new RegexPostProcessor();
        this.testResults = [];
    }

    async initialize() {
        await this.processor.initialize({
            DebugMode: true,
            ChunkBufferSize: 100,
            ProcessInterval: 100
        });
    }

    // 测试不同速率的chunk流
    async testDifferentRates() {
        console.log('🚀 开始稳定性测试...\n');

        const testCases = [
            { name: '快速模型 (50ms间隔)', interval: 50, chunks: 20 },
            { name: '中等速率 (100ms间隔)', interval: 100, chunks: 20 },
            { name: '慢速模型 (200ms间隔)', interval: 200, chunks: 20 },
            { name: '极慢模型 (500ms间隔)', interval: 500, chunks: 20 }
        ];

        for (const testCase of testCases) {
            console.log(`📊 测试场景: ${testCase.name}`);
            await this.testRateScenario(testCase);
            console.log(''); // 空行分隔
        }

        this.printSummary();
    }

    async testRateScenario(testCase) {
        const { interval, chunks } = testCase;
        const startTime = Date.now();

        // 模拟TOOL_REQUEST块
        const toolRequestContent = `<<<[TOOL_REQUEST]>>>
tool_name:「始」TestTool「末」,
expression:「始」这是一个测试表达式「末」
<<<[END_TOOL_REQUEST]>>>`;

        // 分割成多个chunk来模拟流式传输
        const chunkSize = Math.ceil(toolRequestContent.length / chunks);
        const testChunks = [];

        for (let i = 0; i < toolRequestContent.length; i += chunkSize) {
            testChunks.push(toolRequestContent.slice(i, i + chunkSize));
        }

        console.log(`  总内容长度: ${toolRequestContent.length}`);
        console.log(`  分割成 ${testChunks.length} 个chunk`);
        console.log(`  平均chunk大小: ${Math.round(toolRequestContent.length / testChunks.length)}`);

        // 异步处理所有chunks，模拟不同速率
        const processingPromises = testChunks.map(async (chunk, index) => {
            await this.delay(interval * index); // 模拟不同速率的chunk到达

            try {
                const result = await this.processor.processStreamingChunk(chunk);
                console.log(`  ✓ Chunk ${index + 1}/${testChunks.length} processed successfully`);
                return { success: true, chunkIndex: index, result };
            } catch (error) {
                console.log(`  ✗ Chunk ${index + 1}/${testChunks.length} failed: ${error.message}`);
                return { success: false, chunkIndex: index, error: error.message };
            }
        });

        const results = await Promise.all(processingPromises);
        const endTime = Date.now();

        const successCount = results.filter(r => r.success).length;
        const successRate = (successCount / results.length) * 100;

        this.testResults.push({
            scenario: testCase.name,
            interval,
            chunks: testChunks.length,
            successCount,
            successRate,
            duration: endTime - startTime
        });

        console.log(`  ✅ 完成: ${successCount}/${results.length} chunks成功 (${successRate.toFixed(1)}%)`);
        console.log(`  ⏱️ 耗时: ${endTime - startTime}ms`);
    }

    // 测试并发处理稳定性
    async testConcurrentProcessing() {
        console.log('🔄 测试并发处理稳定性...');

        const concurrentTasks = 5;
        const chunksPerTask = 10;
        const startTime = Date.now();

        // 创建多个并发任务
        const tasks = Array.from({ length: concurrentTasks }, async (_, taskIndex) => {
            const taskResults = [];

            for (let i = 0; i < chunksPerTask; i++) {
                const chunk = `<<<[TOOL_REQUEST]>>>task${taskIndex}_chunk${i}<<<[END_TOOL_REQUEST]>>>`;

                try {
                    const result = await this.processor.processStreamingChunk(chunk);
                    taskResults.push({ success: true, chunkIndex: i });
                } catch (error) {
                    taskResults.push({ success: false, chunkIndex: i, error: error.message });
                }
            }

            return taskResults;
        });

        const allResults = await Promise.all(tasks);
        const endTime = Date.now();

        const totalChunks = concurrentTasks * chunksPerTask;
        const successCount = allResults.flat().filter(r => r.success).length;
        const successRate = (successCount / totalChunks) * 100;

        console.log(`  并发任务数: ${concurrentTasks}`);
        console.log(`  总chunk数: ${totalChunks}`);
        console.log(`  成功率: ${successCount}/${totalChunks} (${successRate.toFixed(1)}%)`);
        console.log(`  ⏱️ 耗时: ${endTime - startTime}ms`);

        this.testResults.push({
            scenario: '并发处理测试',
            concurrentTasks,
            totalChunks,
            successCount,
            successRate,
            duration: endTime - startTime
        });
    }

    // 测试边界情况
    async testEdgeCases() {
        console.log('⚡ 测试边界情况...');

        const edgeCases = [
            { name: '空chunk', content: '' },
            { name: 'null chunk', content: null },
            { name: 'undefined chunk', content: undefined },
            { name: '只包含开始标记', content: '<<<[TOOL_REQUEST]>>>' },
            { name: '只包含结束标记', content: '<<<[END_TOOL_REQUEST]>>>' },
            { name: '嵌套标记', content: '<<<[TOOL_REQUEST]>>>inner<<<[TOOL_REQUEST]>>>nested<<<[END_TOOL_REQUEST]>>><<<[END_TOOL_REQUEST]>>>' },
            { name: '超长内容', content: '<<<[TOOL_REQUEST]>>>' + 'x'.repeat(20000) + '<<<[END_TOOL_REQUEST]>>>' }
        ];

        for (const edgeCase of edgeCases) {
            try {
                console.log(`  测试: ${edgeCase.name}`);
                const result = await this.processor.processStreamingChunk(edgeCase.content);
                console.log(`    ✓ 处理成功`);
            } catch (error) {
                console.log(`    ✗ 处理失败: ${error.message}`);
            }
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    printSummary() {
        console.log('📋 测试总结:');
        console.log('='.repeat(50));

        this.testResults.forEach((result, index) => {
            console.log(`${index + 1}. ${result.scenario}:`);
            console.log(`   成功率: ${result.successRate.toFixed(1)}%`);
            console.log(`   耗时: ${result.duration}ms`);
            console.log('');
        });

        const avgSuccessRate = this.testResults.reduce((sum, r) => sum + r.successRate, 0) / this.testResults.length;
        console.log(`平均成功率: ${avgSuccessRate.toFixed(1)}%`);

        if (avgSuccessRate >= 95) {
            console.log('🎉 稳定性测试通过！');
        } else {
            console.log('⚠️ 稳定性测试发现问题，需要进一步优化。');
        }
    }

    async runAllTests() {
        await this.initialize();
        await this.testDifferentRates();
        await this.testConcurrentProcessing();
        await this.testEdgeCases();
        await this.processor.shutdown();
    }
}

// 如果直接运行此脚本，则执行测试
if (require.main === module) {
    const tester = new StabilityTester();
    tester.runAllTests().catch(console.error);
}

module.exports = StabilityTester;