#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// 读取同级目录的 config.env
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });

const configuredPort = Number.parseInt(process.env.TOMATO_DOWNLOADER_PORT || '18423', 10);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 18423;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const DEFAULT_EXE_PATH = '';

// 帮助实现简易 HTTP 请求的 Promise 包装（使用 Node.js 原生 http）
function httpRequest(method, urlPath, bodyData = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1',
            port: PORT,
            path: urlPath,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`HTTP Status ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (e) => { reject(e); });

        if (bodyData) {
            req.write(JSON.stringify(bodyData));
        }
        req.end();
    });
}

// 检查服务是否在线，若不在线则自动拉起
async function ensureServerOnline() {
    try {
        // 尝试发送一个极速的 ping 请求 (timeout 1.5s)
        await Promise.race([
            httpRequest('GET', '/api/jobs'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1500))
        ]);
        return; // 在线，直接返回
    } catch (err) {
        // 不在线，开始执行拉起逻辑
        const exePath = process.env.TOMATO_DOWNLOADER_PATH || DEFAULT_EXE_PATH;
        const cwd = process.env.TOMATO_DOWNLOADER_CWD || (exePath ? path.dirname(exePath) : process.cwd());

        if (!fs.existsSync(exePath)) {
            throw new Error('未配置或找不到 TomatoNovelDownloader.exe，请设置 TOMATO_DOWNLOADER_PATH。');
        }

        const childEnv = { ...process.env };
        const proxy = process.env.TOMATO_HTTP_PROXY;
        if (proxy) {
            childEnv.HTTP_PROXY = proxy;
            childEnv.HTTPS_PROXY = proxy;
        }

        // 以分离模式（detached）在后台拉起下载器
        const serverProcess = spawn(exePath, ['--server'], {
            cwd: cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: {
                ...childEnv
            }
        });

        serverProcess.on('error', (spawnErr) => {
            console.error(`[TomatoNovel] 拉起后台进程失败: ${spawnErr.message}`);
        });

        serverProcess.unref();

        // 自旋探测端口就绪状态，最多重试 15 次 (约 6.0 秒)
        for (let i = 0; i < 15; i++) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            try {
                await Promise.race([
                    httpRequest('GET', '/api/jobs'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 800))
                ]);
                return; // 通了，说明服务完全就绪！
            } catch (pingErr) {
                // 忽略，等待下一次轮询自旋
            }
        }
        throw new Error(`后台下载服务已拉起，但自旋探测未能通 ${PORT} 端口，可能初始化失败。`);
    }
}

// 从 stdin 读取参数
function readInput() {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk) => { data += chunk; });
        stdin.on('end', () => { resolve(data); });
        if (stdin.isTTY) { resolve('{}'); }
    });
}

async function handleSearch(query) {
    const data = await httpRequest('GET', `/api/search?q=${encodeURIComponent(query)}`);
    const books = data.items || [];

    if (books.length === 0) {
        return {
            status: 'success',
            result: `未能在番茄小说上搜索到与 "${query}" 相关的书籍。`
        };
    }

    // 格式化为非常漂亮的 Markdown 表格
    let md = [];
    md.push(`### 🔍 针对 "${query}" 的番茄小说搜索结果 (共 ${books.length} 本)`);
    md.push("| 序号 | 书名 | 作者 | 类别/标签 | 在读人数 | 书籍 ID |");
    md.push("|:---:|:---|:---|:---|:---|:---|");

    books.forEach((book, idx) => {
        const title = book.title || (book.raw && book.raw.book_name) || "未知";
        const author = book.author || (book.raw && book.raw.author) || "未知";
        const category = book.raw ? book.raw.pure_category_tags || book.raw.category || "无" : "无";
        const score = book.raw ? book.raw.score || "无评分" : "无评分";
        const readers = book.raw ? book.raw.read_cnt_text || "未知" : "未知";
        const book_id = book.book_id;
        md.push(`| ${idx + 1} | **${title}** | ${author} | \`${category}\` | ${readers} (评分: ${score}) | \`${book_id}\` |`);
    });

    return {
        status: 'success',
        result: md.join('\n')
    };
}

async function handleDownload(bookId, rangeStart = null, rangeEnd = null, isIntroOnly = false) {
    // 1. 创建下载 Job
    const jobReq = { book_id: bookId };
    if (rangeStart !== null && rangeEnd !== null) {
        jobReq.range_start = rangeStart;
        jobReq.range_end = rangeEnd;
    }

    let jobResp;
    try {
        jobResp = await httpRequest('POST', '/api/jobs', jobReq);
    } catch (postErr) {
        if (postErr.message && postErr.message.includes('429')) {
            // 遇到了 429 并发限制，开始自动清理挂起在 Rust 内存里的旧任务占用的通道
            try {
                const activeJobs = await httpRequest('GET', '/api/jobs');
                const items = activeJobs.items || [];
                for (const item of items) {
                    const activeJobId = item.id;
                    // 发送 cancel 请求以强行移除和停止旧的无主活跃任务
                    await httpRequest('POST', `/api/jobs/${activeJobId}/cancel`, {});
                }
                // 等待 1.0 秒给后端释放通道
                await new Promise((resolve) => setTimeout(resolve, 1000));
                // 重新尝试提交创建任务
                jobResp = await httpRequest('POST', '/api/jobs', jobReq);
            } catch (retryErr) {
                throw new Error(`并发下载通道被占用 (HTTP 429)，且自动清理重试失败: ${retryErr.message}`);
            }
        } else {
            throw postErr;
        }
    }
    const jobId = jobResp.id;

    // 2. 轮询等待任务结束，并自动提交名字/格式选择
    let jobDone = false;
    let jobResult = null;
    const maxRetries = 400; // 调大轮询以防全本下载时间长

    for (let check = 0; check < maxRetries; check++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const jobsData = await httpRequest('GET', '/api/jobs');
        const items = jobsData.items || [];

        let currentJob = items.find(item => item.id === jobId);
        if (!currentJob) {
            // 不在活跃任务中，去 history 查
            const historyData = await httpRequest('GET', '/api/history');
            const historyItems = historyData.items || [];
            currentJob = historyItems.find(item => item.id === jobId);

            if (!currentJob) {
                // 如果历史里也没有，可能被清理了，或者是完成了
                jobDone = true;
                break;
            }
        }

        const status = currentJob.status || {};
        const stateStr = currentJob.state || "";

        // 自动选择书名
        if (currentJob.book_name_options && currentJob.book_name_options.length > 0) {
            const choice = currentJob.book_name_options[0];
            await httpRequest('POST', `/api/jobs/${jobId}/book_name`, { value: choice });
        }

        // 自动选择格式
        if (currentJob.format_options && currentJob.format_options.length > 0) {
            const choice = currentJob.format_options[0];
            await httpRequest('POST', `/api/jobs/${jobId}/format`, { value: choice });
        }

        // 成功或失败判定
        if (stateStr === 'done' || stateStr.includes('Done') || stateStr.includes('Success')) {
            jobDone = true;
            jobResult = { status: 'success', currentJob };
            break;
        } else if (stateStr === 'failed' || stateStr.includes('Failed')) {
            jobDone = true;
            jobResult = { status: 'error', error: currentJob.message || "下载任务失败" };
            break;
        }
    }

    if (!jobDone) {
        throw new Error("下载任务轮询超时，仍在后台运行中。");
    }

    if (jobResult.status === 'error') {
        return {
            status: 'error',
            error: jobResult.error
        };
    }

    // 3. 定位生成的 EPUB 文件物理路径
    const bookTitle = jobResult.currentJob.title || "未知小说";
    const exePath = process.env.TOMATO_DOWNLOADER_PATH || DEFAULT_EXE_PATH;
    const downloadDir = process.env.TOMATO_DOWNLOAD_DIR || (exePath ? path.dirname(exePath) : process.cwd());

    // 番茄下载器默认会把小说打包保存在下载目录的 "<书名>.epub"
    let epubPath = path.join(downloadDir, `${bookTitle}.epub`);

    if (!fs.existsSync(epubPath)) {
        const fallbackPath = path.join(downloadDir, `${bookId}.epub`);
        if (fs.existsSync(fallbackPath)) {
            try {
                fs.renameSync(fallbackPath, epubPath);
                console.error(`[TomatoNovel] Web fallback detected, renamed ${bookId}.epub to ${bookTitle}.epub`);
            } catch (renameErr) {
                epubPath = fallbackPath; // 重命名失败则直接使用 bookId.epub 路径
            }
        }
    }

    if (!fs.existsSync(epubPath)) {
        return {
            status: 'error',
            error: `下载已标记完成，但是在输出目录下未能定位到 EPUB 文件: ${epubPath}`
        };
    }

    // 4. 处理 "仅下载首页和目录" 的大纲模式
    if (isIntroOnly) {
        return new Promise((resolve) => {
            const scriptPath = path.join(__dirname, 'extract_intro.py');
            exec(`python "${scriptPath}" "${epubPath}"`, (err, stdout, stderr) => {
                // 读取完大纲后，因为只是临时的大纲包，自动清理这个只下了 1 章的临时 epub 文件以节省磁盘空间！
                try {
                    fs.unlinkSync(epubPath);
                } catch (e) {}

                if (err) {
                    resolve({
                        status: 'error',
                        error: `提取大纲失败: ${stderr || err.message}`
                    });
                } else {
                    resolve({
                        status: 'success',
                        result: `### 📖 《${bookTitle}》 首页与大纲信息已成功提取！\n\n` + stdout.trim()
                    });
                }
            });
        });
    }

    // 5. 全本精准下载模式
    return {
        status: 'success',
        result: `### 🎉 小说全本下载成功！\n\n` +
                `- **书名**：《${bookTitle}》\n` +
                `- **作者**：${jobResult.currentJob.author || "未知"}\n` +
                `- **章节总数**：${jobResult.currentJob.progress ? jobResult.currentJob.progress.chapter_total : "未知"} 章\n` +
                `- **存储路径**：\`${epubPath}\` (标准 EPUB 格式，字体脱混淆已完全解密)\n\n` +
                `您已可以直接在对应路径找到该文件进行阅读。`
    };
}

async function main() {
    let output;
    try {
        // 1. 读取标准输入
        const input = await readInput();
        const request = JSON.parse(input);

        // 自动解析或提取子命令 action
        // 支持统合后的 action 参数，同时兼容旧的 tool_name 别名
        let action = request.action;
        const toolName = request.tool_name || "";

        if (!action) {
            if (toolName === "TomatoNovelSearch") action = "search";
            else if (toolName === "TomatoNovelDownload") action = "download";
            else if (toolName === "TomatoNovelDownloadIntro") action = "download_intro";
        }

        // 2. 保证底层 Rust 服务在后台运行
        await ensureServerOnline();

        // 3. 路由具体业务 Action
        if (action === "search") {
            const query = request.query;
            if (!query) throw new Error("缺少搜索关键词 'query' 参数。");
            output = await handleSearch(query);
        } else if (action === "download") {
            const bookId = request.book_id;
            if (!bookId) throw new Error("缺少书籍 ID 'book_id' 参数。");
            // 全本精准下载
            output = await handleDownload(bookId, null, null, false);
        } else if (action === "download_intro") {
            const bookId = request.book_id;
            if (!bookId) throw new Error("缺少书籍 ID 'book_id' 参数。");
            // 仅下载大纲（指定 range 1-1 并开启 isIntroOnly）
            output = await handleDownload(bookId, 1, 1, true);
        } else {
            throw new Error(`未支持的 Action: ${action || toolName}`);
        }

    } catch (e) {
        output = { status: 'error', error: e.message };
    } finally {
        // 输出 JSON 结果给 VCP 插件调度系统
        console.log(JSON.stringify(output, null, 2));
        if (output.status === 'error') {
            process.exit(1);
        }
    }
}

main();
