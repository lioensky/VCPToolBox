'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { JevThirdPartyRegistry } = require('../modules/jevThirdPartyRegistry');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'ToolConfigs', 'jev_tool_call_exp.json');
const PROMPT_PATH = path.join(ROOT, 'TVStxt', 'JevToolCallDecision.txt');

const WAVE4_FOLDERS = [
    'FluxGen',
    'NovelAIGen',
    'ComfyUIGen',
    'ComfyCloudGen',
    'WebUIGen',
    'DMXDoubaoGen',
    'GeminiImageGen',
    'QwenImageGen',
    'SenseGen',
    'AgnesGen',
    'AgnesVideoGen',
    'GrokVideo',
    'VideoGenerator',
    'SunoMusicGen'
];

function loadBackendManifest(folder) {
    const p = path.join(ROOT, 'Plugin', folder, 'plugin-manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeWave4Planner() {
    const registry = new JevThirdPartyRegistry();
    const items = WAVE4_FOLDERS.map(folder => ({
        manifest: loadBackendManifest(folder),
        origin: 'local'
    }));
    const snapshot = registry.build(items);
    const planner = new JevToolCallExp({
        configPath: CONFIG_PATH,
        decisionPromptPath: PROMPT_PATH,
        thirdPartyRegistry: registry,
        env: { JEV_THIRD_PARTY_EXP: 'true' }
    });
    return { registry, snapshot, planner };
}

test('Wave 4: 全部 14 个第三方视觉创作、视频与音乐生成插件通过注册表校验且有效（DoubaoGen 由官方一级目录集中管理）', () => {
    const { snapshot } = makeWave4Planner();
    assert.equal(snapshot.total, 14);
    assert.equal(snapshot.validCount, 14);
    assert.equal(snapshot.invalidCount, 0);

    for (const entry of snapshot.entries) {
        assert.equal(entry.validation.status, 'valid', `${entry.pluginName} 校验失败: ${entry.validation.errors.join(', ')}`);
        assert.equal(entry.category, 'media_entertainment');
    }
});

test('Wave 4: 离线规划验证 FluxGen 画幅枚举裁决', async () => {
    const { planner } = makeWave4Planner();
    const [call] = await planner.plan('请使用 {媒体娱乐} 中的 `FluxGen`，生成图片【赛博朋克雨夜中的橙发少女，霓虹光影】[壁纸]。');
    assert.equal(call.name, 'FluxGen');
    assert.equal(call.args.prompt, '赛博朋克雨夜中的橙发少女，霓虹光影');
    assert.equal(call.args.resolution, '1024x576');
});

test('Wave 4: 离线规划验证 NovelAIGen 多命令路由（文生图、放大、标签建议、订阅查询）', async () => {
    const { planner } = makeWave4Planner();

    const [genCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，绘制【1girl, silver hair, golden eyes, masterpiece】[竖屏][负面:lowres]。');
    assert.equal(genCall.name, 'NovelAIGen');
    assert.equal(genCall.args.command, 'NovelAIGenerate');
    assert.equal(genCall.args.prompt, '1girl, silver hair, golden eyes, masterpiece');
    assert.equal(genCall.args.resolution, '832x1216');
    assert.equal(genCall.args.uc, 'lowres');

    const [upCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，高清放大[https://example.com/anime.png]。');
    assert.equal(upCall.name, 'NovelAIGen');
    assert.equal(upCall.args.command, 'NovelAIUpscale');
    assert.equal(upCall.args.image, 'https://example.com/anime.png');

    const [subCall] = await planner.plan('请使用 {媒体娱乐} 中的 `NovelAIGen`，查询余额与订阅状态。');
    assert.equal(subCall.name, 'NovelAIGen');
    assert.equal(subCall.args.command, 'NovelAISubscription');
});

test('Wave 4: 离线规划验证 ComfyUIGen、ComfyCloudGen 与 WebUIGen', async () => {
    const { planner } = makeWave4Planner();

    const [comfyCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ComfyUIGen`，工作流生图【1girl, blue eyes, cinematic】[工作流:AnimaEZGen][负面:bad hands]。');
    assert.equal(comfyCall.name, 'ComfyUIGen');
    assert.equal(comfyCall.args.prompt, '1girl, blue eyes, cinematic');
    assert.equal(comfyCall.args.workflow, 'AnimaEZGen');
    assert.equal(comfyCall.args.negative_prompt, 'bad hands');

    const [cloudCall] = await planner.plan('请使用 {媒体娱乐} 中的 `ComfyCloudGen`，云端生图【a beautiful anime girl with pink hair】[模板:FluxDev]。');
    assert.equal(cloudCall.name, 'ComfyCloudGen');
    assert.equal(cloudCall.args.command, 'GenerateImage');
    assert.equal(cloudCall.args.workflow, 'FluxDev');

    const [webuiCall] = await planner.plan('请使用 {媒体娱乐} 中的 `WebUIGen`，WebUI生图【a cute anime girl】[高清方图]。');
    assert.equal(webuiCall.name, 'WebUIGen');
    assert.equal(webuiCall.args.resolution, '1024x1024');
});

test('Wave 4: 离线规划验证 DMXDoubaoGen、DoubaoGen、GeminiImageGen、QwenImageGen 与 SenseGen', async () => {
    const { planner } = makeWave4Planner();

    const [dmxCall] = await planner.plan('请使用 {媒体娱乐} 中的 `DMXDoubaoGen`，修图【给女孩戴上墨镜】[https://example.com/girl.png]。');
    assert.equal(dmxCall.name, 'DMXDoubaoGen');
    assert.equal(dmxCall.args.command, 'DoubaoEditImage');
    assert.equal(dmxCall.args.image, 'https://example.com/girl.png');

    const [doubaoCall] = await planner.plan("请使用 {图片生成} 能力，用 '豆包' 生成【身披未来机甲的猫咪武士】[高清方图]。");
    assert.equal(doubaoCall.name, 'DoubaoGen');
    assert.equal(doubaoCall.args.prompt, '身披未来机甲的猫咪武士');
    assert.equal(doubaoCall.args.size, '2048x2048');

    const [geminiCall] = await planner.plan('请使用 {媒体娱乐} 中的 `GeminiImageGen`，编辑图片【在旁边加一只羊驼】[https://example.com/me.png]。');
    assert.equal(geminiCall.name, 'GeminiImageGen');
    assert.equal(geminiCall.args.command, 'GeminiEditImage');
    assert.equal(geminiCall.args.image_url, 'https://example.com/me.png');

    const [qwenCall] = await planner.plan('请使用 {媒体娱乐} 中的 `QwenImageGen`，千问生图【宇航员猫咪在月球】[横屏]。');
    assert.equal(qwenCall.name, 'QwenImageGen');
    assert.equal(qwenCall.args.command, 'GenerateImage');
    assert.equal(qwenCall.args.image_size, '1664x928');

    const [senseCall] = await planner.plan('请使用 {媒体娱乐} 中的 `SenseGen`，生成信息图【AI时代个人知识管理系统三栏架构】[横版PPT]。');
    assert.equal(senseCall.name, 'SenseGen');
    assert.equal(senseCall.args.command, 'SenseGenerateDocumentImage');
    assert.equal(senseCall.args.size, '2752x1536');
});

test('Wave 4: 离线规划验证 AgnesGen、AgnesVideoGen、GrokVideoGen、Wan2.1VideoGen 与 SunoMusicGen', async () => {
    const { planner } = makeWave4Planner();

    const [agnesImg] = await planner.plan('请使用 {媒体娱乐} 中的 `AgnesGen`，生成图像【云雾峡谷上的发光浮空城】[竖屏]。');
    assert.equal(agnesImg.name, 'AgnesGen');
    assert.equal(agnesImg.args.size, '768x1024');

    const [agnesVid] = await planner.plan('请使用 {媒体娱乐} 中的 `AgnesVideoGen`，生成视频【赛博朋克猫咪雨夜漫步】[10秒]。');
    assert.equal(agnesVid.name, 'AgnesVideoGen');
    assert.equal(agnesVid.args.command, 'submit');
    assert.equal(agnesVid.args.num_frames, '241');

    const [grokVid] = await planner.plan('请使用 {媒体娱乐} 中的 `GrokVideoGen`，图生视频【镜头缓缓推进】[https://example.com/city.png]。');
    assert.equal(grokVid.name, 'GrokVideoGen');
    assert.equal(grokVid.args.command, 'submit');
    assert.equal(grokVid.args.image_url, 'https://example.com/city.png');

    const [wanVid] = await planner.plan('请使用 {媒体娱乐} 中的 `Wan2.1VideoGen`，生成视频【橘猫在太空漫步】[文生视频][竖屏]。');
    assert.equal(wanVid.name, 'Wan2.1VideoGen');
    assert.equal(wanVid.args.command, 'submit');
    assert.equal(wanVid.args.mode, 't2v');
    assert.equal(wanVid.args.resolution, '720x1280');

    const [sunoAsync] = await planner.plan('请使用 {媒体娱乐} 中的 `SunoMusicGen`，创作音乐【深夜阅读的安静大提琴曲】[纯音乐][V5]。');
    assert.equal(sunoAsync.name, 'SunoMusicGen');
    assert.equal(sunoAsync.args.command, 'submit');
    assert.equal(sunoAsync.args.instrumental, 'true');
    assert.equal(sunoAsync.args.model, 'V5');
});