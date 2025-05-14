const fs = require('fs').promises;
const path = require('path');

async function processDailyNotes(inputContent) {
    // Use PROJECT_BASE_PATH environment variable set by Plugin.js
    const projectBasePath = process.env.PROJECT_BASE_PATH;
    if (!projectBasePath) {
        console.error('PROJECT_BASE_PATH environment variable is not set.');
        return { status: 'error', error: '无法确定项目主目录。' };
    }
    const outputDir = path.join(projectBasePath, 'dailynote', '已整理日记');
    const results = []; // Define results here

    try {
        // Ensure the output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // 添加调试输出，显示接收到的内容
        console.error(`[Debug] 收到的日记内容前100个字符: ${inputContent.substring(0, 100)}...`);

        const lines = inputContent.split('\n');
        let currentFilename = null;
        let currentContentLines = [];

        // Helper function to save the current note
        const saveCurrentNote = async () => {
            if (currentFilename && currentContentLines.length > 0) {
                const filename = currentFilename.trim();
                // Join lines and trim leading/trailing whitespace, but keep internal line breaks
                const content = currentContentLines.join('\n').trim();

                // 添加调试输出，显示即将保存的日记信息
                console.error(`[Debug] 准备保存日记: 文件名=${filename}, 内容长度=${content.length}`);

                if (!filename.toLowerCase().endsWith('.txt') || content.length === 0) {
                     results.push({ status: 'warning', filename: filename || '未知', message: `无效的日记条目格式或内容为空。跳过保存。` });
                     console.error(`无效的日记条目格式或内容为空。文件名: ${filename}, 内容长度: ${content.length}`);
                     return; // Skip saving if invalid
                }

                const filePath = path.join(outputDir, filename);

                try {
                    await fs.writeFile(filePath, content, 'utf-8');
                    results.push({ status: 'success', filename: filename, message: `成功保存日记: ${filename}` });
                    console.error(`成功保存日记: ${filename}`);
                } catch (writeError) {
                    results.push({ status: 'error', filename: filename, message: `保存日记失败: ${filename} - ${writeError.message}` });
                    console.error(`保存日记失败: ${filename}`, writeError);
                }
            }
        };

        // Iterate through lines to find diary entries
        for (const line of lines) {
            const trimmedLine = line.trim();
            // Check if the line matches the filename pattern (YYYY.MM.DD.txt or YYYY.MM.DD.N.txt)
            const filenameMatch = trimmedLine.match(/^(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)\.txt$/);

            if (filenameMatch) {
                // Found a new filename line, save the previous note if any
                await saveCurrentNote();

                // Start a new note
                currentFilename = trimmedLine;
                currentContentLines = []; // Reset content lines for the new note
                console.error(`[Debug] 检测到新的日记文件标记: ${currentFilename}`);
            } else if (currentFilename !== null) {
                // If we are currently collecting content for a note, add the line
                currentContentLines.push(line);
            }
            // If currentFilename is null and the line is not a filename, ignore it (e.g., leading empty lines)
        }

        // Save the last note after the loop finishes
        await saveCurrentNote();

         // Check if any notes were processed
         if (results.length === 0) {
             results.push({ status: 'warning', message: '在命令块中未找到有效的日记条目。请检查AI输出格式。' });
             console.error('在命令块中未找到有效的日记条目。请检查AI输出格式。');
         }

    } catch (dirError) {
        results.push({ status: 'error', message: `创建输出目录失败: ${outputDir} - ${dirError.message}` });
        console.error(`创建输出目录失败: ${outputDir}`, dirError);
        return { status: 'error', error: `创建输出目录失败: ${outputDir} - ${dirError.message}` }; // Return immediately on directory creation failure
    }

    // Determine overall status and format output for Plugin.js
    const errors = results.filter(r => r.status === 'error');
    const warnings = results.filter(r => r.status === 'warning');
    const successes = results.filter(r => r.status === 'success');

    if (errors.length > 0) {
        const errorMessages = errors.map(e => `${e.filename || '未知文件'}: ${e.message}`).join('\n');
        return { status: 'error', error: `保存日记时发生错误:\n${errorMessages}` };
    } else if (results.length === 0) {
         // This case is handled by the check inside the try block, but as a fallback:
         return { status: 'warning', result: '未找到有效的日记条目进行处理。请检查AI输出格式。' };
    }
    else {
        const successMessages = successes.map(s => `成功保存: ${s.filename}`).join('\n');
        const warningMessages = warnings.map(w => `警告: ${w.message}`).join('\n');
        let resultMessage = successMessages;
        if (warningMessages) {
            resultMessage += `\n\n警告:\n${warningMessages}`;
        }
        return { status: 'success', result: `日记处理完成:\n${resultMessage}` };
    }
}

// Read input from stdin
let inputData = '';
process.stdin.on('data', (chunk) => {
    inputData += chunk;
});

process.stdin.on('end', async () => {
    let processingResult;
    let diaryContent = '';

    try {
        // Parse the JSON input from Plugin.js
        const parsedInput = JSON.parse(inputData);
        // Extract the 'command' field which contains the raw diary data
        if (parsedInput && typeof parsedInput.command === 'string') {
            diaryContent = parsedInput.command;
        } else {
            throw new Error('Invalid input format: Expected JSON with a "command" string field.');
        }

        // Process the extracted diary content
        processingResult = await processDailyNotes(diaryContent);

        // 确保返回有效的JSON格式
        if (!processingResult || typeof processingResult !== 'object') {
            processingResult = {
                status: 'error',
                error: '处理结果格式无效'
            };
        }

    } catch (parseError) {
        console.error('Error parsing input JSON or extracting command:', parseError.message);
        processingResult = { status: 'error', error: `处理输入数据失败: ${parseError.message}` };
    }

    // Output result as JSON to stdout
    console.log(JSON.stringify(processingResult, null, 2));
    // Exit the process
    process.exit(processingResult.status === 'error' ? 1 : 0);
});

process.stdin.on('error', (err) => {
    console.error('Error reading from stdin:', err);
    console.log(JSON.stringify({ status: 'error', error: `读取标准输入失败: ${err.message}` }, null, 2));
    process.exit(1);
});