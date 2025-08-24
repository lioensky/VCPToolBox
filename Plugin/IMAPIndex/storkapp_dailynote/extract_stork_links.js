const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

// --- 配置 ---
// 要扫描的目录
const SOURCE_DIR = path.join(__dirname, '..', 'mail_store', 'support_storkapp.me');
// 临时索引文件路径
const TEMP_INDEX_FILE = path.join(__dirname, 'stork_paper_ids.tmp.txt');
// 永久索引文件路径
const PERMANENT_INDEX_FILE = path.join(__dirname, 'stork_paper_ids.txt');
// 抓取脚本的路径
const FETCH_SCRIPT_PATH = path.join(__dirname, 'fetch_stork_pages.js');
// 旧的链接文件，脚本会尝试删除它
const OLD_LINKS_FILE = path.join(__dirname, 'stork_links.txt');
// --- 配置结束 ---

/**
 * 从给定的文本内容中提取 Stork paper ID。
 * @param {string} content - 文件内容。
 * @returns {string[]} - 提取到的 paper ID 数组，保持发现顺序。
 */
function extractPaperIds(content) {
    const ids = new Set();
    const regex = /https?:\/\/www\.storkapp\.cn\/(?:goTo\.php\?.*?url=|paper\/showPaper\.php\?)(.*?)(?:\)|"|'|\s)/g;
    
    let match;
    while ((match = regex.exec(content)) !== null) {
        let urlPart = match[1];
        try {
            urlPart = decodeURIComponent(urlPart);
        } catch (e) {
            // Ignore decoding errors
        }
        urlPart = urlPart.replace(/&/g, '&');

        if (urlPart.includes('showPaper.php')) {
            const idMatch = urlPart.match(/id=(\d+)/);
            if (idMatch && idMatch[1]) {
                ids.add(idMatch[1]);
            }
        }
    }
    return Array.from(ids);
}

/**
 * 读取永久索引文件。
 * @returns {Promise<Set<string>>}
 */
async function readPermanentIndex() {
    try {
        const content = await fs.readFile(PERMANENT_INDEX_FILE, 'utf-8');
        return new Set(content.split('\n').filter(line => line.trim() !== ''));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return new Set();
        }
        throw error;
    }
}

/**
 * 调用抓取脚本
 * @param {string[]} newIds - 需要抓取的新 ID 列表
 * @returns {Promise<void>}
 */
function triggerFetchScript(newIds) {
    return new Promise((resolve, reject) => {
        if (newIds.length === 0) {
            console.log("- 没有新的 ID，跳过抓取。");
            return resolve();
        }

        console.log(`\n--- 开始调用抓取脚本 ---`);
        const fetchProcess = spawn('node', [FETCH_SCRIPT_PATH, ...newIds], { stdio: 'inherit' });

        fetchProcess.on('close', (code) => {
            console.log(`--- 抓取脚本执行完毕，退出码: ${code} ---`);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`抓取脚本执行失败，退出码: ${code}`));
            }
        });

        fetchProcess.on('error', (err) => {
            console.error('无法启动抓取脚本:', err);
            reject(err);
        });
    });
}

/**
 * 主执行函数
 */
async function main() {
    console.log(`开始扫描目录: ${SOURCE_DIR}`);
    
    const permanentIds = await readPermanentIndex();
    const tempIds = new Set();
    let processedFileCount = 0;
    let totalIdsFound = 0;

    try {
        const files = await fs.readdir(SOURCE_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));
        console.log(`发现 ${mdFiles.length} 个 .md 文件。`);

        for (const file of mdFiles) {
            const filePath = path.join(SOURCE_DIR, file);
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const extracted = extractPaperIds(content);
                extracted.forEach(id => tempIds.add(id));
                totalIdsFound += extracted.length;
                processedFileCount++;
            } catch (readError) {
                console.error(`读取文件失败: ${filePath}`, readError);
            }
        }

        const tempIdArray = Array.from(tempIds);
        
        if (tempIdArray.length > 0) {
            await fs.writeFile(TEMP_INDEX_FILE, tempIdArray.join('\n'));
            console.log(`\n- 本次扫描发现 ${totalIdsFound} 个链接，提取到 ${tempIdArray.length} 个唯一 ID。`);
            console.log(`- 临时索引已保存到: ${TEMP_INDEX_FILE}`);
        } else {
            console.log('\n- 本次扫描未找到任何符合条件的 ID。');
            return;
        }

        const newIds = tempIdArray.filter(id => !permanentIds.has(id));

        if (newIds.length > 0) {
            console.log(`- 发现 ${newIds.length} 个新 ID，将启动处理流程。`);
            await triggerFetchScript(newIds);
        } else {
            console.log(`- 未发现新 ID，无需处理。`);
        }

        // 打印当前永久索引总数
        console.log(`- 当前永久索引总数: ${permanentIds.size}`);
        console.log(`- 永久索引文件: ${PERMANENT_INDEX_FILE}`);

        // 尝试删除旧文件
        try {
            await fs.unlink(OLD_LINKS_FILE);
            console.log(`- 已成功删除旧的链接文件: ${OLD_LINKS_FILE}`);
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
                console.warn(`- 删除旧链接文件失败: ${OLD_LINKS_FILE}`, unlinkError);
            }
        }

    } catch (error) {
        console.error(`\n执行过程中发生严重错误:`, error);
        if (error.code === 'ENOENT') {
            console.error(`错误详情: 目录不存在，请检查路径 '${SOURCE_DIR}' 是否正确。`);
        }
    }
}

main();