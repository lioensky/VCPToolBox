// modules/finalContextStore.js
//
// 最终上下文快照管理（含 5 组缓存的滑窗）
// ----------------------------------------------------------------
// - 每次 chatCompletionHandler 完成最终请求体合成后，调用 setLastFinalContext(body, metadata)
// - 服务器在内存中保留最近 MAX_SNAPSHOTS 个会话快照（默认 5 组）
// - 管理面板可通过 listFinalContexts() 拉取所有快照的元信息（id + capturedAt + metadata.model 等）
//   并通过 getFinalContextById(id) 切换查看具体快照内容

// Token 计数：
// - 权威数字是上游 API 返回的 usage.prompt_tokens，请求结束后由 recordUpstreamUsage 写回快照；
// - 分块数字是本地估算：汉字按 2 个字符、其余按 1 个字符计，再除以 3。只用于看各块占比，
//   不再用 cl100k_base（GPT-4 旧词表对中文多算约 1.5 倍）。
const TOKEN_METHOD = 'estimate:cjk2/3';
const { promptTokensFromUsage } = require('./contextBudget.js');
const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

const MAX_SNAPSHOTS = 5;
const snapshots = []; // 数组首位为最新快照（unshift 写入）
let snapshotIdSeq = 0;

function safeClone(value) {
  if (value === undefined || value === null) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return {
      __vcp_snapshot_error__: 'Failed to clone final context payload.',
      message: error.message
    };
  }
}

function estimateTokensForText(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil((chineseChars * 2 + text.length - chineseChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function countTokensForText(text) {
  return {
    tokenCount: typeof text === 'string' && text.length > 0 ? estimateTokensForText(text) : 0,
    tokenMethod: TOKEN_METHOD
  };
}

function tokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/** OpenAI / Anthropic 风格 usage → { promptTokens, completionTokens?, totalTokens?, cachedTokens? }。 */
function normalizeUpstreamUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Anthropic 风格的 input_tokens 不含缓存读写部分，统一由 promptTokensFromUsage 加回。
  const promptTokens = tokenNumber(promptTokensFromUsage(raw));
  if (!promptTokens) return null;
  const completionTokens = tokenNumber(raw.completion_tokens ?? raw.output_tokens);
  const totalTokens = tokenNumber(raw.total_tokens);
  const cachedTokens = tokenNumber(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens);
  return {
    promptTokens,
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedTokens ? { cachedTokens } : {})
  };
}

function getBase64ByteLength(dataUrlOrBase64) {
  if (typeof dataUrlOrBase64 !== 'string' || dataUrlOrBase64.length === 0) {
    return 0;
  }

  const base64 = dataUrlOrBase64.includes(',')
    ? dataUrlOrBase64.slice(dataUrlOrBase64.indexOf(',') + 1)
    : dataUrlOrBase64;
  const normalized = base64.replace(/\s/g, '');
  const padding = (normalized.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function estimateImageTokens(part, mediaType) {
  const detail = String(part.image_url?.detail || part.detail || 'auto').toLowerCase();
  const url = part.image_url?.url || part.url || '';
  const byteLength = getBase64ByteLength(url);

  if (detail === 'low') {
    return {
      tokenCount: 85,
      method: 'multimodal-estimate:image-low',
      byteLength
    };
  }

  // 无法在这里稳定解码图片尺寸；按高细节/自动模式给保守估算。
  return {
    tokenCount: 765,
    method: detail === 'high' ? 'multimodal-estimate:image-high' : 'multimodal-estimate:image-auto',
    byteLength
  };
}

function estimateAudioTokens(part) {
  const data = part.input_audio?.data || part.audio?.data || part.data || '';
  const byteLength = getBase64ByteLength(data);
  return {
    tokenCount: byteLength > 0 ? Math.max(1, Math.ceil(byteLength / 1024 * 32)) : 0,
    method: 'multimodal-estimate:audio-by-size',
    byteLength
  };
}

function estimateFileTokens(part) {
  const data = part.file?.file_data || part.file?.data || part.data || '';
  const byteLength = getBase64ByteLength(data);
  return {
    tokenCount: byteLength > 0 ? Math.max(1, Math.ceil(byteLength / 1024 * 8)) : 0,
    method: 'multimodal-estimate:file-by-size',
    byteLength
  };
}

function estimateGenericAttachmentTokens(part) {
  const serialized = JSON.stringify(part || {});
  return {
    tokenCount: Math.max(1, Math.ceil(serialized.length / 12)),
    method: 'multimodal-estimate:generic-structure',
    byteLength: 0
  };
}

function summarizeContentPart(part) {
  if (!part || typeof part !== 'object') {
    return { type: typeof part, text: String(part ?? '') };
  }

  if (part.type === 'text') {
    return {
      type: 'text',
      text: typeof part.text === 'string' ? part.text : ''
    };
  }

  if (part.type === 'image_url') {
    const url = part.image_url?.url;
    const mimeMatch = typeof url === 'string' ? url.match(/^data:([^;]+);base64,/) : null;
    const mediaType = mimeMatch ? mimeMatch[1] : 'image';
    const tokenEstimate = estimateImageTokens(part, mediaType);
    return {
      type: 'image_url',
      mediaType,
      tokenCount: tokenEstimate.tokenCount,
      tokenMethod: tokenEstimate.method,
      byteLength: tokenEstimate.byteLength,
      note: '[多模态附件：图片]'
    };
  }

  if (part.type === 'input_audio' || part.type === 'audio') {
    const tokenEstimate = estimateAudioTokens(part);
    return {
      type: part.type,
      mediaType: part.input_audio?.format || part.audio?.format || 'audio',
      tokenCount: tokenEstimate.tokenCount,
      tokenMethod: tokenEstimate.method,
      byteLength: tokenEstimate.byteLength,
      note: '[多模态附件：音频]'
    };
  }

  if (part.type === 'file') {
    const tokenEstimate = estimateFileTokens(part);
    return {
      type: 'file',
      mediaType: part.file?.mime_type || part.file?.type || 'file',
      filename: part.file?.filename || part.file?.name || '',
      tokenCount: tokenEstimate.tokenCount,
      tokenMethod: tokenEstimate.method,
      byteLength: tokenEstimate.byteLength,
      note: '[多模态附件：文件]'
    };
  }

  const tokenEstimate = estimateGenericAttachmentTokens(part);
  return {
    type: part.type || 'unknown',
    tokenCount: tokenEstimate.tokenCount,
    tokenMethod: tokenEstimate.method,
    byteLength: tokenEstimate.byteLength,
    note: `[非文本内容：${part.type || 'unknown'}]`
  };
}

function buildMessageSummary(index, role, contentType, text, attachments = [], extra = {}) {
  const tokenStats = countTokensForText(text);
  const attachmentTokenCount = attachments.reduce((sum, attachment) => sum + (attachment.tokenCount || 0), 0);
  const attachmentTokenMethods = [...new Set(attachments.map(attachment => attachment.tokenMethod).filter(Boolean))];

  return {
    index,
    role,
    contentType,
    text,
    textLength: text.length,
    textTokenCount: tokenStats.tokenCount,
    attachmentTokenCount,
    tokenCount: tokenStats.tokenCount + attachmentTokenCount,
    tokenMethod: attachmentTokenMethods.length > 0
      ? `${tokenStats.tokenMethod} + ${attachmentTokenMethods.join(' + ')}`
      : tokenStats.tokenMethod,
    attachments,
    ...extra
  };
}

function summarizeMessage(message, index) {
  const role = message?.role || 'unknown';
  const content = message?.content;

  if (typeof content === 'string') {
    return buildMessageSummary(index, role, 'text', content);
  }

  if (Array.isArray(content)) {
    const parts = content.map(summarizeContentPart);
    const text = parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');

    const attachments = parts
      .filter(part => part.type !== 'text')
      .map(part => ({
        type: part.type,
        mediaType: part.mediaType || part.type,
        filename: part.filename || '',
        tokenCount: part.tokenCount || 0,
        tokenMethod: part.tokenMethod || 'multimodal-estimate:unknown',
        byteLength: part.byteLength || 0
      }));

    const attachmentCounts = attachments.reduce((acc, attachment) => {
      const key = attachment.mediaType || attachment.type || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return buildMessageSummary(index, role, 'multi_part', text, attachments, {
      attachmentCounts,
      parts
    });
  }

  const text = content === undefined || content === null ? '' : JSON.stringify(content, null, 2);
  return buildMessageSummary(index, role, typeof content, text);
}

function buildSummary(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const blocks = messages.map(summarizeMessage);
  const roleCounts = blocks.reduce((acc, block) => {
    acc[block.role] = (acc[block.role] || 0) + 1;
    return acc;
  }, {});
  const totalTextLength = blocks.reduce((sum, block) => sum + (block.textLength || 0), 0);
  const totalTextTokenCount = blocks.reduce((sum, block) => sum + (block.textTokenCount || 0), 0);
  const totalAttachmentTokenCount = blocks.reduce((sum, block) => sum + (block.attachmentTokenCount || 0), 0);
  const toolsTokenCount = Array.isArray(body?.tools) && body.tools.length > 0
    ? estimateTokensForText(JSON.stringify(body.tools))
    : 0;
  const totalTokenCount = totalTextTokenCount + totalAttachmentTokenCount + toolsTokenCount;
  const tokenMethods = [...new Set(blocks.map(block => block.tokenMethod).filter(Boolean))];

  return {
    model: body?.model || null,
    stream: body?.stream === true,
    messageCount: messages.length,
    totalTextLength,
    totalTextTokenCount,
    totalAttachmentTokenCount,
    toolsTokenCount,
    totalTokenCount,
    upstreamUsage: null,
    tokenMethod: tokenMethods.length === 1 ? tokenMethods[0] : tokenMethods.join(' + '),
    roleCounts,
    blocks
  };
}

function setLastFinalContext(body, metadata = {}) {
  const clonedBody = safeClone(body);
  const snapshot = {
    id: ++snapshotIdSeq,
    capturedAt: new Date().toISOString(),
    metadata: safeClone(metadata) || {},
    body: clonedBody,
    summary: buildSummary(clonedBody)
  };
  snapshots.unshift(snapshot);
  while (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.pop();
  }
}

/**
 * 把上游对这次最终请求报告的 usage 记到对应快照上（按 requestId 匹配，先到先得）。
 * 只应传入首个上游调用的 usage：工具循环后续调用的请求体与快照不同。
 */
function recordUpstreamUsage(requestId, rawUsage) {
  if (!requestId) return false;
  const usage = normalizeUpstreamUsage(rawUsage);
  if (!usage) return false;
  const target = snapshots.find(snapshot => snapshot.metadata?.requestId === requestId || snapshot.metadata?.messageId === requestId);
  if (!target || target.summary.upstreamUsage) return false;
  target.summary.upstreamUsage = usage;
  return true;
}

function getLastFinalContext() {
  return snapshots.length > 0 ? safeClone(snapshots[0]) : null;
}

/**
 * 列出所有缓存中的快照轻量元信息（不含 body / blocks），用于前端构建切换下拉。
 * 返回数组按时间倒序排列（最新在前）。
 */
function listFinalContexts() {
  return snapshots.map(snapshot => ({
    id: snapshot.id,
    capturedAt: snapshot.capturedAt,
    metadata: safeClone(snapshot.metadata) || {},
    summary: {
      model: snapshot.summary?.model ?? null,
      stream: snapshot.summary?.stream ?? false,
      messageCount: snapshot.summary?.messageCount ?? 0,
      totalTokenCount: snapshot.summary?.totalTokenCount ?? 0,
      totalTextTokenCount: snapshot.summary?.totalTextTokenCount ?? 0,
      totalAttachmentTokenCount: snapshot.summary?.totalAttachmentTokenCount ?? 0,
      toolsTokenCount: snapshot.summary?.toolsTokenCount ?? 0,
      upstreamUsage: snapshot.summary?.upstreamUsage ?? null,
      tokenMethod: snapshot.summary?.tokenMethod ?? null,
      roleCounts: snapshot.summary?.roleCounts ?? {}
    }
  }));
}

/**
 * 根据 id 取回完整快照副本。id 不存在时返回 null。
 */
function getFinalContextById(id) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  const target = snapshots.find(snapshot => snapshot.id === numericId);
  return target ? safeClone(target) : null;
}

/**
 * 清空所有缓存（管理面板可通过专用按钮触发，目前未对外暴露）。
 */
function clearFinalContexts() {
  snapshots.length = 0;
}

module.exports = {
  setLastFinalContext,
  recordUpstreamUsage,
  getLastFinalContext,
  listFinalContexts,
  getFinalContextById,
  clearFinalContexts,
  MAX_SNAPSHOTS
};