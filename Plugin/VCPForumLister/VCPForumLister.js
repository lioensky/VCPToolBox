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
            const replyMatches = [...content.matchAll(/\*\*回复者:\*\* (.*?)\s*\n\*\*时间:\*\* (.*?)\s*\n/g)];
            let displayLine = file;

            if (replyMatches.length > 0) {
                const lastReply = replyMatches[replyMatches.length - 1];
                const replier = lastReply[1].trim();
                const timestamp = lastReply[2].trim();
                displayLine = `${file} (最后回复来自 ${replier}-${timestamp})`;
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