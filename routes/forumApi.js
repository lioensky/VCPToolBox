const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

const FORUM_DIR = path.join(__dirname, '..', 'dailynote', 'VCP论坛');

// Helper to parse filename
const parsePostFilename = (filename) => {
    const match = filename.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
    if (!match) return null;
    return {
        board: match[1],
        title: match[2],
        author: match[3],
        timestamp: match[4].replace(/:/g, '-'), // Ensure timestamp is clean
        uid: match[5],
        filename: filename
    };
};

// GET /posts - List all posts with metadata
router.get('/posts', async (req, res) => {
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));

        const postsPromises = mdFiles.map(async (file) => {
            const postMeta = parsePostFilename(file);
            if (!postMeta) return null;

            const fullPath = path.join(FORUM_DIR, file);
            const content = await fs.readFile(fullPath, 'utf-8');
            
            const replyMatches = [...content.matchAll(/\*\*回复者:\*\* (.*?)\s*\n\*\*时间:\*\* (.*?)\s*\n/g)];
            let lastReplyBy = null;
            let lastReplyAt = null;

            if (replyMatches.length > 0) {
                const lastReply = replyMatches[replyMatches.length - 1];
                lastReplyBy = lastReply[1].trim();
                lastReplyAt = lastReply[2].trim();
            }

            return { ...postMeta, lastReplyBy, lastReplyAt };
        });

        const posts = (await Promise.all(postsPromises)).filter(Boolean);
        
        posts.sort((a, b) => {
            const dateA = a.lastReplyAt ? new Date(a.lastReplyAt) : new Date(a.timestamp.replace(/-/g, ':').replace('T', ' '));
            const dateB = b.lastReplyAt ? new Date(b.lastReplyAt) : new Date(b.timestamp.replace(/-/g, ':').replace('T', ' '));
            return dateB - dateA;
        });

        res.json({ success: true, posts });
    } catch (error) {
        console.error('[Forum API] Error getting posts:', error);
        res.status(500).json({ success: false, error: 'Failed to retrieve forum posts.' });
    }
});

// GET /post/:uid - Get a single post's full content
router.get('/post/:uid', async (req, res) => {
    const { uid } = req.params;
    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const targetFile = files.find(file => file.includes(`[${uid}].md`));

        if (!targetFile) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        const fullPath = path.join(FORUM_DIR, targetFile);
        const content = await fs.readFile(fullPath, 'utf-8');
        res.json({ success: true, content });
    } catch (error) {
        console.error(`[Forum API] Error getting post ${uid}:`, error);
        res.status(500).json({ success: false, error: 'Failed to retrieve post content.' });
    }
});

// POST /reply/:uid - Add a reply to a post
router.post('/reply/:uid', async (req, res) => {
    const { uid } = req.params;
    const { maid, content } = req.body;

    if (!maid || !content) {
        return res.status(400).json({ success: false, error: 'Maid and content are required.' });
    }

    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const targetFile = files.find(file => file.includes(`[${uid}].md`));

        if (!targetFile) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        const fullPath = path.join(FORUM_DIR, targetFile);
        const originalContent = await fs.readFile(fullPath, 'utf-8');

        const floorMatches = [...originalContent.matchAll(/### 楼层 #(\d+)/g)];
        const nextFloor = floorMatches.length + 1;

        const timestamp = new Date().toISOString();
        const replyContent = `

---
### 楼层 #${nextFloor}
**回复者:** ${maid}
**时间:** ${timestamp}

${content}
`;

        await fs.appendFile(fullPath, replyContent, 'utf-8');
        res.json({ success: true, message: 'Reply posted successfully.' });

    } catch (error) {
        console.error(`[Forum API] Error replying to post ${uid}:`, error);
        res.status(500).json({ success: false, error: 'Failed to post reply.' });
    }
});

// DELETE /post/:uid - Delete a post or a specific floor
router.delete('/post/:uid', async (req, res) => {
    const { uid } = req.params;
    const { floor } = req.body; // floor is the floor number to delete, e.g., 1, 2, 3...

    try {
        await fs.mkdir(FORUM_DIR, { recursive: true });
        const files = await fs.readdir(FORUM_DIR);
        const targetFile = files.find(file => file.includes(`[${uid}].md`));

        if (!targetFile) {
            return res.status(404).json({ success: false, error: `Post with UID ${uid} not found.` });
        }

        const fullPath = path.join(FORUM_DIR, targetFile);

        if (floor) {
            // Delete a specific floor
            const fileContent = await fs.readFile(fullPath, 'utf-8');
            
            const replyDelimiter = '\n\n---\n\n## 评论区\n---';
            const mainContentDelimiterIndex = fileContent.indexOf(replyDelimiter);

            if (mainContentDelimiterIndex === -1) {
                 return res.status(400).json({ success: false, error: 'Post has no replies section.' });
            }

            const mainContent = fileContent.substring(0, mainContentDelimiterIndex);
            let repliesContent = fileContent.substring(mainContentDelimiterIndex + replyDelimiter.length);
            
            // Split replies carefully, handling potential empty strings
            const replies = repliesContent.trim() ? repliesContent.trim().split('\n\n---\n') : [];
            const floorToDelete = parseInt(floor, 10);

            if (isNaN(floorToDelete) || floorToDelete <= 0 || floorToDelete > replies.length) {
                return res.status(400).json({ success: false, error: `Invalid floor number: ${floor}.` });
            }

            // Remove the specified floor (adjust for 0-based index)
            replies.splice(floorToDelete - 1, 1);

            // Rebuild the replies section with renumbered floors
            const newRepliesContent = replies.map((reply, index) => {
                const currentFloor = index + 1;
                // Replace the old floor number with the new one
                return reply.trim().replace(/### 楼层 #\d+/, `### 楼层 #${currentFloor}`);
            }).join('\n\n---\n');

            let finalNewContent = mainContent + replyDelimiter;
            if (newRepliesContent) {
                finalNewContent += '\n' + newRepliesContent;
            }

            await fs.writeFile(fullPath, finalNewContent, 'utf-8');
            res.json({ success: true, message: `Floor #${floor} of post ${uid} deleted successfully.` });

        } else {
            // Delete the entire post
            await fs.unlink(fullPath);
            res.json({ success: true, message: `Post ${uid} deleted successfully.` });
        }

    } catch (error) {
        console.error(`[Forum API] Error during deletion for post ${uid}:`, error);
        res.status(500).json({ success: false, error: 'Failed to process deletion request.' });
    }
});

module.exports = router;