/**
 * OneBot 消息处理管道
 * 
 * 处理 OneBot 事件 -> 转换为 B2 Envelope -> 发送到 ChannelHub -> 接收回复 -> 发送回 QQ
 */

// 会话 TTL 配置
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24小时
const SESSION_MAX_SIZE = 10000; // 最大会话数

// QQ 消息长度限制
const QQ_MAX_MESSAGE_LENGTH = 4500;

/**
 * 创建消息处理管道
 * @param {Object} options
 * @param {Object} options.vcpClient - VCP ChannelHub 客户端
 * @param {Object} options.onebotClient - OneBot 客户端
 * @param {Object} options.logger - 日志器
 * @param {string} options.defaultAgentName - 默认 Agent 名称
 * @param {string} options.defaultAgentDisplayName - 默认 Agent 显示名称
 */
export function createMessagePipeline({
  vcpClient,
  onebotClient,
  logger = console,
  defaultAgentName = 'Nova',
  defaultAgentDisplayName = 'Nova',
}) {
  const sessions = new Map();

  /**
   * 清理过期会话
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
      logger.info(`[pipeline] Session cleanup: removed ${cleaned} stale sessions, current size: ${sessions.size}`);
    }
  }

  // 每小时清理一次过期会话
  const cleanupInterval = setInterval(cleanupStaleSessions, 60 * 60 * 1000);
  cleanupInterval.unref();

  /**
   * 构建会话键
   */
  function buildSessionKey(event) {
    const isGroup = event.message_type === 'group';
    if (isGroup) {
      return `qq:group:${event.group_id}:${event.user_id}`;
    }
    return `qq:private:${event.user_id}`;
  }

  /**
   * 获取或创建会话
   */
  function getOrCreateSession(event) {
    const key = buildSessionKey(event);

    if (sessions.has(key)) {
      const existing = sessions.get(key);
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const session = {
      key,
      agentName: defaultAgentName,
      agentDisplayName: defaultAgentDisplayName,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    sessions.set(key, session);
    return session;
  }

  /**
   * 检查是否应该处理该消息
   */
  function shouldProcessMessage(event) {
    // 只处理消息事件
    if (event.post_type !== 'message') {
      return false;
    }

    // 获取机器人自己的 QQ 号
    const selfId = onebotClient.selfId;
    if (!selfId) {
      return true; // 如果不知道自己的 ID，就处理所有消息
    }

    // 忽略自己发送的消息
    if (event.user_id === selfId) {
      logger.debug('[pipeline] Ignoring self message');
      return false;
    }

    // 群消息需要 @ 机器人
    if (event.message_type === 'group') {
      const message = event.message || [];
      const hasAt = message.some((seg) => {
        if (seg.type === 'at') {
          // @全体成员 或 @机器人
          return seg.data?.qq === 'all' || String(seg.data?.qq) === String(selfId);
        }
        return false;
      });

      if (!hasAt) {
        logger.debug('[pipeline] Group message without @, ignoring');
        return false;
      }
    }

    return true;
  }

  /**
   * 处理入站消息
   */
  async function handleIncomingMessage(event) {
    logger.info('[pipeline] Processing message:', {
      messageType: event.message_type,
      userId: event.user_id,
      groupId: event.group_id,
      messageId: event.message_id,
    });

    // 检查是否应该处理
    if (!shouldProcessMessage(event)) {
      return;
    }

    const session = getOrCreateSession(event);
    const isGroup = event.message_type === 'group';

    try {
      // 发送到 ChannelHub
      const reply = await vcpClient.processAndSend(event, {
        agentId: session.agentName,
      });

      logger.info('[pipeline] Received reply from ChannelHub:', {
        ok: reply.ok,
        requestId: reply.requestId,
      });

      if (!reply.ok) {
        logger.error('[pipeline] ChannelHub returned error:', reply.error);
        await sendErrorMessage(event, '处理消息时发生错误');
        return;
      }

      // 提取回复内容
      const richReply = vcpClient.extractRichReply(reply);

      logger.info('[pipeline] Rich reply:', {
        textLength: richReply.text.length,
        imageCount: richReply.images.length,
        fileCount: richReply.files.length,
        optionCount: richReply.options.length,
      });

      // 发送回复
      await sendReply(event, richReply);

    } catch (error) {
      logger.error('[pipeline] Failed to process message:', error);
      await sendErrorMessage(event, '处理消息时发生错误，请稍后重试');
    }
  }

  /**
   * 发送回复到 QQ
   */
  async function sendReply(event, richReply) {
    const isGroup = event.message_type === 'group';
    const targetId = isGroup ? event.group_id : event.user_id;

    try {
      // 构建消息段
      const segments = [];

      // 添加文本
      if (richReply.text) {
        // QQ 消息长度限制
        const text = richReply.text.length > QQ_MAX_MESSAGE_LENGTH
          ? richReply.text.slice(0, QQ_MAX_MESSAGE_LENGTH - 3) + '...'
          : richReply.text;

        segments.push({
          type: 'text',
          data: { text },
        });
      }

      // 添加图片
      for (const image of richReply.images.slice(0, 5)) { // 最多 5 张图片
        if (image.url) {
          segments.push({
            type: 'image',
            data: { file: image.url },
          });
        }
      }

      // 添加文件 (QQ 不太支持直接发文件，转为文本链接)
      for (const file of richReply.files) {
        if (file.url) {
          segments.push({
            type: 'text',
            data: { text: `\n📎 文件: ${file.fileName || file.url}` },
          });
        }
      }

      // 如果有选项，添加为文本
      if (richReply.options.length > 0) {
        const optionsText = '\n\n' + richReply.options
          .map((opt, i) => `${i + 1}. ${opt.label}`)
          .join('\n');
        segments.push({
          type: 'text',
          data: { text: optionsText },
        });
      }

      // 如果没有任何内容，发送默认消息
      if (segments.length === 0) {
        segments.push({
          type: 'text',
          data: { text: '我收到了你的消息，但没有生成回复内容。' },
        });
      }

      // 发送消息
      await onebotClient.sendMessage(event.message_type, targetId, segments);

      logger.info('[pipeline] Reply sent successfully');

    } catch (error) {
      logger.error('[pipeline] Failed to send reply:', error);
    }
  }

  /**
   * 发送错误消息
   */
  async function sendErrorMessage(event, text) {
    const isGroup = event.message_type === 'group';
    const targetId = isGroup ? event.group_id : event.user_id;

    try {
      await onebotClient.sendMessage(event.message_type, targetId, [
        { type: 'text', data: { text } },
      ]);
    } catch (error) {
      logger.error('[pipeline] Failed to send error message:', error);
    }
  }

  return {
    handleIncomingMessage,
    buildSessionKey,
    shouldProcessMessage,
    getOrCreateSession,
    sendReply,
    sendErrorMessage,
  };
}