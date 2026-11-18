// modules/finalContextStore.js
//
// 最终上下文快照管理（含 5 组缓存的滑窗）
// ----------------------------------------------------------------
// - 每次 chatCompletionHandler 完成最终请求体合成后，调用 setLastFinalContext(body, metadata)
// - 服务器在内存中保留最近 MAX_SNAPSHOTS 个会话快照（默认 5 组）
// - 管理面板可通过 listFinalContexts() 拉取所有快照的元信息（id + capturedAt + metadata.model 等）
//   并通过 getFinalContextById(id) 切换查看具体快照内容

let encoding = null;
const TOKENIZER_NAME = 'cl100k_base';
const TOKENIZER_METHOD = '@dqbd/tiktoken:cl100k_base';

try {
  const { get_encoding } = require('@dqbd/tiktoken');
  encoding = get_encoding(TOKENIZER_NAME);
} catch (error) {
  encoding = null;
}

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
  const cjkCount = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const wordCount = (text.match(/[A-Za-z0-9]+/g) || []).length;
  const symbolCount = (text.match(/[^\s\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return Math.max(0, Math.ceil((cjkCount + wordCount + Math.ceil(symbolCount / 3)) * 1.08));
}

function countTokensForText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      tokenCount: 0,
      tokenMethod: encoding ? TOKENIZER_METHOD : 'estimate'
    };
  }

  if (encoding) {
    try {
      return {
        tokenCount: encoding.encode(text).length,
        tokenMethod: TOKENIZER_METHOD
      };
    } catch (error) {
      // Fall back to heuristic below.
    }
  }

  return {
    tokenCount: estimateTokensForText(text),
    tokenMethod: 'estimate'
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
  const totalTokenCount = totalTextTokenCount + totalAttachmentTokenCount;
  const tokenMethods = [...new Set(blocks.map(block => block.tokenMethod).filter(Boolean))];

  return {
    model: body?.model || null,
    stream: body?.stream === true,
    messageCount: messages.length,
    totalTextLength,
    totalTextTokenCount,
    totalAttachmentTokenCount,
    totalTokenCount,
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
  getLastFinalContext,
  listFinalContexts,
  getFinalContextById,
  clearFinalContexts,
  MAX_SNAPSHOTS
};