const test = require('node:test');
const assert = require('node:assert/strict');
const template = require('./workflows/AnimeSharp.json');
const { fillWorkflowParameters, isValidComfyUIGenArgs, prepareWorkflowImages } = require('./ComfyUIGen');

test('AnimeSharp accepts image and scale without prompt and preserves graph', async () => {
    const args = { image: 'existing.png', resize_scale: '1.5' };
    assert.equal(isValidComfyUIGenArgs(args, template.requiresPrompt), true);
    assert.equal(isValidComfyUIGenArgs(args), false);
    assert.equal(isValidComfyUIGenArgs({ prompt: 'draw' }), true);
    assert.deepEqual(template.requiredInputs, ['image']);
    const prepared = await prepareWorkflowImages(args, template.requiredInputs, {});
    const graph = fillWorkflowParameters(template.workflow, prepared, { userSettings: template.defaults });
    assert.equal(graph['3'].inputs.image, 'existing.png');
    assert.equal(graph['1'].inputs.model_name, '4x-AnimeSharp.pth');
    assert.equal(graph['6'].inputs.resize_scale, 1.5);
    assert.equal(graph['6'].inputs.resize_method, 'lanczos');
    assert.deepEqual(graph['6'].inputs.image, ['3', 0]);
    assert.deepEqual(graph['6'].inputs.upscale_model, ['1', 0]);
    assert.deepEqual(graph['4'].inputs.images, ['6', 0]);
    assert.equal(graph['4'].class_type, 'SaveImage');
    assert.ok(!JSON.stringify(graph).includes('{{'));
    await assert.rejects(prepareWorkflowImages({}, template.requiredInputs, {}), /requires/);
});

test('AnimeSharp defaults to 2x and rejects invalid scales', () => {
    const fill = args => fillWorkflowParameters(template.workflow, args, { userSettings: template.defaults });
    assert.equal(fill({ image: 'one.png' })['6'].inputs.resize_scale, 2);
    assert.equal(fill({ resize_scale: 4 })['6'].inputs.resize_scale, 4);
    for (const resize_scale of [0, -1, '', ' ', 'abc', Infinity, NaN, true, []]) {
        assert.throws(() => fill({ resize_scale }), /resize_scale/);
    }
});