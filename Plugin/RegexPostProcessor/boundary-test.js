// Plugin/RegexPostProcessor/boundary-test.js
// 边界处理测试脚本 - 专门测试chunk前边界和完整过滤问题

const RegexPostProcessor = require('./regex-post-processor.js');

class BoundaryTester {
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

    // 测试前边界保护
    async testFrontBoundaryProtection() {
        console.log('🔍 测试前边界保护...');

        const testCases = [
            {
                name: '开始标记在chunk中间',
                chunks: [
                    '这是一个很长',
                    '的文本内容，<<<[STRUCTURED_BLOCK]>>>',
                    'block_type: 「始」TestBlock「末」,',
                    'content: 「始」测试内容「末」',
                    '<<<[END_STRUCTURED_BLOCK]>>>',
                    '这是结束后的内容。'
                ],
                expectedFiltered: '这是一个很长的文本内容，这是结束后的内容。',
                description: '确保开始标记前的内容不会被切掉'
            },
            {
                name: '开始标记在chunk开头',
                chunks: [
                    '<<<[STRUCTURED_BLOCK]>>>',
                    'block_type: 「始」TestBlock「末」,',
                    'content: 「始」测试内容「末」',
                    '<<<[END_STRUCTURED_BLOCK]>>>',
                    '这是结束后的内容。'
                ],
                expectedFiltered: '这是结束后的内容。',
                description: '确保开始标记在开头时正确处理'
            },
            {
                name: '跨chunk的完整结构',
                chunks: [
                    '前面的内容，<<<[STRUCTURED_BLOCK]',
                    '>>>block_type: 「始」TestBlock「末」',
                    ',content: 「始」测试内容「末」',
                    '<<<[END_STRUCTURED_BLOCK]>>>后',
                    '面的内容。'
                ],
                expectedFiltered: '前面的内容，后面的内容。',
                description: '测试跨chunk的完整结构过滤'
            }
        ];

        for (const testCase of testCases) {
            console.log(`\n📋 测试案例: ${testCase.name}`);
            console.log(`   描述: ${testCase.description}`);

            let finalResult = '';

            for (let i = 0; i < testCase.chunks.length; i++) {
                const chunk = testCase.chunks[i];
                console.log(`   处理chunk ${i + 1}/${testCase.chunks.length}: "${chunk.substring(0, 30)}${chunk.length > 30 ? '...' : ''}"`);

                try {
                    const result = await this.processor.processStreamingChunk(chunk);
                    if (result) {
                        finalResult += result;
                        console.log(`   ✓ 输出: "${result.substring(0, 30)}${result.length > 30 ? '...' : ''}"`);
                    } else {
                        console.log(`   - 无输出（被过滤）`);
                    }
                } catch (error) {
                    console.log(`   ✗ 错误: ${error.message}`);
                }
            }

            console.log(`   最终结果: "${finalResult}"`);
            console.log(`   预期结果: "${testCase.expectedFiltered}"`);

            if (finalResult.trim() === testCase.expectedFiltered.trim()) {
                console.log(`   ✅ 测试通过！`);
                this.testResults.push({ name: testCase.name, passed: true });
            } else {
                console.log(`   ❌ 测试失败！`);
                this.testResults.push({ name: testCase.name, passed: false, actual: finalResult, expected: testCase.expectedFiltered });
            }
        }
    }

    // 测试完整过滤功能
    async testCompleteFiltering() {
        console.log('\n🎯 测试完整过滤功能...');

        const testCases = [
            {
                name: '简单完整结构',
                content: '<<<[STRUCTURED_BLOCK]>>>block_type: 「始」Test「末」<<<[END_STRUCTURED_BLOCK]>>>',
                shouldBeEmpty: true
            },
            {
                name: '带参数的完整结构',
                content: '<<<[STRUCTURED_BLOCK]>>>block_type: 「始」TestBlock「末」,content: 「始」测试内容「末」<<<[END_STRUCTURED_BLOCK]>>>',
                shouldBeEmpty: true
            },
            {
                name: '混合内容中的完整结构',
                content: '前文<<<[STRUCTURED_BLOCK]>>>block_type: 「始」Test「末」<<<[END_STRUCTURED_BLOCK]>>>后文',
                expected: '前文后文'
            }
        ];

        for (const testCase of testCases) {
            console.log(`\n📋 测试案例: ${testCase.name}`);

            try {
                const result = await this.processor.processStreamingChunk(testCase.content);

                if (testCase.shouldBeEmpty) {
                    if (result === '' || result === null) {
                        console.log(`   ✅ 正确过滤为空`);
                        this.testResults.push({ name: testCase.name, passed: true });
                    } else {
                        console.log(`   ❌ 应该过滤为空，但得到: "${result}"`);
                        this.testResults.push({ name: testCase.name, passed: false });
                    }
                } else {
                    if (result === testCase.expected) {
                        console.log(`   ✅ 过滤结果正确: "${result}"`);
                        this.testResults.push({ name: testCase.name, passed: true });
                    } else {
                        console.log(`   ❌ 过滤结果错误，期望: "${testCase.expected}"，实际: "${result}"`);
                        this.testResults.push({ name: testCase.name, passed: false });
                    }
                }
            } catch (error) {
                console.log(`   ✗ 错误: ${error.message}`);
                this.testResults.push({ name: testCase.name, passed: false, error: error.message });
            }
        }
    }

    // 测试跨chunk场景
    async testCrossChunkScenarios() {
        console.log('\n🌉 测试跨chunk场景...');

        const scenarios = [
            {
                name: '开始标记和结束标记在不同chunk',
                chunks: [
                    '前文<<<[STRUCTURED_BLOCK]>>>block_type: 「始」Test「末」',
                    ',content: 「始」测试内容「末」<<<[END_STRUCTURED_BLOCK]>>>后文'
                ],
                expected: '前文后文'
            },
            {
                name: '多个结构化块',
                chunks: [
                    '前文<<<[STRUCTURED_BLOCK]>>>block_type: 「始」Test1「末」<<<[END_STRUCTURED_BLOCK]>>>中',
                    '间<<<[STRUCTURED_BLOCK]>>>block_type: 「始」Test2「末」<<<[END_STRUCTURED_BLOCK]>>>后文'
                ],
                expected: '前文中后文'
            }
        ];

        for (const scenario of scenarios) {
            console.log(`\n📋 测试场景: ${scenario.name}`);

            let finalResult = '';

            for (let i = 0; i < scenario.chunks.length; i++) {
                const chunk = scenario.chunks[i];
                console.log(`   处理chunk ${i + 1}: "${chunk.substring(0, 40)}${chunk.length > 40 ? '...' : ''}"`);

                const result = await this.processor.processStreamingChunk(chunk);
                if (result) {
                    finalResult += result;
                    console.log(`   ✓ 输出: "${result.substring(0, 40)}${result.length > 40 ? '...' : ''}"`);
                } else {
                    console.log(`   - 无输出`);
                }
            }

            if (finalResult.trim() === scenario.expected.trim()) {
                console.log(`   ✅ 测试通过！`);
                this.testResults.push({ name: scenario.name, passed: true });
            } else {
                console.log(`   ❌ 测试失败！期望: "${scenario.expected}"，实际: "${finalResult}"`);
                this.testResults.push({ name: scenario.name, passed: false });
            }
        }
    }

    printSummary() {
        console.log('\n📊 测试总结:');
        console.log('='.repeat(50));

        const passedTests = this.testResults.filter(r => r.passed).length;
        const totalTests = this.testResults.length;
        const successRate = (passedTests / totalTests) * 100;

        console.log(`通过测试: ${passedTests}/${totalTests} (${successRate.toFixed(1)}%)`);

        if (successRate >= 90) {
            console.log('🎉 边界处理测试基本通过！');
        } else {
            console.log('⚠️ 边界处理测试发现问题，需要进一步优化。');

            // 显示失败的测试详情
            const failedTests = this.testResults.filter(r => !r.passed);
            console.log('\n失败的测试:');
            failedTests.forEach(test => {
                console.log(`❌ ${test.name}`);
                if (test.actual !== undefined) {
                    console.log(`   期望: "${test.expected}"`);
                    console.log(`   实际: "${test.actual}"`);
                }
                if (test.error) {
                    console.log(`   错误: ${test.error}`);
                }
            });
        }
    }

    async runAllTests() {
        await this.initialize();
        await this.testFrontBoundaryProtection();
        await this.testCompleteFiltering();
        await this.testCrossChunkScenarios();
        await this.processor.shutdown();
        this.printSummary();
    }
}

// 如果直接运行此脚本，则执行测试
if (require.main === module) {
    const tester = new BoundaryTester();
    tester.runAllTests().catch(console.error);
}

module.exports = BoundaryTester;