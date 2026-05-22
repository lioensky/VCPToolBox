/**
 * AI Image Execution Adapter
 *
 * Card 3A-0：骨架，不调真实 PluginManager。
 * 职责：接收 plan，映射 step → plugin，构造参数，解析结果。
 *
 * 统一返回结构（无论成功/失败/部分）：
 *   { ok, images, errors, steps }
 */

// ---------------------------------------------------------------------------
// 插件路由表 — step.plugin → pluginManager toolName
// ---------------------------------------------------------------------------
const PLUGIN_ROUTE_MAP = Object.freeze({
  FluxGen:          { toolName: 'FluxGen',          command: 'FluxGenerateImage' },
  ComfyUIGen:       { toolName: 'ComfyUIGen',       command: 'ComfyUIGenerateImage' },
  ComfyCloudGen:    { toolName: 'ComfyCloudGen',    command: 'GenerateImage' },
  DoubaoGen:        { toolName: 'DoubaoGen',        command: 'generate' },            // 子命令: generate/edit/compose/group
  DMXDoubaoGen:     { toolName: 'DMXDoubaoGen',     command: 'DoubaoGenerateImage' },
  GeminiImageGen:   { toolName: 'GeminiImageGen',   command: 'GeminiGenerateImage' },
  ZImageGen:        { toolName: 'ZImageGen',        command: 'ZImageGenerate' },
  ZImageGen2:       { toolName: 'ZImageGen2',       command: 'ZImageGenerate' },
  ZImageTurboGen:   { toolName: 'ZImageTurboGen',   command: 'GenerateImage' },
  WebUIGen:         { toolName: 'WebUIGen',         command: 'WebUIGenerate' },
  NovelAIGen:       { toolName: 'NovelAIGen',       command: 'NovelAIGenerateImage' },
  QwenImageGen:     { toolName: 'QwenImageGen',     command: 'GenerateImage' },
  NanoBananaGen2:   { toolName: 'NanoBananaGen2',   command: 'NanoBananaGenerateImage' },
  NanoBananaGenOR:  { toolName: 'NanoBananaGenOR',  command: 'NanoBananaGenerateImage' },
});

// ---------------------------------------------------------------------------
// 已知 step type 白名单
// ---------------------------------------------------------------------------
const KNOWN_STEP_TYPES = Object.freeze([
  'generate_image',
  'edit_image',
  'compose_image',
]);

const DOUBAO_COMMAND_BY_STEP_TYPE = Object.freeze({
  generate_image: 'generate',
  edit_image: 'edit',
  compose_image: 'compose',
});

function resolveSourceImages(step) {
  if (!step || typeof step !== 'object') return null;

  const candidates = [
    step.image,
    step.images,
    step.sourceImage,
    step.sourceImages,
    step.source_image,
    step.source_images,
    step.referenceImage,
    step.referenceImages,
    step.reference_image,
    step.reference_images,
    step.inputImage,
    step.inputImages,
    step.input_image,
    step.input_images,
  ];

  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (_) {
          // 非 JSON 数组字符串时按单图处理
        }
      }

      return trimmed;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// normalizeImageStep(step) → { ok, step, error }
// ---------------------------------------------------------------------------
function normalizeImageStep(step) {
  if (!step || typeof step !== 'object') {
    return { ok: false, step: null, error: 'step_must_be_object' };
  }

  if (!KNOWN_STEP_TYPES.includes(step.type)) {
    return {
      ok: false,
      step: null,
      error: `unknown_step_type:${step.type || '<empty>'}`,
    };
  }

  if (!step.plugin || typeof step.plugin !== 'string') {
    return { ok: false, step: null, error: 'step_plugin_required' };
  }

  if (!PLUGIN_ROUTE_MAP[step.plugin]) {
    return {
      ok: false,
      step: null,
      error: `unknown_plugin:${step.plugin}`,
    };
  }

  if (!step.prompt || typeof step.prompt !== 'string') {
    return { ok: false, step: null, error: 'step_prompt_required' };
  }

  return {
    ok: true,
    step: {
      type: step.type,
      plugin: step.plugin,
      prompt: step.prompt.trim(),
      resolution: step.resolution || null,
      seed: Number.isFinite(step.seed) ? step.seed : null,
      negativePrompt: step.negativePrompt || null,
      sourceImages: resolveSourceImages(step),
    },
  };
}

// ---------------------------------------------------------------------------
// mapStepToPlugin(step) → { ok, toolName, command, args, error }
// ---------------------------------------------------------------------------
function mapStepToPlugin(step) {
  const normalized = normalizeImageStep(step);
  if (!normalized.ok) {
    return { ok: false, toolName: null, command: null, args: null, error: normalized.error };
  }

  const s = normalized.step;
  const route = PLUGIN_ROUTE_MAP[s.plugin];
  const command = s.plugin === 'DoubaoGen'
    ? DOUBAO_COMMAND_BY_STEP_TYPE[s.type] || route.command
    : route.command;

  const args = {
    prompt: s.prompt,
  };

  if (s.resolution) {
    args.resolution = s.resolution;
  }
  if (s.seed !== null) {
    args.seed = s.seed;
  }
  if (s.negativePrompt) {
    args.negative_prompt = s.negativePrompt;
  }
  if (s.sourceImages) {
    args.image = s.sourceImages;
  }

  return {
    ok: true,
    toolName: route.toolName,
    command,
    args,
  };
}

// ---------------------------------------------------------------------------
// parsePluginResult(result) → { ok, image, error }
// ---------------------------------------------------------------------------
/**
 * 从任意嵌套对象中提取图片信息。
 * processToolCall 已 unwrap 子进程的 { status, result } 包装，返回的是内层 result 对象。
 * 不同插件的内层结构差异大：有些平铺 url/path，有些嵌套在 details/data/result 下。
 */
function extractImageFromBody(body) {
  if (!body || typeof body !== 'object') return null;

  // 顶层直铺字段 + 常见变体
  const urlArr   = Array.isArray(body.imageUrls) ? body.imageUrls : null;
  const url      = body.url      || body.imageUrl  || (urlArr && urlArr[0]) || null;
  const path     = body.path     || body.imagePath || body.filePath || body.serverPath || null;
  const filename = body.filename || body.fileName  || null;

  if (url || path || filename) {
    return { url, path, filename };
  }

  // DoubaoGen 风格：{ details: { imageUrls, serverPath, fileName } }
  const details = body.details || body.data || body.result || {};
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return extractImageFromBody(details);
  }

  // 数组风格：{ data: [{ url, ... }] }（如 ComfyUI / Flux）
  const arr = Array.isArray(body.data) ? body.data : null;
  if (arr && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
    const first = arr[0];
    if (first.url || first.imageUrl || first.path || first.filePath || first.filename) {
      return extractImageFromBody(first);
    }
  }

  return null;
}

function parsePluginResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, image: null, error: 'plugin_result_not_object' };
  }

  // 原始 stdio 格式（未被 processToolCall unwrap）：{ status, result/error }
  if (result.hasOwnProperty('status')) {
    if (result.status === 'error') {
      return {
        ok: false,
        image: null,
        error: result.error || 'plugin_returned_error',
      };
    }

    if (result.status !== 'success') {
      return {
        ok: false,
        image: null,
        error: `unknown_plugin_status:${result.status}`,
      };
    }

    // 递归提取 result.result
    const image = extractImageFromBody(result.result || {});
    if (image) return { ok: true, image };

    return { ok: false, image: null, error: 'plugin_result_no_image_data' };
  }

  // processToolCall 已 unwrap 的格式
  const image = extractImageFromBody(result);
  if (image) return { ok: true, image };

  return {
    ok: false,
    image: null,
    error: 'plugin_result_no_image_data',
  };
}

// ---------------------------------------------------------------------------
// executeImagePlan(plan, options)
//
// plan:  { steps: [...] }
// options: { pluginManager: <required> }
//
// 返回：{ ok, images, errors, steps }
// ---------------------------------------------------------------------------
async function executeImagePlan(plan, options = {}) {
  const pluginManager = options.pluginManager || null;
  const results = {
    ok: false,
    images: [],
    errors: [],
    steps: [],
  };

  if (!pluginManager) {
    results.errors.push('plugin_manager_not_provided');
    return results;
  }

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    results.errors.push('plan_steps_empty');
    return results;
  }

  if (typeof pluginManager.processToolCall !== 'function') {
    results.errors.push('plugin_manager_missing_processToolCall');
    return results;
  }

  let hasSuccess = false;

  for (let i = 0; i < plan.steps.length; i++) {
    const rawStep = plan.steps[i];
    const stepIndex = i;

    // 只处理 generate_image / edit_image / compose_image
    if (!KNOWN_STEP_TYPES.includes(rawStep.type)) {
      results.steps.push({ index: stepIndex, ok: true, skipped: true, reason: `non_image_step_type:${rawStep.type}` });
      continue;
    }

    const mapped = mapStepToPlugin(rawStep);
    if (!mapped.ok) {
      results.errors.push(`step[${stepIndex}]: ${mapped.error}`);
      results.steps.push({ index: stepIndex, ok: false, error: mapped.error });
      continue;
    }

    const toolArgs = { command: mapped.command, ...mapped.args };
    results.steps.push({ index: stepIndex, ok: false, pending: true, plugin: mapped.toolName });

    try {
      const rawResult = await pluginManager.processToolCall(
        mapped.toolName,
        toolArgs,
        '127.0.0.1',            // requestIp
        { requestSource: 'ai-image-pipeline' }  // executionContext
      );

      const parsed = parsePluginResult(rawResult);
      if (parsed.ok) {
        results.images.push({
          stepIndex,
          plugin: mapped.toolName,
          prompt: mapped.args.prompt,
          ...parsed.image,
        });
        results.steps[results.steps.length - 1] = { index: stepIndex, ok: true, plugin: mapped.toolName };
        hasSuccess = true;
      } else {
        results.errors.push(`step[${stepIndex}]: plugin_error: ${parsed.error}`);
        results.steps[results.steps.length - 1] = { index: stepIndex, ok: false, error: parsed.error, plugin: mapped.toolName };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`step[${stepIndex}]: exception: ${msg}`);
      results.steps[results.steps.length - 1] = { index: stepIndex, ok: false, error: msg, plugin: mapped.toolName };
    }
  }

  results.ok = results.errors.length === 0 && hasSuccess;
  return results;
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
module.exports = {
  // 主入口
  executeImagePlan,

  // 子函数（可独立 smoke test）
  normalizeImageStep,
  mapStepToPlugin,
  parsePluginResult,

  // 路由表（只读引用，不期望外部修改）
  PLUGIN_ROUTE_MAP,
  KNOWN_STEP_TYPES,
  DOUBAO_COMMAND_BY_STEP_TYPE,
  resolveSourceImages,
};
