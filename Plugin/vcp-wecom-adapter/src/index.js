import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dns from 'dns';

// 使用公共 DNS 绕过本地 DNS 污染
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

import { createCallbackServer } from './adapters/wecom/callbackServer.js';
import { createWecomSender } from './adapters/wecom/sender.js';
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

  // 检查必要的环境变量
  assertEnv('WECOM_CORP_ID');
  assertEnv('WECOM_CORP_SECRET');
  assertEnv('WECOM_AGENT_ID');

  const agentId = process.env.VCP_AGENT_NAME || 'Nova';
  const agentDisplayName = process.env.VCP_AGENT_DISPLAY_NAME || 'Assistant';

  // 创建 VCP 客户端
  const vcpClient = createVcpClient({
    // B2 协议配置
    channelHubUrl: process.env.VCP_CHANNEL_HUB_URL || 'http://127.0.0.1:6010/internal/channel-hub/events',
    adapterId: process.env.VCP_CHANNEL_ADAPTER_ID || 'wecom-main',
    adapterKey: process.env.VCP_CHANNEL_BRIDGE_KEY || '',
    useChannelHub: String(process.env.VCP_USE_CHANNEL_HUB || 'true').toLowerCase() !== 'false',

    // B1 回退配置
    bridgeUrl: process.env.VCP_CHANNEL_BRIDGE_URL || 'http://127.0.0.1:6010/internal/channel-ingest',
    bridgeKey: process.env.VCP_CHANNEL_BRIDGE_KEY || '',
    useBridge: String(process.env.VCP_USE_CHANNEL_BRIDGE || 'true').toLowerCase() !== 'false',

    // OpenAI 兼容回退
    baseUrl: process.env.VCP_BASE_URL || 'http://127.0.0.1:6005',
    chatPath: process.env.VCP_CHAT_PATH || '/v1/chat/completions',
    apiKey: process.env.VCP_API_KEY || '',
    model: process.env.VCP_MODEL || agentId,
    defaultAgentName: agentId,
    defaultAgentDisplayName: agentDisplayName,
    timeoutMs: Number(process.env.VCP_TIMEOUT_MS || 120000),
    logger,
  });

  // 创建企业微信消息发送器
  const wecomSender = createWecomSender({
    logger,
    corpId: process.env.WECOM_CORP_ID,
    corpSecret: process.env.WECOM_CORP_SECRET,
    agentId: process.env.WECOM_AGENT_ID,
  });

  // 创建消息处理管道
  const onMessage = createMessagePipeline({
    vcpClient,
    wecomSender,
    logger,
    defaultAgentName: agentId,
    platform: 'wecom',
  });

  // 创建回调服务器
  const callbackUrl = process.env.WECOM_CALLBACK_URL;
  const callbackToken = process.env.WECOM_CALLBACK_TOKEN;
  const callbackAesKey = process.env.WECOM_CALLBACK_ENCODING_AES_KEY;

  if (callbackUrl && callbackToken) {
    // 启用回调模式
    const server = createCallbackServer({
      port: 6090,
      onMessage,
      logger,
      corpId: process.env.WECOM_CORP_ID,
      token: callbackToken,
      aesKey: callbackAesKey,
    });

    logger.info('vpc-wecom-adapter started with callback server');
  } else {
    // 仅使用主动调用模式（轮询企业微信消息）
    logger.warn('WECOM_CALLBACK_URL not configured, running in polling mode (not implemented yet)');
    logger.info('vpc-wecom-adapter started in passive mode');
  }

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received, shutting down...');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});