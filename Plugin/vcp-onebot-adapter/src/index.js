/**
 * VCP OneBot Adapter - QQ 机器人适配器
 * 
 * 支持 OneBot 11 协议的实现：
 * - go-cqhttp
 * - NapCat
 * - LLOneBot
 * - Lagrange.OneBot
 * 
 * 通过 ChannelHub B2 协议与 VCPToolBox 集成
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 加载插件目录下的 .env 文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', '.env') });

import { createOneBotClient } from './adapters/onebot/client.js';
import { createVcpChannelClient } from './adapters/vcp/channelClient.js';
import { createMessagePipeline } from './core/pipeline.js';
import { createLogger } from './utils/logger.js';

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function normalizeChannelHubUrl(input) {
  const rawValue = (input || '').trim();
  if (!rawValue) {
    return 'http://127.0.0.1:6010/internal/channel-hub/events';
  }

  try {
    const url = new URL(rawValue);
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/internal/channel-hub/events';
    } else if (!url.pathname.endsWith('/events')) {
      url.pathname = url.pathname.replace(/\/$/, '') + '/events';
    }
    return url.toString();
  } catch (error) {
    if (rawValue.endsWith('/events')) {
      return rawValue;
    }
    return `${rawValue.replace(/\/$/, '')}/events`;
  }
}

async function main() {
  const logger = createLogger(process.env.LOG_LEVEL || 'info');

  logger.info('[main] Starting VCP OneBot Adapter...');

  // 验证必要配置
  const adapterId = process.env.VCP_ADAPTER_ID || 'onebot-qq-main';
  const agentName = process.env.VCP_AGENT_NAME || 'Nova';
  const agentDisplayName = process.env.VCP_AGENT_DISPLAY_NAME || 'Nova';

  // OneBot 连接配置
  const onebotWsUrl = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
  const onebotAccessToken = process.env.ONEBOT_ACCESS_TOKEN || '';

  // VCP ChannelHub 配置
  const channelHubUrl = normalizeChannelHubUrl(process.env.VCP_CHANNEL_HUB_URL);
  const bridgeKey = process.env.VCP_CHANNEL_BRIDGE_KEY || '';

  logger.info('[main] Configuration:', {
    adapterId,
    agentName,
    onebotWsUrl,
    channelHubUrl,
  });

  // 创建 VCP ChannelHub 客户端 (B2 协议)
  const vcpClient = createVcpChannelClient({
    channelHubUrl,
    bridgeKey,
    adapterId,
    defaultAgentName: agentName,
    defaultAgentDisplayName: agentDisplayName,
    timeoutMs: Number(process.env.VCP_TIMEOUT_MS || 120000),
    logger,
  });

  // 创建 OneBot 客户端
  const onebotClient = createOneBotClient({
    wsUrl: onebotWsUrl,
    accessToken: onebotAccessToken,
    logger,
  });

  // 创建消息处理管道
  const messagePipeline = createMessagePipeline({
    vcpClient,
    onebotClient,
    logger,
    defaultAgentName: agentName,
    defaultAgentDisplayName: agentDisplayName,
  });

  // 注册 OneBot 事件处理器
  onebotClient.on('message', async (event) => {
    try {
      await messagePipeline.handleIncomingMessage(event);
    } catch (error) {
      logger.error('[main] Message pipeline error:', error);
    }
  });

  onebotClient.on('meta_event', (event) => {
    logger.info('[main] OneBot meta event:', event);
  });

  onebotClient.on('error', (error) => {
    logger.error('[main] OneBot client error:', error);
  });

  onebotClient.on('close', (code, reason) => {
    logger.warn('[main] OneBot connection closed:', { code, reason: reason.toString() });
  });

  onebotClient.on('reconnecting', (attempt) => {
    logger.info('[main] OneBot reconnecting, attempt:', attempt);
  });

  // 连接 OneBot
  try {
    await onebotClient.connect();
    logger.info('[main] Connected to OneBot server');
  } catch (error) {
    logger.error('[main] Failed to connect to OneBot:', error);
    process.exit(1);
  }

  logger.info('[main] VCP OneBot Adapter started successfully');

  // 优雅关闭
  const shutdown = async (signal) => {
    logger.warn(`[main] ${signal} received, shutting down...`);
    try {
      await onebotClient.disconnect();
    } catch (e) {
      logger.error('[main] Error during shutdown:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
