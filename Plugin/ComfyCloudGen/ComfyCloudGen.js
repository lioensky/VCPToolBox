#!/usr/bin/env node
/**
 * ComfyCloudGen v0.4.0 - Comfy Cloud 云端图像/视频生成器
 * 
 * 数据驱动架构：
 *   ecosystems.json定义模型生态参数
 *   cloud_models.json判断模型loader类型
 *   cloud_node_defs.json提供参数兜底默认值
 *   cloud_workflow_params.json校验COMBO参数合法性
 *   PipelineFactory硬编码3种拓扑模板
 * 
 * 三种模式：
 *   auto     - 传模型名自动推导生态+pipeline（默认）
 *   template - 传workflow名使用已有模板文件
 *   raw      - 传workflow_json直接提交
 * 
 * 作者：Rosa
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ComfyCloudAuth = require('./ComfyCloudAuth');
const ComfyCloudNetwork = require('./ComfyCloudNetwork');
const EcosystemResolver = require('./EcosystemResolver');
const PipelineFactory = require('./PipelineFactory');
const CacheManager = require('./CacheManager');

// ============ 配置加载 ============

function loadEnv(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/\r/g, '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

// ============ 模式判定 ============

function parseMode(params) {
  if (params.workflow_json) return 'raw';
  if (params.workflow) return 'template';
  return 'auto';
}

// ============ 模板模式处理 ============

function loadTemplate(workflowName, workflowDirs) {
  for (const dir of workflowDirs) {
    const p = path.join(dir, `${workflowName}.json`);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  throw new Error(`Workflow template "${workflowName}" not found in: ${workflowDirs.join(', ')}`);
}

function patchTemplate(workflow, params) {
  // 深拷贝
  const wf = JSON.parse(JSON.stringify(workflow));

  for (const [nid, node] of Object.entries(wf)) {
    if (!node || !node.class_type) continue;
    const ct = node.class_type;
    const inp = node.inputs;

    // KSampler系列
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      if (params.seed !== undefined) inp.seed = Number(params.seed);
      else inp.seed = crypto.randomBytes(4).readUInt32BE(0);
      if (params.steps !== undefined) inp.steps = Number(params.steps);
      if (params.cfg !== undefined) inp.cfg = Number(params.cfg);
      if (params.sampler_name) inp.sampler_name = params.sampler_name;
      if (params.scheduler) inp.scheduler = params.scheduler;
      if (params.denoise !== undefined) inp.denoise = Number(params.denoise);
    }

    // CLIPTextEncode
    if (ct === 'CLIPTextEncode') {
      const title = (node._meta && node._meta.title) || '';
      const isNeg = /neg/i.test(title);
      if (isNeg && params.negative_prompt !== undefined) {
        inp.text = params.negative_prompt;
      } else if (!isNeg && params.prompt !== undefined) {
        inp.text = params.prompt;
      }
    }

    // Latent尺寸
    if (ct === 'EmptyLatentImage' || ct === 'EmptySD3LatentImage') {
      if (params.width !== undefined) inp.width = Number(params.width);
      if (params.height !== undefined) inp.height = Number(params.height);
    }

    // Loader覆盖
    if (ct === 'UNETLoader' && params.unet) inp.unet_name = params.unet;
    if (ct === 'CheckpointLoaderSimple' && params.checkpoint) inp.ckpt_name = params.checkpoint;
    if (ct === 'CLIPLoader' && params.clip) inp.clip_name = params.clip;
    if (ct === 'VAELoader' && params.vae) inp.vae_name = params.vae;
  }

  return wf;
}

// ============ Raw模式处理 ============

function parseRawWorkflow(input) {
  let wf = input;
  if (typeof wf === 'string') {
    wf = JSON.parse(wf);
  }
  // 校验：必须是API格式（节点ID为key的对象）
  if (typeof wf !== 'object' || Array.isArray(wf)) {
    throw new Error('workflow_json must be an object (API format), not an array');
  }
  if (wf.nodes && wf.links) {
    throw new Error('workflow_json appears to be editor format. Please export as API format.');
  }
  // 校验每个节点有class_type
  for (const [nid, node] of Object.entries(wf)) {
    if (!node.class_type) {
      throw new Error(`Node "${nid}" missing class_type`);
    }
  }
  return wf;
}

// ============ 主流程 ============

async function main() {
  const startTime = Date.now();
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = JSON.parse(raw);
  } catch (e) {
    return outputError(`Failed to parse input: ${e.message}`);
  }

  const params = input.params || input;

  // 加载配置
  const pluginDir = __dirname;
  const dataDir = path.join(pluginDir, 'data');
  const env = loadEnv(path.join(pluginDir, 'config.env'));

  const refreshToken = env.COMFY_REFRESH_TOKEN;
  const apiKey = env.COMFY_FIREBASE_API_KEY;
  const proxy = env.COMFY_PROXY || null;

  if (!refreshToken || !apiKey) {
    return outputError('Missing COMFY_REFRESH_TOKEN or COMFY_FIREBASE_API_KEY in config.env. Run: node setup.js');
  }

  // 图片存储目录
  const basePath = process.env.PROJECT_BASE_PATH || path.resolve(pluginDir, '..', '..');
  const imageDir = path.join(basePath, 'image', 'comfycloud');

  // 初始化模块
  const auth = new ComfyCloudAuth(refreshToken, apiKey, proxy);
  const network = new ComfyCloudNetwork(auth, proxy, imageDir);
  const resolver = new EcosystemResolver(dataDir);
  const factory = new PipelineFactory(resolver);
    const cacheDir = path.join(pluginDir, 'cache');
    const cacheMax = parseInt(env.COMFY_CACHE_MAX, 10) || 10;
    const cache = new CacheManager(cacheDir, cacheMax);

  try {
    // load_cached优先级最高：跳过模式判定，加载缓存+patchTemplate覆盖参数
    if (params.load_cached) {
      process.stderr.write(`[CACHE] Loading: ${params.load_cached}\n`);
      let workflow = cache.load(params.load_cached);
      workflow = patchTemplate(workflow, params);
      const { prompt_id } = await network.submitWorkflow(workflow);
      const job = await network.pollForCompletion(prompt_id);
      const result = await network.downloadImage(job);
      const port = process.env.SERVER_PORT || '6005';
      const imageKey = process.env.IMAGESERVER_IMAGE_KEY || '147258369plm';
      const httpUrl = process.env.VarHttpUrl || 'http://localhost';
      const imageUrl = `${httpUrl}:${port}/pw=${imageKey}/images/comfycloud/${result.filename}`;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return outputSuccess({
        image_url: imageUrl, local_path: result.localPath, file_size: result.size,
        elapsed_seconds: elapsed, ecosystem: 'cached', ecosystem_name: params.load_cached,
        pipeline: 'cached', model: '', prompt_id,
        messageForAI: `图片已生成！(${elapsed}s) [缓存: ${params.load_cached}]\n<img src="${imageUrl}" width="400">`
      });
    }

    const mode = parseMode(params);
    process.stderr.write(`[MODE] ${mode}\n`);

    let workflow;
    let meta = {};

    switch (mode) {
      case 'auto': {
        // 确定模型：用户传unet/checkpoint，否则默认z_image_bf16
        const modelName = params.unet || params.checkpoint || 'z_image_bf16.safetensors';
        const loaderHint = params.checkpoint ? 'checkpoint' : (params.unet ? 'unet' : null);

        // 解析生态
        const ecoConfig = resolver.resolve(modelName, loaderHint);
        process.stderr.write(`[ECO] Matched: ${ecoConfig.ecosystem_name} (${ecoConfig.pipeline})\n`);

        // 合并参数
        const merged = resolver.mergeParams(ecoConfig, {
          prompt: params.prompt,
          negative_prompt: params.negative_prompt,
          steps: params.steps,
          cfg: params.cfg,
          sampler_name: params.sampler_name || params.sampler,
          scheduler: params.scheduler,
          width: params.width,
          height: params.height,
          seed: params.seed,
          denoise: params.denoise,
          shift: params.shift,
          weight_dtype: params.weight_dtype,
          lora: params.lora,
          lora_strength: params.lora_strength,
          clip_strength: params.clip_strength,
          num_frames: params.num_frames,
          fps: params.fps,
          batch_size: params.batch_size,
        });

        // 构建工作流
        workflow = factory.build(ecoConfig, merged);
        meta = workflow._buildMeta || {};
        delete workflow._buildMeta;
        break;
      }

      case 'template': {
        const workflowDirs = [
          path.join(pluginDir, 'workflows'),
          path.join(pluginDir, '..', 'ComfyCloudHacker', 'workflows'),
        ];
        const template = loadTemplate(params.workflow, workflowDirs);
        workflow = patchTemplate(template, params);
        meta = { mode: 'template', template: params.workflow };
        break;
      }

      case 'raw': {
        workflow = parseRawWorkflow(params.workflow_json);
        meta = { mode: 'raw' };
        break;
      }
    }

    // save_as缓存
    if (params.save_as) {
      cache.save(params.save_as, workflow, meta);
      process.stderr.write(`[CACHE] Saved as: ${params.save_as}\n`);
    }

    // 提交
    const { prompt_id } = await network.submitWorkflow(workflow);

    // 轮询
    const job = await network.pollForCompletion(prompt_id);

    // 下载
    const result = await network.downloadImage(job);

    // 构建URL
    const port = process.env.SERVER_PORT || '6005';
    const imageKey = process.env.IMAGESERVER_IMAGE_KEY || '147258369plm';
    const httpUrl = process.env.VarHttpUrl || 'http://localhost';
    const imageUrl = `${httpUrl}:${port}/pw=${imageKey}/images/comfycloud/${result.filename}`;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    outputSuccess({
      image_url: imageUrl,
      local_path: result.localPath,
      file_size: result.size,
      elapsed_seconds: elapsed,
      ecosystem: meta.ecosystem || meta.mode || 'unknown',
      ecosystem_name: meta.ecosystemName || '',
      pipeline: meta.pipeline || '',
      model: meta.model || '',
      prompt_id: prompt_id,
      messageForAI: `图片已生成！(${elapsed}s)\n生态: ${meta.ecosystemName || meta.mode || 'unknown'}\n<img src="${imageUrl}" width="400">`
    });

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stderr.write(`[ERROR] ${err.message}\n`);

    // 尝试提取云端报错详情
    let detail = err.message;
    if (detail.length > 2000) detail = detail.substring(0, 2000) + '...';

    outputError(`生成失败 (${elapsed}s): ${detail}`);
  }
}

function outputSuccess(data) {
  const result = {
    status: 'success',
    result: {
      content: [{ type: 'text', text: data.messageForAI }],
      details: data
    }
  };
  process.stdout.write(JSON.stringify(result));
}

function outputError(message) {
  const result = {
    status: 'error',
    result: {
      content: [{ type: 'text', text: message }],
      details: { error: message }
    }
  };
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  process.stderr.write(`[FATAL] ${err.stack}\n`);
  outputError(`Fatal error: ${err.message}`);
});