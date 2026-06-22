"use strict";
// AICodeWorker - VCP 插件主入口 v1.6.0
// 让 VCP Agent 可以安全调度本地 opencode 执行代码分析和 patch 生成。
// 插件类型: synchronous / stdio。
//
// v1.5 核心升级：规范化报告输出
//   - 三种模式前缀末尾加入固定报告规范（文件清单 + 执行结果摘要锚点）
//   - buildResult 优先提取 【执行结果摘要】 锚点，新增 fileReadList 字段
//   - opencode 工作质量与上报质量双保证

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BACKOFF_RUN_WAIT = [2, 3, 5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BACKOFF_QUERY    = [5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

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
        opencodeBaseUrl:  raw.OPENCODE_BASE_URL  || "",
        // 不回退 process.env.ANTHROPIC_API_KEY：留空即走 opencode 免费模型，
        // 避免无意中把宿主的 key 注入、误用付费通道。
        opencodeApiKey:   raw.OPENCODE_API_KEY   || "",
        opencodeModel:    raw.OPENCODE_MODEL      || "",
        enableAntigravity:(raw.ENABLE_ANTIGRAVITY || "false") !== "false",
        agyBin:           raw.AGY_BIN             || "agy",
        agyModel:         raw.AGY_MODEL           || "",
        agyProxy:         raw.AGY_PROXY           || "http://127.0.0.1:7890",
        allowedRoots:     (raw.ALLOWED_PROJECT_ROOTS || "/app/VCPToolBox_new,/app/ZhongZhuan,/app/claud")
                              .split(",").map(s => s.trim()).filter(Boolean),
        jobRoot:          raw.JOB_ROOT           || path.join(__dirname, "jobs"),
        maxTaskChars:     parseInt(raw.MAX_TASK_CHARS      || "20000", 10),
        defaultTimeout:   parseInt(raw.DEFAULT_TIMEOUT_SEC || "600",   10),
        allowDangerSkip:  (raw.ALLOW_DANGEROUS_SKIP_PERMISSIONS || "false") !== "false",
        redactSecrets:    (raw.REDACT_SECRETS    || "true")  !== "false",
        projectContext:   raw.PROJECT_CONTEXT ? raw.PROJECT_CONTEXT.replace(/\\n/g, "\n") : "",
        fileSizeWarnKB:   parseInt(raw.FILE_SIZE_WARN_KB || "200", 10),
    };
}

const CFG = loadConfig();
let _ocVersionCache = null;

// ─── Job 路径 ─────────────────────────────────────────────────────────────────

function jobPaths(jobId) {
    return {
        output: path.join(CFG.jobRoot, "output",  `${jobId}.txt`),
        log:    path.join(CFG.jobRoot, "logs",    `${jobId}.log`),
        patch:  path.join(CFG.jobRoot, "patches", `${jobId}.patch`),
        meta:   path.join(CFG.jobRoot, "meta",    `${jobId}.json`),
        args:   path.join(CFG.jobRoot, "meta",    `${jobId}.args.json`),
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
    const p = x => String(x).padStart(2, "0");
    const rand = String(Math.floor(Math.random() * 9000) + 1000);
    return `job_${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}_${rand}`;
}

function readMeta(jobId) {
    const mp = jobPaths(jobId).meta;
    if (!fs.existsSync(mp)) return null;
    try { return JSON.parse(fs.readFileSync(mp, "utf8")); } catch { return null; }
}

function saveMeta(jobId, meta) {
    fs.writeFileSync(jobPaths(jobId).meta, JSON.stringify(meta, null, 2), "utf8");
}

function isProcessRunning(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

// ─── 密钥脱敏 ─────────────────────────────────────────────────────────────────

const SECRET_RE = [
    // 要求 key 名后面有 =: 分隔符 + 实际值（≥10字符），避免误伤源码变量名/正则
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|x-api-key)\s*[=:]\s*["']?[A-Za-z0-9\-_.+/]{10,}["']?/gi,
    /Authorization\s*:\s*\S{10,}/gi,
    /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /\b(?:password|token|secret)\b\s*[=:]\s*\S{6,}/gi,
];

function redact(text) {
    if (!CFG.redactSecrets || !text) return text || "";
    let out = text;
    for (const re of SECRET_RE) out = out.replace(re, "***MASKED***");
    return out;
}

// ─── 路径白名单验证 ───────────────────────────────────────────────────────────

function validatePath(projectPath) {
    if (!projectPath || typeof projectPath !== "string")
        return "projectPath 是必填参数。";
    const resolved = path.resolve(projectPath);
    for (const root of CFG.allowedRoots) {
        const r = path.resolve(root);
        if (resolved === r || resolved.startsWith(r + path.sep)) return null;
    }
    return `projectPath "${resolved}" 不在白名单内。允许的路径: ${CFG.allowedRoots.join(", ")}`;
}

// ─── Preset 快捷任务库（v1.6）────────────────────────────────────────────────
// 低算力模型只需传 preset + targetPath（+ 少量附加参数），插件自动生成任务书和 mode。
// projectPath 在未提供时从 targetPath 自动推导。

const PRESETS = {
    index: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "列出文件的所有函数/方法索引（行号·名称·功能）",
        generate: (p) =>
            `请读取 ${p.targetPath}，列出所有函数/方法的完整索引。\n` +
            `每行格式：行号 | 函数名 | 功能描述（≤20字）\n` +
            `不修改任何文件。`,
    },
    read: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "读取文件完整内容并原文输出",
        generate: (p) =>
            `请读取 ${p.targetPath} 的完整内容并原文输出。不修改任何文件。`,
    },
    scan: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "扫描目录结构，列出文件树 + 用途说明",
        generate: (p) =>
            `请扫描 ${p.targetPath}` +
            (p.depth ? `（最多 ${p.depth} 层）` : "") +
            `，列出目录/文件树形结构，每个文件附一句用途说明。不修改任何文件。`,
    },
    bug: {
        mode: "analyze",
        required: ["targetPath", "error"],
        desc: "分析文件中某个错误的根本原因",
        generate: (p) =>
            `请分析 ${p.targetPath} 中以下错误的根本原因：\n` +
            `错误信息：${p.error}\n` +
            (p.detail ? `附加上下文：${p.detail}\n` : "") +
            `只输出分析报告，不修改任何文件。`,
    },
    set: {
        mode: "write",
        required: ["targetPath", "key", "value"],
        desc: "修改文件中某个配置项/变量的值",
        generate: (p) =>
            `请修改 ${p.targetPath}，将 ${p.key} 的值改为 ${p.value}。\n` +
            `约束：只改这一处，禁止修改其他内容或其他文件。\n` +
            `验证：修改后用 grep 搜索 "${p.key}" 并在报告中附输出。`,
    },
    append: {
        mode: "write",
        required: ["targetPath", "content"],
        desc: "在文件末尾（或指定位置）追加内容",
        generate: (p) =>
            `请在 ${p.targetPath} 的${p.position || "末尾"}追加以下内容：\n` +
            `${p.content}\n` +
            `约束：只追加，禁止修改已有内容，禁止操作其他文件。\n` +
            `验证：追加后读取文件末尾 20 行并在报告中附输出。`,
    },
    create: {
        mode: "write",
        required: ["targetPath", "what"],
        desc: "创建或覆写一个文件",
        generate: (p) =>
            `请在 ${p.targetPath} 创建（或覆写）文件，内容要求如下：\n` +
            `${p.what}\n` +
            `约束：只操作这一个文件，禁止修改其他文件。\n` +
            `验证：写入完成后读取文件前 30 行并在报告中附输出。`,
    },
};

/**
 * 处理 preset 快捷参数。
 * 成功返回新的 input 对象（task/mode/projectPath 已填充）；
 * 验证失败返回 {status:"error"} 对象；
 * 未传 preset 返回 null。
 */
function applyPreset(input) {
    const preset = (input.preset || "").trim().toLowerCase();
    if (!preset) return null;

    const def = PRESETS[preset];
    if (!def) {
        const list = Object.entries(PRESETS)
            .map(([k, v]) => `  ${k}：${v.desc}`)
            .join("\n");
        return { status: "error", error: `未知预设 "${input.preset}"。可用预设：\n${list}` };
    }

    const missing = def.required.filter(k => !input[k]);
    if (missing.length > 0) {
        return {
            status: "error",
            error: `预设 "${preset}" 缺少必填参数：${missing.join(", ")}。` +
                   `\n该预设说明：${def.desc}` +
                   `\n必填：${def.required.join(", ")}`,
        };
    }

    // projectPath 未提供时从 targetPath 自动推导
    let projectPath = input.projectPath;
    if (!projectPath && input.targetPath) {
        try {
            const stat = fs.statSync(input.targetPath);
            projectPath = stat.isDirectory() ? input.targetPath : path.dirname(input.targetPath);
        } catch {
            projectPath = path.dirname(input.targetPath);
        }
    }

    return {
        ...input,
        task:        def.generate(input),
        mode:        input.mode || def.mode,
        projectPath: projectPath || input.projectPath,
    };
}

// ─── 报告规范尾部（三种模式共用）─────────────────────────────────────────────
// v1.5 核心：强制 opencode 在报告末尾输出固定格式锚点
// buildResult 优先提取【执行结果摘要】，VCP AI 无需重读全文

const REPORT_FOOTER_ANALYZE = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 报告正文用 ▍01 · 标题 / ▍02 · 标题 格式分节，每节标题清晰
② 发现关键风险/坑点/异常时用 ⚠️ 明显标出
③ 结论基于推断而非直接读取时，必须注明：「此处基于推断，未直读源文件」
④ 报告最后必须输出以下两行（格式固定，不得省略）：
【读取文件清单】已读：<逗号分隔的文件路径列表> | 跳过/未读：<文件及原因，无则写"无">
【执行结果摘要】<60字以内一句话：做了什么 · 发现了什么 · 结论是什么>`;

const REPORT_FOOTER_PATCH = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 每个 diff 块前说明：修改原因 + 影响范围
② diff 格式：标准 unified diff，上下文保留 3 行，行号必须准确
③ 若某处修改有风险，用 ⚠️ 标注并说明原因
④ 报告最后必须输出以下三行（格式固定，不得省略）：
【读取文件清单】已读：<文件列表> | 跳过：<文件及原因，无则写"无">
【变更摘要】共 N 处修改 | 涉及文件：<列表> | 风险点：<若有则列出，无则写"无">
【执行结果摘要】<60字以内一句话：生成了什么补丁 · 解决了什么问题 · 是否有风险>`;

const REPORT_FOOTER_WRITE = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 每次修改文件前说明：修改哪个文件、改了什么、为什么
② 修改完成后必须读取文件确认写入成功（ls -la 或 cat 关键行）
③ 发现与预期不符时立即停止并说明，不要强行继续
④ 报告最后必须输出以下三行（格式固定，不得省略）：
【读取文件清单】已读：<列表> | 已修改：<列表> | 已新增：<列表> | 已删除：<列表，无则写"无">
【变更摘要】<逐文件一行描述：路径 → 做了什么变更>
【执行结果摘要】<60字以内一句话：改了什么 · 验证结果如何 · 是否完全成功>`;

// ─── 安全前缀 ─────────────────────────────────────────────────────────────────

const PREFIX_ANALYZE = `【VCP AICodeWorker - analyze 模式，安全约束必须严格遵守】
你作为只读代码分析 Worker 执行此任务：
- 只允许读取和分析文件，禁止修改、删除、移动、创建任何文件
- 禁止安装依赖（npm install / pip install 等），禁止重启或停止服务
- 如需提出修改建议，以 diff/patch 格式输出，不得直接落盘
- 禁止在输出中包含 API Key、密码、Token 等敏感信息
【任务内容】
`;

const PREFIX_PATCH = `【VCP AICodeWorker - patch 模式，安全约束必须严格遵守】
你作为 patch 生成 Worker 执行此任务：
- 可以读取文件进行分析
- 必须以 unified diff 格式输出修改建议，每处修改单独一个 diff 块
- 禁止直接写入、修改、删除任何文件，禁止安装依赖、重启服务
- 禁止在输出中包含敏感信息
【任务内容】
`;

const PREFIX_WRITE = `【VCP AICodeWorker - write 模式，安全约束必须严格遵守】
你作为代码修改 Worker 执行此任务：
- 可以读取文件进行分析
- 可以修改/新增文件，但只能操作 task 中明确指定或直接相关的文件
- 禁止删除文件（除非 task 明确要求删除且说明原因）
- 禁止修改配置文件（*.env, config.env, .env.* 等）
- 禁止安装依赖（npm install / pip install 等），禁止重启或停止任何服务
- 禁止在输出或文件内容中写入 API Key、密码、Token 等敏感信息
【任务内容】
`;

// ─── 任务书预检 ───────────────────────────────────────────────────────────────

const VAGUE_VERBS    = /看一下|处理一下|优化一下|整理一下|随便|帮我看看|感觉|好像|试试|弄一下|搞一下|清理一下(?!.{0,30}\/)/;
const HAS_ABS_PATH   = /\/[a-zA-Z0-9_一-龥]/;
const HAS_CONSTRAINT = /禁止|只改|不要|仅|只有|排除|不能|不得|不允许/;
const HAS_VERIFY     = /验证|ls |ls$|cat |check|确认|ENOENT|\$\?/;
const DANGER_OPS     = /\brm\b|删除|清空|移动|\bmv\b|truncate|unlink/;

function preflightCheck(task, mode) {
    const warnings = [];
    if (VAGUE_VERBS.test(task))
        warnings.push({ level: "warn",  message: "任务描述含模糊动词（看一下/处理一下等），opencode 可能偏离意图；建议改为明确动作动词。" });
    if ((mode === "write" || mode === "patch") && !HAS_ABS_PATH.test(task))
        warnings.push({ level: "error", message: "write/patch 模式未检测到绝对路径（/开头），建议改用绝对路径防止工作目录歧义。" });
    if (mode === "write" && !HAS_CONSTRAINT.test(task))
        warnings.push({ level: "warn",  message: "write 模式未包含操作约束（禁止/只改/不要等），opencode 可能顺手修改无关文件。" });
    if (mode === "write" && DANGER_OPS.test(task) && !HAS_VERIFY.test(task))
        warnings.push({ level: "error", message: "任务含删除/移动操作但未要求验证步骤，建议加：'操作前后必须 ls -la 验证并在报告中附输出'。" });
    return warnings;
}

// ─── 大文件预检 ───────────────────────────────────────────────────────────────

const FILE_PATH_RE = /(?:^|[\s"'`(（])(\/[^\s"'`)\n）]{3,})/gm;

function checkFileSizes(task) {
    const warnings = [];
    const seen = new Set();
    let m;
    FILE_PATH_RE.lastIndex = 0;
    while ((m = FILE_PATH_RE.exec(task)) !== null) {
        const fp = m[1].replace(/[,。、）)】]+$/, "");
        if (seen.has(fp)) continue;
        seen.add(fp);
        const isAllowed = CFG.allowedRoots.some(r => fp.startsWith(path.resolve(r)));
        if (!isAllowed) continue;
        try {
            const stat = fs.statSync(fp);
            if (!stat.isFile()) continue;
            const kb = stat.size / 1024;
            if (kb > CFG.fileSizeWarnKB) {
                warnings.push({
                    level: "warn",
                    message: `文件 ${fp} 约 ${Math.round(kb)}KB（超过 ${CFG.fileSizeWarnKB}KB 阈值），opencode 全量读取可能超时或质量下降；建议缩小范围（指定函数名/行号，或先 grep 过滤）。`
                });
            }
        } catch {}
    }
    return warnings;
}

// ─── 危险操作自动补丁 ─────────────────────────────────────────────────────────

const DANGER_VERIFY_PATCH = `

【AICodeWorker 安全补丁 - 自动注入】
检测到删除/移动操作，强制执行三步验证协议：
① 操作前：ls -la <目标路径> 确认目标存在
② 执行操作
③ 操作后：ls -la <目标路径> 验证结果（删除则确认 ENOENT/No such file）
最终报告必须包含每步的实际命令输出，不允许只写"已完成"。`;

// ─── 任务包装（注入前缀 + 项目上下文 + 报告规范尾部）────────────────────────

function wrapTask(task, mode) {
    const ctx = CFG.projectContext
        ? `\n【项目上下文 - 自动注入，供 Worker 参考】\n${CFG.projectContext}\n\n`
        : "";
    if (mode === "patch") {
        return PREFIX_PATCH + ctx + task + REPORT_FOOTER_PATCH;
    }
    if (mode === "write") {
        const needsPatch = DANGER_OPS.test(task) && !HAS_VERIFY.test(task);
        return PREFIX_WRITE + ctx + task + (needsPatch ? DANGER_VERIFY_PATCH : "") + REPORT_FOOTER_WRITE;
    }
    return PREFIX_ANALYZE + ctx + task + REPORT_FOOTER_ANALYZE;
}

// ─── 结果构建 ─────────────────────────────────────────────────────────────────
// v1.5：新增 fileReadList 字段；summary 优先提取【执行结果摘要】固定锚点

function buildResult(jobId, meta) {
    const p = jobPaths(jobId);

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

    // 提取【读取文件清单】→ fileReadList 字段，让 VCP AI 知道 opencode 读了哪些文件
    let fileReadList = "";
    if (output) {
        const frm = output.match(/【读取文件清单】[^\n]*/);
        if (frm) fileReadList = frm[0].trim();
    }

    // 摘要提取优先级：① summaryHint → ② 【执行结果摘要】锚点 → ③ 变更摘要等关键词 → ④ 尾部截取
    let summary = "";
    if (output) {
        const hint = meta && meta.summaryHint;
        if (hint) {
            const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // 非贪婪匹配，遇到空行、【新节】或字符串结尾即停，避免截入无关内容
            const hm = output.match(new RegExp(escaped + "[\\s\\S]{0,250}?(?=\\n{2,}|【|$)", "i"));
            if (hm) summary = hm[0].slice(0, 220).trim();
        }
        if (!summary) {
            // 优先提取固定锚点（v1.5 报告规范强制输出）
            const anchor = output.match(/【执行结果摘要】[^\n]{1,200}/);
            if (anchor) summary = anchor[0].trim();
        }
        if (!summary) {
            const summaryMatch = output.match(/(?:变更摘要|执行结果|完成|总结|验证结果)[\s\S]{0,800}/i);
            summary = summaryMatch
                ? summaryMatch[0].slice(0, 400).trim()
                : output.replace(/^[\s\S]*?\n\n/, "").slice(-300).trim();
        }
    }

    return {
        status:      "success",
        jobId,
        state:       meta.state,
        exitCode:    meta.exitCode,
        startedAt:   meta.startedAt,
        completedAt: meta.completedAt,
        projectPath: meta.projectPath,
        mode:        meta.mode,
        fileReadList, // v1.5 新增：opencode 读了哪些文件
        summary,      // 优先锚点提取，比 v1.4 更准确
        output,
        logSummary,
        outputFile: p.output,
        logFile:    p.log,
        patchFile:  fs.existsSync(p.patch) ? p.patch : null,
    };
}

function checkAndMarkDead(meta, jobId, source) {
    if (meta.state === "running" && meta.pid && !isProcessRunning(meta.pid)) {
        meta.state = "failed";
        meta.completedAt = new Date().toISOString();
        meta.exitReason = `runner 进程意外退出（${source} 检测）`;
        saveMeta(jobId, meta);
    }
    return meta;
}

// ─── 探活缓存 ─────────────────────────────────────────────────────────────────

async function checkOcVersion() {
    if (_ocVersionCache && (Date.now() - _ocVersionCache.ts) < 300000)
        return _ocVersionCache;
    const result = await new Promise(resolve => {
        const p = spawn(CFG.opencodeBin, ["--version"], {
            env: process.env, stdio: ["ignore", "pipe", "ignore"]
        });
        let ver = "";
        p.stdout.on("data", d => { ver += d.toString(); });
        p.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        p.on("error", () => resolve({ ok: false, ver: "" }));
    });
    _ocVersionCache = { ...result, ts: Date.now() };
    return _ocVersionCache;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

let _agyVersionCache = null;
async function checkAgyVersion() {
    if (_agyVersionCache && (Date.now() - _agyVersionCache.ts) < 300000)
        return _agyVersionCache;
    const result = await new Promise(resolve => {
        const ap = spawn(CFG.agyBin, ["--version"], {
            env: { ...process.env, PATH: `${process.env.HOME || ""}/.local/bin:${process.env.PATH || ""}` },
            stdio: ["ignore", "pipe", "ignore"]
        });
        let ver = "";
        ap.stdout.on("data", d => { ver += d.toString(); });
        ap.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        ap.on("error", () => resolve({ ok: false, ver: "" }));
    });
    _agyVersionCache = { ...result, ts: Date.now() };
    return _agyVersionCache;
}

async function cmdCapabilities() {
    const ocOk = await checkOcVersion();
    const agyOk = CFG.enableAntigravity ? await checkAgyVersion() : { ok: false, ver: "" };
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
                name: "antigravity",
                available: CFG.enableAntigravity && agyOk.ok,
                version: agyOk.ver || "unknown",
                note: CFG.enableAntigravity
                    ? "复杂/严谨任务专用 · Gemini Pro 配额(约1500/天) · worker:antigravity 调用"
                    : "未启用(ENABLE_ANTIGRAVITY=false),复杂任务需在 config.env 开启"
            },
            { name: "mimocode", available: false, note: "adapter 预留，暂未实现" }
        ]
    };
}

async function cmdRun(input) {
    // v1.6: preset 快捷方式 — 自动生成 task / mode / projectPath
    if (input.preset) {
        const presetResult = applyPreset(input);
        if (presetResult && presetResult.status === "error") return presetResult;
        if (presetResult) input = presetResult;
    }

    const { worker = "opencode", projectPath, task, mode = "analyze",
            sessionId, attachments = [], timeoutSec, summaryHint, model } = input;

    if (!task)
        return { status: "error", error: "task 是必填参数。若要快速上手可使用 preset 参数，例如：preset=index, targetPath=/path/to/file.js" };
    if (task.length > CFG.maxTaskChars)
        return { status: "error", error: `task 超出最大长度 ${CFG.maxTaskChars} 字符。` };

    const pathErr = validatePath(projectPath);
    if (pathErr) return { status: "error", error: pathErr };

    const normWorker = (worker === "agy") ? "antigravity" : worker;
    if (normWorker !== "opencode" && normWorker !== "antigravity")
        return { status: "error", error: `worker "${worker}" 不支持。可用: opencode, antigravity` };

    ensureJobDirs();
    const jobId = generateJobId();
    const p = jobPaths(jobId);
    const finalTask = wrapTask(task, mode);
    const wantSkip = (mode === "write" || CFG.allowDangerSkip);
    const timeoutS = Number(timeoutSec) || CFG.defaultTimeout;

    let runnerArgs;
    if (normWorker === "opencode") {
        if (!CFG.enableOpencode)
            return { status: "error", error: "opencode 已被禁用（ENABLE_OPENCODE=false）。" };
        const ocOk = await checkOcVersion();
        if (!ocOk.ok)
            return { status: "error", error: `找不到 opencode（OPENCODE_BIN=${CFG.opencodeBin}），请确认已安装。` };
        const ocArgs = ["run", "--format", "json"];
        if (CFG.opencodeModel)  ocArgs.push("-m", CFG.opencodeModel);
        if (sessionId)          ocArgs.push("--session", String(sessionId));
        for (const f of attachments) {
            if (typeof f === "string" && f.trim()) ocArgs.push("-f", f.trim());
        }
        if (wantSkip) ocArgs.push("--dangerously-skip-permissions");
        ocArgs.push(finalTask);
        runnerArgs = {
            jobId, jobRoot: CFG.jobRoot, worker: "opencode",
            opencodeBin: CFG.opencodeBin, opencodeBaseUrl: CFG.opencodeBaseUrl,
            projectPath: path.resolve(projectPath),
            ocArgs,
            timeoutSec: timeoutS,
            redactSecrets: CFG.redactSecrets,
        };
    } else {
        if (!CFG.enableAntigravity)
            return { status: "error", error: "Antigravity 未启用（ENABLE_ANTIGRAVITY=false）。请用 worker=opencode 或在 config.env 开启。" };
        const agyOk = await checkAgyVersion();
        if (!agyOk.ok)
            return { status: "error", error: `找不到 agy（AGY_BIN=${CFG.agyBin}），请确认 Antigravity CLI 已安装。` };
        const agyModel = (typeof model === "string" && model.trim()) ? model.trim() : CFG.agyModel;
        const agyArgs = ["--print", finalTask, "--print-timeout", `${timeoutS}s`];
        if (agyModel) agyArgs.push("--model", agyModel);
        if (wantSkip) agyArgs.push("--dangerously-skip-permissions");
        runnerArgs = {
            jobId, jobRoot: CFG.jobRoot, worker: "antigravity",
            agyBin: CFG.agyBin, agyProxy: CFG.agyProxy,
            projectPath: path.resolve(projectPath),
            agyArgs,
            timeoutSec: timeoutS,
            redactSecrets: CFG.redactSecrets,
        };
    }
    fs.writeFileSync(p.args, JSON.stringify(runnerArgs), "utf8");

    const warnings = [...preflightCheck(task, mode), ...checkFileSizes(task)];

    const meta = {
        jobId, worker, mode,
        projectPath:  path.resolve(projectPath),
        sessionId:    sessionId || null,
        summaryHint:  summaryHint || null,
        startedAt:    new Date().toISOString(),
        state: "running",
        pid: null, exitCode: null, completedAt: null,
        warnings,
        ...p
    };
    saveMeta(jobId, meta);

    fs.writeFileSync(p.output, [
        "=== AICodeWorker Job ===",
        `Job ID   : ${jobId}`,
        `Worker   : ${worker}`,
        `Project  : ${meta.projectPath}`,
        `Mode     : ${mode}`,
        `Started  : ${meta.startedAt}`,
        "==================="
    ].join("\n") + "\n\n", "utf8");

    const runner = spawn(process.execPath, [path.join(__dirname, "runner.js"), p.args], {
        detached: true, stdio: "ignore", env: process.env
    });
    meta.pid = runner.pid;
    saveMeta(jobId, meta);
    runner.unref();

    return {
        status: "success", jobId, state: "running", pid: runner.pid,
        warnings, outputFile: p.output, logFile: p.log, patchFile: p.patch,
        message: `任务已提交。使用 query 命令查询进度：command=query, jobId=${jobId}`
    };
}

async function cmdRunAndWait(input) {
    const runResult = await cmdRun(input);
    if (runResult.status === "error") return runResult;
    const { jobId } = runResult;

    for (const sec of BACKOFF_RUN_WAIT) {
        await sleep(sec * 1000);
        let meta = readMeta(jobId);
        if (!meta) return { status: "error", error: `Job "${jobId}" 元数据丢失。` };
        meta = checkAndMarkDead(meta, jobId, "run_and_wait");
        if (meta.state !== "running") {
            const result = buildResult(jobId, meta);
            result.warnings = meta.warnings || [];
            return result;
        }
    }

    const meta = readMeta(jobId);
    return {
        status: "success", jobId, state: "running",
        warnings: meta?.warnings || [],
        startedAt: meta?.startedAt, suggestedWaitSec: 0,
        hint: "任务超过 7 分钟仍在运行，请立即调用一次 query（query 内部同样会等待约 7 分钟，无需频繁调用）"
    };
}

async function cmdQuery(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    let meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    if (meta.state !== "running") return buildResult(jobId, meta);

    for (const sec of BACKOFF_QUERY) {
        await sleep(sec * 1000);
        meta = readMeta(jobId);
        if (!meta) break;
        meta = checkAndMarkDead(meta, jobId, "query");
        if (meta.state !== "running") break;
    }
    meta = readMeta(jobId) || meta;

    if (meta.state === "running") {
        return {
            status: "success", jobId, state: "running",
            warnings: meta.warnings || [],
            startedAt: meta.startedAt, suggestedWaitSec: 0,
            hint: "任务仍在运行，请再调用一次 query（query 会自动内部等待，无需频繁调用）"
        };
    }
    return buildResult(jobId, meta);
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
            let m = JSON.parse(fs.readFileSync(path.join(metaDir, file), "utf8"));
            m = checkAndMarkDead(m, m.jobId, "listJobs");
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
        try { fs.appendFileSync(jobPaths(jobId).output, `\n=== 任务已手动取消 (${meta.completedAt}) ===\n`); } catch {}
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
            case "capabilities":  result = await cmdCapabilities();   break;
            case "run":           result = await cmdRun(input);        break;
            case "run_and_wait":  result = await cmdRunAndWait(input); break;
            case "query":         result = await cmdQuery(input);      break;
            case "listjobs":      result = await cmdListJobs(input);   break;
            case "cancel":        result = await cmdCancel(input);     break;
            default:
                result = { status: "error", error: `未知命令 "${cmd}"。支持: capabilities, run, run_and_wait, query, listJobs, cancel` };
        }
    } catch (err) {
        result = { status: "error", error: `插件内部错误: ${err.message}` };
    }
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
