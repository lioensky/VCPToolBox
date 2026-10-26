'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function getTarget() {
    const targets = {
        'win32:x64': { triple: 'x86_64-pc-windows-msvc', extension: '.exe' },
        'win32:arm64': { triple: 'aarch64-pc-windows-msvc', extension: '.exe' },
        'linux:x64': { triple: 'x86_64-unknown-linux-gnu', extension: '' },
        'linux:arm64': { triple: 'aarch64-unknown-linux-gnu', extension: '' },
        'darwin:x64': { triple: 'x86_64-apple-darwin', extension: '' },
        'darwin:arm64': { triple: 'aarch64-apple-darwin', extension: '' }
    };
    return targets[`${process.platform}:${process.arch}`] || null;
}

function getCandidates(target) {
    const binaryName = `MinerUParser${target.extension}`;
    return [
        path.join(__dirname, 'bin', `MinerUParser-${target.triple}${target.extension}`),
        path.join(__dirname, 'src', 'target', target.triple, 'release', binaryName),
        path.join(__dirname, 'src', 'target', 'release', binaryName),
        path.join(__dirname, 'src', 'target', target.triple, 'debug', binaryName),
        path.join(__dirname, 'src', 'target', 'debug', binaryName)
    ];
}

function findExecutable() {
    const target = getTarget();
    if (!target) {
        throw new Error(`MinerUParser does not support platform ${process.platform}/${process.arch}`);
    }

    const candidates = getCandidates(target);
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
        } catch (_) {
            // Try the next platform-compatible artifact.
        }
    }

    throw new Error(
        `MinerUParser executable for ${process.platform}/${process.arch} (${target.triple}) was not found or is not executable. ` +
        `Build with "cargo build --release" in the src/ directory (the bridge falls back to src/target/release) ` +
        `or provide one of: ${candidates.join(', ')}`
    );
}

function killChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
        child.kill('SIGTERM');
    } catch (_) {
        // The process already exited.
    }
}

function main() {
    let executable;
    try {
        executable = findExecutable();
    } catch (error) {
        process.stderr.write(`[MinerUParser bridge] ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

    // 子进程工作目录固定为 VCPToolBox 根目录，与插件资产落盘基准一致
    const child = spawn(executable, [], {
        cwd: path.resolve(__dirname, '..', '..'),
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on('error', error => {
        process.stderr.write(`[MinerUParser bridge] Failed to start ${executable}: ${error.message}\n`);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        if (signal) {
            process.stderr.write(`[MinerUParser bridge] Native process terminated by ${signal}\n`);
            process.exitCode = 1;
        } else {
            process.exitCode = code ?? 1;
        }
    });

    process.once('SIGINT', () => killChild(child));
    process.once('SIGTERM', () => killChild(child));
}

main();
