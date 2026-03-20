import path from 'node:path';
import { createDingAuthClient } from './auth.js';
import { createMediaUploader, isPublicHttpUrl } from './mediaUploader.js';

const SUPPORTED_FILE_TYPES = new Set([
  'xlsx',
  'pdf',
  'zip',
  'rar',
  'doc',
  'docx',
]);

function now() {
  return Date.now();
}

function isWebhookUsable(expiredTime) {
  const t = Number(expiredTime || 0);
  if (!t) return true;
  return now() + 5000 < t;
}

async function safeReadBody(resp) {
  const raw = await resp.text();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeFileType(fileName = '') {
  const ext = path.extname(fileName || '').replace('.', '').toLowerCase();
  if (!ext) return null;
  return SUPPORTED_FILE_TYPES.has(ext) ? ext : null;
}

export function createDingSender({
  logger = console,
  appKey = process.env.DING_APP_KEY,
  appSecret = process.env.DING_APP_SECRET,
} = {}) {
  const authClient = createDingAuthClient({ appKey, appSecret, logger });
  const mediaUploader = createMediaUploader({ authClient, logger });

  async function replyBySessionWebhook({ sessionWebhook, text }) {
    if (!sessionWebhook) {
      throw new Error('missing sessionWebhook');
    }

    const payload = {
      msgtype: 'text',
      text: {
        content: text,
      },
    };

    const resp = await fetch(sessionWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `sessionWebhook reply failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] sessionWebhook reply ok');
    return body;
  }

  async function replyMarkdownBySessionWebhook({
    sessionWebhook,
    title = '消息',
    text,
  }) {
    if (!sessionWebhook) {
      throw new Error('missing sessionWebhook');
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title,
        text,
      },
    };

    const resp = await fetch(sessionWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `sessionWebhook markdown reply failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] sessionWebhook markdown reply ok');
    return body;
  }

  async function sendGroupMessage({
    openConversationId,
    robotCode,
    msgKey,
    msgParam,
  }) {
    if (!openConversationId) {
      throw new Error('sendGroupMessage missing openConversationId');
    }
    if (!robotCode) {
      throw new Error('sendGroupMessage missing robotCode');
    }
    if (!msgKey) {
      throw new Error('sendGroupMessage missing msgKey');
    }

    const accessToken = await authClient.getAccessToken();
    const payload = {
      msgKey,
      msgParam: JSON.stringify(msgParam || {}),
      openConversationId,
      robotCode,
    };

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `groupMessages/send failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] group message send ok', { msgKey, openConversationId });
    return body;
  }

  async function sendGroupImage({
    openConversationId,
    robotCode,
    source,
    fileName = '',
  }) {
    let photoURL = source;

    if (!isPublicHttpUrl(String(source || ''))) {
      const uploaded = await mediaUploader.uploadFromSource({
        source,
        fileName,
        forceType: 'image',
      });
      photoURL = uploaded.mediaId;
    }

    return sendGroupMessage({
      openConversationId,
      robotCode,
      msgKey: 'sampleImageMsg',
      msgParam: {
        photoURL,
      },
    });
  }

  async function sendGroupFile({
    openConversationId,
    robotCode,
    source,
    fileName = '',
  }) {
    const uploaded = await mediaUploader.uploadFromSource({
      source,
      fileName,
      forceType: 'file',
    });

    const dingFileType = normalizeFileType(uploaded.fileName);
    if (!dingFileType) {
      throw new Error(
        `unsupported DingTalk file type: ${uploaded.fileName}. ` +
        `当前仅支持 xlsx/pdf/zip/rar/doc/docx`
      );
    }

    return sendGroupMessage({
      openConversationId,
      robotCode,
      msgKey: 'sampleFile',
      msgParam: {
        mediaId: uploaded.mediaId,
        fileName: uploaded.fileName,
        fileType: dingFileType,
      },
    });
  }

  async function sendSingleMessage({
    userId,
    robotCode,
    text,
  }) {
    if (!userId) throw new Error('sendSingleMessage missing userId');
    if (!robotCode) throw new Error('sendSingleMessage missing robotCode');

    const accessToken = await authClient.getAccessToken();

    const payload = {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: text }),
    };

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/privateMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `privateMessages/send failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] single message send ok via OpenAPI', { userId, robotCode });
    return body;
  }

  async function sendSingleImage({
    userId,
    robotCode,
    source,
    fileName = '',
  }) {
    if (!userId) throw new Error('sendSingleImage missing userId');
    if (!robotCode) throw new Error('sendSingleImage missing robotCode');

    let photoURL = source;

    // 非公网 URL 需要先上传到钉钉媒体服务器
    if (!isPublicHttpUrl(String(source || ''))) {
      const uploaded = await mediaUploader.uploadFromSource({
        source,
        fileName,
        forceType: 'image',
      });
      photoURL = uploaded.mediaId;
    }

    const accessToken = await authClient.getAccessToken();

    const payload = {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL }),
    };

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/privateMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `privateMessages/send image failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] single image send ok via OpenAPI', { userId, robotCode });
    return body;
  }

  async function sendSingleFile({
    userId,
    robotCode,
    source,
    fileName = '',
  }) {
    if (!userId) throw new Error('sendSingleFile missing userId');
    if (!robotCode) throw new Error('sendSingleFile missing robotCode');

    // 文件必须先上传到钉钉媒体服务器
    const uploaded = await mediaUploader.uploadFromSource({
      source,
      fileName,
      forceType: 'file',
    });

    const dingFileType = normalizeFileType(uploaded.fileName);
    if (!dingFileType) {
      throw new Error(
        `unsupported DingTalk file type: ${uploaded.fileName}. ` +
        `当前仅支持 xlsx/pdf/zip/rar/doc/docx`
      );
    }

    const accessToken = await authClient.getAccessToken();

    const payload = {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleFile',
      msgParam: JSON.stringify({
        mediaId: uploaded.mediaId,
        fileName: uploaded.fileName,
        fileType: dingFileType,
      }),
    };

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/privateMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `privateMessages/send file failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] single file send ok via OpenAPI', { userId, robotCode, fileName: uploaded.fileName });
    return body;
  }

  async function replyText({
    conversationId,
    userId,
    robotCode,
    sessionWebhook,
    sessionWebhookExpiredTime,
    text,
  }) {
    if (!text) {
      throw new Error('replyText missing text');
    }

    // 优先使用 sessionWebhook（快速、无需 accessToken）
    if (sessionWebhook && isWebhookUsable(sessionWebhookExpiredTime)) {
      return replyBySessionWebhook({ sessionWebhook, text });
    }

    // sessionWebhook 失效 → OpenAPI 主动发送兜底
    logger.warn(
      '[dingSender] sessionWebhook unavailable, falling back to OpenAPI privateMessages/send',
      { conversationId, userId, robotCode }
    );

    if (userId && robotCode) {
      return sendSingleMessage({ userId, robotCode, text });
    }

    throw new Error(
      `No valid sessionWebhook and missing userId/robotCode for conversationId=${conversationId}. ` +
      `无法通过任何方式发送单聊消息。`
    );
  }

  async function replyRich({
    chatType,
    conversationId,
    userId,
    robotCode,
    sessionWebhook,
    sessionWebhookExpiredTime,
    text = '',
    images = [],
    files = [],
  }) {
    const safeText = String(text || '').trim();

    if (safeText) {
      await replyText({
        conversationId,
        userId,
        robotCode,
        sessionWebhook,
        sessionWebhookExpiredTime,
        text: safeText,
      });
    }

    if (chatType === 'group' && conversationId && robotCode) {
      for (const image of images) {
        const source = image?.source || image?.url;
        if (!source) continue;
        await sendGroupImage({
          openConversationId: conversationId,
          robotCode,
          source,
          fileName: image?.fileName || '',
        });
      }

      for (const file of files) {
        const source = file?.source || file?.url;
        if (!source) continue;
        await sendGroupFile({
          openConversationId: conversationId,
          robotCode,
          source,
          fileName: file?.fileName || '',
        });
      }

      return;
    }

    // 单聊：使用 OpenAPI privateMessages/send 发送图片/文件
    if (userId && robotCode) {
      for (const image of images) {
        const source = image?.source || image?.url;
        if (!source) continue;
        await sendSingleImage({
          userId,
          robotCode,
          source,
          fileName: image?.fileName || '',
        });
      }

      for (const file of files) {
        const source = file?.source || file?.url;
        if (!source) continue;
        await sendSingleFile({
          userId,
          robotCode,
          source,
          fileName: file?.fileName || '',
        });
      }
      return;
    }

    // 无 userId/robotCode 时的最终兜底：尝试 markdown 外链
    for (const image of images) {
      const source = image?.source || image?.url;
      if (!source) continue;

      if (isPublicHttpUrl(String(source)) && sessionWebhook && isWebhookUsable(sessionWebhookExpiredTime)) {
        await replyMarkdownBySessionWebhook({
          sessionWebhook,
          title: '图片',
          text: `![](${source})`,
        });
      } else {
        logger.warn('[dingSender] cannot send image in single chat: missing userId/robotCode and no valid webhook');
        break;
      }
    }

    if (files.length > 0) {
      logger.warn('[dingSender] cannot send file in single chat: missing userId/robotCode and no valid webhook');
    }
  }

  /**
   * 发送互动卡片（按钮选项）
   * @param {Object} params
   * @param {string} params.conversationId - 会话 ID
   * @param {string} params.userId - 用户 ID（单聊必需）
   * @param {string} params.robotCode - 机器人代码
   * @param {string} params.sessionWebhook - sessionWebhook
   * @param {number} params.sessionWebhookExpiredTime - 过期时间
   * @param {string} params.chatType - 'single' | 'group'
   * @param {string} params.title - 卡片标题
   * @param {string} params.text - 卡片文本
   * @param {Array<{label: string, value: string}>} params.options - 选项列表
   * @param {string} params.callbackRouteKey - 回调路由键（用于识别回调）
   */
  async function sendInteractiveCard({
    conversationId,
    userId,
    robotCode,
    sessionWebhook,
    sessionWebhookExpiredTime,
    chatType,
    title = '请选择',
    text = '',
    options = [],
    callbackRouteKey = 'vcp_option',
  }) {
    if (!options || options.length === 0) {
      throw new Error('sendInteractiveCard requires at least one option');
    }

    // 构建按钮元素
    const buttons = options.slice(0, 4).map((opt, index) => ({
      tag: 'action',
      text: {
        tag: 'plain_text',
        content: String(opt.label || `选项${index + 1}`),
      },
      type: 'primary',
      value: {
        action: callbackRouteKey,
        value: String(opt.value || opt.label),
        conversationId,
        userId,
        robotCode,
        chatType,
      },
    }));

    // 卡片 JSON 结构
    const cardJson = {
      config: {
        wide: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: String(title),
        },
      },
      elements: [
        ...(text ? [{
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: String(text),
          },
        }] : []),
        {
          tag: 'action',
          actions: buttons,
        },
      ],
    };

    // 优先使用 sessionWebhook 发送
    if (sessionWebhook && isWebhookUsable(sessionWebhookExpiredTime)) {
      const payload = {
        msgtype: 'interactiveCard',
        interactiveCard: {
          cardData: JSON.stringify(cardJson),
        },
      };

      const resp = await fetch(sessionWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const body = await safeReadBody(resp);

      if (!resp.ok) {
        throw new Error(
          `sessionWebhook interactiveCard failed: ${resp.status} ${
            typeof body === 'string' ? body : JSON.stringify(body)
          }`
        );
      }

      logger.info('[dingSender] interactiveCard sent via sessionWebhook');
      return body;
    }

    // OpenAPI 发送（需要 userId + robotCode）
    if (!userId || !robotCode) {
      throw new Error('sendInteractiveCard requires userId and robotCode when sessionWebhook unavailable');
    }

    const accessToken = await authClient.getAccessToken();

    const payload = {
      robotCode,
      userIds: [userId],
      msgKey: 'interactiveCard',
      msgParam: JSON.stringify({
        cardData: JSON.stringify(cardJson),
      }),
    };

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/privateMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await safeReadBody(resp);

    if (!resp.ok) {
      throw new Error(
        `privateMessages/send interactiveCard failed: ${resp.status} ${
          typeof body === 'string' ? body : JSON.stringify(body)
        }`
      );
    }

    logger.info('[dingSender] interactiveCard sent via OpenAPI', { userId, robotCode });
    return body;
  }

  return {
    replyText,
    replyRich,
    replyBySessionWebhook,
    replyMarkdownBySessionWebhook,
    sendGroupMessage,
    sendGroupImage,
    sendGroupFile,
    sendSingleMessage,
    sendSingleImage,
    sendSingleFile,
    sendInteractiveCard,
  };
}