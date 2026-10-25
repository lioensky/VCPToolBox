const test = require('node:test');
const assert = require('node:assert/strict');
const template = require('./workflows/AnimaEZGen.json');
const source = require('./Anima生图增强.json');
const { fillWorkflowParameters, configureWorkflowLora } = require('./ComfyUIGen');

const fill = args => fillWorkflowParameters(template.workflow, { prompt: '1girl', ...args }, { userSettings: template.defaults });

function validateGraph(graph) {
    assert.ok(!JSON.stringify(graph).includes('{{'));
    for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs)) {
            if (Array.isArray(value)) assert.ok(graph[value[0]], `missing node ${value[0]}`);
        }
        if (node.class_type === 'CLIPTextEncode') assert.ok(node.inputs.clip);
    }
}

test('enhanced Anima retains source pipeline and defaults to 1x with face prompt', () => {
    const graph = fill({});
    validateGraph(graph);
    for (const [id, node] of Object.entries(source)) {
        assert.equal(graph[id].class_type, node.class_type);
    }
    assert.equal(graph['94'].inputs.resize_scale, 1);
    assert.equal(graph['91'].inputs.text, 'detailed glassy eyes, smooth porcelain skin');
    assert.deepEqual(graph['87'].inputs.image, ['94', 0]);
    assert.deepEqual(graph['85'].inputs.images, ['87', 0]);
    assert.deepEqual(graph['91'].inputs.clip, ['86', 1]);
    assert.deepEqual(graph['92'].inputs.clip, ['86', 1]);
    assert.equal(graph['82'].inputs.steps, 24);
    assert.equal(graph['87'].inputs.denoise, 0.38);
    assert.equal(graph['87'].inputs.steps, 18);
    assert.equal(graph['82'].inputs.seed, graph['87'].inputs.seed);
});

test('enhanced Anima allows scale and independent face prompt overrides', () => {
    const graph = fill({ resize_scale: '1.5', face_prompt: 'blue eyes, smiling', width: '768', height: '1024', steps: '32', seed: '42' });
    validateGraph(graph);
    assert.equal(graph['94'].inputs.resize_scale, 1.5);
    assert.equal(graph['91'].inputs.text, 'blue eyes, smiling');
    assert.equal(graph['83'].inputs.text, '1girl');
    assert.equal(graph['80'].inputs.width, 768);
    assert.equal(graph['80'].inputs.height, 1024);
    assert.equal(graph['82'].inputs.steps, 32);
    assert.equal(graph['87'].inputs.seed, 42);
    assert.equal(fill({ face_prompt: '' })['91'].inputs.text, '');
    assert.throws(() => fill({ face_prompt: 123 }), /face_prompt/);
    assert.throws(() => fill({ resize_scale: 0 }), /resize_scale/);
});

test('disabling LoRA also reconnects face encoders and FaceDetailer', () => {
    const graph = configureWorkflowLora(fill({}), { lora_name: '' });
    validateGraph(graph);
    assert.equal(graph['86'], undefined);
    for (const id of ['81', '83', '91', '92', '87']) {
        assert.deepEqual(graph[id].inputs.clip, ['77', 0]);
    }
    assert.deepEqual(graph['87'].inputs.model, ['84', 0]);
});