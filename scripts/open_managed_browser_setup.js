'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.env');

if (fs.existsSync(configPath)) {
    dotenv.config({ path: configPath, override: false });
} else {
    console.warn('[Managed Browser Setup] 未找到 config.env，将使用默认值和当前环境变量。');
}

const browserRuntimeManager = require('../modules/browserRuntimeManager.js');

function resolveProjectPath(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function requestJson(url, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { timeout: timeoutMs }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', reject);
    });
}

async function detectActiveManagedProfile(profileDir) {
    const activePortPath = path.join(profileDir, 'DevToolsActivePort');
    try {
        const content = await fs.promises.readFile(activePortPath, 'utf8');
        const port = Number.parseInt(content.split(/\r?\n/)[0], 10);
        if (!Number.isFinite(port) || port <= 0) return null;
        const version = await requestJson(`http://127.0.0.1:${port}/json/version`);
        return {
            port,
            browser: version.Browser || 'Chrome',
            webSocketDebuggerUrl: version.webSocketDebuggerUrl || null
        };
    } catch (_) {
        return null;
    }
}

async function main() {
    const profileDir = resolveProjectPath(
        process.env.VCP_BROWSER_PROFILE_DIR,
        path.join(projectRoot, 'Plugin', 'ChromeBridge', 'managed-profile')
    );
    const activeRuntime = await detectActiveManagedProfile(profileDir);

    console.log('============================================================');
    console.log(' VCP Managed Chrome - 人工基础设置模式');
    console.log('============================================================');
    console.log(`Profile: ${profileDir}`);
    console.log('');

    if (activeRuntime) {
        throw new Error(
            `托管 Profile 正被运行中的 ${activeRuntime.browser} 占用（DevTools 端口 ${activeRuntime.port}）。` +
            '请先通过 ChromeBridge close_chrome 或关闭服务器托管浏览器，再重新运行本脚本；' +
            '禁止同时用两个 Chrome 进程写入同一 Profile。'
        );
    }

    console.log('将以有头、非最小化模式打开与生产环境相同的 managed Profile。');
    console.log('可在浏览器中设置麦克风、摄像头、通知、语言、登录态和站点权限。');
    console.log('设置完成后请正常关闭整个浏览器窗口；本脚本会随浏览器退出。');
    console.log('');

    const status = await browserRuntimeManager.ensureManagedBrowser({
        enabled: true,
        headless: false,
        startMinimized: false,
        windowsHide: false,
        // 人工设置期间不触发常规 5 分钟空闲回收；最长保留 24 小时。
        idleTimeoutMs: 24 * 60 * 60 * 1000
    });

    console.log('[Managed Browser Setup] 浏览器已启动：');
    console.log(JSON.stringify({
        pid: status.pid,
        executablePath: status.executablePath,
        profileDir: status.profileDir,
        extensionDir: status.extensionDir,
        headless: status.headless,
        startMinimized: status.startMinimized,
        windowsHide: status.windowsHide
    }, null, 2));
    console.log('');
    console.log('提示：Chrome 的麦克风/摄像头权限通常按站点 origin 保存。');
    console.log('请访问实际目标站点并在地址栏左侧“网站设置”中允许对应权限。');
}

main().catch(error => {
    console.error('');
    console.error(`[Managed Browser Setup] 启动失败：${error.message}`);
    process.exitCode = 1;
});