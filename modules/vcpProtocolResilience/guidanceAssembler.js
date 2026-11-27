'use strict';

/**
 * modules/vcpProtocolResilience/guidanceAssembler.js
 * 负责构建轮内动态纠偏指导回执与轮间常驻药丸（单例预编译，零运行期 IO）
 */
const fs = require('fs');
const path = require('path');

const PILL_HEADER_TAG = '[系统提示:] 【VCP 工具调用协议规范】';
const PILL_CLOSING_TAG = '【/VCP 工具调用协议规范】';

const PILL_HEADER_REGEX = /^[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/;
const PILL_CLOSING_REGEX = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*$/;


let _cachedStaticBase = null;
let _cachedCleanBody = null;

// 安全内置降级底座（防止极端情况下外部文档缺失导致的崩溃）
const FALLBACK_STATIC_PROMPT = `
[系统提示:] 【VCP 工具调用协议规范】
VCP 格式是本系统中 AI 大语言模型的专用自动化工具调用协议，其标准格式与语法如下：

### 一、标准骨架模板
\`\`\`vcp
<<<[TOOL_REQUEST]>>>
maid:「始」你的署名「末」,
tool_name:「始」目标工具名「末」,
command:「始」工具参数内容「末」,
content:「始ESCAPE」这是一个优先正则保护字段，内部包含<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>或「始」字面量时不会破坏解析器「末ESCAPE」
<<<[END_TOOL_REQUEST]>>>
\`\`\`

### 二、核心调用规则（请严格遵循）
1. **外框独立成对闭合**：必须以独占一行的 \`<<<[TOOL_REQUEST]>>>\` 开始，并以独占一行的 \`<<<[END_TOOL_REQUEST]>>>\` 结束，严禁漏写尾标。
2. **字段冒号与定界符包裹**：每个参数由 \`字段名:\` 开启，参数内容必须且只能由 \`「始」\` 与 \`「末」\` 完整包裹（富文本与复杂换行完全兼容）。如需传递包含协议字面量的代码，请使用 \`「始ESCAPE」...「末ESCAPE」\`。
3. **必填身份标识（tool_name）**：工具调用的核心是执行动作，因此 \`tool_name\` 字段**必不可少**。
4. **署名字段（maid / valet）**：用于任务追踪和了解调用发起者，女性角色填 \`maid\`，男性角色填 \`valet\`。本系统强制要求准确填写署名（部分鉴权插件为不可省参数）。

### 三、典型用例参考（通过源码查询插件探索具体工具用法）
- **用例 1：查询前端分布式插件源码**
\`\`\`vcp
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」PluginSourceViewer「末」,
targettool:「始」CodeSearcher「末」
<<<[END_TOOL_REQUEST]>>>
\`\`\`

- **用例 2：查询后端插件源码**
\`\`\`vcp
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」ServerPluginSourceViewer「末」,
targettool:「始」LinuxShellExecutor「末」
<<<[END_TOOL_REQUEST]>>>
\`\`\`

> **注意**：以上用例演示了如何通过源码查询工具探索具体插件的内部参数与用法。发起调用时请严格保持上述定界符与键值结构！
【/VCP 工具调用协议规范】
`.trim();

/**
 * 剥离静态提示词首尾的外壳标记，获取用于三明治内层的干净正文
 * 支持对历史药丸标签的向前正则兼容（含/不含"工具调用"）
 * @param {string} raw
 * @returns {string}
 */
function extractCleanBody(raw) {
  let body = (raw || '').trim();
  body = body.replace(/^[ \t]*(?:[【\[［]\s*系统提示\s*[:：]\s*[】\]］]\s*)?[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*\r?\n?/, '');
  body = body.replace(/^[ \t]*[【\[［]\s*系统提示\s*[:：]\s*[】\]］][ \t]*\r?\n?/, '');
  body = body.replace(/\r?\n?[ \t]*[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］][ \t]*$/, '');
  return body.trim();
}

/**
 * 获取并编译静态底座（单例预编译，运行期零磁盘 IO）
 * @param {string} [customStaticPrompt] 可选的自定义底座字符串
 * @returns {{ fullBase: string, cleanBody: string }}
 */
function ensurePillWrapper(raw) {
  const trimmed = (raw || '').trim();
  const hasSysPrefix = /^[ \t]*[【\[［]\s*系统提示\s*[:：]\s*[】\]］]/.test(trimmed);
  const hasHeader = PILL_HEADER_REGEX.test(trimmed);
  const hasClosing = PILL_CLOSING_REGEX.test(trimmed);
  const cleanBody = extractCleanBody(trimmed);
  if (hasSysPrefix && hasHeader && hasClosing) {
    return { fullBase: trimmed, cleanBody };
  }
  return {
    fullBase: `${PILL_HEADER_TAG}\n${cleanBody}\n${PILL_CLOSING_TAG}`,
    cleanBody
  };
}

function loadStaticBasePrompt(customStaticPrompt) {
  if (customStaticPrompt && typeof customStaticPrompt === 'string') {
    return ensurePillWrapper(customStaticPrompt);
  }

  if (_cachedStaticBase && _cachedCleanBody) {
    return { fullBase: _cachedStaticBase, cleanBody: _cachedCleanBody };
  }

  let raw = '';
  const candidatePaths = [
    path.resolve(__dirname, './assets/VCP_STATIC_PILL_PROMPT.md')
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        raw = fs.readFileSync(p, 'utf-8').trim();
        break;
      } catch (e) { /* ignore */ }
    }
  }

  if (!raw) {
    raw = FALLBACK_STATIC_PROMPT.trim();
  }

  const wrapped = ensurePillWrapper(raw);
  _cachedStaticBase = wrapped.fullBase;
  _cachedCleanBody = wrapped.cleanBody;

  return { fullBase: _cachedStaticBase, cleanBody: _cachedCleanBody };
}

/**
 * 别名，兼容旧命名
 */
const loadAndCompileStaticBase = loadStaticBasePrompt;

/**
 * 动态靶向字典全集（覆盖 00/02 全部分类）
 */
/**
 * 清洗并截断写入纠偏回执文本的动态插值字段，防止协议毒字符注入破坏上层信封边界。
 * @param {*} value
 * @param {number} [maxLen=64]
 * @returns {string}
 */
function sanitizeGuidanceInterpolation(value, maxLen = 64) {
  if (value === null || value === undefined) return '';
  let sanitized = String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]<>{}]/g, '');
  let prev;
  do {
    prev = sanitized;
    sanitized = sanitized.replace(/VCP调用结果结束|VCP协议纠偏指导|ROLE_DIVIDE/gi, '');
  } while (sanitized !== prev);
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  if (Number.isFinite(maxLen) && maxLen > 0 && sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen);
  }
  return sanitized;
}

const DYNAMIC_ERROR_MAP = {
  // 1. 缺 tool_name 或误填入 maid（黑名单场景 A）
  MISSING_TOOL_NAME: {
    head: (call) => {
      const safePlugin = sanitizeGuidanceInterpolation(call.detectedPluginInMaid);
      return safePlugin
        ? `⚠️ 检测到你将目标插件名「${safePlugin}」误填入了署名字段 maid/valet，导致系统无法定位要执行的工具！`
        : `⚠️ 本轮工具调用缺少核心字段 tool_name，系统无法识别你要执行什么工具！`;
    },
    tail: (call) => {
      const safePlugin = sanitizeGuidanceInterpolation(call.detectedPluginInMaid);
      return safePlugin
        ? `👉 立即纠偏动作：请将插件名移至 tool_name:「始」${safePlugin}「末」，并在 maid 字段中填写你的角色署名。`
        : `👉 立即纠偏动作：请在工具块中补齐 tool_name:「始」目标工具名「末」，并规范填写参数。`;
    }
  },

  // 2. 缺少 maid/valet 强制署名
  MISSING_MAID: {
    head: (call) => `⚠️ 本轮工具调用缺少 maid (女性) / valet (男性) 角色署名字段！`,
    tail: (call) => `👉 立即纠偏动作：本系统强制要求每次调用必须标明发起者。请在工具块开头添加 maid:「始」你的署名「末」（男性填 valet）。`
  },

  // 3. 角色名误填入 tool_name、插件名误入 maid（黑名单场景 B）或控制键大小写错
  INVALID_TOOL_NAME: {
    head: (call) => {
      const safeRole = sanitizeGuidanceInterpolation(call.roleNameInTool);
      const safePlugin = sanitizeGuidanceInterpolation(call.pluginInMaid);
      const safeDetail = sanitizeGuidanceInterpolation(call.errorDetail, 256);
      if (safeRole) return `⚠️ 检测到你将角色名「${safeRole}」误填入了 tool_name，tool_name 必须是真实的系统工具名！`;
      if (safePlugin) return `⚠️ 检测到你在 maid 署名中填写了系统插件名「${safePlugin}」，署名字段仅能填写你的角色名字！`;
      return `⚠️ ${safeDetail || '工具控制键大小写错误或键名包含非法字符！'}`;
    },
    tail: (call) => {
      const safeRole = sanitizeGuidanceInterpolation(call.roleNameInTool);
      if (safeRole) return `👉 立即纠偏动作：请将 tool_name 替换为你真正要调用的工具名称（如 LinuxShellExecutor），并在 maid 中填写 ${safeRole}。`;
      if (call.pluginInMaid) return `👉 立即纠偏动作：请在 maid 中正确填写你的角色署名，切勿在署名中使用插件名称。`;
      return `👉 立即纠偏动作：系统控制与署名键（tool_name, maid, valet, archery, ink, river, vref, timely_contact, tool_password）必须严格全小写，普通参数键名仅支持字母、数字与下划线。`;
    }
  },

  // 4. 字段未闭合或定界符错乱（III-2）
  UNCLOSED_FIELD: {
    head: (call) => `⚠️ 参数定界符未成对闭合（检测到字段漏写配对的「末」或转义保护符越界）！`,
    tail: (call) => `👉 立即纠偏动作：请检查所有参数，确保每个「始」均有严格配对的「末」；复杂内容包含字面量时请使用「始ESCAPE」...「末ESCAPE」。`
  },

  // 5. 语法与赋值畸变（III-3 / 重复键冲突 III-4 / 原生解析失败）
  MALFORMED_BLOCK_SYNTAX: {
    head: (call) => {
      if (call.isDuplicateConflict) {
        let conflictKey = 'tool_name';
        let targetDesc = '调用目标';
        if (call.errorDetail && call.errorDetail.includes('jev')) {
          conflictKey = 'jev';
        } else if (call.errorDetail && (call.errorDetail.includes('maid') || call.errorDetail.includes('valet') || call.errorDetail.includes('署名'))) {
          conflictKey = 'maid/valet 署名';
          targetDesc = '调用角色';
        }
        return `⚠️ 同一工具块内部重复定义了冲突的 ${conflictKey}，导致系统无法确定${targetDesc}！`;
      }
      if (call.subType === 'NATIVE_PARSE_FAILED') {
        const safeDetail = sanitizeGuidanceInterpolation(call.errorDetail, 256);
        return `⚠️ ${safeDetail || '工具块语法结构异常，原生解析器无法解析！'}`;
      }
      if (call.errorDetail) {
        const safeDetail = sanitizeGuidanceInterpolation(call.errorDetail, 256);
        return `⚠️ ${safeDetail || '工具块语法结构异常！'}`;
      }
      return `⚠️ 参数赋值语法错误（禁止使用等号 =、全角冒号 ：或普通引号包裹参数）！`;
    },
    tail: (call) => {
      if (call.isDuplicateConflict) {
        let conflictDesc = 'tool_name';
        if (call.errorDetail && call.errorDetail.includes('jev')) {
          conflictDesc = 'jev';
        } else if (call.errorDetail && (call.errorDetail.includes('maid') || call.errorDetail.includes('valet') || call.errorDetail.includes('署名'))) {
          conflictDesc = 'maid 或 valet 署名字段';
        }
        return `👉 立即纠偏动作：同一工具块内仅能声明一次 ${conflictDesc}，请移除多余的重复定义。`;
      }
      if (call.subType === 'NATIVE_PARSE_FAILED') {
        return `👉 立即纠偏动作：请检查工具块语法结构，确保包含合法的 tool_name 与符合 key:「始」val「末」规范的参数格式。`;
      }
      return `👉 立即纠偏动作：参数必须采用 key:「始」value「末」格式（半角冒号与定界符），起止标记必须严格保持 \`<<<[TOOL_REQUEST]>>>\` 与 \`<<<[END_TOOL_REQUEST]>>>\`。`;
    }
  },

  // 6. 兜底全空块
  EMPTY_OR_MALFORMED_FIELDS: {
    head: (call) => `⚠️ 工具块内部为空或不包含任何有效字段！`,
    tail: (call) => `👉 立即纠偏动作：请在工具块内部准确填入 tool_name、maid 及工具所需参数。`
  }
};

/**
 * 组装轮内实时纠偏回执
 *
 * @param {object} [toolCallOrOptions={}]
 * @param {string} [toolCallOrOptions.errorCode] 错误码
 * @param {string} [toolCallOrOptions.errorDetail] 错误详情
 * @param {string} [toolCallOrOptions.blockFingerprint] 坏块指纹
 * @param {string} [toolCallOrOptions.actionAdvice] 动作建议覆盖
 * @param {string} [toolCallOrOptions.customStaticPrompt] 自定义底座提示词
 * @returns {object} 符合 VCP 协议回执契约的对象
 */
function assembleInTurnGuidance(toolCallOrOptions = {}) {
  const code = toolCallOrOptions.errorCode || 'MALFORMED_BLOCK_SYNTAX';
  const fp = toolCallOrOptions.blockFingerprint || 'unknown';
  const mapping = DYNAMIC_ERROR_MAP[code] || DYNAMIC_ERROR_MAP.MALFORMED_BLOCK_SYNTAX;

  const headAlert = mapping.head(toolCallOrOptions);
  const tailAction = toolCallOrOptions.actionAdvice || mapping.tail(toolCallOrOptions);
  const { cleanBody } = loadStaticBasePrompt(toolCallOrOptions.customStaticPrompt);

  const guidanceText = [
    `[[VCP协议纠偏指导: code=${code} block=${fp}]]`,
    headAlert,
    '',
    cleanBody,
    '',
    tailAction,
    `[[/VCP协议纠偏指导]]`
  ].join('\n');

  return {
    success: false,
    isFormatGuidance: true,
    isProtocolError: true,
    content: [{ type: 'text', text: guidanceText }],
    raw: guidanceText,    // streamHandler.js 与 nonStreamHandler.js 读取 raw 传给 vcpInfoHandler
    error: guidanceText   // 双重兜底
  };
}

/**
 * 专项防错警示映射字典（短小精悍，根据会话中已发生具体情况无限动态累加）
 */
const SPECIALIZED_REMINDERS_MAP = {
  DUPLICATE_KEY_CONFLICT: '- 【严禁参数重复冲突】工具调用中同一字段严禁重复定义，同一工具块内部仅能声明一次 tool_name 或 jev 及对应参数，严禁多次重复定义冲突的工具名或角色署名。',
  MAID_IS_PLUGIN: '- 【严禁署名错位】maid 字段仅用于填写对话角色名，严禁填写任何插件名（如 LinuxShellExecutor）；插件名必须且只能填写在 tool_name。',
  INVALID_TOOL_NAME: '- 【严禁控制键与工具名错误】tool_name 必须是有效系统插件名且严禁填写角色名；系统控制键（tool_name, maid, valet, archery, ink, river, vref, timely_contact, tool_password）必须严格全小写。',
  ROLE_IN_TOOL_NAME: '- 【严禁工具名错位】tool_name 必须填写具体插件名，严禁填写角色名；角色名必须填写在 maid 字段中。',
  MISSING_MAID: '- 【必须签署角色】必须包含 maid 字段并填写当前说话的角色名，严禁遗漏署名。',
  MISSING_TOOL_NAME: '- 【必须指定工具】必须包含 tool_name 字段并填写具体要调用的插件名，严禁遗漏工具名。',
  MALFORMED_BLOCK_SYNTAX: '- 【严禁键值符号混淆】工具参数必须使用半角冒号与定界符赋值（如 key:「始」val「末」），严禁使用等号赋值（如 key="val"）或冒号引号 JSON 语法。',
  UNCLOSED_FIELD: '- 【严禁定界符遗漏】所有参数值必须由「始」与「末」完整包裹，严禁漏写闭合定界符。',
  EMPTY_OR_MALFORMED_FIELDS: '- 【必须包含有效参数】工具块内部必须包含 tool_name、maid 及工具所需具体参数，严禁输出空块。'
};

/**
 * 组装轮间常驻药丸（纯净静态底座 + 根据实际发生情况无限动态累加的专项警示）
 *
 * @param {object} [options={}]
 * @param {Array<string|object>} [options.historicalErrors] 历史错误集合（错误代码或错误对象）
 * @param {Array<string>} [options.accumulatedAntiPatterns] 会话中已发生的易错特征标记列表 (去重累加)
 * @param {string} [options.customStaticPrompt] 可选自定义底座提示词
 * @param {string} [options.floorNote] 额外指定的单条临时说明（可选）
 * @returns {string} 顶格以 [系统提示:] 开头的标准药丸
 */
function assembleHistoricalPill(options = {}) {
  const { fullBase } = loadStaticBasePrompt(options.customStaticPrompt);

  const errorKeys = [];

  if (Array.isArray(options.historicalErrors)) {
    for (const item of options.historicalErrors) {
      if (typeof item === 'string') {
        if (item === 'DUPLICATE_KEY_CONFLICT' || /DUPLICATE/i.test(item) || item.includes('重复')) {
          errorKeys.push('DUPLICATE_KEY_CONFLICT');
        } else if (item === 'COLON_SYNTAX') {
          errorKeys.push('MALFORMED_BLOCK_SYNTAX');
        } else if (item === 'EXTRA_ROLE_DIVIDER') {
          // 死键忽略
        } else {
          errorKeys.push(item);
        }
      } else if (item && typeof item === 'object') {
        if (item.isDuplicateConflict || item.subType === 'DUPLICATE_KEY_CONFLICT' || item.errorCode === 'DUPLICATE_KEY_CONFLICT' || (typeof item.errorCode === 'string' && /DUPLICATE/i.test(item.errorCode)) || (typeof item.errorDetail === 'string' && (item.errorDetail.includes('重复定义') || item.errorDetail.includes('冲突')))) {
          errorKeys.push('DUPLICATE_KEY_CONFLICT');
        } else if (item.subType === 'BLACKLIST_SCENARIO_A' || item.detectedPluginInMaid) {
          errorKeys.push('MAID_IS_PLUGIN');
        } else if (item.subType === 'ROLE_IN_TOOL_NAME' || item.roleNameInTool) {
          errorKeys.push('ROLE_IN_TOOL_NAME');
        } else if (item.subType === 'BLACKLIST_SCENARIO_B' || item.pluginInMaid) {
          errorKeys.push('MAID_IS_PLUGIN');
        } else if (item.errorCode) {
          errorKeys.push(item.errorCode);
        }
      }
    }
  }

  if (Array.isArray(options.accumulatedAntiPatterns)) {
    for (const pat of options.accumulatedAntiPatterns) {
      if (typeof pat === 'string') errorKeys.push(pat);
    }
  }

  const uniqueKeys = [...new Set(errorKeys)];
  const specializedLines = [];

  for (const key of uniqueKeys) {
    if (SPECIALIZED_REMINDERS_MAP[key]) {
      specializedLines.push(SPECIALIZED_REMINDERS_MAP[key]);
    } else if (key.startsWith('-')) {
      specializedLines.push(key);
    } else {
      specializedLines.push(`- ${key}`);
    }
  }

  if (options.floorNote && !specializedLines.includes(options.floorNote)) {
    specializedLines.push(options.floorNote.startsWith('-') ? options.floorNote : `- ${options.floorNote}`);
  }

  if (specializedLines.length === 0) {
    return fullBase;
  }

  const specializedSection = [
    '',
    '### 四、本会话防错专项警示（根据当前会话已发生的具体情况动态累加，请严格规避）',
    ...specializedLines
  ].join('\n');

  const closeTagRe = /[【\[［]\s*(?:\/|／|\\)\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/gi;
  let match;
  let lastMatch = null;
  while ((match = closeTagRe.exec(fullBase)) !== null) {
    lastMatch = match;
  }
  if (lastMatch) {
    const idx = lastMatch.index;
    const matchedTag = lastMatch[0];
    return fullBase.slice(0, idx).trimEnd() +
      `\n${specializedSection}\n` +
      matchedTag;
  }
  return `${fullBase}\n${specializedSection}`;
}

function _clearPromptCache() {
  _cachedStaticBase = null;
  _cachedCleanBody = null;
}

const assemblePermanentPill = assembleHistoricalPill;

module.exports = {
  sanitizeGuidanceInterpolation,
  assembleInTurnGuidance,
  assembleHistoricalPill,
  assemblePermanentPill,
  loadStaticBasePrompt,
  loadAndCompileStaticBase,
  _clearPromptCache,
  DYNAMIC_ERROR_MAP,
  SPECIALIZED_REMINDERS_MAP,
  PILL_HEADER_TAG,
  PILL_CLOSING_TAG,
  FALLBACK_STATIC_PROMPT
};
