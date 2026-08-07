'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function getTarget() {
    const targets = {
        'win32:x64': { triple: 'x86_64-pc-windows-msvc', extension: '.exe', legacy: ['CodeSearcher.exe'] },
        'win32:arm64': { triple: 'aarch64-pc-windows-msvc', extension: '.exe', legacy: [] },
        'linux:x64': { triple: 'x86_64-unknown-linux-gnu', extension: '', legacy: ['CodeSearcher-linux-x64-musl'] },
        'linux:arm64': { triple: 'aarch64-unknown-linux-musl', extension: '', legacy: ['CodeSearcher-linux-arm64'] },
        'darwin:x64': { triple: 'x86_64-apple-darwin', extension: '', legacy: [] },
        'darwin:arm64': { triple: 'aarch64-apple-darwin', extension: '', legacy: [] }
    };
    return targets[`${process.platform}:${process.arch}`] || null;
}

function getCandidates(target) {
    const binaryName = `CodeSearcher${target.extension}`;
    return [
        path.join(__dirname, `CodeSearcher-${target.triple}${target.extension}`),
        ...target.legacy.map(name => path.join(__dirname, name)),
        path.join(__dirname, 'src', 'target', target.triple, 'release', binaryName),
        path.join(__dirname, 'src', 'target', 'release', binaryName),
        path.join(__dirname, 'src', 'target', target.triple, 'debug', binaryName),
        path.join(__dirname, 'src', 'target', 'debug', binaryName)
    ];
}

function findExecutable() {
    const target = getTarget();
    if (!target) {
        throw new Error(`CodeSearcher does not support platform ${process.platform}/${process.arch}`);
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
        `CodeSearcher executable for ${process.platform}/${process.arch} (${target.triple}) was not found or is not executable. ` +
        `Run "npm run build:code-searcher" locally or provide one of: ${candidates.join(', ')}`
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
        process.stderr.write(`[CodeSearcher bridge] ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

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
        process.stderr.write(`[CodeSearcher bridge] Failed to start ${executable}: ${error.message}\n`);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        if (signal) {
            process.stderr.write(`[CodeSearcher bridge] Native process terminated by ${signal}\n`);
            process.exitCode = 1;
        } else {
            process.exitCode = code ?? 1;
        }
    });

    process.once('SIGINT', () => killChild(child));
    process.once('SIGTERM', () => killChild(child));
}

main();