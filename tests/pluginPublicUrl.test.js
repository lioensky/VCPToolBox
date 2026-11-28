const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const TARGET_PLUGINS = [
    { name: 'BilibiliFetch', files: ['BilibiliFetch.py'], manifest: 'plugin-manifest.json' },
    { name: 'UrlFetch', files: ['UrlFetch.js'], manifest: 'plugin-manifest.json' },
    { name: 'DailyNote', files: ['dailynote.js'], manifest: 'plugin-manifest.json' },
    { name: 'DMXDoubaoGen', files: ['DoubaoGen.js'], manifest: 'plugin-manifest.json' },
    { name: 'DoubaoGen', files: ['DoubaoGen.js'], manifest: 'plugin-manifest.json' },
    { name: 'FluxGen', files: ['FluxGen.mjs'], manifest: 'plugin-manifest.json' },
    { name: 'GeminiImageGen', files: ['GeminiImageGen.js', 'GeminiImageGen.mjs'], manifest: 'plugin-manifest.json' },
    { name: 'MagiAgent', files: ['MagiAgent.js'], manifest: 'plugin-manifest.json' },
    { name: 'MediaRenderer', files: ['MediaRenderer.js'], manifest: 'plugin-manifest.json' },
    { name: 'QwenImageGen', files: ['QwenImageGen.js'], manifest: 'plugin-manifest.json' },
    { name: 'TarotDivination', files: ['tarot_divination.js'], manifest: 'plugin-manifest.json' },
    { name: 'ToolCallRecordQuery', files: ['toolCallRecordReportFormatter.js'], manifest: 'plugin-manifest.json' },
    { name: 'VCPForum', files: ['VCPForum.js'], manifest: 'plugin-manifest.json' },
    { name: 'ComfyUIGen', files: ['ComfyUIGen.js'], manifest: 'plugin-manifest.json.block' },
    { name: 'FileListGenerator', files: ['file-list-generator.js'], manifest: 'plugin-manifest.json.block' },
    { name: 'ZImageGen2', files: ['ZImageGen.mjs'], manifest: 'plugin-manifest.json.block' },
];

test('all 16 built-in plugins declare USE_PUBLIC_URL in manifest and avoid unconditional :PORT/pw= hardcoding', () => {
    const hardcodedPortPwPattern = /:\$\{[^}]*(?:PORT|port)[^}]*\}\/pw=|:\{server_port\}\/pw=/;

    for (const plugin of TARGET_PLUGINS) {
        const pluginDir = path.join(REPO_ROOT, 'Plugin', plugin.name);
        const manifestPath = path.join(pluginDir, plugin.manifest);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));

        assert.ok(
            manifest.configSchema && Object.prototype.hasOwnProperty.call(manifest.configSchema, 'USE_PUBLIC_URL'),
            `${plugin.name}/${plugin.manifest} must declare USE_PUBLIC_URL in configSchema`
        );

        for (const relFile of plugin.files) {
            const content = fs.readFileSync(path.join(pluginDir, relFile), 'utf8');
            assert.ok(
                content.includes('USE_PUBLIC_URL'),
                `${plugin.name}/${relFile} must read USE_PUBLIC_URL`
            );
            assert.ok(
                content.includes('VarHttpsUrl'),
                `${plugin.name}/${relFile} must support VarHttpsUrl`
            );

            // Allow BilibiliFetch.py's else-branch fallback (`return f"{base_url}:{server_port}/pw=..."`)
            // which is explicitly guarded by `if use_public_url:`.
            if (plugin.name !== 'BilibiliFetch') {
                assert.doesNotMatch(
                    content,
                    hardcodedPortPwPattern,
                    `${plugin.name}/${relFile} still contains unconditional :PORT/pw= hardcoding`
                );
            }
        }
    }
});

test('root config.env.example declares USE_PUBLIC_URL=false by default', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'config.env.example'), 'utf8');
    assert.match(content, /^USE_PUBLIC_URL=false$/m);
});

test('ToolCallRecordQuery formatter respects USE_PUBLIC_URL=false (default) and USE_PUBLIC_URL=true', () => {
    const formatterPath = path.join(REPO_ROOT, 'Plugin', 'ToolCallRecordQuery', 'toolCallRecordReportFormatter.js');
    const saved = {
        USE_PUBLIC_URL: process.env.USE_PUBLIC_URL,
        VarHttpUrl: process.env.VarHttpUrl,
        VarHttpsUrl: process.env.VarHttpsUrl,
        SERVER_PORT: process.env.SERVER_PORT,
        IMAGESERVER_IMAGE_KEY: process.env.IMAGESERVER_IMAGE_KEY,
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH,
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-public-url-tcrq-'));
    try {
        process.env.PROJECT_BASE_PATH = tmpDir;
        process.env.VarHttpUrl = 'http://localhost/';
        process.env.VarHttpsUrl = 'https://example.com/';
        process.env.SERVER_PORT = '6005';
        process.env.IMAGESERVER_IMAGE_KEY = 'demo-key';

        delete require.cache[require.resolve(formatterPath)];
        const { formatQueryReport } = require(formatterPath);

        const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        const makePayload = () => ({
            total: 1,
            limit: 20,
            offset: 0,
            records: [
                {
                    id: 'rec-1',
                    toolName: 'TestTool',
                    caller: 'Kestrel',
                    timestamp: '2026-11-28T00:00:00Z',
                    status: 'success',
                    returnContent: { content: [{ type: 'image_url', image_url: { url: png1x1 } }] }
                }
            ]
        });

        // 1. Default (USE_PUBLIC_URL unset / false): local URL with port
        delete process.env.USE_PUBLIC_URL;
        const localReport = formatQueryReport(makePayload(), {}, { migrateMultimodal: true });
        assert.match(localReport.markdown, /http:\/\/localhost:6005\/pw=demo-key\/images\/tool-call-records\//);

        // 2. USE_PUBLIC_URL=true: VarHttpsUrl without port and without double slash
        process.env.USE_PUBLIC_URL = 'true';
        const publicReport = formatQueryReport(makePayload(), {}, { migrateMultimodal: true });
        assert.match(publicReport.markdown, /https:\/\/example\.com\/pw=demo-key\/images\/tool-call-records\//);
        assert.doesNotMatch(publicReport.markdown, /example\.com:6005/);
        assert.doesNotMatch(publicReport.markdown, /example\.com\/\/pw=/);

        // 3. USE_PUBLIC_URL=true with empty VarHttpsUrl: falls back to VarHttpUrl without port
        process.env.VarHttpsUrl = '';
        const fallbackReport = formatQueryReport(makePayload(), {}, { migrateMultimodal: true });
        assert.match(fallbackReport.markdown, /http:\/\/localhost\/pw=demo-key\/images\/tool-call-records\//);
        assert.doesNotMatch(fallbackReport.markdown, /localhost:6005/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test('FileListGenerator respects USE_PUBLIC_URL=false (default) and USE_PUBLIC_URL=true', () => {
    const scriptPath = path.join(REPO_ROOT, 'Plugin', 'FileListGenerator', 'file-list-generator.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-public-url-flg-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'file'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'file', 'sample.txt'), 'ok');

        const baseEnv = {
            ...process.env,
            PROJECT_BASE_PATH: tmpDir,
            VarHttpUrl: 'http://localhost',
            VarHttpsUrl: 'https://example.com/',
            PORT: '6005',
            File_Key: 'file-key-123',
        };
        delete baseEnv.USE_PUBLIC_URL;

        const outDefault = execFileSync(process.execPath, [scriptPath], { env: baseEnv, encoding: 'utf8' });
        assert.match(outDefault, /http:\/\/localhost:6005\/pw=file-key-123\/files\//);

        const outPublic = execFileSync(process.execPath, [scriptPath], {
            env: { ...baseEnv, USE_PUBLIC_URL: 'true' },
            encoding: 'utf8',
        });
        assert.match(outPublic, /https:\/\/example\.com\/pw=file-key-123\/files\//);
        assert.doesNotMatch(outPublic, /example\.com:6005/);
        assert.doesNotMatch(outPublic, /example\.com\/\/pw=/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('BilibiliFetch get_accessible_url respects USE_PUBLIC_URL=false (default) and USE_PUBLIC_URL=true', () => {
    const pyScript = `
import os, sys, tempfile
sys.path.insert(0, os.path.join(${JSON.stringify(REPO_ROOT)}, "Plugin", "BilibiliFetch"))
import BilibiliFetch as bf

with tempfile.TemporaryDirectory() as td:
    img_dir = os.path.join(td, "image", "bili")
    os.makedirs(img_dir, exist_ok=True)
    img_path = os.path.join(img_dir, "snap.jpg")
    open(img_path, "wb").write(b"x")

    os.environ["PROJECT_BASE_PATH"] = td
    os.environ["IMAGESERVER_IMAGE_KEY"] = "imgkey"
    os.environ["VarHttpUrl"] = "http://localhost/"
    os.environ["VarHttpsUrl"] = "https://example.com/"
    os.environ["SERVER_PORT"] = "6005"

    os.environ.pop("USE_PUBLIC_URL", None)
    u_default = bf.get_accessible_url(img_path)
    assert u_default == "http://localhost:6005/pw=imgkey/images/bili/snap.jpg", u_default

    os.environ["USE_PUBLIC_URL"] = "false"
    u_false = bf.get_accessible_url(img_path)
    assert u_false == "http://localhost:6005/pw=imgkey/images/bili/snap.jpg", u_false

    os.environ["USE_PUBLIC_URL"] = "true"
    u_true = bf.get_accessible_url(img_path)
    assert u_true == "https://example.com/pw=imgkey/images/bili/snap.jpg", u_true

    os.environ["VarHttpsUrl"] = ""
    u_fallback = bf.get_accessible_url(img_path)
    assert u_fallback == "http://localhost/pw=imgkey/images/bili/snap.jpg", u_fallback
print("BILIBILI_PUBLIC_URL_OK")
`;
    const out = execFileSync('python3', ['-c', pyScript], { encoding: 'utf8' });
    assert.match(out, /BILIBILI_PUBLIC_URL_OK/);
});
