const { spawn, execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

// --- Shell 检测（PS7 优先） ---
// 与前端 PowerShellExecutor v1.1.0 保持一致的检测逻辑
// 检测顺序：Program Files 标准路径 → where.exe PATH 查找 → 回退 powershell.exe
let resolvedShell = 'powershell.exe';

if (os.platform() === 'win32') {
    const pwshPath = path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    if (fs.existsSync(pwshPath)) {
        resolvedShell = pwshPath;
    } else {
        // 二级回退：尝试 where.exe 查找 PATH 中的 pwsh
        // 注意：winget/MSIX 安装的 PS7 位于 WindowsApps（AppExecution Alias），
        // 该路径下的 pwsh.exe 是特殊占位文件，fs.existsSync 可能返回 false，
        // 但 where.exe 能正确找到它且可直接 spawn。因此直接信任 where 结果。
        try {
            const whereResult = execSync('where.exe pwsh', { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim();
            const firstLine = whereResult.split(/\r?\n/)[0].trim();
            if (firstLine) {
                resolvedShell = firstLine;
            }
        } catch (e) {
            // where.exe 失败（pwsh 不在 PATH 中），保持 powershell.exe 回退
        }
    }
}

console.error(`[ServerPowerShellExecutor] Using shell: ${resolvedShell}`);

// --- 配置加载 ---
const defaultConfig = {
    returnMode: 'delta',
    forbiddenCommands: [],
    authRequiredCommands: []
};

try {
    const configPath = path.join(__dirname, 'config.env');
    if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');

        const returnModeMatch = configContent.match(/^POWERSHELL_RETURN_MODE\s*=\s*(delta|full)/m);
        if (returnModeMatch) {
            defaultConfig.returnMode = returnModeMatch[1];
        }

        const forbiddenMatch = configContent.match(/^FORBIDDEN_COMMANDS\s*=\s*(.*)/m);
        if (forbiddenMatch && forbiddenMatch[1]) {
            defaultConfig.forbiddenCommands = forbiddenMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }

        const authRequiredMatch = configContent.match(/^AUTH_REQUIRED_COMMANDS\s*=\s*(.*)/m);
        if (authRequiredMatch && authRequiredMatch[1]) {
            defaultConfig.authRequiredCommands = authRequiredMatch[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c);
        }
    }
} catch (error) {
    console.error('[ServerPowerShellExecutor] Error reading config.env:', error);
}

// --- 智能安全检查（移植自前端 v1.1.0） ---
/**
 * 智能安全检查函数 - 区分命令关键字和路径内容
 * @param {string} command - 要检查的命令字符串
 * @param {string[]} forbiddenKeywords - 禁止的关键字列表
 * @param {string[]} authRequiredKeywords - 需要授权的关键字列表
 * @returns {object} - 检查结果 {isForbidden, needsAuth, matchedKeyword, reason}
 */
function intelligentSecurityCheck(command, forbiddenKeywords, authRequiredKeywords) {
    const result = {
        isForbidden: false,
        needsAuth: false,
        matchedKeyword: null,
        reason: null
    };

    const normalizedCommand = command.trim().toLowerCase();
    if (!normalizedCommand) {
        return result;
    }

    // 定义路径模式
    const pathPatterns = [
        /[a-z]:\\[^\\/:*?"<>|]*(?:\\[^\\/:*?"<>|]*)*\\?/gi,  // Windows路径
        /\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g,                      // Unix路径
        /\$env:[a-z_]+[^\\/:*?"<>|\s]*/gi,                   // PS环境变量路径
        /\${[^}]+}[^\\/:*?"<>|\s]*/gi,                       // 变量路径
        /~\/[^\/\s]*(?:\/[^\/\s]*)*\/?/g                     // 用户目录路径
    ];

    // 提取所有可能的路径
    const detectedPaths = [];
    pathPatterns.forEach(pattern => {
        const matches = normalizedCommand.match(pattern);
        if (matches) {
            detectedPaths.push(...matches);
        }
    });

    // 创建不包含路径的命令版本
    let commandWithoutPaths = normalizedCommand;
    detectedPaths.forEach(p => {
        commandWithoutPaths = commandWithoutPaths.replace(p.toLowerCase(), ' __PATH_PLACEHOLDER__ ');
    });
    commandWithoutPaths = commandWithoutPaths.replace(/\s+/g, ' ').trim();

    // 检查禁止的关键字
    for (const keyword of forbiddenKeywords) {
        if (!keyword) continue;
        const keywordLower = keyword.toLowerCase();

        const isInPath = detectedPaths.some(p => p.toLowerCase().includes(keywordLower));
        if (isInPath && !commandWithoutPaths.includes(keywordLower)) {
            continue;
        }

        if (commandWithoutPaths.includes(keywordLower)) {
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.isForbidden = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含被禁止的关键字: ${keyword}`;
                return result;
            }
        }
    }

    // 检查需要授权的关键字
    for (const keyword of authRequiredKeywords) {
        if (!keyword) continue;
        const keywordLower = keyword.toLowerCase();

        const isInPath = detectedPaths.some(p => p.toLowerCase().includes(keywordLower));
        if (isInPath && !commandWithoutPaths.includes(keywordLower)) {
            continue;
        }

        if (commandWithoutPaths.includes(keywordLower)) {
            const wordBoundaryPattern = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (wordBoundaryPattern.test(commandWithoutPaths)) {
                result.needsAuth = true;
                result.matchedKeyword = keyword;
                result.reason = `命令包含需要授权的关键字: ${keyword}`;
            }
        }
    }

    return result;
}

// --- 回调函数 ---
function sendCallback(requestId, status, result) {
    const callbackBaseUrl = process.env.CALLBACK_BASE_URL || 'http://localhost:6005/plugin-callback';
    const pluginNameForCallback = process.env.PLUGIN_NAME_FOR_CALLBACK || 'PowerShellExecutor';

    if (!callbackBaseUrl) {
        console.error('错误: CALLBACK_BASE_URL 环境变量未设置。');
        return;
    }

    const callbackUrl = `${callbackBaseUrl}/${pluginNameForCallback}/${requestId}`;
    const payload = JSON.stringify({ requestId, status, result });
    const protocol = callbackBaseUrl.startsWith('https') ? require('https') : require('http');

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = protocol.request(callbackUrl, options, (res) => {
        console.error(`回调响应状态 ${requestId}: ${res.statusCode}`);
    });
    req.on('error', (e) => {
        console.error(`回调请求错误 ${requestId}: ${e.message}`);
    });
    req.write(payload);
    req.end();
}

/**
 * 在 Windows 上强制终止进程树
 */
function forceKillProcessTree(pid) {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        // 进程可能已经退出
    }
}

/**
 * 执行 PowerShell 命令
 * blocking 模式使用临时脚本文件（BOM 保护中文）
 * background 模式同理
 */
async function executePowerShellCommand(command, executionType = 'blocking', timeout = 600000) {
    return new Promise((resolve, reject) => {
        let stdoutBuffer = Buffer.from('');
        let stderrBuffer = Buffer.from('');
        let tempScriptPath = null;

        // 预置编码命令
        const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;

        if (executionType === 'blocking') {
            // blocking 模式：写入带 BOM 的临时脚本文件执行，确保中文命令在 PS5.1 下也不乱码
            try {
                const tempScriptName = `vcp-server-ps-${crypto.randomUUID()}.ps1`;
                tempScriptPath = path.join(os.tmpdir(), tempScriptName);
                // UTF-8 BOM 前缀保护中文（与前端 v1.1.0 一致）
                fs.writeFileSync(tempScriptPath, `\ufeff${fullCommand}`, 'utf8');
            } catch (e) {
                return reject(new Error(`无法创建临时脚本文件: ${e.message}`));
            }

            const child = spawn(resolvedShell, [
                '-NoProfile',
                '-NoLogo',
                '-ExecutionPolicy', 'Bypass',
                '-File', tempScriptPath
            ], {
                windowsHide: true,
                timeout: 0,
            });

            const timeoutId = setTimeout(() => {
                forceKillProcessTree(child.pid);
                cleanupTempScript(tempScriptPath);
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
                cleanupTempScript(tempScriptPath);

                const stdout = stdoutBuffer.toString('utf8');
                const stderr = stderrBuffer.toString('utf8');

                if (code !== 0) {
                    let errorMessage = `PowerShell 命令执行失败，退出码为 ${code}。`;
                    if (stderr) errorMessage += ` 错误输出: ${stderr}`;
                    if (stdout) errorMessage += ` 标准输出: ${stdout}`;
                    if (!stderr && !stdout) {
                        errorMessage += ` [诊断] 无输出。Shell: ${resolvedShell} | 临时脚本: ${tempScriptPath || 'N/A'}`;
                    }
                    reject(new Error(errorMessage));
                    return;
                }
                resolve(stdout);
            });

            child.on('error', (err) => {
                clearTimeout(timeoutId);
                cleanupTempScript(tempScriptPath);
                reject(new Error(`启动PowerShell命令失败: ${err.message}`));
            });

        } else {
            // background 模式：保持原有逻辑（spawn 不分离，轮询输出文件）
            const child = spawn(resolvedShell, ['-NoProfile', '-NoLogo', '-Command', fullCommand], {
                windowsHide: false,
                timeout: 0,
            });

            resolve(child);
        }
    });
}

/**
 * 清理临时脚本文件
 */
function cleanupTempScript(filePath) {
    if (filePath) {
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            // 文件可能已被清理或不存在，忽略
        }
    }
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

            // --- 智能安全性检查 ---
            let isAuthRequiredByConfig = false;

            for (const cmd of commands) {
                const securityResult = intelligentSecurityCheck(
                    cmd,
                    defaultConfig.forbiddenCommands,
                    defaultConfig.authRequiredCommands
                );

                if (securityResult.isForbidden) {
                    throw new Error(`执行被拒绝：${securityResult.reason}`);
                }

                if (securityResult.needsAuth) {
                    isAuthRequiredByConfig = true;
                    console.error(`[ServerPowerShellExecutor] 命令需要授权：${securityResult.reason}`);
                }
            }
            // --- 安全性检查结束 ---

            let command;
            const isMultiCommand = commands.length > 1;
            if (isMultiCommand) {
                const psCommandObjects = commands.map(cmd => {
                    const escapedCmdForPs = cmd.replace(/'/g, "''");
                    const escapedCmdForJson = cmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    return `$output = (Invoke-Expression -Command '${escapedCmdForPs}') *>&1 | Out-String; $results.Add([PSCustomObject]@{command='${escapedCmdForJson}'; output=$output.Trim()}) | Out-Null;`;
                }).join('\n');
                command = `$results = New-Object System.Collections.ArrayList; ${psCommandObjects} $results | ConvertTo-Json -Compress -Depth 5;`;
            } else {
                command = commands.join('; ');
            }

            let executionType = args.executionType;
            const toolPassword = args.tool_password || args.requireAdmin;
            let notice;

            if (!executionType) {
                executionType = 'blocking';
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
            }

            if (executionType === 'background') {
                const requestId = crypto.randomUUID();
                const tempFilePath = path.join(__dirname, `${requestId}.log`);
                const finalCommand = `${command} *>&1 | Tee-Object -FilePath "${tempFilePath}"`;

                const childProcess = await executePowerShellCommand(finalCommand, 'background');

                const output = await new Promise((resolve, reject) => {
                    let lastSize = -1;
                    let idleCycles = 0;
                    let totalWaitTime = 0;
                    const maxIdleCycles = 3;
                    const pollingInterval = 2000;
                    const maxTotalWaitTime = 45000;
                    let processExited = false;

                    childProcess.on('exit', () => { processExited = true; });
                    childProcess.on('error', (err) => {
                        processExited = true;
                        console.error(`后台进程启动错误: ${err.message}`);
                    });

                    const intervalId = setInterval(async () => {
                        totalWaitTime += pollingInterval;
                        try {
                            const stats = await fsPromises.stat(tempFilePath).catch(() => null);

                            if (stats) {
                                if (stats.size > 0 && stats.size > lastSize) {
                                    lastSize = stats.size;
                                    idleCycles = 0;
                                } else if (stats.size > 0) {
                                    idleCycles++;
                                }
                            }

                            const shouldFinish = processExited || idleCycles >= maxIdleCycles || totalWaitTime >= maxTotalWaitTime;

                            if (shouldFinish) {
                                clearInterval(intervalId);

                                if (!processExited && totalWaitTime >= maxTotalWaitTime) {
                                    console.error(`后台任务超时 (${maxTotalWaitTime / 1000}s)，强制终止进程树 PID: ${childProcess.pid}`);
                                    forceKillProcessTree(childProcess.pid);
                                } else if (!processExited && idleCycles >= maxIdleCycles) {
                                    forceKillProcessTree(childProcess.pid);
                                }

                                await new Promise(r => setTimeout(r, 1000));

                                const fileBuffer = await fsPromises.readFile(tempFilePath).catch(() => null);
                                let fileContent = (totalWaitTime >= maxTotalWaitTime && lastSize === -1)
                                    ? '后台任务启动超时或无输出产生。'
                                    : '未能读取到后台任务输出。';

                                if (fileBuffer && fileBuffer.length > 0) {
                                    fileContent = fileBuffer.toString('utf8');
                                    if (fileContent.includes('\u0000')) {
                                        fileContent = fileBuffer.toString('utf16le');
                                    }
                                }
                                await fsPromises.unlink(tempFilePath).catch(() => {});
                                resolve(fileContent);
                            }
                        } catch (error) {
                            clearInterval(intervalId);
                            if (!processExited && childProcess.pid) {
                                forceKillProcessTree(childProcess.pid);
                            }
                            await fsPromises.unlink(tempFilePath).catch(() => {});
                            reject(new Error(`轮询后台任务输出时出错: ${error.message}`));
                        }
                    }, pollingInterval);
                });

                let resultOutput = output;
                if (isMultiCommand) {
                    try {
                        resultOutput = JSON.parse(output);
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
                    resultOutput = `**PowerShell 执行结果**\n\`\`\`\n${output}\n\`\`\``;
                }

                const finalResult = { status: 'success', result: { content: [{ type: 'text', text: resultOutput }] } };
                if (notice) {
                    finalResult.result.notice = notice;
                    finalResult.result.content = [{ type: 'text', text: `> [!WARNING]\n> ${notice}\n\n` + resultOutput }];
                }
                console.log(JSON.stringify(finalResult));

            } else {
                // blocking 模式
                const output = await executePowerShellCommand(command, executionType);
                let resultOutput = output;
                if (isMultiCommand) {
                    try {
                        resultOutput = JSON.parse(output);
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