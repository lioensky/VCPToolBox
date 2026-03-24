import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dns from 'dns';

const defaultDnsServers = ['8.8.8.8', '8.8.4.4', '223.5.5.5', '223.6.6.6'];
const dnsServersEnv = process.env.DNS_SERVERS;
const dnsServers = dnsServersEnv
  ? dnsServersEnv.split(',').map(s => s.trim()).filter(Boolean)
  : defaultDnsServers;
dns.setServers(dnsServers);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', '.env') });

import { createCallbackServer } from './adapters/feishu/callbackServer.js';
import { createFeishuSender } from './adapters/feishu/sender.js';
import { createVcpClient } from './adapters/vcp/client.js';
import { createMessagePipeline } from './core/pipeline.js';

function createLogger(level = 'info') {
  const levels = ['debug', 'info', 'warn', 'error'];
  const current = levels.indexOf(level);
  const enabled = (target) => levels.indexOf(target) >= current;
  return {
    debug(...args) { if (enabled('debug')) console.debug('[DEBUG]', ...args); },
    info(...args) { if (enabled('info')) console.info('[INFO]', ...args); },
    warn(...args) { if (enabled('warn')) console.warn('[WARN]', ...args); },
    error(...args) { if (enabled('error')) console.error('[ERROR]', ...args); },
  };
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function main() {
  const logger = createLogger(process.env.LOG_LEVEL || 'info');

  assertEnv('FEISHU_APP_ID');
  assertEnv('FEISHU_APP_SECRET');

  const agentId = process.env.VCP_AGENT_NAME || 'Nova';
  const agentDisplayName = process.env.VCP_AGENT_DISPLAY_NAME || 'Assistant';

  const vcpClient = createVcpClient({
    channelHubUrl: process.env.VCP_CHANNEL_HUB_URL || 'http://127.0.0.1:6010/internal/channel-hub/events',
    adapterId: process.env.VCP_CHANNEL_ADAPTER_ID || 'feishu-main',
    adapterKey: process.env.VCP_CHANNEL_BRIDGE_KEY || '',
    useChannelHub: String(process.env.VCP_USE_CHANNEL_HUB || 'true').toLowerCase() !== 'false',
    bridgeUrl: process.env.VCP_CHANNEL_BRIDGE_URL || 'http://127.0.0.1:6010/internal/channel-ingest',
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

  const feishuSender = createFeishuSender({
    logger,
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  });

  const onMessage = createMessagePipeline({
    vcpClient,
    feishuSender,
    logger,
    defaultAgentName: agentId,
    platform: 'feishu',
  });

  const callbackUrl = process.env.FEISHU_CALLBACK_URL;

  if (callbackUrl) {
    const server = createCallbackServer({
      port: 6091,
      onMessage,
      logger,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verifyToken: process.env.FEISHU_VERIFY_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    });
    logger.info('vcp-feishu-adapter started with callback server');
  } else {
    logger.warn('FEISHU_CALLBACK_URL not configured');
    logger.info('vcp-feishu-adapter started');
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