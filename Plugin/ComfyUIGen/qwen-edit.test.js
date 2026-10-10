const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { prepareWorkflowImages, fillWorkflowParameters } = require('./ComfyUIGen');

test('Qwen single/dual templates preserve graph and numeric parameters', () => {
    for (const name of ['qwen21edit', 'qwen21edit2in1']) {
        const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflows', `${name}.json`)));
        const graph = fillWorkflowParameters(template.workflow, {
            prompt: '使用图1主体和图2背景', image: 'one.png', image_2: 'two.png', seed: '0'
        }, { userSettings: template.defaults });
        assert.equal(graph['458'].inputs.steps, 8);
        assert.equal(graph['458'].inputs.cfg, 1);
        assert.equal(graph['458'].inputs.seed, 0);
        assert.equal(graph['474'].inputs.resolution, 0);
        assert.deepEqual(graph['458'].inputs.latent_image, ['474', 2]);
        assert.equal(graph['470'].inputs.image, 'one.png');
        if (name.endsWith('2in1')) assert.equal(graph['477'].inputs.image, 'two.png');
        assert.ok(!JSON.stringify(graph).includes('{{'));
        for (const node of Object.values(graph)) {
            for (const value of Object.values(node.inputs)) {
                if (Array.isArray(value)) assert.ok(graph[value[0]], `missing ${value[0]}`);
            }
        }
        const overridden = fillWorkflowParameters(template.workflow, {
            prompt: 'edit', steps: '12', cfg: '0', resolution: '1024'
        }, { userSettings: template.defaults });
        assert.equal(overridden['458'].inputs.steps, 12);
        assert.equal(overridden['458'].inputs.cfg, 0);
        assert.equal(overridden['474'].inputs.resolution, 1024);
    }
});

test('HTTP images upload separately; filenames pass through; invalid images fail', async () => {
    let uploads = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=', 'base64');
    const server = http.createServer(async (req, res) => {
        if (req.url === '/picture') { res.end(png); return; }
        if (req.url === '/upload/image') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            assert.match(req.headers['content-type'], /multipart\/form-data; boundary=/);
            assert.ok(body.includes(png));
            assert.match(body.toString(), /name="type"/);
            uploads++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ name: `image${uploads}.png`, subfolder: 'vcp' }));
            return;
        }
        res.end('<html>not an image</html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-qwen-'));
    const localImage = path.join(tempDir, '追踪 图片.png');
    fs.writeFileSync(localImage, png);
    try {
        const config = { COMFYUI_BASE_URL: base };
        const args = { image: `${base}/picture`, image_2: `${base}/picture` };
        const prepared = await prepareWorkflowImages(args, ['image', 'image_2'], config);
        assert.equal(prepared.image, 'vcp/image1.png');
        assert.equal(prepared.image_2, 'vcp/image2.png');
        assert.equal(args.image, `${base}/picture`);
        assert.equal(uploads, 2);
        assert.equal((await prepareWorkflowImages({ image: 'existing.png' }, ['image'], config)).image, 'existing.png');
        await assert.rejects(prepareWorkflowImages({}, ['image'], config), /requires/);
        await assert.rejects(prepareWorkflowImages({ image: `${base}/bad` }, ['image'], config), /PNG/);
        await assert.rejects(prepareWorkflowImages({ image: pathToFileURL(path.join(tempDir, 'missing.png')).href }, ['image'], config), /file tracing/);
        await assert.rejects(prepareWorkflowImages({ image: 'file://remote/share.png' }, ['image'], config), /network share/);
        await assert.rejects(prepareWorkflowImages({ image: '../test.png' }, ['image'], config), /must be/);
        assert.equal(uploads, 2);
        const fromFile = await prepareWorkflowImages({ image: pathToFileURL(localImage).href }, ['image'], config);
        assert.equal(fromFile.image, 'vcp/image3.png');
        assert.equal(uploads, 3);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        await new Promise(resolve => server.close(resolve));
    }
});