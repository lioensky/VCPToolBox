"use strict";
// AICodeWorker - VCP 插件主入口
// 让 VCP Agent 可以安全调度本地 opencode / mimocode 执行代码分析和 patch 生成。
// 插件类型: synchronous / stdio。run 命令后台启动 runner.js 并立即返回 jobId。

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── 配置加载 ─────────────────────────────────────────────────────────────────

function loadConfig() {
    const envPath = path.join(__dirname, "config.env");
    const raw = {};
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const eq = t.indexOf("=");
            if (eq === -1) continue;
            const k = t.slice(0, eq).trim();
            const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
            raw[k] = v;
        }
    }
    return {
        enableOpencode:   (raw.ENABLE_OPENCODE   || "true")  !== "false",
        enableMimocode:   (raw.ENABLE_MIMOCODE   || "false") !== "false",
        opencodeBin:      raw.OPENCODE_BIN       || "opencode",
        opencodeBaseUrl:  raw.OPENCODE_BASE_URL  || "http://127.0.0.1:6005",
        opencodeApiKey:   raw.OPENCODE_API_KEY   || process.env.ANTHROPIC_API_KEY || "",
        allowedRoots:     (raw.ALLOWED_PROJECT_ROOTS || "/app/VCPToolBox_new,/app/ZhongZhuan,/app/claud")
                              .split(",").map(s => s.trim()).filter(Boolean),
        jobRoot:          raw.JOB_ROOT           || path.join(__dirname, "jobs"),
        maxTaskChars:     parseInt(raw.MAX_TASK_CHARS      || "20000", 10),
        defaultTimeout:   parseInt(raw.DEFAULT_TIMEOUT_SEC || "600",   10),
        allowDangerSkip:  (raw.ALLOW_DANGEROUS_SKIP_PERMISSIONS || "false") !== "false",
        redactSecrets:    (raw.REDACT_SECRETS    || "true")  !== "false",
    };
}

const CFG = loadConfig();

// ─── Job 路径 ─────────────────────────────────────────────────────────────────

function jobPaths(jobId) {
    return {
        output: path.join(CFG.jobRoot, "output", `${jobId}.txt`),
        log:    path.join(CFG.jobRoot, "logs",   `${jobId}.log`),
        patch:  path.join(CFG.jobRoot, "patches",`${jobId}.patch`),
        meta:   path.join(CFG.jobRoot, "meta",   `${jobId}.json`),
        args:   path.join(CFG.jobRoot, "meta",   `${jobId}.args.json`),
    };
}

function ensureJobDirs() {
    for (const sub of ["output", "logs", "patches", "meta"]) {
        const d = path.join(CFG.jobRoot, sub);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
}

function generateJobId() {
    const n = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return `job_${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}_${process.pid}`;
}

function readMeta(jobId) {
    const mp = jobPaths(jobId).meta;
    if (!fs.existsSync(mp)) return null;
    try { return JSON.parse(fs.readFileSync(mp, "utf8")); } catch { return null; }
}

function saveMeta(jobId, meta) {
    fs.writeFileSync(jobPaths(jobId).meta, JSON.stringify(meta, null, 2), "utf8");
}

// ─── 进程存活检测 ─────────────────────────────────────────────────────────────

function isProcessRunning(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

// ─── 密钥脱敏 ─────────────────────────────────────────────────────────────────

const SECRET_RE = [
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|x-api-key|Authorization)[^\n"',]*/gi,
    /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /(?:password|token|secret)[=:\s]+\S+/gi,
];

function redact(text) {
    if (!CFG.redactSecrets || !text) return text || "";
    let out = text;
    for (const re of SECRET_RE) out = out.replace(re, "***MASKED***");
    return out;
}

// ─── 路径白名单验证 ───────────────────────────────────────────────────────────

function validatePath(projectPath) {
    if (!projectPath || typeof projectPath !== "string") {
        return "projectPath 是必填参数。";
    }
    const resolved = path.resolve(projectPath);
    for (const root of CFG.allowedRoots) {
        const r = path.resolve(root);
        if (resolved === r || resolved.startsWith(r + path.sep)) return null;
    }
    return `projectPath "${resolved}" 不在白名单内。允许的路径: ${CFG.allowedRoots.join(", ")}`;
}

// ─── 安全前缀 ─────────────────────────────────────────────────────────────────

const PREFIX_ANALYZE = `【VCP AICodeWorker - 安全约束，必须严格遵守】
你作为只读代码分析 Worker 执行此任务：
- 只允许读取和分析文件
- 禁止修改、删除、移动、创建任何文件
- 禁止安装依赖（npm install / pip install 等）
- 禁止重启或停止服务
- 如需提出修改建议，以 diff/patch 格式输出，不得直接落盘
- 禁止在输出中包含 API Key、密码、Token 等敏感信息
【任务内容】
`;

const PREFIX_PATCH = `【VCP AICodeWorker - 安全约束，必须严格遵守】
你作为 patch 生成 Worker 执行此任务：
- 可以读取文件进行分析
- 必须以 unified diff 格式输出修改建议，每处修改单独一个 diff 块
- 禁止直接写入、修改、删除任何文件
- 禁止安装依赖、重启服务
- 禁止在输出中包含敏感信息
- 输出结尾附上：「已生成 N 处修改建议，等待审查确认后落盘。」
【任务内容】
`;

const PREFIX_WRITE = `【VCP AICodeWorker - write 模式，必须严格遵守以下约束】
你作为代码修改 Worker 执行此任务：
- 可以读取文件进行分析
- 可以修改/新增文件，但只能操作 task 中明确指定或直接相关的文件
- 禁止删除文件（除非 task 明确要求删除且说明原因）
- 禁止修改配置文件（*.env, config.env, .env.* 等）
- 禁止安装依赖（npm install / pip install 等）
- 禁止重启或停止任何服务
- 禁止在输出或文件内容中写入 API Key、密码、Token 等敏感信息
- 每次修改文件前先说明：修改哪个文件、改了什么、为什么
- 全部完成后输出变更摘要：列出所有被修改/新增的文件路径及变更简述
【任务内容】
`;

function wrapTask(task, mode) {
    if (mode === "patch")  return PREFIX_PATCH  + task;
    if (mode === "write")  return PREFIX_WRITE  + task;
    return PREFIX_ANALYZE + task;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdCapabilities() {
    const ocOk = await new Promise(resolve => {
        const p = spawn(CFG.opencodeBin, ["--version"], {
            env: process.env, stdio: ["ignore", "pipe", "ignore"]
        });
        let ver = "";
        p.stdout.on("data", d => { ver += d.toString(); });
        p.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        p.on("error", () => resolve({ ok: false, ver: "" }));
    });
    return {
        status: "success",
        workers: [
            {
                name: "opencode",
                available: CFG.enableOpencode && ocOk.ok,
                version: ocOk.ver || "unknown",
                supportsRun: true, supportsJson: true,
                supportsSession: true, supportsAttachments: true,
                dangerousSkipEnabled: CFG.allowDangerSkip,
                note: CFG.allowDangerSkip
                    ? "auto-approve 已启用，opencode 不会等待权限提示"
                    : "auto-approve 未启用，若 opencode 出现权限提示可能阻塞直到超时"
            },
            {
                name: "mimocode",
                available: false,
                note: "adapter 预留，暂未实现"
            }
        ]
    };
}

async function cmdRun(input) {
    const { worker = "opencode", projectPath, task, mode = "analyze",
            sessionId, attachments = [], timeoutSec } = input;

    if (!task)        return { status: "error", error: "task 是必填参数。" };
    if (task.length > CFG.maxTaskChars)
        return { status: "error", error: `task 超出最大长度 ${CFG.maxTaskChars} 字符。` };

    const pathErr = validatePath(projectPath);
    if (pathErr) return { status: "error", error: pathErr };

    if (worker !== "opencode")
        return { status: "error", error: `worker "${worker}" 暂未支持，当前仅支持: opencode` };
    if (!CFG.enableOpencode)
        return { status: "error", error: "opencode 已被禁用（ENABLE_OPENCODE=false）。" };

    // 检测 opencode 是否可用
    const ocOk = await new Promise(resolve => {
        const p = spawn(CFG.opencodeBin, ["--version"], {
            env: process.env, stdio: ["ignore", "pipe", "ignore"]
        });
        p.on("close", code => resolve(code === 0));
        p.on("error", () => resolve(false));
    });
    if (!ocOk)
        return { status: "error", error: `找不到 opencode（OPENCODE_BIN=${CFG.opencodeBin}），请确认已安装。` };

    ensureJobDirs();
    const jobId = generateJobId();
    const p = jobPaths(jobId);

    // 构造 opencode 参数数组（严格 spawn args，不拼 shell 字符串）
    const finalTask = wrapTask(task, mode);
    const ocArgs = ["run", "--format", "json", finalTask];
    if (sessionId) ocArgs.push("--session", String(sessionId));
    for (const f of attachments) {
        if (typeof f === "string" && f.trim()) ocArgs.push("-f", f.trim());
    }
    // write 模式自动开启 skip-permissions（opencode 需要此标志才能在非交互模式下写文件）
    if (mode === "write" || CFG.allowDangerSkip) ocArgs.push("--dangerously-skip-permissions");

    // runner 参数写入 args 文件（避免敏感信息出现在进程列表里）
    const runnerArgs = {
        jobId,
        jobRoot:   CFG.jobRoot,
        opencodeBin:    CFG.opencodeBin,
        opencodeBaseUrl: CFG.opencodeBaseUrl,
        // API Key 通过 runner.js 读取 config.env，不在 args 文件中
        projectPath: path.resolve(projectPath),
        ocArgs,
        timeoutSec: Number(timeoutSec) || CFG.defaultTimeout,
        redactSecrets: CFG.redactSecrets,
    };
    fs.writeFileSync(p.args, JSON.stringify(runnerArgs), "utf8");

    // 初始 meta
    const meta = {
        jobId, worker, mode,
        projectPath: path.resolve(projectPath),
        sessionId: sessionId || null,
        startedAt: new Date().toISOString(),
        state: "running",
        pid: null, exitCode: null, completedAt: null,
        ...p
    };
    saveMeta(jobId, meta);

    // 写 header 到输出文件
    fs.writeFileSync(p.output, [
        "=== AICodeWorker Job ===",
        `Job ID   : ${jobId}`,
        `Worker   : ${worker}`,
        `Project  : ${meta.projectPath}`,
        `Mode     : ${mode}`,
        `Started  : ${meta.startedAt}`,
        "==================="
    ].join("\n") + "\n\n", "utf8");

    // 后台启动 runner.js（detached + unref，主进程退出后继续运行）
    const runner = spawn(process.execPath, [path.join(__dirname, "runner.js"), p.args], {
        detached: true,
        stdio: "ignore",
        env: process.env
    });

    meta.pid = runner.pid;
    saveMeta(jobId, meta);
    runner.unref();

    return {
        status: "success",
        jobId,
        state: "running",
        pid: runner.pid,
        outputFile: p.output,
        logFile:    p.log,
        patchFile:  p.patch,
        message: `任务已提交。使用 query 命令查询进度：command=query, jobId=${jobId}`
    };
}

async function cmdQuery(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };

    const p = jobPaths(jobId);

    // 进程存活检测（runner.js 退出 = job 完成）
    if (meta.state === "running" && meta.pid && !isProcessRunning(meta.pid)) {
        meta.state = "completed";
        meta.completedAt = meta.completedAt || new Date().toISOString();
        saveMeta(jobId, meta);
    }

    // 读输出（截断超大文件）
    let output = "";
    if (fs.existsSync(p.output)) {
        const raw = fs.readFileSync(p.output, "utf8");
        const masked = redact(raw);
        output = masked.length > 50000
            ? "[输出已截断，仅显示最后 50000 字符]\n" + masked.slice(-50000)
            : masked;
    }

    let logSummary = "";
    if (fs.existsSync(p.log)) {
        const rawLog = fs.readFileSync(p.log, "utf8");
        const ml = redact(rawLog);
        logSummary = ml.length > 5000 ? "[日志已截断]\n" + ml.slice(-5000) : ml;
    }

    return {
        status: "success",
        jobId,
        state:       meta.state,
        exitCode:    meta.exitCode,
        startedAt:   meta.startedAt,
        completedAt: meta.completedAt,
        projectPath: meta.projectPath,
        mode:        meta.mode,
        output,
        logSummary,
        outputFile: p.output,
        logFile:    p.log,
        patchFile:  fs.existsSync(p.patch) ? p.patch : null,
    };
}

async function cmdListJobs(input) {
    ensureJobDirs();
    const metaDir = path.join(CFG.jobRoot, "meta");
    const limit = Math.min(parseInt(input.limit || "10", 10), 50);

    const files = fs.readdirSync(metaDir)
        .filter(f => f.endsWith(".json") && !f.endsWith(".args.json"))
        .sort().reverse().slice(0, limit);

    const jobs = [];
    for (const file of files) {
        try {
            const m = JSON.parse(fs.readFileSync(path.join(metaDir, file), "utf8"));
            if (m.state === "running" && m.pid && !isProcessRunning(m.pid)) {
                m.state = "completed";
                saveMeta(m.jobId, m);
            }
            jobs.push({
                jobId: m.jobId, state: m.state, worker: m.worker,
                mode: m.mode, projectPath: m.projectPath,
                startedAt: m.startedAt, completedAt: m.completedAt, exitCode: m.exitCode
            });
        } catch {}
    }
    return { status: "success", total: jobs.length, jobs };
}

async function cmdCancel(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    if (meta.state !== "running")
        return { status: "error", error: `Job "${jobId}" 状态为 "${meta.state}"，不是运行中。` };
    if (!meta.pid)
        return { status: "error", error: `Job "${jobId}" 无 PID 记录，无法取消。` };

    try {
        process.kill(Number(meta.pid), "SIGTERM");
        meta.state = "cancelled";
        meta.completedAt = new Date().toISOString();
        saveMeta(jobId, meta);
        const p = jobPaths(jobId);
        try { fs.appendFileSync(p.output, `\n=== 任务已手动取消 (${meta.completedAt}) ===\n`); } catch {}
        return { status: "success", jobId, message: `Job "${jobId}" 已发送 SIGTERM。` };
    } catch (err) {
        return { status: "error", error: `终止 PID ${meta.pid} 失败: ${err.message}` };
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;

    let input;
    try {
        input = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
        process.stdout.write(JSON.stringify({ status: "error", error: "stdin 不是合法 JSON。" }));
        return;
    }

    const cmd = (input.command || "").trim().toLowerCase();
    let result;
    try {
        switch (cmd) {
            case "capabilities": result = await cmdCapabilities(); break;
            case "run":          result = await cmdRun(input);          break;
            case "query":        result = await cmdQuery(input);         break;
            case "listjobs":     result = await cmdListJobs(input);      break;
            case "cancel":       result = await cmdCancel(input);        break;
            default:
                result = {
                    status: "error",
                    error: `未知命令 "${cmd}"。支持: capabilities, run, query, listJobs, cancel`
                };
        }
    } catch (err) {
        result = { status: "error", error: `插件内部错误: ${err.message}` };
    }

    // VCP 协议要求: 成功 → {status:"success", result:{...}}, 错误 → {status:"error", error:"..."}
    if (result.status === "error") {
        process.stdout.write(JSON.stringify(result));
    } else {
        const { status, ...payload } = result;
        process.stdout.write(JSON.stringify({ status, result: payload }));
    }
}

main().catch(err => {
    process.stdout.write(JSON.stringify({ status: "error", error: `插件崩溃: ${err.message}` }));
});
