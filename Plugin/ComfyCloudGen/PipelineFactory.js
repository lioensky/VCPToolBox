/**
 * PipelineFactory.js - 工作流拓扑工厂
 * 
 * 硬编码3种pipeline拓扑，用代码构建而非JSON模板。
 * 拓扑是结构性知识，变化频率极低，硬编码比JSON模板更可靠。
 * 
 * 支持的pipeline:
 *   ucv          - UNet+CLIP+VAE三件套 → KSampler → VAEDecode → Save
 *   ucv_auraflow - ucv + ModelSamplingAuraFlow节点
 *   checkpoint   - CheckpointLoaderSimple → KSampler → VAEDecode → Save
 *   wan_video    - WanVideo专用采样器pipeline（WanVideoSampler/HunyuanVideoSampler）
 *   ltx_video    - LTX Video专用pipeline
 */

class PipelineFactory {
  constructor(resolver) {
    this.resolver = resolver; // EcosystemResolver实例，用于COMBO校验
  }

  /**
   * 构建完整工作流
   * @param {object} ecoConfig - EcosystemResolver.resolve()返回的配置
   * @param {object} params - EcosystemResolver.mergeParams()返回的最终参数
   * @returns {object} API格式工作流JSON
   */
  build(ecoConfig, params) {
    const pipelineType = ecoConfig.pipeline;

    let workflow;
    switch (pipelineType) {
      case 'ucv':
        workflow = this._buildUCV(ecoConfig, params, false);
        break;
      case 'ucv_auraflow':
        workflow = this._buildUCV(ecoConfig, params, true);
        break;
      case 'checkpoint':
        workflow = this._buildCheckpoint(ecoConfig, params);
        break;
      case 'wan_video':
        workflow = this._buildWanVideo(ecoConfig, params);
        break;
      case 'ltx_video':
        workflow = this._buildLTXVideo(ecoConfig, params);
        break;
      default:
        throw new Error(`Unknown pipeline type: ${pipelineType}`);
    }

    // LoRA注入
    if (params.lora) {
      workflow = this._injectLoRA(workflow, params, ecoConfig.pipeline);
    }

    // COMBO校验
    this._validateWorkflow(workflow);

    // 附加构建元信息
    workflow._buildMeta = {
      ecosystem: ecoConfig.ecosystem_id,
      ecosystemName: ecoConfig.ecosystem_name,
      pipeline: pipelineType,
      model: ecoConfig.model,
      paramsUsed: this._traceParams(ecoConfig, params),
    };

    return workflow;
  }

  // ============ UCV Pipeline ============
  // CLIP → UNet → [AuraFlow?] → KSampler → VAEDecode → Save

  _buildUCV(eco, p, withAuraFlow) {
    const wf = {};
    let nextId = 1;
    const id = () => String(nextId++);

    // 节点ID
    const clipId = id();     // 1
    const unetId = id();     // 2
    const vaeId = id();      // 3
    const posId = id();      // 4
    const negId = id();      // 5
    const latentId = id();   // 6
    const samplerId = id();  // 7
    const decodeId = id();   // 8
    const saveId = id();     // 9

    // CLIPLoader
    wf[clipId] = {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: eco.clip,
        type: eco.clip_type || 'sd3'
      },
      _meta: { title: 'CLIPLoader' }
    };

    // UNETLoader
    wf[unetId] = {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: eco.model,
        weight_dtype: p.weight_dtype || 'default'
      },
      _meta: { title: 'UNETLoader' }
    };

    // VAELoader
    wf[vaeId] = {
      class_type: 'VAELoader',
      inputs: {
        vae_name: eco.vae
      },
      _meta: { title: 'VAELoader' }
    };

    // CLIPTextEncode (Positive)
    wf[posId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.prompt || '',
        clip: [clipId, 0]
      },
      _meta: { title: 'CLIP Positive' }
    };

    // CLIPTextEncode (Negative)
    wf[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative_prompt || '',
        clip: [clipId, 0]
      },
      _meta: { title: 'CLIP Negative' }
    };

    // EmptySD3LatentImage
    wf[latentId] = {
      class_type: 'EmptySD3LatentImage',
      inputs: {
        width: p.width,
        height: p.height,
        batch_size: p.batch_size || 1
      },
      _meta: { title: 'Empty Latent' }
    };

    // model数据流：UNet → [AuraFlow] → KSampler
    let modelSource = unetId;

    if (withAuraFlow) {
      const auraId = id(); // 10
      wf[auraId] = {
        class_type: 'ModelSamplingAuraFlow',
        inputs: {
          shift: p.shift || 3,
          model: [unetId, 0]
        },
        _meta: { title: 'AuraFlow Shift' }
      };
      modelSource = auraId;
    }

    // 处理ecosystem中的extra_nodes（通用机制）
    if (eco.extra_nodes && eco.extra_nodes.length > 0) {
      for (const extra of eco.extra_nodes) {
        // 跳过AuraFlow如果已经硬编码处理
        if (withAuraFlow && extra.class_type === 'ModelSamplingAuraFlow') continue;

        const extraId = id();
        const inputs = {};
        // 解析参数：$变量名 → 从params取值
        for (const [key, val] of Object.entries(extra.params || {})) {
          if (typeof val === 'string' && val.startsWith('$')) {
            inputs[key] = p[val.substring(1)];
          } else {
            inputs[key] = val;
          }
        }
        // 连接model输入
        if (extra.insert_after === 'unet') {
          inputs.model = [modelSource, 0];
          modelSource = extraId;
        }
        wf[extraId] = {
          class_type: extra.class_type,
          inputs,
          _meta: { title: extra.class_type }
        };
      }
    }

    // KSampler
    wf[samplerId] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler_name || 'euler',
        scheduler: p.scheduler || 'normal',
        denoise: p.denoise || 1,
        model: [modelSource, 0],
        positive: [posId, 0],
        negative: [negId, 0],
        latent_image: [latentId, 0]
      },
      _meta: { title: 'KSampler' }
    };

    // VAEDecode
    wf[decodeId] = {
      class_type: 'VAEDecode',
      inputs: {
        samples: [samplerId, 0],
        vae: [vaeId, 0]
      },
      _meta: { title: 'VAEDecode' }
    };

    // SaveImage
    wf[saveId] = {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'ComfyCloud',
        images: [decodeId, 0]
      },
      _meta: { title: 'SaveImage' }
    };

    return wf;
  }

  // ============ Checkpoint Pipeline ============
  // CheckpointLoaderSimple → KSampler → VAEDecode → Save

  _buildCheckpoint(eco, p) {
    const wf = {};
    let nextId = 1;
    const id = () => String(nextId++);

    const ckptId = id();     // 1
    const posId = id();      // 2
    const negId = id();      // 3
    const latentId = id();   // 4
    const samplerId = id();  // 5
    const decodeId = id();   // 6
    const saveId = id();     // 7

    // CheckpointLoaderSimple
    wf[ckptId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: eco.model
      },
      _meta: { title: 'Checkpoint Loader' }
    };

    // CLIPTextEncode (Positive) - clip从checkpoint输出
    wf[posId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.prompt || '',
        clip: [ckptId, 1] // checkpoint的第2个输出是clip
      },
      _meta: { title: 'CLIP Positive' }
    };

    // CLIPTextEncode (Negative)
    wf[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative_prompt || '',
        clip: [ckptId, 1]
      },
      _meta: { title: 'CLIP Negative' }
    };

    // EmptyLatentImage
    wf[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: p.width,
        height: p.height,
        batch_size: p.batch_size || 1
      },
      _meta: { title: 'Empty Latent' }
    };

    // KSampler
    wf[samplerId] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler_name || 'dpmpp_2m',
        scheduler: p.scheduler || 'normal',
        denoise: p.denoise || 1,
        model: [ckptId, 0],    // checkpoint第1个输出是model
        positive: [posId, 0],
        negative: [negId, 0],
        latent_image: [latentId, 0]
      },
      _meta: { title: 'KSampler' }
    };

    // VAEDecode - vae从checkpoint输出
    wf[decodeId] = {
      class_type: 'VAEDecode',
      inputs: {
        samples: [samplerId, 0],
        vae: [ckptId, 2] // checkpoint第3个输出是vae
      },
      _meta: { title: 'VAEDecode' }
    };

    // SaveImage
    wf[saveId] = {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'ComfyCloud',
        images: [decodeId, 0]
      },
      _meta: { title: 'SaveImage' }
    };

    return wf;
  }

  // ============ WanVideo Pipeline ============
  // CLIP → UNet → VAE → WanVideoSampler → VAEDecode → SaveAnimatedWEBP

  _buildWanVideo(eco, p) {
    const wf = {};
    let nextId = 1;
    const id = () => String(nextId++);

    const clipId = id();
    const unetId = id();
    const vaeId = id();
    const posId = id();
    const negId = id();
    const samplerId = id();
    const decodeId = id();
    const saveId = id();

    // CLIPLoader (Wan用umt5)
    wf[clipId] = {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: eco.clip,
        type: eco.clip_type || 'wan'
      },
      _meta: { title: 'CLIPLoader' }
    };

    // UNETLoader
    wf[unetId] = {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: eco.model,
        weight_dtype: p.weight_dtype || 'default'
      },
      _meta: { title: 'UNETLoader' }
    };

    // VAELoader
    wf[vaeId] = {
      class_type: 'VAELoader',
      inputs: {
        vae_name: eco.vae
      },
      _meta: { title: 'VAELoader' }
    };

    // CLIPTextEncode
    wf[posId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.prompt || '',
        clip: [clipId, 0]
      },
      _meta: { title: 'CLIP Positive' }
    };

    wf[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: p.negative_prompt || '',
        clip: [clipId, 0]
      },
      _meta: { title: 'CLIP Negative' }
    };

    // WanVideoSampler (或 HunyuanVideoSampler)
    const samplerClass = eco.sampler_class || 'WanVideoSampler';
    wf[samplerId] = {
      class_type: samplerClass,
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler: p.sampler_name || 'uni_pc_bh2',
        scheduler: p.scheduler || 'beta',
        denoise: p.denoise || 1,
        width: p.width || 832,
        height: p.height || 480,
        num_frames: p.num_frames || 81,
        force_offload: p.force_offload !== undefined ? p.force_offload : true,
        model: [unetId, 0],
        positive: [posId, 0],
        negative: [negId, 0],
        vae: [vaeId, 0]
      },
      _meta: { title: samplerClass }
    };

    // VAEDecode
    wf[decodeId] = {
      class_type: 'VAEDecode',
      inputs: {
        samples: [samplerId, 0],
        vae: [vaeId, 0]
      },
      _meta: { title: 'VAEDecode' }
    };

    // SaveAnimatedWEBP
    wf[saveId] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: {
        filename_prefix: 'ComfyCloud',
        fps: p.fps || 16,
        lossless: false,
        quality: 85,
        method: 'default',
        images: [decodeId, 0]
      },
      _meta: { title: 'SaveAnimatedWEBP' }
    };

    return wf;
  }

  // ============ LTX Video Pipeline ============

  _buildLTXVideo(eco, p) {
    const wf = {};
    let nextId = 1;
    const id = () => String(nextId++);

    const clipId = id();
    const unetId = id();
    const vaeId = id();
    const posId = id();
    const negId = id();
    const samplerId = id();
    const decodeId = id();
    const saveId = id();

    wf[clipId] = {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: eco.clip,
        type: eco.clip_type || 'ltx'
      },
      _meta: { title: 'CLIPLoader' }
    };

    wf[unetId] = {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: eco.model,
        weight_dtype: p.weight_dtype || 'default'
      },
      _meta: { title: 'UNETLoader' }
    };

    wf[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: eco.vae },
      _meta: { title: 'VAELoader' }
    };

    wf[posId] = {
      class_type: 'CLIPTextEncode',
      inputs: { text: p.prompt || '', clip: [clipId, 0] },
      _meta: { title: 'CLIP Positive' }
    };

    wf[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: { text: p.negative_prompt || '', clip: [clipId, 0] },
      _meta: { title: 'CLIP Negative' }
    };

    // LTX用标准KSampler + EmptySD3LatentImage
    const latentId = id();
    wf[latentId] = {
      class_type: 'EmptySD3LatentImage',
      inputs: {
        width: p.width || 768,
        height: p.height || 512,
        batch_size: p.num_frames || 97
      },
      _meta: { title: 'Empty Latent' }
    };

    wf[samplerId] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler_name || 'euler',
        scheduler: p.scheduler || 'simple',
        denoise: p.denoise || 1,
        model: [unetId, 0],
        positive: [posId, 0],
        negative: [negId, 0],
        latent_image: [latentId, 0]
      },
      _meta: { title: 'KSampler' }
    };

    wf[decodeId] = {
      class_type: 'VAEDecode',
      inputs: { samples: [samplerId, 0], vae: [vaeId, 0] },
      _meta: { title: 'VAEDecode' }
    };

    wf[saveId] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: {
        filename_prefix: 'ComfyCloud',
        fps: p.fps || 24,
        lossless: false,
        quality: 85,
        method: 'default',
        images: [decodeId, 0]
      },
      _meta: { title: 'SaveAnimatedWEBP' }
    };

    return wf;
  }

  // ============ LoRA注入 ============

  _injectLoRA(workflow, params, pipelineType) {
    const wf = { ...workflow };
    const loraName = params.lora;
    const loraStrength = params.lora_strength !== undefined ? params.lora_strength : 0.8;
    const clipStrength = params.clip_strength !== undefined ? params.clip_strength : loraStrength;

    // 找到KSampler/WanVideoSampler节点
    let samplerNodeId = null;
    let samplerNode = null;
    for (const [nid, node] of Object.entries(wf)) {
      if (nid === '_buildMeta') continue;
      if (['KSampler', 'KSamplerAdvanced', 'WanVideoSampler', 'HunyuanVideoSampler']
          .includes(node.class_type)) {
        samplerNodeId = nid;
        samplerNode = node;
        break;
      }
    }

    if (!samplerNode) {
      process.stderr.write('[LORA] Warning: No sampler node found, skipping LoRA injection\n');
      return wf;
    }

    // 找到sampler的model来源
    const modelInput = samplerNode.inputs.model; // [sourceId, outputIndex]
    if (!Array.isArray(modelInput)) return wf;

    // 找到clip来源（从CLIPTextEncode回溯）
    let clipSource = null;
    for (const [nid, node] of Object.entries(wf)) {
      if (nid === '_buildMeta') continue;
      if (node.class_type === 'CLIPTextEncode' && Array.isArray(node.inputs.clip)) {
        clipSource = node.inputs.clip;
        break;
      }
    }

    // 分配新ID
    const maxId = Math.max(...Object.keys(wf).filter(k => k !== '_buildMeta').map(Number));
    const loraId = String(maxId + 1);

    // 创建LoraLoader节点
    wf[loraId] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: loraName,
        strength_model: loraStrength,
        strength_clip: clipStrength,
        model: modelInput,               // 接管原model来源
        clip: clipSource || modelInput,   // 接管原clip来源
      },
      _meta: { title: `LoRA: ${loraName}` }
    };

    // 重连sampler的model → LoRA输出
    samplerNode.inputs.model = [loraId, 0];

    // 重连所有CLIPTextEncode的clip → LoRA的clip输出
    for (const [nid, node] of Object.entries(wf)) {
      if (nid === '_buildMeta') continue;
      if (node.class_type === 'CLIPTextEncode') {
        node.inputs.clip = [loraId, 1];
      }
    }

    process.stderr.write(`[LORA] Injected ${loraName} (model:${loraStrength}, clip:${clipStrength})\n`);
    return wf;
  }

  // ============ 校验 ============

  _validateWorkflow(workflow) {
    const warnings = [];
    for (const [nid, node] of Object.entries(workflow)) {
      if (nid === '_buildMeta') continue;
      if (!node.class_type) {
        warnings.push(`Node ${nid}: missing class_type`);
        continue;
      }
      // COMBO参数校验
      if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
        const sn = node.inputs.sampler_name;
        if (sn && !this.resolver.validateCombo('KSampler', 'sampler_name', sn)) {
          warnings.push(`KSampler.sampler_name "${sn}" not in allowed COMBO list`);
        }
        const sc = node.inputs.scheduler;
        if (sc && !this.resolver.validateCombo('KSampler', 'scheduler', sc)) {
          warnings.push(`KSampler.scheduler "${sc}" not in allowed COMBO list`);
        }
      }
      if (node.class_type === 'CLIPLoader') {
        const ct = node.inputs.type;
        if (ct && !this.resolver.validateCombo('CLIPLoader', 'type', ct)) {
          warnings.push(`CLIPLoader.type "${ct}" not in allowed COMBO list`);
        }
      }
    }
    if (warnings.length > 0) {
      process.stderr.write(`[VALIDATE] ${warnings.length} warnings:\n${warnings.join('\n')}\n`);
    }
  }

  // ============ 参数溯源 ============

  _traceParams(eco, params) {
    // 记录每个关键参数的来源
    const trace = {};
    const ecoDefaults = eco.defaults || {};
    const keys = ['steps', 'cfg', 'sampler_name', 'scheduler', 'width', 'height',
                  'seed', 'denoise', 'shift', 'lora', 'lora_strength'];
    for (const k of keys) {
      if (params[k] !== undefined) {
        trace[k] = { value: params[k] };
      }
    }
    return trace;
  }
}

module.exports = PipelineFactory;