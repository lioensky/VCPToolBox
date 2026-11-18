'use strict';
// 共享代码校验：按扩展名选择校验器，返回统一格式的诊断列表。
// 诊断项：{ line, column, severity: 'error'|'warning', message, ruleId, fatal }
// fatal=true 表示语法级错误（文件无法被解析），可用于 revertOnSyntaxError。

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

let eslintInstances = null;
let stylelintModule = null;

function getEslint(sourceType) {
    if (!eslintInstances) {
        const { ESLint } = require('eslint');
        const js = require('@eslint/js');
        const globals = require('globals');
        const make = type => new ESLint({
            overrideConfigFile: true,
            overrideConfig: [
                js.configs.recommended,
                {
                    languageOptions: {
                        ecmaVersion: 'latest',
                        sourceType: type,
                        globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
                    },
                },
            ],
        });
        eslintInstances = { module: make('module'), commonjs: make('commonjs') };
    }
    return eslintInstances[sourceType];
}

/** .mjs → module；.cjs → commonjs；.js 按是否出现顶层 import/export 判断。 */
function detectSourceType(ext, content) {
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    return /^\s*(import\s[\s\S]*?from\s|import\s*['"{*]|export\s)/m.test(content) ? 'module' : 'commonjs';
}

async function validateJavaScript(filePath, content, ext) {
    const eslint = getEslint(detectSourceType(ext, content));
    const [result] = await eslint.lintText(content, { filePath });
    return (result?.messages || []).map(msg => ({
        line: msg.line || 1,
        column: msg.column || 1,
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.message,
        ruleId: msg.ruleId || (msg.fatal ? 'syntax' : null),
        fatal: Boolean(msg.fatal),
    }));
}

async function validateCss(content) {
    if (!stylelintModule) stylelintModule = require('stylelint');
    const lintResult = await stylelintModule.lint({
        code: content,
        config: { extends: 'stylelint-config-standard', rules: {} },
        customSyntax: 'postcss-safe-parser',
    });
    return (lintResult?.results?.[0]?.warnings || []).map(w => ({
        line: w.line || 1,
        column: w.column || 1,
        severity: w.severity === 'error' ? 'error' : 'warning',
        message: w.text,
        ruleId: w.rule,
        fatal: w.rule === 'CssSyntaxError',
    }));
}

function validateJson(content) {
    if (content.trim() === '') return [];
    try {
        JSON.parse(content);
        return [];
    } catch (error) {
        // V8 错误信息形如 "... at position 123" 或 "(line 3 column 5)"
        let line = 1;
        let column = 1;
        const lc = error.message.match(/line (\d+) column (\d+)/);
        const pos = error.message.match(/position (\d+)/);
        if (lc) {
            line = Number(lc[1]);
            column = Number(lc[2]);
        } else if (pos) {
            const before = content.slice(0, Number(pos[1])).split('\n');
            line = before.length;
            column = before[before.length - 1].length + 1;
        }
        return [{ line, column, severity: 'error', message: error.message, ruleId: 'json-syntax', fatal: true }];
    }
}

// 异步执行 py_compile：同步调用最长阻塞 20s，且 reviewCode 前后各跑一次，
// 在常驻进程（ProjectForge）中会卡住整个事件循环。临时文件名加随机后缀，避免并发校验同毫秒撞名。
function execFileAsync(file, args, options) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function validatePython(content) {
    const tempFile = path.join(os.tmpdir(), `vcp_val_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.py`);
    await fs.promises.writeFile(tempFile, content);
    try {
        // 参数数组形式调用，不经过 shell，杜绝路径注入。
        await execFileAsync('python', ['-m', 'py_compile', tempFile], { windowsHide: true, timeout: 20000 });
        return [];
    } catch (error) {
        if (error.code === 'ENOENT') return []; // 未安装 python：跳过校验而非报错
        const stderr = error.stderr ? error.stderr.toString() : error.message;
        const lineMatch = stderr.match(/line (\d+)/);
        const lastLine = stderr.trim().split(/\r?\n/).pop() || stderr;
        return [{
            line: lineMatch ? Number(lineMatch[1]) : 1,
            column: 1,
            severity: 'error',
            message: lastLine.replace(tempFile, path.basename(tempFile)),
            ruleId: 'python-syntax',
            fatal: true,
        }];
    } finally {
        await fs.promises.unlink(tempFile).catch(() => { /* 已删除 */ });
    }
}

const SUPPORTED = new Set(['.js', '.cjs', '.mjs', '.css', '.json', '.py']);

function isValidatable(filePath) {
    return SUPPORTED.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * 校验代码内容。校验器自身异常时返回一条 ruleId=linter-error 的警告（非 fatal），
 * 不影响文件操作本身。
 */
async function validateCode(filePath, content) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const text = String(content ?? '');
    try {
        switch (ext) {
            case '.js':
            case '.cjs':
            case '.mjs':
                return await validateJavaScript(filePath, text, ext);
            case '.css':
                return await validateCss(text);
            case '.json':
                return validateJson(text);
            case '.py':
                return await validatePython(text);
            default:
                return [];
        }
    } catch (error) {
        return [{
            line: 1,
            column: 1,
            severity: 'warning',
            message: `Linter execution failed: ${error.message}`,
            ruleId: 'linter-error',
            fatal: false,
        }];
    }
}

/** 诊断签名：忽略行号，仅比较规则与信息，用于编辑前后取差集。 */
function diagnosticKey(d) {
    return `${d.severity}|${d.ruleId || ''}|${d.message}`;
}

/**
 * 仅返回编辑后新增的诊断（按签名计数做多重集差集），
 * 避免存量告警淹没本次编辑引入的问题。
 */
function diffDiagnostics(before = [], after = []) {
    const counts = new Map();
    for (const d of before) counts.set(diagnosticKey(d), (counts.get(diagnosticKey(d)) || 0) + 1);
    const introduced = [];
    for (const d of after) {
        const key = diagnosticKey(d);
        const left = counts.get(key) || 0;
        if (left > 0) counts.set(key, left - 1);
        else introduced.push(d);
    }
    return introduced;
}

module.exports = {
    validateCode,
    diffDiagnostics,
    isValidatable,
    _test: { detectSourceType, validateJson },
};