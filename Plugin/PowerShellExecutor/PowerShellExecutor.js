const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http'); // 用于向主服务器发送回调
const fs = require('fs').promises; // 添加 fs 模块

// 用于向主服务器发送回调的函数
function sendCallback(requestId, status, result) {
    const callbackBaseUrl = process.env.CALLBACK_BASE_URL|| 'http://localhost:6005/plugin-callback'; // 默认为localhost
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

// 解密验证码
function decryptCode(encryptedCode) {
    const secretKey = '314159'; // 必须与 auth.js 中的密钥相同
    let realCode = '';
    for (let i = 0; i < encryptedCode.length; i++) {
        const encryptedDigit = parseInt(encryptedCode[i], 10);
        const keyDigit = parseInt(secretKey[i], 10);
        // 解密逻辑：(加密数字 - 密钥数字 + 10) % 10
        const realDigit = (encryptedDigit - keyDigit + 10) % 10;
        realCode += realDigit;
    }
    return realCode;
}

async function executePowerShellCommand(command, executionType = 'blocking', timeout = 60000) {
    return new Promise((resolve, reject) => {
        let stdoutBuffer = Buffer.from('');
        let stderrBuffer = Buffer.from('');

        // 预置编码命令以确保UTF-8输出
        const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;

        let child;
        if (executionType === 'background') {
            // 对于异步执行，打开一个可见的PowerShell窗口
            // 使用'start'命令打开一个可见的PowerShell窗口的正确方法
            const args = ['/c', 'start', 'powershell.exe', '-Command', fullCommand];
            
            // 我们调用cmd.exe来使用它的'start'命令
            child = spawn('cmd.exe', args, {
                detached: true, // 分离子进程
                // 不再需要'stdio: inherit'，因为'start'会处理新窗口。
                // 默认的stdio ('pipe') 即可，或者我们可以明确地忽略它。
                stdio: 'ignore'
            });
            
            child.unref(); // 允许父进程独立退出
        } else {
            // 对于同步执行，隐藏控制台窗口
            child = spawn('powershell.exe', ['-Command', fullCommand], {
                windowsHide: true,
                timeout: timeout,
                encoding: 'utf8'
            });

            const timeoutId = setTimeout(() => {
                child.kill(); // 如果超时，则终止进程
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
            const command = args.command;
            const executionType = args.executionType;
            const requireAdmin = args.requireAdmin;

            if (!executionType || (executionType !== 'blocking' && executionType !== 'background')) {
                throw new Error('缺少或无效的参数: executionType。必须是 "blocking" 或 "background"。');
            }

            if (!command) {
                throw new Error('缺少必需参数: command');
            }

            // 管理员模式验证
            if (requireAdmin) {
                if (executionType !== 'background') {
                    throw new Error('管理员模式仅支持 "background" 执行类型。');
                }

                const authCodePath = path.join(__dirname, '..', 'UserAuth', 'auth_code.txt');
                let encryptedCode;
                try {
                    encryptedCode = (await fs.readFile(authCodePath, 'utf-8')).trim();
                } catch (e) {
                    throw new Error('读取验证码文件失败。请确保UserAuth插件已生成验证码。');
                }

                const realCode = decryptCode(encryptedCode);

                if (String(requireAdmin) !== realCode) {
                    throw new Error('管理员验证码错误。');
                }
            }

            if (executionType === 'background') {
                const requestId = crypto.randomUUID();
                const tempFilePath = path.join(__dirname, `${requestId}.log`);
                const finalCommand = `${command} *>&1 | Tee-Object -FilePath "${tempFilePath}"`;

                // 启动一个可见的PowerShell窗口，但我们的脚本不等待它
                executePowerShellCommand(finalCommand, 'background');

                // 关键：现在我们等待轮询完成，而不是立即响应
                const output = await new Promise((resolve, reject) => {
                    let lastSize = -1;
                    let idleCycles = 0;
                    const maxIdleCycles = 3; // 6秒
                    const pollingInterval = 2000; // 2秒

                    const intervalId = setInterval(async () => {
                        try {
                            const stats = await fs.stat(tempFilePath).catch(() => null);

                            if (stats) {
                                if (stats.size > lastSize) {
                                    lastSize = stats.size;
                                    idleCycles = 0;
                                } else {
                                    idleCycles++;
                                }
                            } else if (lastSize !== -1) {
                                // 文件曾存在但现在消失了，说明进程结束
                                idleCycles = maxIdleCycles;
                            }

                            if (idleCycles >= maxIdleCycles) {
                                clearInterval(intervalId);
                                const fileBuffer = await fs.readFile(tempFilePath).catch(() => null);
                                let fileContent = '未能读取到后台任务的输出。';
                                if (fileBuffer) {
                                    // PowerShell on Windows typically outputs UTF-16LE.
                                    // Node.js's 'utf16le' decoder will handle the BOM if it exists.
                                    fileContent = fileBuffer.toString('utf16le');
                                }
                                await fs.unlink(tempFilePath).catch(e => console.error(`删除临时文件失败: ${e.message}`));
                                resolve(fileContent);
                            }
                        } catch (error) {
                            clearInterval(intervalId);
                            await fs.unlink(tempFilePath).catch(e => console.error(`轮询出错后删除临时文件失败: ${e.message}`));
                            reject(new Error(`轮询后台任务输出时出错: ${error.message}`));
                        }
                    }, pollingInterval);
                });

                // 只有在轮询结束后，才进行最终的输出
                console.log(JSON.stringify({ status: 'success', result: output }));

            } else {
                // blocking 模式保持不变
                const output = await executePowerShellCommand(command, executionType);
                console.log(JSON.stringify({ status: 'success', result: output }));
            }
        } catch (error) {
            console.error(JSON.stringify({ status: 'error', error: error.message }));
            process.exit(1);
        }
    });
}

main();