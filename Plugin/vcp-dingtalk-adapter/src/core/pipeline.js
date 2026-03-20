import { normalizeIncomingMessage } from './normalizer.js';

function isDebugRichReplyEnabled() {
  return String(process.env.VCP_DEBUG_RICH_REPLY || '').toLowerCase() === 'true';
}

function summarizeRichReply(richReply) {
  return {
    textLength: String(richReply?.text || '').length,
    imageCount: Array.isArray(richReply?.images) ? richReply.images.length : 0,
    fileCount: Array.isArray(richReply?.files) ? richReply.files.length : 0,
    optionCount: Array.isArray(richReply?.options) ? richReply.options.length : 0,
    imageSamples: Array.isArray(richReply?.images)
      ? richReply.images.slice(0, 3).map((x) => ({
          source: x?.source || '',
          fileName: x?.fileName || '',
        }))
      : [],
    fileSamples: Array.isArray(richReply?.files)
      ? richReply.files.slice(0, 3).map((x) => ({
          source: x?.source || '',
          fileName: x?.fileName || '',
        }))
      : [],
    optionSamples: Array.isArray(richReply?.options)
      ? richReply.options.slice(0, 4).map((x) => ({
          label: x?.label || '',
          value: x?.value || '',
        }))
      : [],
  };
}

/**
 * 支持的消息类型
 */
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'file', 'audio']);

/**
 * 构建发送给 VCP 的消息内容
 * 支持文本、图片、文件等多模态内容
 */
function buildMessageContent(msg) {
  const content = [];

  // 添加文本内容
  if (msg.text) {
    content.push({
      type: 'text',
      text: msg.text,
    });
  }

  // 添加图片内容
  if (msg.messageType === 'image' && msg.media?.url) {
    content.push({
      type: 'image_url',
      image_url: {
        url: msg.media.url,
        fileName: msg.media.fileName || '',
      },
    });
  }

  // 添加文件内容
  if (msg.messageType === 'file' && msg.media?.downloadCode) {
    // 文件需要通过 downloadCode 构建可访问的 URL 或标识
    // 钉钉文件的 downloadCode 需要通过 API 转换为实际 URL
    content.push({
      type: 'file_url',
      file_url: {
        url: `dingtalk://file/${msg.media.downloadCode}`,
        fileName: msg.media.fileName || 'unknown_file',
        fileSize: msg.media.fileSize || 0,
      },
    });
  }

  // 添加音频内容
  if (msg.messageType === 'audio' && msg.media?.downloadCode) {
    content.push({
      type: 'audio_url',
      audio_url: {
        url: `dingtalk://audio/${msg.media.downloadCode}`,
        duration: msg.media.duration || 0,
      },
    });
  }

  // 如果没有任何内容，返回空文本
  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '[用户发送了不支持的消息类型]',
    });
  }

  return content;
}

// 会话 TTL 配置
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24小时
const SESSION_MAX_SIZE = 10000; // 最大会话数

export function createMessagePipeline({
  vcpClient,
  dingSender,
  logger = console,
  defaultAgentName = 'Nova',
  defaultAgentDisplayName = process.env.VCP_AGENT_DISPLAY_NAME || 'Coffee',
}) {
  const sessions = new Map();

  /**
   * 清理过期会话，防止内存泄漏
   */
  function cleanupStaleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of sessions) {
      if (now - (session.lastActiveAt || session.createdAt) > SESSION_TTL_MS) {
        sessions.delete(key);
        cleaned++;
      }
    }
    // 超出上限时删除最旧的
    if (sessions.size > SESSION_MAX_SIZE) {
      const entries = [...sessions.entries()];
      entries.sort((a, b) => (a[1].lastActiveAt || a[1].createdAt) - (b[1].lastActiveAt || b[1].createdAt));
      const toRemove = entries.slice(0, sessions.size - SESSION_MAX_SIZE);
      for (const [key] of toRemove) {
        sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`[pipeline] session cleanup: removed ${cleaned} stale sessions, current size: ${sessions.size}`);
    }
  }

  // 每小时清理一次过期会话
  const cleanupInterval = setInterval(cleanupStaleSessions, 60 * 60 * 1000);
  cleanupInterval.unref(); // 不阻止进程退出

  // 每 5 分钟输出会话统计（用于内存监控）
  const statsInterval = setInterval(() => {
    const stats = {
      totalSessions: sessions.size,
      oldestSessionAge: 0,
      newestSessionAge: 0,
    };

    if (sessions.size > 0) {
      const now = Date.now();
      let oldest = Infinity;
      let newest = 0;
      for (const session of sessions.values()) {
        const age = now - (session.lastActiveAt || session.createdAt);
        if (age < oldest) oldest = age;
        if (age > newest) newest = age;
      }
      stats.oldestSessionAge = Math.round(oldest / 1000 / 60); // 分钟
      stats.newestSessionAge = Math.round(newest / 1000 / 60); // 分钟
    }

    logger.info('[pipeline] session stats', stats);
  }, 5 * 60 * 1000);
  statsInterval.unref(); // 不阻止进程退出

  function buildSessionKey(msg) {
    return [
      'dingtalk',
      msg.chatType,
      msg.conversationId,
      msg.userId || 'anonymous',
    ].join(':');
  }

  function getOrCreateSession(msg) {
    const key = buildSessionKey(msg);

    if (sessions.has(key)) {
      const existing = sessions.get(key);
      existing.lastActiveAt = Date.now(); // 刷新活跃时间
      return existing;
    }

    const session = {
      key,
      agentName: defaultAgentName,
      agentDisplayName: defaultAgentDisplayName,
      externalSessionKey: key,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    sessions.set(key, session);
    return session;
  }

  return async function handleIncomingMessage(rawEvent) {
    const msg = normalizeIncomingMessage(rawEvent);

    if (!msg) {
      logger.warn('[pipeline] invalid message event, ignored');
      return;
    }

    if (msg.isFromSelf) {
      logger.info('[pipeline] self message ignored');
      return;
    }

    if (msg.chatType === 'group' && !msg.isAt) {
      logger.info('[pipeline] group message without @, ignored');
      return;
    }

    // 检查是否为支持的消息类型
    if (!SUPPORTED_MESSAGE_TYPES.has(msg.messageType)) {
      logger.info('[pipeline] unsupported message type ignored', msg.messageType);
      return;
    }

    // 检查是否有有效内容
    const hasText = msg.text && msg.text.trim().length > 0;
    const hasMedia = msg.media && (msg.media.url || msg.media.downloadCode);

    if (!hasText && !hasMedia) {
      logger.info('[pipeline] empty message ignored');
      return;
    }

    const session = getOrCreateSession(msg);

    let richReply = {
      text: '',
      images: [],
      files: [],
    };

    try {
      // 构建多模态消息内容
      const messageContent = buildMessageContent(msg);

      logger.info('[pipeline] sending message to VCP', {
        messageType: msg.messageType,
        contentTypes: messageContent.map((c) => c.type),
        hasMedia: !!hasMedia,
      });

      const vcpResponse = await vcpClient.sendMessage({
        agentName: session.agentName,
        agentDisplayName: session.agentDisplayName,
        externalSessionKey: session.externalSessionKey,
        message: messageContent,
        metadata: {
          platform: 'dingtalk',
          conversationId: msg.conversationId,
          conversationTitle: msg.conversationTitle,
          userId: msg.userId,
          senderNick: msg.senderNick,
          senderCorpId: msg.senderCorpId,
          isAdmin: msg.isAdmin,
          robotCode: msg.robotCode,
          chatType: msg.chatType,
          messageId: msg.messageId,
          sessionWebhook: msg.sessionWebhook,
          sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime,
          // 添加媒体元数据
          media: msg.media,
          originalMessageType: msg.messageType,
        },
      });

      richReply =
        typeof vcpClient.extractRichReply === 'function'
          ? vcpClient.extractRichReply(vcpResponse)
          : {
              text: vcpClient.extractDisplayText(vcpResponse),
              images: [],
              files: [],
            };

      logger.info('[pipeline] richReply summary =>', summarizeRichReply(richReply));

      if (isDebugRichReplyEnabled()) {
        logger.info(`[pipeline] RICH_REPLY >>>\n${JSON.stringify(richReply, null, 2)}`);
      }

      if (
        !richReply.text &&
        (!Array.isArray(richReply.images) || richReply.images.length === 0) &&
        (!Array.isArray(richReply.files) || richReply.files.length === 0)
      ) {
        richReply.text = '我收到了，但这次没有拿到可展示内容。';
      }
    } catch (error) {
      logger.error('[pipeline] VCP request failed', error);
      richReply = {
        text: '抱歉，刚刚处理这条消息时出错了，请稍后再试一次。',
        images: [],
        files: [],
      };
    }

    try {
      const hasReplyMedia =
        (Array.isArray(richReply.images) && richReply.images.length > 0) ||
        (Array.isArray(richReply.files) && richReply.files.length > 0);

      if (hasReplyMedia && typeof dingSender.replyRich === 'function') {
        await dingSender.replyRich({
          chatType: msg.chatType,
          conversationId: msg.conversationId,
          userId: msg.userId,
          robotCode: msg.robotCode,
          sessionWebhook: msg.sessionWebhook,
          sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime,
          text: richReply.text,
          images: richReply.images || [],
          files: richReply.files || [],
        });
      } else {
        await dingSender.replyText({
          conversationId: msg.conversationId,
          userId: msg.userId,
          robotCode: msg.robotCode,
          sessionWebhook: msg.sessionWebhook,
          sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime,
          text: richReply.text,
        });
      }
    } catch (error) {
      logger.error('[pipeline] reply failed', error);
    }
  };
}