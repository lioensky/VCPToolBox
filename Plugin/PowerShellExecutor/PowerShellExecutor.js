const { spawn, execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http'); // 用于向主服务器发送回调
const fs = require('fs').promises; // 添加 fs 模块
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

// 用于向主服务器发送回调的函数
function sendCallback(requestId, status, result) {
    const callbackBaseUrl = process.env.CALLBACK_BASE_URL || 'http://localhost:6005/plugin-callback'; // 默认为localhost
    const pluginNameForCallback = process.env.PLUGIN_NAME_FOR_CALLBACK || 'PowerShellExecutor';

    if (!callbackBaseUrl) {
        console.error('错误: CALLBACK_BASE_URL 环境变量未设置。无法发送异步回调。');
        return;
    }

    const callbackUrl = `${callbackBaseUrl}/${pluginNameForCallback}/${requestId}`;

    const payload = JSON.stringify({
        requestId: requestId,
        status: status,
        result: result
    });

    const protocol = callbackBaseUrl.startsWith('https') ? require('https') : require('http');

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = protocol.request(callbackUrl, options, (res) => {
        console.log(`回调响应状态 ${requestId}: ${res.statusCode}`);
    });

    req.on('error', (e) => {
        console.error(`回调请求错误 ${requestId}: ${e.message}`);
    });

    req.write(payload);
    req.end();
}

/**
 * 在 Windows 上强制终止进程树
 * @param {number} pid - 要终止的进程 PID
 */
function forceKillProcessTree(pid) {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        // 进程可能已经退出，忽略错误
    }
}

async function executePowerShellCommand(command, executionType = 'blocking', timeout = 60000) {
    return new Promise((resolve, reject) => {
        let stdoutBuffer = Buffer.from('');
        let stderrBuffer = Buffer.from('');

        // 预置编码命令以确保UTF-8输出
        const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;

        // 统一使用非分离模式 spawn powershell.exe，保持进程树完整
        const child = spawn('powershell.exe', ['-Command', fullCommand], {
            windowsHide: executionType !== 'background', // background 模式显示窗口
            timeout: 0, // 我们自己管理超时
        });

        if (executionType === 'background') {
            // background 模式：不再 detach，保持进程树完整以便超时后清理
            // 返回子进程引用供调用方管理
            resolve(child);
        } else {
            // blocking 模式
            const timeoutId = setTimeout(() => {
                // Windows 上 child.kill() 可能无效，使用 taskkill 强杀进程树
                forceKillProcessTree(child.pid);
                reject(new Error(`命令在 ${timeout / 1000} 秒后超时。`));
            }, timeout);

            child.stdout.on('data', (data) => {
                stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
            });

            child.stderr.on('data', (data) => {
                stderrBuffer = Buffer.concat([stderrBuffer, data]);
            });

            child.on('close', (code) => {
                clearTimeout(timeoutId);

                const stdout = stdoutBuffer.toString('utf8');
                const stderr = stderrBuffer.toString('utf8');

                if (code !== 0) {
                    let errorMessage = `PowerShell 命令执行失败，退出码为 ${code}。`;
                    if (stderr) {
                        errorMessage += ` 错误输出: ${stderr}`;
                    }
                    if (stdout) {
                        errorMessage += ` 标准输出: ${stdout}`;
                    }
                    reject(new Error(errorMessage));
                    return;
                }
                resolve(stdout);
            });

            child.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(new Error(`启动PowerShell命令失败: ${err.message}`));
            });
        }
    });
}

async function main() {
    let input = '';
    process.stdin.on('data', (chunk) => {
        input += chunk;
    });

    process.stdin.on('end', async () => {
        try {
            const args = JSON.parse(input);
            // 支持 command, command1, command2... 串行执行
            const commands = [];
            if (args.command) {
                commands.push(args.command);
            }
            let i = 1;
            while (args[`command${i}`]) {
                commands.push(args[`command${i}`]);
                i++;
            }

            // --- 安全性检查 ---
            const forbiddenCommands = (process.env.FORBIDDEN_COMMANDS || '').toLowerCase().split(',').map(cmd => cmd.trim()).filter(Boolean);
            const authRequiredCommands = (process.env.AUTH_REQUIRED_COMMANDS || '').toLowerCase().split(',').map(cmd => cmd.trim()).filter(Boolean);
            let isAuthRequiredByConfig = false;

            for (const cmd of commands) {
                const lowerCaseCmd = cmd.toLowerCase();

                // 1. 检查是否包含被禁止的指令
                if (forbiddenCommands.length > 0 && forbiddenCommands.some(forbidden => lowerCaseCmd.includes(forbidden))) {
                    throw new Error(`执行被拒绝：指令 "${cmd.substring(0, 50)}..." 包含被禁止的关键字。`);
                }

                // 2. 检查是否需要管理员授权
                if (!isAuthRequiredByConfig && authRequiredCommands.length > 0 && authRequiredCommands.some(authCmd => lowerCaseCmd.includes(authCmd))) {
                    isAuthRequiredByConfig = true;
                }
            }
            // --- 安全性检查结束 ---

            let command;
            const isMultiCommand = commands.length > 1;
            if (isMultiCommand) {
                const psCommandObjects = commands.map(cmd => {
                    const escapedCmdForPs = cmd.replace(/'/g, "''");
                    // 为最终输出的JSON字符串转义命令本身
                    const escapedCmdForJson = cmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    return `$output = (Invoke-Expression -Command '${escapedCmdForPs}') *>&1 | Out-String; $results.Add([PSCustomObject]@{command='${escapedCmdForJson}'; output=$output.Trim()}) | Out-Null;`;
                }).join('\n');
                // 将所有命令包装在一个脚本中，该脚本收集每个命令的输出并最终输出为JSON
                command = `$results = New-Object System.Collections.ArrayList; ${psCommandObjects} $results | ConvertTo-Json -Compress -Depth 5;`;
            } else {
                command = commands.join('; ');
            }
            let executionType = args.executionType;
            const toolPassword = args.tool_password || args.requireAdmin; // 兼容旧版 requireAdmin 参数
            let notice;

            if (!executionType) {
                executionType = 'blocking'; // 如果未提供，则默认为 blocking
            } else if (executionType !== 'blocking' && executionType !== 'background') {
                throw new Error('无效的参数: executionType。必须是 "blocking" 或 "background"。');
            }

            if (!command) {
                throw new Error('缺少必需参数: 必须提供 "command" 或 "command1", "command2", ... 等参数。');
            }

            // 验证码验证逻辑
            if (isAuthRequiredByConfig && !toolPassword) {
                throw new Error('此操作涉及敏感指令，需要验证码授权，但未提供 tool_password。');
            }

            if (toolPassword) {
                const realCode = process.env.DECRYPTED_AUTH_CODE;

                if (!realCode) {
                    throw new Error('无法获取验证码。请确保主服务器配置正确。');
                }

                if (String(toolPassword) !== realCode) {
                    throw new Error('验证码错误。');
                }
                // 移除原有的强制切换 background 的逻辑
            }

            if (executionType === 'background') {
                const requestId = crypto.randomUUID();
                const tempFilePath = path.join(__dirname, `${requestId}.log`);
                const finalCommand = `${command} *>&1 | Tee-Object -FilePath "${tempFilePath}"`;

                // 启动 PowerShell 进程（不再 detach，保持进程树完整）
                const childProcess = await executePowerShellCommand(finalCommand, 'background');

                // 关键：等待轮询完成，同时持有子进程引用以便超时清理
                const output = await new Promise((resolve, reject) => {
                    let lastSize = -1;
                    let idleCycles = 0;
                    let totalWaitTime = 0;
                    const maxIdleCycles = 3; // 6秒无增长则认为结束
                    const pollingInterval = 2000; // 2秒
                    const maxTotalWaitTime = 45000; // 最大等待45秒
                    let processExited = false;

                    // 监听进程退出事件，提前结束轮询
                    childProcess.on('exit', () => {
                        processExited = true;
                    });

                    childProcess.on('error', (err) => {
                        processExited = true;
                        console.error(`后台进程启动错误: ${err.message}`);
                    });

                    const intervalId = setInterval(async () => {
                        totalWaitTime += pollingInterval;
                        try {
                            const stats = await fs.stat(tempFilePath).catch(() => null);

                            if (stats) {
                                if (stats.size > 0 && stats.size > lastSize) {
                                    lastSize = stats.size;
                                    idleCycles = 0;
                                } else if (stats.size > 0) {
                                    idleCycles++;
                                }
                            }

                            // 判定结束的条件：
                            // 1. 进程已退出（最可靠的信号）
                            // 2. 超过空闲周期
                            // 3. 超过最大总等待时间
                            const shouldFinish = processExited || idleCycles >= maxIdleCycles || totalWaitTime >= maxTotalWaitTime;

                            if (shouldFinish) {
                                clearInterval(intervalId);

                                // 如果进程还没退出且是超时导致的结束，强杀进程树
                                if (!processExited && totalWaitTime >= maxTotalWaitTime) {
                                    console.error(`后台任务超时 (${maxTotalWaitTime / 1000}s)，强制终止进程树 PID: ${childProcess.pid}`);
                                    forceKillProcessTree(childProcess.pid);
                                } else if (!processExited && idleCycles >= maxIdleCycles) {
                                    // 输出稳定，进程可能还在但不再产出，也强杀
                                    forceKillProcessTree(childProcess.pid);
                                }

                                // 赋予最后一两秒的写入宽限期
                                await new Promise(r => setTimeout(r, 1000));

                                const fileBuffer = await fs.readFile(tempFilePath).catch(() => null);
                                let fileContent = (totalWaitTime >= maxTotalWaitTime && lastSize === -1)
                                    ? '后台任务启动超时或无输出产生。'
                                    : '未能读取到后台任务输出。';

                                if (fileBuffer && fileBuffer.length > 0) {
                                    fileContent = fileBuffer.toString('utf8');
                                    if (fileContent.includes('\u0000')) {
                                        fileContent = fileBuffer.toString('utf16le');
                                    }
                                }
                                await fs.unlink(tempFilePath).catch(() => { });
                                resolve(fileContent);
                            }
                        } catch (error) {
                            clearInterval(intervalId);
                            // 超时清理：确保进程被杀死
                            if (!processExited && childProcess.pid) {
                                forceKillProcessTree(childProcess.pid);
                            }
                            await fs.unlink(tempFilePath).catch(() => { });
                            reject(new Error(`轮询后台任务输出时出错: ${error.message}`));
                        }
                    }, pollingInterval);
                });

                // 只有在轮询结束后，才进行最终的输出
                let resultOutput = output;
                if (isMultiCommand) {
                    try {
                        // 如果是多命令模式，输出应该是JSON字符串，我们将其解析为对象
                        resultOutput = JSON.parse(output);

                        // ===== 将多命令输出转化为 Markdown =====
                        let markdownOutput = `**PowerShell 批量执行结果**\n\n`;
                        if (Array.isArray(resultOutput)) {
                            resultOutput.forEach((res, index) => {
                                markdownOutput += `### 命令行 ${index + 1}\n\`\`\`powershell\n${res.command}\n\`\`\`\n`;
                                markdownOutput += `**输出:**\n\`\`\`\n${res.output || '(无输出)'}\n\`\`\`\n\n`;
                            });
                        } else {
                            markdownOutput += `\`\`\`json\n${JSON.stringify(resultOutput, null, 2)}\n\`\`\``;
                        }
                        resultOutput = markdownOutput;

                    } catch (e) {
                        console.error(`多命令JSON解析错误: ${e.message}。返回原始输出。`);
                        resultOutput = `**PowerShell 原始输出**\n\`\`\`\n${output}\n\`\`\``;
                    }
                } else {
                    // 单一命令直接包装
                    resultOutput = `**PowerShell 执行结果**\n\`\`\`\n${output}\n\`\`\``;
                }
                const finalResult = { status: 'success', result: { content: [{ type: 'text', text: resultOutput }] } };
                if (notice) {
                    finalResult.result.notice = notice;
                    finalResult.result.content = [{ type: 'text', text: `> [!WARNING]\n> ${notice}\n\n` + resultOutput }];
                }
                console.log(JSON.stringify(finalResult));

            } else {
                // blocking 模式保持不变
                const output = await executePowerShellCommand(command, executionType);
                let resultOutput = output;
                if (isMultiCommand) {
                    try {
                        // 如果是多命令模式，输出应该是JSON字符串，我们将其解析为对象
                        resultOutput = JSON.parse(output);

                        // ===== 将多命令输出转化为 Markdown =====
                        let markdownOutput = `**PowerShell 批量执行结果**\n\n`;
                        if (Array.isArray(resultOutput)) {
                            resultOutput.forEach((res, index) => {
                                markdownOutput += `### 命令行 ${index + 1}\n\`\`\`powershell\n${res.command}\n\`\`\`\n`;
                                markdownOutput += `**输出:**\n\`\`\`\n${res.output || '(无输出)'}\n\`\`\`\n\n`;
                            });
                        } else {
                            markdownOutput += `\`\`\`json\n${JSON.stringify(resultOutput, null, 2)}\n\`\`\``;
                        }
                        resultOutput = markdownOutput;

                    } catch (e) {
                        console.error(`多命令JSON解析错误: ${e.message}。返回原始输出。`);
                        resultOutput = `**PowerShell 原始输出**\n\`\`\`\n${output}\n\`\`\``;
                    }
                } else {
                    // 单一命令直接包装
                    resultOutput = `**PowerShell 执行结果**\n\`\`\`\n${output}\n\`\`\``;
                }
                console.log(JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: resultOutput }] } }));
            }
        } catch (error) {
            console.error(JSON.stringify({ status: 'error', error: error.message }));
            process.exit(1);
        }
    });
}

main();