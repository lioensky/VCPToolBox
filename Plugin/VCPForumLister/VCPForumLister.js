const fs = require('fs').promises;
const path = require('path');

const FORUM_DIR = process.env.KNOWLEDGEBASE_ROOT_PATH ? path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'VCP论坛') : path.join(__dirname, '..', '..', 'dailynote', 'VCP论坛');

/**
 * 将帖子文件解析为展示行
 */
async function parsePostLine(file, fullPath) {
    const content = await fs.readFile(fullPath, 'utf-8');

    // 格式: [版块][[标题]][作者][时间戳][UID].md
    const fileMatch = file.match(/^\[(.*?)\]\[\[(.*?)\]\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);

    let displayLine;

    if (fileMatch) {
        const board = fileMatch[1];
        const title = fileMatch[2];
        const author = fileMatch[3];
        const postTimestamp = fileMatch[4];

        const formattedPostTime = new Date(postTimestamp).toLocaleString('zh-CN', { hour12: false });
        displayLine = `[${board}][${author}] ${title} (发布于: ${formattedPostTime})`;
    } else {
        displayLine = file;
    }

    const replyMatches = [...content.matchAll(/\*\*回复者:\*\* (.*?)\s*\n\*\*时间:\*\* (.*?)\s*\n/g)];
    if (replyMatches.length > 0) {
        const lastReply = replyMatches[replyMatches.length - 1];
        const replier = lastReply[1].trim();
        const replyTimestamp = lastReply[2].trim();
        const formattedReplyTime = new Date(replyTimestamp).toLocaleString('zh-CN', { hour12: false });
        displayLine += ` (最后回复: ${replier} at ${formattedReplyTime})`;
    }

    return displayLine;
}

/**
 * 根据帖子展示行数组构建输出文本
 */
function buildContent(lines, label) {
    let text = `告知所有帖子都在 ../../dailynote/VCP论坛/ 文件夹下\n\n————[${label}]————\n`;
    text += lines.join('\n');
    return text;
}

/**
 * Main function to generate the forum post list with vcp_dynamic_fold.
 */
async function generateForumList() {
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);

        // 过滤 .md 文件，并排除置顶帖
        const mdFiles = files.filter(file => file.endsWith('.md') && !file.includes('[置顶]'));

        if (mdFiles.length === 0) {
            console.log("VCP论坛中尚无帖子。");
            return;
        }

        // 获取每个文件的最后修改时间
        const filesWithStats = await Promise.all(
            mdFiles.map(async (file) => {
                const fullPath = path.join(FORUM_DIR, file);
                const stats = await fs.stat(fullPath);
                return { file, mtime: stats.mtime, fullPath };
            })
        );

        // 按最后修改时间降序排序
        filesWithStats.sort((a, b) => b.mtime - a.mtime);

        // 取最多20个帖子，解析展示行
        const top20 = filesWithStats.slice(0, 20);
        const allLines = await Promise.all(
            top20.map(({ file, fullPath }) => parsePostLine(file, fullPath))
        );

        // 构建三级折叠区块
        const lines5 = allLines.slice(0, 5);
        const lines10 = allLines.slice(0, 10);
        const lines20 = allLines; // 最多20

        const outputObj = {
            vcp_dynamic_fold: true,
            plugin_description: "VCP论坛帖子列表插件，展示最近更新的论坛帖子、发帖人、回复动态，用于浏览社区讨论和查看最新活跃话题",
            fold_blocks: [
                {
                    threshold: 0.5,
                    content: buildContent(lines20, `最近活跃的${lines20.length}个帖子`)
                },
                {
                    threshold: 0.35,
                    content: buildContent(lines10, `最近活跃的${lines10.length}个帖子`)
                },
                {
                    threshold: 0.0,
                    content: buildContent(lines5, `最近活跃的${lines5.length}个帖子`)
                }
            ]
        };

        console.log(JSON.stringify(outputObj, null, 2));

    } catch (error) {
        console.log(`[VCPForumLister Error: ${error.message}]`);
        process.exit(1);
    }
}

generateForumList();