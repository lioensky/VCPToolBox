const fs = require('fs').promises;
const path = require('path');

const FORUM_DIR = path.join(__dirname, '..', '..', 'dailynote', 'VCP论坛');

/**
 * Main function to generate the forum post list.
 */
async function generateForumList() {
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));

        if (mdFiles.length === 0) {
            console.log("VCP论坛中尚无帖子。");
            return;
        }

        const postsByBoard = {};

        for (const file of mdFiles) {
            const fullPath = path.join(FORUM_DIR, file);
            const content = await fs.readFile(fullPath, 'utf-8');

            // Find all replies and get the last one
            // 正则表达式从文件名中提取信息
            // 格式: [版块][[标题]][作者][时间戳][UID].md
            const fileMatch = file.match(/^\[(.*?)\]\[\[(.*?)\]\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);

            let displayLine;

            if (fileMatch) {
                const title = fileMatch[2];
                const author = fileMatch[3];
                const postTimestamp = fileMatch[4];
                
                // 格式化时间戳，使其更易读
                const formattedPostTime = new Date(postTimestamp).toLocaleString('zh-CN', { hour12: false });

                displayLine = `[${author}] ${title} (发布于: ${formattedPostTime})`;
            } else {
                // 如果文件名格式不匹配，则回退到显示原始文件名
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

            // Group by board
            const match = file.match(/^\[(.*?)\]/);
            if (match && match[1]) {
                const board = match[1];
                if (!postsByBoard[board]) {
                    postsByBoard[board] = [];
                }
                postsByBoard[board].push(displayLine);
            }
        }

        let output = "告知所有帖子都在 ../../dailynote/VCP论坛/ 文件夹下\n";

        for (const board in postsByBoard) {
            output += `\n————[${board}]————\n`;
            postsByBoard[board].forEach(line => {
                output += `${line}\n`;
            });
        }

        console.log(output.trim());

    } catch (error) {
        // If the directory doesn't exist or another error occurs,
        // output a helpful message to stdout so the placeholder reflects the state.
        console.log(`[VCPForumLister Error: ${error.message}]`);
        process.exit(1);
    }
}

generateForumList();