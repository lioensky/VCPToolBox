const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const http = require('http'); // 用于向主服务器发送回调

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
            const args = ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', fullCommand];
            
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

            if (!executionType || (executionType !== 'blocking' && executionType !== 'background')) {
                throw new Error('缺少或无效的参数: executionType。必须是 "blocking" 或 "background"。');
            }

            if (!command) {
                throw new Error('缺少必需参数: command');
            }

            if (executionType === 'background') {
                const requestId = crypto.randomUUID(); // 为后台任务生成唯一ID
                // 启动后台命令而不等待其完成
                executePowerShellCommand(command, executionType)
                    .then(output => {
                        sendCallback(requestId, 'success', output);
                    })
                    .catch(error => {
                        sendCallback(requestId, 'error', error.message);
                    });

                // 立即返回一个占位符给AI
                const resultStringForAI = `PowerShell后台任务已提交。`;
                console.log(JSON.stringify({ status: 'success', result: resultStringForAI }));
            } else {
                // 同步执行
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
