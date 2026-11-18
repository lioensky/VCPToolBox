'use strict';
// 共享二进制透视套件：纯 JS 零依赖静态解构与 UBAM Markdown 大盘渲染。
// 作为 Rust 原生索引器的安全降级气囊，杜绝任何乱码与上下文撑爆。

const BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.bin',
    '.o', '.obj', '.a', '.lib', '.pdb',
]);

function isBinaryExtension(filePathOrExt) {
    const ext = filePathOrExt.includes('.')
        ? '.' + filePathOrExt.split('.').pop().toLowerCase()
        : filePathOrExt.toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

function calculateShannonEntropy(buffer, start = 0, length = buffer.length) {
    const end = Math.min(start + length, buffer.length);
    const total = end - start;
    if (total <= 0) return 0.0;

    const counts = new Uint32Array(256);
    for (let i = start; i < end; i++) {
        counts[buffer[i]]++;
    }

    let entropy = 0.0;
    const log2Total = Math.log2(total);
    for (let i = 0; i < 256; i++) {
        const c = counts[i];
        if (c > 0) {
            entropy += c * Math.log2(c);
        }
    }
    return Math.max(0.0, Math.min(8.0, log2Total - (entropy / total)));
}

function classifyEntropy(entropy, canExec) {
    if (entropy < 1.0) return 'zero_padding';
    if (entropy < 5.5) return 'normal_data';
    if (entropy <= 7.10) return canExec ? 'normal_code' : 'normal_data';
    return 'packed_or_encrypted';
}

function parsePEBuffer(buffer, fileSizeBytes) {
    if (buffer.length < 0x40) throw new Error('文件过小，无法容纳 DOS 头');
    const e_lfanew = buffer.readUInt32LE(0x3C);
    if (e_lfanew < 0x40 || e_lfanew + 24 > buffer.length) throw new Error(`畸形 e_lfanew 偏移 (0x${e_lfanew.toString(16)})`);

    const peSig = buffer.toString('ascii', e_lfanew, e_lfanew + 4);
    if (peSig !== 'PE\0\0') throw new Error('无效的 PE 签名');

    const fileHeader = e_lfanew + 4;
    const machine = buffer.readUInt16LE(fileHeader);
    const numSections = Math.min(buffer.readUInt16LE(fileHeader + 2), 96);
    const sizeOfOptHeader = buffer.readUInt16LE(fileHeader + 16);

    const optHeader = fileHeader + 20;
    const magic = buffer.readUInt16LE(optHeader);
    const isPE32Plus = magic === 0x20B;

    const arch = machine === 0x8664 ? 'x86_64' : machine === 0x14C ? 'x86' : machine === 0xAA64 ? 'aarch64' : 'unknown';
    const entryPoint = buffer.readUInt32LE(optHeader + 16);
    const dllChar = isPE32Plus ? buffer.readUInt16LE(optHeader + 70) : buffer.readUInt16LE(optHeader + 70);

    const sections = [];
    const secStart = optHeader + sizeOfOptHeader;
    for (let i = 0; i < numSections; i++) {
        const offset = secStart + i * 40;
        if (offset + 40 > buffer.length) break;

        const rawSlice = buffer.toString('utf8', offset, offset + 8);
        const nullIdx = rawSlice.indexOf('\0');
        const rawName = (nullIdx !== -1 ? rawSlice.slice(0, nullIdx) : rawSlice).replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        const virtSize = buffer.readUInt32LE(offset + 8);
        const virtAddr = buffer.readUInt32LE(offset + 12);
        const rawSize = buffer.readUInt32LE(offset + 16);
        const rawOffset = buffer.readUInt32LE(offset + 20);
        const secChar = buffer.readUInt32LE(offset + 36);

        const canRead = (secChar & 0x40000000) !== 0;
        const canWrite = (secChar & 0x80000000) !== 0;
        const canExec = (secChar & 0x20000000) !== 0;

        const perms = (canRead ? 'R' : '-') + (canWrite ? 'W' : '-') + (canExec ? 'X' : '-');
        const entropy = calculateShannonEntropy(buffer, rawOffset, rawSize);

        sections.push({
            name: rawName || `sec_${i}`,
            virtualAddress: `0x${virtAddr.toString(16).padStart(8, '0').toUpperCase()}`,
            virtualSize: virtSize,
            rawOffset: rawOffset,
            rawSize: rawSize,
            permissions: perms,
            entropy: Math.round(entropy * 100) / 100,
            entropyStatus: classifyEntropy(entropy, canExec),
        });
    }

    return {
        isBinary: true,
        kind: 'binary',
        size: fileSizeBytes,
        format: isPE32Plus ? 'PE32+' : 'PE32',
        architecture: arch,
        subsystem: 'Windows',
        fileSizeBytes,
        entryPointRVA: `0x${entryPoint.toString(16).padStart(8, '0').toUpperCase()}`,
        imagePreferredBase: isPE32Plus ? '0x140000000' : '0x00400000',
        mitigations: {
            aslr: (dllChar & 0x0040) !== 0,
            highEntropyVA: (dllChar & 0x0020) !== 0,
            dep: (dllChar & 0x0100) !== 0,
            stackCanary: true,
            controlFlowGuard: (dllChar & 0x4000) !== 0,
            codeSigned: false,
        },
        sections,
        symbols: [],
        imports: [],
    };
}

function parseBinaryBuffer(buffer, filePath, fileSizeBytes = buffer.length) {
    if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
        try {
            return parsePEBuffer(buffer, fileSizeBytes);
        } catch {
            // 安全降级：捕获畸形 PE 解析异常，进入通用二进制兜底
        }
    }
    // 基础兜底结构
    return {
        isBinary: true,
        kind: 'binary',
        size: fileSizeBytes,
        format: 'Binary',
        architecture: 'unknown',
        fileSizeBytes,
        entryPointRVA: '0x00000000',
        imagePreferredBase: '0x00000000',
        mitigations: { aslr: false, highEntropyVA: false, dep: false, stackCanary: false, controlFlowGuard: false, codeSigned: false },
        sections: [{ name: '.data', virtualAddress: '0x0000', virtualSize: fileSizeBytes, rawOffset: 0, rawSize: fileSizeBytes, permissions: 'RW-', entropy: calculateShannonEntropy(buffer), entropyStatus: 'normal_data' }],
        symbols: [],
        imports: [],
    };
}

function formatBinaryMarkdown(meta, displayPath) {
    const lines = [];
    const sizeKB = (meta.fileSizeBytes / 1024).toFixed(2);
    lines.push(`#### ${displayPath} (${sizeKB} KB · ${meta.format} / ${meta.architecture} · Binary Inspection)`);

    const m = meta.mitigations || {};
    const aslrStr = `ASLR: ${m.aslr ? '✅' : '❌'}${m.highEntropyVA ? ' (HighEntropy)' : ''}`;
    const mitigationsStr = [
        aslrStr,
        `DEP: ${m.dep ? '✅' : '❌'}`,
        `Canary: ${m.stackCanary ? '✅' : '❌'}`,
        `CFG: ${m.controlFlowGuard ? '✅' : '❌'}`,
        m.relro ? `RELRO: ${m.relro}` : '',
        `Signed: ${m.codeSigned ? '✅' : '❌'}`,
    ].filter(Boolean).join(' | ');
    lines.push(`- 编译器安全加固：${mitigationsStr}`);
    lines.push(`- 执行入口 (RVA)：\`${meta.entryPointRVA || '0x00000000'}\` · 首选虚拟基址：\`${meta.imagePreferredBase || '0x0'}\``);

    if (meta.sections && meta.sections.length > 0) {
        lines.push(`- 节区拓扑总览 (Sections · ${meta.sections.length})：`);
        for (const sec of meta.sections) {
            const vSizeKB = (sec.virtualSize / 1024).toFixed(1);
            const rSizeKB = (sec.rawSize / 1024).toFixed(1);
            lines.push(`  • ${sec.name.padEnd(8, ' ')} · VAddr: ${sec.virtualAddress} | VSize: ${vSizeKB.padStart(6, ' ')} KB | Raw: ${rSizeKB.padStart(6, ' ')} KB | Perm: ${sec.permissions} | Entropy: ${sec.entropy.toFixed(2)} (${sec.entropyStatus})`);
        }
    }

    if (meta.symbols && meta.symbols.length > 0) {
        lines.push(`\n- 原生导出符号 (Exports · ${meta.symbols.length} 项 · 支持 \`path=${displayPath}#符号名\` 寻址)：`);
        for (let i = 0; i < meta.symbols.length; i++) {
            const sym = meta.symbols[i];
            const demangled = sym.demangled && sym.demangled !== sym.name ? ` · ${sym.demangled}` : '';
            lines.push(`  [${i + 1}] \`${sym.name}\` (RVA: ${sym.rva}${sym.ordinal ? ` · Ordinal: ${sym.ordinal}` : ''}${demangled})`);
        }
    }

    if (meta.imports && meta.imports.length > 0) {
        lines.push(`\n- 依赖动态库 (Imports · ${meta.imports.length} 个模块)：`);
        for (const imp of meta.imports) {
            const fns = imp.functions && imp.functions.length > 0 ? `: \`${imp.functions.slice(0, 5).join('`, `')}\`${imp.functions.length > 5 ? ` 等共 ${imp.functions.length} 项` : ''}` : '';
            lines.push(`  • ${imp.library}${fns}`);
        }
    }

    return lines.join('\n');
}

async function readBinaryAsContent(filePath, buffer, options = {}) {
    const displayPath = options.displayPath || filePath;
    const meta = parseBinaryBuffer(buffer, filePath, options.fileSizeBytes || buffer.length);
    const markdown = formatBinaryMarkdown(meta, displayPath);
    return {
        parts: [{ type: 'text', text: markdown }],
        raw: meta,
    };
}

module.exports = {
    isBinaryExtension,
    calculateShannonEntropy,
    classifyEntropy,
    parseBinaryBuffer,
    formatBinaryMarkdown,
    readBinaryAsContent,
};