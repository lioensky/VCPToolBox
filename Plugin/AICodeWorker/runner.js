"use strict";
// runner.js - 后台任务执行器
// 由 AICodeWorker.js 以 detached 方式启动，负责实际运行 opencode 并写入 meta 结果。
// 接收参数：process.argv[2] = args.json 文件路径

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// 读取配置（独立于主插件，自己读 config.env）
function loadConfig(pluginDir) {
    const envPath = path.join(pluginDir, "config.env");
    const result = {};
    if (!fs.existsSync(envPath)) return result;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    }
    return result;
}

async function run() {
    const argsFile = process.argv[2];
    if (!argsFile || !fs.existsSync(argsFile)) {
        process.exit(1);
    }

    let runArgs;
    try {
        runArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    } catch {
        process.exit(1);
    }

    const {
        jobId, jobRoot, opencodeBin, opencodeBaseUrl,
        projectPath, ocArgs, timeoutSec
    } = runArgs;

    const metaPath  = path.join(jobRoot, "meta",   `${jobId}.json`);
    const outputPath = path.join(jobRoot, "output", `${jobId}.txt`);
    const logPath    = path.join(jobRoot, "logs",   `${jobId}.log`);

    // 从插件目录读取配置（plugin dir = jobRoot 的父目录）
    const pluginDir = path.resolve(jobRoot, "..");
    const cfg = loadConfig(pluginDir);
    const model = cfg.OPENCODE_MODEL || "";

    // 默认让 opencode 用自己的内置免费模型（不重定向 API）。
    // 仅当 config.env 里同时配置了 OPENCODE_BASE_URL 和 OPENCODE_API_KEY 时，
    // 才把 opencode 的模型请求路由到 VCP 主链路（需要 VCP 里有对应模型配置）。
    const useVCPRouting = !!(cfg.OPENCODE_BASE_URL && cfg.OPENCODE_API_KEY);
    const childEnv = {
        ...process.env,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        no_proxy: "localhost,127.0.0.1",
        NO_PROXY: "localhost,127.0.0.1",
        ...(useVCPRouting ? {
            OPENAI_API_KEY:    cfg.OPENCODE_API_KEY,
            OPENAI_BASE_URL:   cfg.OPENCODE_BASE_URL.replace(/\/v1\/?$/, "") + "/v1",
            ANTHROPIC_API_KEY:  "",
            ANTHROPIC_BASE_URL: "",
        } : {})
    };

    // 有指定模型时注入 -m，无论是否走 VCP 路由
    if (model && !ocArgs.includes("--model") && !ocArgs.includes("-m")) {
        ocArgs.splice(1, 0, "-m", model);
    }

    // 打开输出文件（追加模式）
    const outFd = fs.openSync(outputPath, "a");
    const logFd = fs.openSync(logPath,    "a");

    let timedOut = false;
    const child = spawn(opencodeBin, ocArgs, {
        cwd:   projectPath,
        env:   childEnv,
        stdio: ["ignore", outFd, logFd]
    });

    // 更新 meta 中的 PID（可能已被 AICodeWorker 写入 runner 的 PID，这里改为 opencode 的 PID）
    try {
        const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        m.opencodePid = child.pid;
        fs.writeFileSync(metaPath, JSON.stringify(m, null, 2), "utf8");
    } catch {}

    // 超时处理
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
    }, (timeoutSec || 600) * 1000);

    await new Promise(resolve => child.on("close", resolve));
    clearTimeout(timeoutHandle);

    fs.closeSync(outFd);
    fs.closeSync(logFd);

    const exitCode = child.exitCode ?? 1;
    const suffix = timedOut
        ? `\n=== 任务超时 (${timeoutSec}s) 已终止 (${new Date().toISOString()}) ===\n`
        : `\n=== 完成 (退出码: ${exitCode}, 时间: ${new Date().toISOString()}) ===\n`;
    try { fs.appendFileSync(outputPath, suffix); } catch {}

    // 写入最终 meta
    try {
        const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (m.state === "running") {
            m.state      = timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed";
            m.exitCode   = exitCode;
            m.completedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(m, null, 2), "utf8");
        }
    } catch {}
}

run().catch(() => process.exit(1));
