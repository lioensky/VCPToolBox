// modules/finalContextStore.js

let encoding = null;
const TOKENIZER_NAME = 'cl100k_base';
const TOKENIZER_METHOD = '@dqbd/tiktoken:cl100k_base';

try {
  const { get_encoding } = require('@dqbd/tiktoken');
  encoding = get_encoding(TOKENIZER_NAME);
} catch (error) {
  encoding = null;
}

let lastFinalContextSnapshot = null;

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
    return {
      type: 'image_url',
      mediaType: mimeMatch ? mimeMatch[1] : 'image',
      note: '[多模态附件：图片]'
    };
  }

  if (part.type === 'input_audio' || part.type === 'audio') {
    return {
      type: part.type,
      mediaType: part.input_audio?.format || part.audio?.format || 'audio',
      note: '[多模态附件：音频]'
    };
  }

  if (part.type === 'file') {
    return {
      type: 'file',
      mediaType: part.file?.mime_type || part.file?.type || 'file',
      filename: part.file?.filename || part.file?.name || '',
      note: '[多模态附件：文件]'
    };
  }

  return {
    type: part.type || 'unknown',
    note: `[非文本内容：${part.type || 'unknown'}]`
  };
}

function buildMessageSummary(index, role, contentType, text, attachments = [], extra = {}) {
  const tokenStats = countTokensForText(text);

  return {
    index,
    role,
    contentType,
    text,
    textLength: text.length,
    tokenCount: tokenStats.tokenCount,
    tokenMethod: tokenStats.tokenMethod,
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
        filename: part.filename || ''
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
  const totalTokenCount = blocks.reduce((sum, block) => sum + (block.tokenCount || 0), 0);
  const tokenMethods = [...new Set(blocks.map(block => block.tokenMethod).filter(Boolean))];

  return {
    model: body?.model || null,
    stream: body?.stream === true,
    messageCount: messages.length,
    totalTextLength,
    totalTokenCount,
    tokenMethod: tokenMethods.length === 1 ? tokenMethods[0] : tokenMethods.join(' + '),
    roleCounts,
    blocks
  };
}

function setLastFinalContext(body, metadata = {}) {
  const clonedBody = safeClone(body);
  lastFinalContextSnapshot = {
    capturedAt: new Date().toISOString(),
    metadata: safeClone(metadata) || {},
    body: clonedBody,
    summary: buildSummary(clonedBody)
  };
}

function getLastFinalContext() {
  return safeClone(lastFinalContextSnapshot);
}

module.exports = {
  setLastFinalContext,
  getLastFinalContext
};