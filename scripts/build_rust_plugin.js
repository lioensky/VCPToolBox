'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

function fail(message) {
    console.error(`[build-rust-plugin] ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = { release: true, target: null, pluginDir: null, binaryName: null };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--debug') {
            options.release = false;
        } else if (arg === '--target') {
            options.target = argv[++index] || fail('--target requires a Rust target triple');
        } else if (!options.pluginDir) {
            options.pluginDir = arg;
        } else if (!options.binaryName) {
            options.binaryName = arg;
        } else {
            fail(`unexpected argument: ${arg}`);
        }
    }

    if (!options.pluginDir || !options.binaryName) {
        fail('usage: node scripts/build_rust_plugin.js <plugin-dir> <binary-name> [--target <triple>] [--debug]');
    }
    return options;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: options.capture ? 'utf8' : undefined,
        shell: false,
        windowsHide: true
    });
    if (result.error) fail(`${command} failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
    return options.capture ? String(result.stdout || '') : '';
}

function getHostTriple() {
    const versionInfo = run('rustc', ['-vV'], { capture: true });
    const hostLine = versionInfo.split(/\r?\n/).find(line => line.startsWith('host: '));
    if (!hostLine) fail('unable to determine the host target from rustc -vV');
    return hostLine.slice('host: '.length).trim();
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const pluginDir = path.resolve(projectRoot, options.pluginDir);
    const manifestPath = path.join(pluginDir, 'src', 'Cargo.toml');
    if (!fs.existsSync(manifestPath)) fail(`Cargo manifest not found: ${manifestPath}`);

    const target = options.target || getHostTriple();
    const profile = options.release ? 'release' : 'debug';
    const cargoArgs = ['build', '--manifest-path', manifestPath];
    if (options.release) cargoArgs.push('--release');
    if (options.target) cargoArgs.push('--target', options.target);

    console.log(`[build-rust-plugin] Building ${options.binaryName} for ${target} (${profile})...`);
    run('cargo', cargoArgs);

    const extension = target.includes('windows') ? '.exe' : '';
    const sourcePath = options.target
        ? path.join(pluginDir, 'src', 'target', target, profile, `${options.binaryName}${extension}`)
        : path.join(pluginDir, 'src', 'target', profile, `${options.binaryName}${extension}`);
    const destinationPath = path.join(pluginDir, `${options.binaryName}-${target}${extension}`);

    if (!fs.existsSync(sourcePath)) fail(`Cargo reported success but the binary was not found: ${sourcePath}`);
    fs.copyFileSync(sourcePath, destinationPath);
    if (process.platform !== 'win32') fs.chmodSync(destinationPath, 0o755);

    console.log(`[build-rust-plugin] Deployed ${path.relative(projectRoot, destinationPath)}`);
}

main();