import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dns from 'dns';

// 使用公共 DNS 绕过本地 DNS 污染（本地 DNS 将钉钉 WebSocket 域名解析到内网地址导致 ENOTFOUND）
// 支持通过环境变量 DNS_SERVERS 自定义，格式：逗号分隔的 IP 地址列表
const defaultDnsServers = ['8.8.8.8', '8.8.4.4', '223.5.5.5', '223.6.6.6'];
const dnsServersEnv = process.env.DNS_SERVERS;
const dnsServers = dnsServersEnv
  ? dnsServersEnv.split(',').map(s => s.trim()).filter(Boolean)
  : defaultDnsServers;
dns.setServers(dnsServers);

// 显式加载插件目录下的 .env 文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', '.env') });

import { startStreamReceiver } from './adapters/dingtalk/streamReceiver.js';
import { createDingSender } from './adapters/dingtalk/sender.js';
import { createVcpClient } from './adapters/vcp/client.js';
import { createMessagePipeline } from './core/pipeline.js';

function createLogger(level = 'info') {
  const levels = ['debug', 'info', 'warn', 'error'];
  const current = levels.indexOf(level);

  const enabled = (target) => levels.indexOf(target) >= current;

  return {
    debug(...args) {
      if (enabled('debug')) console.debug('[DEBUG]', ...args);
    },
    info(...args) {
      if (enabled('info')) console.info('[INFO]', ...args);
    },
    warn(...args) {
      if (enabled('warn')) console.warn('[WARN]', ...args);
    },
    error(...args) {
      if (enabled('error')) console.error('[ERROR]', ...args);
    },
  };
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const logger = createLogger(process.env.LOG_LEVEL || 'info');

  assertEnv('DING_APP_KEY');
  assertEnv('DING_APP_SECRET');

  const bridgeUrl = process.env.VCP_CHANNEL_BRIDGE_URL || 'http://127.0.0.1:6010/internal/channel-ingest';

  const agentId = process.env.VCP_AGENT_NAME || 'Nova';
  const agentDisplayName = process.env.VCP_AGENT_DISPLAY_NAME || 'Coffee';

  const vcpClient = createVcpClient({
    bridgeUrl,
    bridgeKey: process.env.VCP_CHANNEL_BRIDGE_KEY || '',
    useBridge: String(process.env.VCP_USE_CHANNEL_BRIDGE || 'true').toLowerCase() !== 'false',

    baseUrl: process.env.VCP_BASE_URL || 'http://127.0.0.1:6005',
    chatPath: process.env.VCP_CHAT_PATH || '/v1/chat/completions',
    apiKey: process.env.VCP_API_KEY || '',
    model: process.env.VCP_MODEL || agentId,
    defaultAgentName: agentId,
    defaultAgentDisplayName: agentDisplayName,
    timeoutMs: Number(process.env.VCP_TIMEOUT_MS || 120000),
    logger,
  });

  const dingSender = createDingSender({
    logger,
    appKey: process.env.DING_APP_KEY,
    appSecret: process.env.DING_APP_SECRET,
  });

  const onMessage = createMessagePipeline({
    vcpClient,
    dingSender,
    logger,
    defaultAgentName: agentId,
  });

  const onCardAction = async (event) => {
    logger.info('[card] callback received');
    logger.debug(event?.data || event);

    try {
      // 解析卡片回调数据
      const data = event?.data || event || {};
      const content = typeof data.content === 'string' ? JSON.parse(data.content) : data.content || data;

      // 提取关键信息
      const actionValue = content?.value || {};
      const action = actionValue.action || '';
      const selectedValue = actionValue.value || '';
      const conversationId = actionValue.conversationId || '';
      const userId = actionValue.userId || '';
      const robotCode = actionValue.robotCode || '';
      const chatType = actionValue.chatType || 'single';

      // 只处理 vcp_option 类型的回调
      if (action !== 'vcp_option' || !selectedValue) {
        logger.info('[card] ignoring non-vcp_option callback', { action, selectedValue });
        return;
      }

      logger.info('[card] user selected option', {
        selectedValue,
        conversationId,
        userId,
        chatType,
      });

      // 构建会话键
      const sessionKey = ['dingtalk', chatType, conversationId, userId || 'anonymous'].join(':');

      // 将用户选择作为消息发送给 VCP
      const vcpResponse = await vcpClient.sendMessage({
        agentName: agentId,
        agentDisplayName: agentDisplayName,
        externalSessionKey: sessionKey,
        message: selectedValue,
        metadata: {
          platform: 'dingtalk',
          conversationId,
          userId,
          robotCode,
          chatType,
          isCardAction: true,
          cardAction: 'option_select',
        },
      });

      // 提取回复并发送
      const richReply = vcpClient.extractRichReply(vcpResponse);

      logger.info('[card] VCP response for card action =>', {
        textLength: String(richReply?.text || '').length,
        hasOptions: Array.isArray(richReply?.options) && richReply.options.length > 0,
      });

      // 发送回复
      const hasOptions = Array.isArray(richReply?.options) && richReply.options.length > 0;

      if (hasOptions && typeof dingSender.sendInteractiveCard === 'function') {
        // 如果有选项，发送新的互动卡片
        await dingSender.sendInteractiveCard({
          conversationId,
          userId,
          robotCode,
          sessionWebhook: '', // 卡片回调没有 sessionWebhook
          sessionWebhookExpiredTime: 0,
          chatType,
          title: '请选择',
          text: richReply.text || '',
          options: richReply.options,
        });
      } else if (richReply.text) {
        // 否则发送文本回复
        await dingSender.replyText({
          conversationId,
          userId,
          robotCode,
          sessionWebhook: '',
          sessionWebhookExpiredTime: 0,
          text: richReply.text,
        });
      }
    } catch (error) {
      logger.error('[card] failed to process card action', error);
    }
  };

  const client = await startStreamReceiver({
    onMessage,
    onCardAction,
    logger,
  });

  logger.info('vcp-dingtalk-adapter started');

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received, shutting down...');
    try {
      if (typeof client?.close === 'function') {
        await client.close();
      }
    } finally {
      process.exit(0);
    }
  });
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});