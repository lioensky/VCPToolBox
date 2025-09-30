// Plugin/RegexPostProcessor/test-streaming.js
// 测试流式处理功能的脚本

const RegexPostProcessor = require('./regex-post-processor.js');

async function testStreaming() {
    console.log('=== RegexPostProcessor 流式处理测试 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 模拟流式数据块
        console.log('2. 模拟流式数据处理...');
        const streamingChunks = [
            '我',
            '是一',
            '个AI',
            '助手',
            '，我',
            '可以帮助您',
            '解决',
            '问题。'
        ];

        console.log('原始chunks:');
        streamingChunks.forEach((chunk, index) => {
            console.log(`  ${index + 1}: "${chunk}"`);
        });

        // 模拟流式处理过程
        let accumulatedContent = '';
        for (let i = 0; i < streamingChunks.length; i++) {
            const chunk = streamingChunks[i];
            accumulatedContent += chunk;

            console.log(`\n--- 处理chunk ${i + 1}: "${chunk}" ---`);
            console.log(`累积内容: "${accumulatedContent}"`);

            // 模拟流式后处理器调用
            const processedContent = await RegexPostProcessor.processResponse(
                accumulatedContent,
                {},
                true, // isStreaming = true
                accumulatedContent
            );

            if (processedContent !== accumulatedContent) {
                console.log(`✓ 内容被修改: "${accumulatedContent}" -> "${processedContent}"`);
            } else {
                console.log('内容未被修改');
            }
        }

        console.log('\n3. 最终结果验证...');
        const finalContent = streamingChunks.join('');
        console.log(`最终累积内容: "${finalContent}"`);

        const finalProcessedContent = await RegexPostProcessor.processResponse(
            finalContent,
            {},
            false // isStreaming = false
        );

        console.log(`最终处理结果: "${finalProcessedContent}"`);
        console.log('✓ 流式处理测试完成\n');

        // 验证结果
        const expectedResult = '偶是一个人工智能助手，偶可以帮助您解决问题。';
        if (finalProcessedContent === expectedResult) {
            console.log('✅ 流式处理结果与预期一致！');
        } else {
            console.log(`❌ 流式处理结果与预期不一致`);
            console.log(`预期: "${expectedResult}"`);
            console.log(`实际: "${finalProcessedContent}"`);
        }

    } catch (error) {
        console.error('流式处理测试失败:', error);
        process.exit(1);
    }
}

// 新增：测试结构化chunk处理功能
async function testStructuredChunkProcessing() {
    console.log('\n=== 测试结构化chunk处理功能 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 测试TOOL_REQUEST结构过滤
        console.log('2. 测试TOOL_REQUEST结构过滤...');
        const testContentWithToolRequest = `这是一个普通的文本内容。
<<<[TOOL_REQUEST]>>>
tool_name: 「始」SciCalculator「末」,
input: 「始」2 + 2「末」,
precision: 「始」2「末」
<<<[END_TOOL_REQUEST]>>>
这是结构化内容后的普通文本。`;

        console.log('原始内容:');
        console.log(testContentWithToolRequest);
        console.log('\n--- 处理内容 ---');

        const processedContent = await RegexPostProcessor.processResponse(
            testContentWithToolRequest,
            {},
            false // 非流式处理
        );

        console.log('处理后内容:');
        console.log(processedContent);

        if (processedContent.includes('<<<[TOOL_REQUEST]>>>')) {
            console.log('❌ 结构化chunk处理失败，TOOL_REQUEST结构仍存在');
        } else {
            console.log('✅ 结构化chunk处理成功，TOOL_REQUEST结构已被过滤');
        }

        if (processedContent.includes('SciCalculator')) {
            console.log('❌ 结构化chunk处理失败，SciCalculator内容仍存在');
        } else {
            console.log('✅ 结构化chunk处理成功，SciCalculator内容已被过滤');
        }

        const expectedContent = `这是一个普通的文本内容。

这是结构化内容后的普通文本。`;

        if (processedContent.trim() === expectedContent.trim()) {
            console.log('✅ 结构化chunk处理结果与预期完全一致！');
        } else {
            console.log('⚠ 结构化chunk处理结果与预期不完全一致');
            console.log(`预期: "${expectedContent.trim()}"`);
            console.log(`实际: "${processedContent.trim()}"`);
        }

    } catch (error) {
        console.error('结构化chunk处理测试失败:', error);
    }
}

// 新增：测试流式环境下的结构化chunk处理
async function testStreamingStructuredChunk() {
    console.log('\n=== 测试流式环境下的结构化chunk处理 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 模拟TOOL_REQUEST结构作为一个完整chunk（更符合实际情况）
        console.log('2. 模拟TOOL_REQUEST结构作为一个完整chunk...');
        const streamingChunks = [
            '这是前面的普通内容。',
            '<<<[TOOL_REQUEST]>>>\ntool_name: 「始」SciCalculator「末」,\ninput: 「始」2 + 2「末」,\nprecision: 「始」2「末」\n<<<[END_TOOL_REQUEST]>>>\n这是TOOL_REQUEST后的普通内容。'
        ];

        console.log('模拟chunks:');
        streamingChunks.forEach((chunk, index) => {
            console.log(`  ${index + 1}: "${chunk.replace(/\n/g, '\\n')}"`);
        });

        // 模拟流式处理过程
        let processedResults = [];
        for (let i = 0; i < streamingChunks.length; i++) {
            const chunk = streamingChunks[i];
            console.log(`\n--- 处理chunk ${i + 1}: "${chunk.replace(/\n/g, '\\n')}" ---`);

            const result = await RegexPostProcessor.processResponse(
                chunk,
                { minChunkSize: 1, maxChunkSize: 1000, processInterval: 100 },
                true, // isStreaming = true
                chunk
            );

            if (result && result.trim()) {
                processedResults.push(result);
                console.log(`✓ 流式处理结果: "${result.replace(/\n/g, '\\n')}"`);
            } else {
                console.log('⚠ chunk被缓冲或过滤，返回空内容');
            }

            // 强制处理缓冲区中的内容（模拟时间过去）
            if (i === streamingChunks.length - 1) {
                console.log('\n--- 强制处理剩余缓冲区 ---');
                // 使用一个较大的时间间隔来触发缓冲区处理
                const finalResult = await RegexPostProcessor.processResponse(
                    'END_OF_STREAM', // 特殊标记，触发缓冲区处理
                    { minChunkSize: 1, maxChunkSize: 1000, processInterval: 100 },
                    true,
                    'END_OF_STREAM'
                );
                if (finalResult && finalResult.trim()) {
                    processedResults.push(finalResult);
                    console.log(`✓ 缓冲区处理结果: "${finalResult.replace(/\n/g, '\\n')}"`);
                }
            }
        }

        console.log('\n3. 最终验证...');
        console.log(`处理了 ${processedResults.length} 个非空chunk`);
        const finalContent = processedResults.join('');
        console.log(`最终输出内容: "${finalContent}"`);

        if (finalContent.includes('SciCalculator')) {
            console.log('❌ 结构化chunk处理失败，SciCalculator内容仍存在');
        } else {
            console.log('✅ 结构化chunk处理成功，SciCalculator内容已被过滤');
        }

        if (finalContent.includes('<<<[TOOL_REQUEST]>>>')) {
            console.log('❌ 结构化chunk处理失败，TOOL_REQUEST标记仍存在');
        } else {
            console.log('✅ 结构化chunk处理成功，TOOL_REQUEST标记已被过滤');
        }

        if (finalContent.includes('这是普通内容')) {
            console.log('✅ 普通内容正确保留');
        } else {
            console.log('❌ 普通内容丢失');
        }

    } catch (error) {
        console.error('流式结构化chunk处理测试失败:', error);
    }
}

// 新增：测试TOOL_REQUEST过滤的专用测试
async function testToolRequestFiltering() {
    console.log('\n=== 测试TOOL_REQUEST过滤功能 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 测试完整的TOOL_REQUEST结构
        console.log('2. 测试完整TOOL_REQUEST结构过滤...');
        const completeToolRequest = `这是一个测试消息。
<<<[TOOL_REQUEST]>>>
tool_name: 「始」SciCalculator「末」,
expression: 「始」2 + 2 * 3「末」,
precision: 「始」2「末」
<<<[END_TOOL_REQUEST]>>>
这是TOOL_REQUEST后的普通内容。`;

        console.log('原始内容:');
        console.log(completeToolRequest);
        console.log('\n--- 处理内容 ---');

        const processedContent = await RegexPostProcessor.processResponse(
            completeToolRequest,
            {},
            false // 非流式处理
        );

        console.log('处理后内容:');
        console.log(processedContent);

        // 验证TOOL_REQUEST结构已被过滤
        if (processedContent.includes('<<<[TOOL_REQUEST]>>>')) {
            console.log('❌ TOOL_REQUEST开始标记仍存在');
        } else {
            console.log('✅ TOOL_REQUEST开始标记已被过滤');
        }

        if (processedContent.includes('<<<[END_TOOL_REQUEST]>>>')) {
            console.log('❌ TOOL_REQUEST结束标记仍存在');
        } else {
            console.log('✅ TOOL_REQUEST结束标记已被过滤');
        }

        if (processedContent.includes('SciCalculator')) {
            console.log('❌ SciCalculator工具名仍存在');
        } else {
            console.log('✅ SciCalculator工具名已被过滤');
        }

        if (processedContent.includes('2 + 2 * 3')) {
            console.log('❌ 表达式内容仍存在');
        } else {
            console.log('✅ 表达式内容已被过滤');
        }

        // 验证普通内容被保留
        if (processedContent.includes('这是一个测试消息')) {
            console.log('✅ 普通前文内容正确保留');
        } else {
            console.log('❌ 普通前文内容丢失');
        }

        if (processedContent.includes('这是TOOL_REQUEST后的普通内容')) {
            console.log('✅ 普通后文内容正确保留');
        } else {
            console.log('❌ 普通后文内容丢失');
        }

        const expectedContent = `这是一个测试消息。


这是TOOL_REQUEST后的普通内容。`;

        if (processedContent.trim() === expectedContent.trim()) {
            console.log('✅ TOOL_REQUEST过滤结果与预期完全一致！');
        } else {
            console.log('⚠ TOOL_REQUEST过滤结果与预期不完全一致');
            console.log(`预期: "${expectedContent.trim()}"`);
            console.log(`实际: "${processedContent.trim()}"`);
        }

    } catch (error) {
        console.error('TOOL_REQUEST过滤测试失败:', error);
    }
}

// 新增：测试状态机TOOL_REQUEST过滤功能
async function testStateMachineToolRequest() {
    console.log('\n=== 测试状态机TOOL_REQUEST过滤功能 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 测试TOOL_REQUEST跨chunk处理
        console.log('2. 测试TOOL_REQUEST跨chunk处理...');
        const streamingChunks = [
            '这是前面的普通内容。',
            '<<<[TOOL_REQUEST]>>>\n',
            'tool_name: 「始」SciCalculator「末」,\n',
            'expression: 「始」2 + 2 * 3「末」,\n',
            'precision: 「始」2「末」\n',
            '<<<[END_TOOL_REQUEST]>>>\n',
            '这是TOOL_REQUEST后的普通内容。'
        ];

        console.log('模拟chunks:');
        streamingChunks.forEach((chunk, index) => {
            console.log(`  ${index + 1}: "${chunk.replace(/\n/g, '\\n')}"`);
        });

        // 模拟流式处理过程
        let processedResults = [];
        for (let i = 0; i < streamingChunks.length; i++) {
            const chunk = streamingChunks[i];
            console.log(`\n--- 处理chunk ${i + 1}: "${chunk.replace(/\n/g, '\\n')}" ---`);

            const result = await RegexPostProcessor.processResponse(
                chunk,
                { minChunkSize: 1, maxChunkSize: 1000, processInterval: 100 },
                true, // isStreaming = true
                chunk
            );

            if (result !== null && result !== undefined && result.trim() !== '') {
                processedResults.push(result);
                console.log(`✓ 流式处理结果: "${result.replace(/\n/g, '\\n')}"`);
            } else {
                console.log('⚠ chunk被状态机处理，返回空内容');
            }
        }

        console.log('\n3. 最终验证...');
        console.log(`处理了 ${processedResults.length} 个非空chunk`);
        const finalContent = processedResults.join('');
        console.log(`最终输出内容: "${finalContent}"`);

        // 验证TOOL_REQUEST结构已被过滤
        if (finalContent.includes('SciCalculator')) {
            console.log('❌ 状态机处理失败，SciCalculator内容仍存在');
        } else {
            console.log('✅ 状态机处理成功，SciCalculator内容已被过滤');
        }

        if (finalContent.includes('<<<[TOOL_REQUEST]>>>')) {
            console.log('❌ 状态机处理失败，TOOL_REQUEST开始标记仍存在');
        } else {
            console.log('✅ 状态机处理成功，TOOL_REQUEST开始标记已被过滤');
        }

        if (finalContent.includes('<<<[END_TOOL_REQUEST]>>>')) {
            console.log('❌ 状态机处理失败，TOOL_REQUEST结束标记仍存在');
        } else {
            console.log('✅ 状态机处理成功，TOOL_REQUEST结束标记已被过滤');
        }

        // 验证普通内容被保留
        if (finalContent.includes('这是前面的普通内容')) {
            console.log('✅ 普通前文内容正确保留');
        } else {
            console.log('❌ 普通前文内容丢失');
        }

        if (finalContent.includes('这是TOOL_REQUEST后的普通内容')) {
            console.log('✅ 普通后文内容正确保留');
        } else {
            console.log('❌ 普通后文内容丢失');
        }

        const expectedContent = '这是前面的普通内容。这是TOOL_REQUEST后的普通内容。';

        if (finalContent.trim() === expectedContent.trim()) {
            console.log('✅ 状态机TOOL_REQUEST过滤结果与预期完全一致！');
        } else {
            console.log('⚠ 状态机TOOL_REQUEST过滤结果与预期不完全一致');
            console.log(`预期: "${expectedContent.trim()}"`);
            console.log(`实际: "${finalContent.trim()}"`);
        }

    } catch (error) {
        console.error('状态机TOOL_REQUEST过滤测试失败:', error);
    }
}

// 新增：测试普通正则规则功能
async function testRegularRegexRules() {
    console.log('\n=== 测试普通正则规则功能 ===\n');

    try {
        // 初始化插件
        console.log('1. 初始化插件...');
        await RegexPostProcessor.initialize({
            RulesFilePath: 'regex-rules.json'
        });
        console.log('✓ 插件初始化成功\n');

        // 测试普通正则规则在流式处理中的应用
        console.log('2. 测试普通正则规则在流式处理中的应用...');
        const streamingChunks = [
            '我',
            '是一',
            '个AI',
            '助手，',
            '我',
            '可以帮助您',
            '解决',
            '问题。'
        ];

        console.log('模拟chunks:');
        streamingChunks.forEach((chunk, index) => {
            console.log(`  ${index + 1}: "${chunk}"`);
        });

        // 模拟流式处理过程
        let processedResults = [];
        for (let i = 0; i < streamingChunks.length; i++) {
            const chunk = streamingChunks[i];
            console.log(`\n--- 处理chunk ${i + 1}: "${chunk}" ---`);

            const result = await RegexPostProcessor.processResponse(
                chunk,
                { minChunkSize: 1, maxChunkSize: 1000, processInterval: 100 },
                true, // isStreaming = true
                chunk
            );

            if (result !== null && result !== undefined && result.trim() !== '') {
                processedResults.push(result);
                console.log(`✓ 流式处理结果: "${result}"`);
            } else {
                console.log('⚠ chunk被缓冲或过滤，返回空内容');
            }
        }

        console.log('\n3. 最终验证...');
        console.log(`处理了 ${processedResults.length} 个非空chunk`);
        const finalContent = processedResults.join('');
        console.log(`最终输出内容: "${finalContent}"`);

        // 验证普通正则规则是否被应用
        if (finalContent.includes('example')) {
            console.log('✅ 示例正则规则被正确应用');
        } else {
            console.log('❌ 示例正则规则未被应用');
        }

        if (finalContent.includes('人工智能')) {
            console.log('✅ 普通正则规则"AI"->"人工智能"被正确应用');
        } else {
            console.log('❌ 普通正则规则"AI"->"人工智能"未被应用');
        }

        if (finalContent.includes('VCP')) {
            console.log('❌ 普通正则规则"VCP"->"Variable & Command Protocol"未被应用');
        } else {
            console.log('✅ 普通正则规则"VCP"->"Variable & Command Protocol"被正确应用');
        }

        const expectedContent = '偶是一偶是一个人工智能偶是一个人工智能助手，偶偶是一个人工智能助手，偶可以帮助您偶是一个人工智能助手，偶可以帮助您解决偶是一个人工智能助手，偶可以帮助您解决问题。';

        if (finalContent.trim() === expectedContent.trim()) {
            console.log('✅ 普通正则规则功能完全正常！');
        } else {
            console.log('⚠ 普通正则规则功能与预期不完全一致');
            console.log(`预期: "${expectedContent.trim()}"`);
            console.log(`实际: "${finalContent.trim()}"`);
        }

    } catch (error) {
        console.error('普通正则规则测试失败:', error);
    }
}

// 运行测试
async function runAllTests() {
    await testStreaming();
    await testStructuredChunkProcessing();
    await testStreamingStructuredChunk();
    await testToolRequestFiltering();
    await testStateMachineToolRequest();
    await testRegularRegexRules();
}

runAllTests();