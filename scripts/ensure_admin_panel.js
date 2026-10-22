'use strict';

/**
 * scripts/ensure_admin_panel.js
 * 
 * 跨平台 AdminPanel-Vue 前端静态资产校验与自愈构建中枢
 * 
 * 核心职责：
 * 1. 探针 A（物理与引用自洽）：检查 dist/index.html 是否存在，并反查其引用的主 JS/CSS 在磁盘是否真实存在（杜绝三层指纹错位与白屏）；
 * 2. 探针 B（源码新鲜度比对）：比对 src/**, public/**, package.json, vite.config.ts 的最新 mtime 是否超过 dist；
 * 3. 安全极速构建：在必要时调用 npm run build:no-type-check，强制覆盖 NODE_ENV=production，并注入 1024MB 堆上限防御 OOM。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const vueDir = path.join(projectRoot, 'AdminPanel-Vue');
const distDir = path.join(vueDir, 'dist');
const distIndex = path.join(distDir, 'index.html');
const distAssets = path.join(distDir, 'assets');

function log(msg) {
    console.log(`[ensure-admin-panel] ${msg}`);
}

function warn(msg) {
    console.warn(`[ensure-admin-panel] [WARN] ${msg}`);
}

function error(msg) {
    console.error(`[ensure-admin-panel] [ERROR] ${msg}`);
}

/**
 * 校验 dist/index.html 存在性及其引用的 assets 哈希文件完整性
 */
function verifyDistIntegrity() {
    if (!fs.existsSync(distIndex)) {
        return { ok: false, reason: 'dist/index.html does not exist' };
    }

    try {
        const html = fs.readFileSync(distIndex, 'utf8');
        // 匹配 index.html 中的 script src 与 link href (以 /AdminPanel/assets 或 ./assets 开头)
        const assetRegex = /(?:src|href)=["'](?:\.|\/AdminPanel)?\/assets\/([^"']+)["']/g;
        const requiredAssets = [];
        let match;
        while ((match = assetRegex.exec(html)) !== null) {
            requiredAssets.push(match[1]);
        }

        if (requiredAssets.length === 0) {
            return { ok: false, reason: 'dist/index.html contains no valid asset references' };
        }

        for (const relAsset of requiredAssets) {
            const assetPath = path.join(distAssets, relAsset);
            if (!fs.existsSync(assetPath)) {
                return { ok: false, reason: `Asset referenced in index.html is missing on disk: ${relAsset}` };
            }
        }

        return { ok: true, distMtime: fs.statSync(distIndex).mtimeMs };
    } catch (e) {
        return { ok: false, reason: `Failed to inspect dist assets: ${e.message}` };
    }
}

/**
 * 递归获取目录下文件的最大 mtime
 */
function getMaxMtime(dirPath) {
    let max = 0;
    if (!fs.existsSync(dirPath)) return max;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
            const subMax = getMaxMtime(fullPath);
            if (subMax > max) max = subMax;
        } else if (entry.isFile()) {
            const mtime = fs.statSync(fullPath).mtimeMs;
            if (mtime > max) max = mtime;
        }
    }
    return max;
}

/**
 * 检查源码或配置是否比当前 dist 产物更新
 */
function isSourceNewer(distMtime) {
    const keyTargets = [
        path.join(vueDir, 'package.json'),
        path.join(vueDir, 'vite.config.ts'),
        path.join(vueDir, 'index.html')
    ];

    for (const target of keyTargets) {
        if (fs.existsSync(target) && fs.statSync(target).mtimeMs > distMtime) {
            return { newer: true, file: path.relative(projectRoot, target) };
        }
    }

    const srcMax = getMaxMtime(path.join(vueDir, 'src'));
    if (srcMax > distMtime) {
        return { newer: true, file: 'AdminPanel-Vue/src' };
    }

    const publicMax = getMaxMtime(path.join(vueDir, 'public'));
    if (publicMax > distMtime) {
        return { newer: true, file: 'AdminPanel-Vue/public' };
    }

    return { newer: false };
}

/**
 * 安全执行命令，跨平台兼容 Windows 的 .cmd 与 Shell 管道
 */
function runCommand(command, args, options = {}) {
    const isWindows = process.platform === 'win32';
    const effectiveCommand = isWindows && !command.endsWith('.cmd') && !command.endsWith('.exe') ? `${command}.cmd` : command;

    const childEnv = {
        ...process.env,
        NODE_ENV: 'development', // 强制覆盖 production，确保安装 devDependencies 并能运行 vite
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=1024`.trim() // 限制 1024MB 堆内存，防护轻量 VPS OOM
    };

    const res = spawnSync(effectiveCommand, args, {
        cwd: vueDir,
        env: childEnv,
        stdio: options.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: isWindows,
        windowsHide: true
    });

    return res;
}

/**
 * 主执行逻辑
 */
function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const checkOnly = args.includes('--check-only');

    if (!fs.existsSync(vueDir)) {
        warn('AdminPanel-Vue directory not found. Skipping.');
        process.exit(0);
    }

    const integrity = verifyDistIntegrity();

    if (!force && integrity.ok) {
        const sourceCheck = isSourceNewer(integrity.distMtime);
        if (!sourceCheck.newer) {
            log('AdminPanel-Vue assets are verified and up to date.');
            process.exit(0);
        } else {
            log(`Source file (${sourceCheck.file}) is newer than dist. Rebuild needed.`);
        }
    } else if (!force) {
        log(`Asset verification failed: ${integrity.reason}. Rebuild needed.`);
    } else {
        log('Force build requested.');
    }

    if (checkOnly) {
        error('AdminPanel-Vue assets require rebuild, but --check-only was specified.');
        process.exit(1);
    }

    // 检查是否需要安装/补全依赖
    const viteBin = path.join(vueDir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
    if (!fs.existsSync(viteBin)) {
        log('Vite executable not found in AdminPanel-Vue/node_modules. Installing dependencies...');
        const installRes = runCommand('npm', ['install', '--include=dev', '--no-audit', '--no-fund']);
        if (installRes.status !== 0) {
            error('npm install in AdminPanel-Vue failed.');
            process.exit(1);
        }
    }

    log('Building AdminPanel-Vue frontend (npm run build:no-type-check)...');
    let buildRes = runCommand('npm', ['run', 'build:no-type-check']);

    // 若构建失败，尝试自动修复原生平台依赖（如跨系统平台导致的 esbuild 缺失）
    if (buildRes.status !== 0) {
        warn('Initial build failed. Attempting dependency reconciliation (npm install --include=dev --force)...');
        runCommand('npm', ['install', '--include=dev', '--no-audit', '--no-fund', '--force']);
        buildRes = runCommand('npm', ['run', 'build:no-type-check']);
    }

    if (buildRes.status !== 0) {
        error('AdminPanel-Vue build failed.');
        process.exit(buildRes.status || 1);
    }

    // 产物落地后二次硬核校验
    const postCheck = verifyDistIntegrity();
    if (!postCheck.ok) {
        error(`Post-build verification failed: ${postCheck.reason}`);
        process.exit(1);
    }

    log('AdminPanel-Vue frontend assets successfully verified and ready.');
    process.exit(0);
}

main();