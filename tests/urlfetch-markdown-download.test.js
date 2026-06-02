const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tempRoot = path.join(os.tmpdir(), `vcptoolbox-urlfetch-${process.pid}`);
process.env.PROJECT_BASE_PATH = tempRoot;

const {
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
