const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempRoot = path.join(os.tmpdir(), `vcptoolbox-urlfetch-${process.pid}`);
process.env.PROJECT_BASE_PATH = tempRoot;

const {
    fetchDownloadMarkdownContent,
    saveMarkdownToKnowledgeFolder,
    sanitizeKnowledgeSubfolderName
} = require('../Plugin/UrlFetch/UrlFetch.js');

test('saveMarkdownToKnowledgeFolder writes markdown without overwriting existing files', async (t) => {
    await fs.mkdir(tempRoot, { recursive: true });
    t.after(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const first = await saveMarkdownToKnowledgeFolder({
        url: 'https://example.com/article',
        content: '# Example\n\nFirst body',
        knowledgeFolder: 'WebDocs',
        fileName: 'article.md',
        sourceMode: 'jina'
    });

    const second = await saveMarkdownToKnowledgeFolder({
        url: 'https://example.com/article',
        content: '# Example\n\nSecond body',
        knowledgeFolder: 'WebDocs',
        fileName: 'article.md',
        sourceMode: 'jina'
    });

    assert.equal(first.details.fileName, 'article.md');
    assert.equal(second.details.fileName, 'article(1).md');
    assert.equal(first.details.requestedFileName, 'article.md');
    assert.equal(second.details.requestedFileName, 'article.md');

    const original = await fs.readFile(first.details.filePath, 'utf8');
    const copy = await fs.readFile(second.details.filePath, 'utf8');

    assert.match(original, /First body/);
    assert.doesNotMatch(original, /Second body/);
    assert.match(copy, /Second body/);
    assert.match(copy, /source_url: "https:\/\/example\.com\/article"/);
    assert.equal(first.details.relativePath.replace(/\\/g, '/'), 'knowledge/WebDocs/article.md');
    assert.equal(second.details.relativePath.replace(/\\/g, '/'), 'knowledge/WebDocs/article(1).md');
});

test('sanitizeKnowledgeSubfolderName rejects traversal and nested paths', () => {
    assert.equal(sanitizeKnowledgeSubfolderName('TDBdocs'), 'TDBdocs');
    assert.throws(() => sanitizeKnowledgeSubfolderName('../outside'), /knowledgeFolder/);
    assert.throws(() => sanitizeKnowledgeSubfolderName('nested/folder'), /knowledgeFolder/);
    assert.throws(() => sanitizeKnowledgeSubfolderName('nested\\folder'), /knowledgeFolder/);
});

test('saveMarkdownToKnowledgeFolder rejects symlinked knowledge subfolders', async (t) => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(tempRoot, 'knowledge'), { recursive: true });
    const outsideDir = path.join(tempRoot, 'outside');
    const linkedDir = path.join(tempRoot, 'knowledge', 'LinkedDocs');
    await fs.mkdir(outsideDir, { recursive: true });

    try {
        await fs.symlink(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`symlink unavailable in this environment: ${error.message}`);
        await fs.rm(tempRoot, { recursive: true, force: true });
        return;
    }

    t.after(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    await assert.rejects(
        () => saveMarkdownToKnowledgeFolder({
            url: 'https://example.com/article',
            content: '# Example',
            knowledgeFolder: 'LinkedDocs',
            fileName: 'article.md',
            sourceMode: 'jina'
        }),
        /符号链接|真实路径越界/
    );

    await assert.rejects(
        () => fs.access(path.join(outsideDir, 'article.md')),
        /ENOENT/
    );
});

test('fetchDownloadMarkdownContent honors configured proxy after normal download paths fail', async () => {
    const calls = [];
    const content = await fetchDownloadMarkdownContent('https://example.com/proxy-only', 'jina', '7890', {
        fetchWithJinaReader: async (url) => {
            calls.push(['jina', url]);
            throw new Error('jina blocked');
        },
        fetchWithDirectHttp: async (url) => {
            calls.push(['direct', url]);
            throw new Error('direct blocked');
        },
        fetchWithPuppeteer: async (url, mode, proxyPort) => {
            calls.push(['puppeteer', url, mode, proxyPort || null]);
            if (!proxyPort) {
                throw new Error('puppeteer without proxy blocked');
            }
            return '# Via proxy';
        }
    });

    assert.equal(content, '# Via proxy');
    assert.deepEqual(calls, [
        ['jina', 'https://example.com/proxy-only'],
        ['direct', 'https://example.com/proxy-only'],
        ['puppeteer', 'https://example.com/proxy-only', 'text', null],
        ['puppeteer', 'https://example.com/proxy-only', 'text', '7890']
    ]);
});
