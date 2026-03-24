/**
 * 消息处理管道 - 将企业微信消息转发到 VCP
 */

/**
 * 创建消息处理管道
 */
export function createMessagePipeline(config) {
  const { vcpClient, wecomSender, logger, defaultAgentName, platform = 'wecom' } = config;

  /**
   * 处理接收到的消息
   */
  async function handleMessage(message, context = {}) {
    try {
      logger.info(`[pipeline] received ${message.type} message from ${message.from?.userId}`);

      // 构建会话键
      const userId = message.from?.userId || '';
      const conversationId = message.from?.conversationId || '';
      const sessionKey = `${platform}:${conversationId}:${userId}`;

      // 提取消息内容
      let vcpMessage = '';
      let attachments = [];

      if (message.type === 'text') {
        vcpMessage = message.content || '';
      } else if (message.type === 'image') {
        // 图片消息需要特殊处理
        vcpMessage = '[图片消息]';
        attachments.push({
          type: 'image_url',
          image_url: { url: message.imageUrl },
        });
      } else if (message.type === 'file') {
        vcpMessage = '[文件消息]';
        attachments.push({
          type: 'file',
          file: { url: message.fileUrl },
        });
      } else if (message.type === 'event') {
        // 事件消息处理
        logger.info(`[pipeline] event: ${message.event}, key: ${message.eventKey}`);

        // 关注/取消关注事件
        if (message.event === 'subscribe') {
          const welcomeText = '您好！我是您的 AI 助手，有什么可以帮您的吗？';
          await wecomSender.replyText({ userId, text: welcomeText });
          return;
        }

        return; // 其他事件暂不处理
      } else {
        logger.warn(`[pipeline] unsupported message type: ${message.type}`);
        return;
      }

      // 发送到 VCP
      const vcpResponse = await vcpClient.sendMessage({
        agentName: defaultAgentName,
        agentDisplayName: defaultAgentName,
        externalSessionKey: sessionKey,
        message: vcpMessage,
        metadata: {
          platform,
          conversationId,
          userId,
          chatType: message.from?.chatType || 'single',
          messageType: message.type,
          attachments,
        },
      });

      // 提取回复
      const richReply = vcpClient.extractRichReply(vcpResponse);

      logger.info('[pipeline] VCP response =>', {
        textLength: String(richReply?.text || '').length,
        hasOptions: Array.isArray(richReply?.options) && richReply.options.length > 0,
      });

      // 发送回复
      if (richReply.text) {
        await wecomSender.replyText({
          userId,
          text: richReply.text,
        });
      }
    } catch (error) {
      logger.error('[pipeline] error:', error);

      // 发送错误提示
      try {
        await wecomSender.replyText({
          userId: message.from?.userId,
          text: '处理消息时发生错误，请稍后重试。',
        });
      } catch (e) {
        logger.error('[pipeline] failed to send error message:', e);
      }
    }
  }

  return {
    handleMessage,
  };
}