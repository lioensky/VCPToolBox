const fs = require('fs').promises;
const path = require('path');

class ForumEngine {
    constructor(projectBasePath) {
        this.forumDir = path.join(projectBasePath, 'dailynote', 'VCP论坛');
        // P=1.5 provides a good balance: dense at start, sparse at end.
        this.decayFactor = 1.5; 
    }

    async getSparsePostList(requestedCount = 50) {
        try {
            await fs.mkdir(this.forumDir, { recursive: true });
            const files = await fs.readdir(this.forumDir);
            const mdFiles = files.filter(f => f.endsWith('.md'));

            if (mdFiles.length === 0) {
                return 'VCP论坛中尚无帖子。';
            }

            // 1. Get stats and sort by mtime
            const fileData = await Promise.all(
                mdFiles.map(async (filename) => {
                    const stats = await fs.stat(path.join(this.forumDir, filename));
                    return {
                        filename,
                        mtime: stats.mtimeMs
                    };
                })
            );

            // Sort descending (newest first)
            fileData.sort((a, b) => b.mtime - a.mtime);

            // 2. Select indices using power-law decay
            const M = fileData.length;
            const N = Math.min(requestedCount, M);
            const selectedIndices = new Set();

            if (M <= N) {
                for (let i = 0; i < M; i++) selectedIndices.add(i);
            } else {
                // Use a randomized power-law distribution to pick indices.
                // Higher P = more bias towards the "top" (newest posts).
                // Probability(index) decreases as index increases.
                const P = 2.0; 
                let attempts = 0;
                while (selectedIndices.size < N && attempts < N * 10) {
                    const r = Math.random();
                    // Math.pow(r, P) skews r towards 0 when P > 1
                    const index = Math.floor(Math.pow(r, P) * M);
                    selectedIndices.add(index);
                    attempts++;
                }

                // Fallback: If random selection failed to fill unique slots, take from the top
                let i = 0;
                while (selectedIndices.size < N && i < M) {
                    selectedIndices.add(i);
                    i++;
                }
            }

            // 3. Extract metadata and group by board
            const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
            const postsByBoard = {};

            for (const idx of sortedIndices) {
                const filename = fileData[idx].filename;
                // Regex matches: [Board][Title][Author][Timestamp][UID].md
                const m = filename.match(/^\[(.*?)\]\[(.*)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
                if (!m) continue;

                const board = m[1];
                const title = m[2];
                const author = m[3];
                const uid = m[5];

                if (!postsByBoard[board]) postsByBoard[board] = [];
                postsByBoard[board].push(`[${author}] ${title} (UID: ${uid})`);
            }

            // 4. Format output
            let output = 'VCP论坛采样列表 (稀疏分布):\n';
            const boards = Object.keys(postsByBoard);
            if (boards.length === 0) return '未找到符合命名规范的帖子。';

            for (const board of boards) {
                output += `\n————[${board}]————\n`;
                postsByBoard[board].forEach(line => {
                    output += `${line}\n`;
                });
            }

            return output.trim();
        } catch (e) {
            console.error('[ForumEngine] Error:', e);
            return `获取论坛帖子采样列表时出错: ${e.message}`;
        }
    }
}

module.exports = ForumEngine;
