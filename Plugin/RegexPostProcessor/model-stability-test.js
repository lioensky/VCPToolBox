// Plugin/RegexPostProcessor/model-stability-test.js
// 模型稳定性测试脚本 - 专门测试不同模型速率下的稳定性差异

const RegexPostProcessor = require('./regex-post-processor.js');

class ModelStabilityTester {
    constructor() {
        this.processor = RegexPostProcessor;
        this.testResults = [];
    }

    async initialize() {
        await this.processor.initialize({
            DebugMode: true,
            ChunkBufferSize: 100,
            ProcessInterval: 100
        });
    }

    // 模拟不同模型的chunk输出特征
    async testModelCharacteristics() {
        console.log('🤖 测试不同模型的chunk输出特征...\n');

        const modelProfiles = [
            {
                name: 'Gemini Pro (快速响应)',
                chunkInterval: 50,    // 快速模型
                chunkSize: 80,        // 中等chunk大小
                variability: 0.2,     // 低变异性
                description: '快速响应，中等chunk，稳定输出'
            },
            {
                name: 'Gemini Flash (高速响应)',
                chunkInterval: 30,    // 高速模型
                chunkSize: 120,       // 大chunk
                variability: 0.1,     // 极低变异性
                description: '高速响应，大chunk，非常稳定'
            },
            {
                name: 'Claude (中等速率)',
                chunkInterval: 100,   // 中等速率
                chunkSize: 60,        // 小chunk
                variability: 0.3,     // 中等变异性
                description: '中等速率，小chunk，中等稳定性'
            },
            {
                name: 'GPT-4 (慢速思考)',
                chunkInterval: 200,   // 慢速模型
                chunkSize: 40,        // 小chunk
                variability: 0.4,     // 高变异性
                description: '慢速响应，小chunk，高变异性'
            }
        ];

        for (const profile of modelProfiles) {
            console.log(`📊 测试模型: ${profile.name}`);
            console.log(`   ${profile.description}`);
            await this.testModelProfile(profile);
            console.log('');
        }

        this.printModelComparison();
    }

    async testModelProfile(profile) {
        const { chunkInterval, chunkSize, variability } = profile;

        // 生成模拟的TOOL_REQUEST响应
        const baseContent = `<<<[TOOL_REQUEST]>>>
tool_name: 「始」SciCalculator「末」,
expression: 「始」243 * 76545「末」
<<<[END_TOOL_REQUEST]>>>`;

        // 分割成多个chunks，模拟模型输出
        const chunks = [];
        let remainingContent = baseContent;

        while (remainingContent.length > 0) {
            // 根据模型特征计算chunk大小（加入变异性）
            const sizeVariation = (Math.random() - 0.5) * 2 * variability * chunkSize;
            const actualChunkSize = Math.max(10, Math.min(chunkSize + sizeVariation, remainingContent.length));

            const chunk = remainingContent.substring(0, actualChunkSize);
            chunks.push(chunk);
            remainingContent = remainingContent.substring(actualChunkSize);
        }

        console.log(`   原始内容长度: ${baseContent.length}`);
        console.log(`   分割成 ${chunks.length} 个chunks`);
        console.log(`   平均chunk大小: ${Math.round(baseContent.length / chunks.length)}`);

        // 模拟模型速率进行处理
        let finalResult = '';
        let processedChunks = 0;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // 模拟模型间隔
            if (i > 0) {
                await this.delay(chunkInterval + (Math.random() - 0.5) * variability * chunkInterval);
            }

            try {
                const result = await this.processor.processStreamingChunk(chunk);
                if (result) {
                    finalResult += result;
                }
                processedChunks++;
                console.log(`   ✓ 处理chunk ${i + 1}/${chunks.length} (大小: ${chunk.length})`);
            } catch (error) {
                console.log(`   ✗ Chunk ${i + 1}/${chunks.length} 处理失败: ${error.message}`);
            }
        }

        // 分析结果
        const hasToolRequest = finalResult.includes('TOOL_REQUEST');
        const hasPartialContent = finalResult.includes('SciCalculator') && !finalResult.includes('END_TOOL_REQUEST');

        console.log(`   最终结果长度: ${finalResult.length}`);
        console.log(`   包含TOOL_REQUEST: ${hasToolRequest}`);
        console.log(`   包含部分内容: ${hasPartialContent}`);

        if (!hasToolRequest && !hasPartialContent) {
            console.log(`   ✅ 过滤完全成功`);
            this.testResults.push({ profile: profile.name, success: true, finalLength: finalResult.length });
        } else {
            console.log(`   ❌ 过滤不完全`);
            this.testResults.push({ profile: profile.name, success: false, hasToolRequest, hasPartialContent, finalLength: finalResult.length });
        }
    }

    // 测试极端情况
    async testExtremeScenarios() {
        console.log('⚡ 测试极端场景...\n');

        const extremeCases = [
            {
                name: '超快速模型',
                chunkInterval: 10,
                chunkCount: 50,
                description: '极短间隔，大量小chunk'
            },
            {
                name: '超慢速模型',
                chunkInterval: 1000,
                chunkCount: 5,
                description: '超长间隔，少量大chunk'
            },
            {
                name: '高度不稳定模型',
                chunkInterval: 100,
                variability: 0.8,
                description: '高变异性，chunk大小和间隔变化很大'
            }
        ];

        for (const extremeCase of extremeCases) {
            console.log(`📋 极端场景: ${extremeCase.name}`);
            console.log(`   ${extremeCase.description}`);

            await this.testExtremeScenario(extremeCase);
        }
    }

    async testExtremeScenario(extremeCase) {
        const { chunkInterval, chunkCount, variability = 0.3 } = extremeCase;

        // 生成测试内容
        const testContent = '<<<[TOOL_REQUEST]>>>tool_name: 「始」TestTool「末」<<<[END_TOOL_REQUEST]>>>';

        // 分割成指定数量的chunks
        const chunkSize = Math.max(5, Math.floor(testContent.length / chunkCount));
        const chunks = [];

        for (let i = 0; i < testContent.length; i += chunkSize) {
            const size = chunkSize + (Math.random() - 0.5) * variability * chunkSize;
            const actualSize = Math.max(1, Math.min(size, testContent.length - i));
            chunks.push(testContent.substring(i, i + actualSize));
        }

        console.log(`   生成 ${chunks.length} 个chunks，平均大小: ${Math.round(testContent.length / chunks.length)}`);

        let finalResult = '';

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // 模拟极端间隔
            if (i > 0) {
                const actualInterval = chunkInterval + (Math.random() - 0.5) * variability * chunkInterval;
                await this.delay(actualInterval);
            }

            try {
                const result = await this.processor.processStreamingChunk(chunk);
                if (result) {
                    finalResult += result;
                }
                console.log(`   ✓ 处理chunk ${i + 1}/${chunks.length}`);
            } catch (error) {
                console.log(`   ✗ Chunk ${i + 1} 处理失败`);
            }
        }

        const success = !finalResult.includes('TOOL_REQUEST') && !finalResult.includes('TestTool');
        console.log(`   过滤成功: ${success}`);
        console.log(`   最终长度: ${finalResult.length}`);

        this.testResults.push({
            scenario: extremeCase.name,
            success,
            finalLength: finalResult.length
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    printModelComparison() {
        console.log('📊 模型稳定性对比:');
        console.log('='.repeat(60));

        const modelResults = this.testResults.filter(r => r.profile);
        const successCount = modelResults.filter(r => r.success).length;
        const totalCount = modelResults.length;

        console.log(`模型测试通过率: ${successCount}/${totalCount} (${((successCount / totalCount) * 100).toFixed(1)}%)`);

        // 按成功率排序
        const sortedResults = modelResults.sort((a, b) => {
            if (a.success && !b.success) return -1;
            if (!a.success && b.success) return 1;
            return a.finalLength - b.finalLength;
        });

        console.log('\n模型稳定性排名:');
        sortedResults.forEach((result, index) => {
            const status = result.success ? '✅' : '❌';
            console.log(`${index + 1}. ${result.profile} ${status} (长度: ${result.finalLength})`);
        });

        // 分析稳定性特征
        const successfulModels = modelResults.filter(r => r.success);
        const failedModels = modelResults.filter(r => !r.success);

        if (successfulModels.length > 0) {
            console.log(`\n✅ 稳定模型特征:`);
            successfulModels.forEach(model => {
                console.log(`   - ${model.profile}: 输出长度 ${model.finalLength}`);
            });
        }

        if (failedModels.length > 0) {
            console.log(`\n❌ 需要优化的模型:`);
            failedModels.forEach(model => {
                console.log(`   - ${model.profile}: 可能存在边界处理问题`);
            });
        }
    }

    async runAllTests() {
        await this.initialize();
        await this.testModelCharacteristics();
        await this.testExtremeScenarios();
        await this.processor.shutdown();

        console.log('\n🏁 模型稳定性测试完成');
    }
}

// 如果直接运行此脚本，则执行测试
if (require.main === module) {
    const tester = new ModelStabilityTester();
    tester.runAllTests().catch(console.error);
}

module.exports = ModelStabilityTester;