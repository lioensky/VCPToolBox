function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function loadDingTalkSdk() {
  const preferred = [
    process.env.DING_STREAM_SDK_PACKAGE,
    '@dingtalk-stream/sdk-nodejs',
    'dingtalk-stream',
  ].filter(Boolean);

  let lastError = null;

  for (const pkg of [...new Set(preferred)]) {
    try {
      const mod = await import(pkg);
      return { mod, pkg };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to load DingTalk Stream SDK. Last error: ${lastError?.message || lastError}`
  );
}

function isRawDebugEnabled() {
  return String(process.env.DING_DEBUG_RAW_EVENT || '').toLowerCase() === 'true';
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDownstream(message) {
  if (!message) return message;
  return {
    ...message,
    data: parseMaybeJson(message.data),
  };
}

function logRawEvent(event, logger = console, stage = 'stream') {
  if (!isRawDebugEnabled()) return;

  try {
    const pretty = JSON.stringify(event, null, 2);
    logger.info(`[${stage}] RAW EVENT >>>\n${pretty}`);
  } catch (error) {
    logger.warn?.(`[${stage}] RAW EVENT stringify failed`, error);
  }
}

function ackSuccess(EventAck) {
  if (EventAck && typeof EventAck.SUCCESS !== 'undefined') {
    return { status: EventAck.SUCCESS };
  }
  return { status: 'SUCCESS' };
}

function runDetached(handler, payload, logger, tag) {
  Promise.resolve()
    .then(() => handler(payload))
    .catch((error) => {
      logger.error(`[stream] ${tag} failed`, error);
    });
}

function ackCallback(client, message, logger) {
  try {
    const messageId = message?.headers?.messageId;
    if (!messageId) return;

    if (typeof client?.socketCallBackResponse === 'function') {
      client.socketCallBackResponse(messageId, { ack: true });
      logger.debug?.('[stream] callback ack sent', { messageId });
    }
  } catch (error) {
    logger.warn?.('[stream] callback ack failed', error);
  }
}

export async function startStreamReceiver({
  onMessage,
  onCardAction = async () => {},
  logger = console,
}) {
  if (typeof onMessage !== 'function') {
    throw new Error('onMessage must be a function');
  }

  const { mod, pkg } = await loadDingTalkSdk();

  const DWClient = mod.DWClient || mod.default?.DWClient;
  const EventAck = mod.EventAck || mod.default?.EventAck;
  const TOPIC_ROBOT = mod.TOPIC_ROBOT || '/v1.0/im/bot/messages/get';
  const TOPIC_CARD = mod.TOPIC_CARD || '/v1.0/card/instances/callback';

  if (!DWClient) {
    throw new Error(`DWClient not found in SDK package: ${pkg}`);
  }

  const client = new DWClient({
    clientId: requiredEnv('DING_APP_KEY'),
    clientSecret: requiredEnv('DING_APP_SECRET'),
    debug: isRawDebugEnabled(),
  });

  if (typeof client.registerAllEventListener === 'function') {
    client.registerAllEventListener((event) => {
      const normalized = normalizeDownstream(event);
      const eventType =
        normalized?.headers?.eventType ||
        normalized?.headers?.topic ||
        'unknown';

      logger.info('[stream:event] event received', {
        eventType,
        type: normalized?.type,
      });
      logRawEvent(normalized, logger, `stream:event:${eventType}`);

      return ackSuccess(EventAck);
    });
  }

  if (typeof client.registerCallbackListener === 'function') {
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      const normalized = normalizeDownstream(message);

      logger.info('[stream:callback] robot message received', {
        topic: TOPIC_ROBOT,
      });
      logRawEvent(normalized, logger, 'stream:callback:robot');

      ackCallback(client, message, logger);
      runDetached(onMessage, normalized, logger, 'onMessage');
    });

    client.registerCallbackListener(TOPIC_CARD, (message) => {
      const normalized = normalizeDownstream(message);

      logger.info('[stream:callback] card callback received', {
        topic: TOPIC_CARD,
      });
      logRawEvent(normalized, logger, 'stream:callback:card');

      ackCallback(client, message, logger);
      runDetached(onCardAction, normalized, logger, 'onCardAction');
    });
  } else {
    logger.warn(
      '[stream] registerCallbackListener not found on SDK client; robot callbacks may not be received'
    );
  }

  if (typeof client.on === 'function') {
    client
      .on('connect', () => logger.info('✓ DingTalk Stream connected'))
      .on('close', () => logger.warn('✗ DingTalk Stream closed'))
      .on('error', (error) => logger.error('✗ DingTalk Stream error', error));
  }

  if (typeof client.connect !== 'function') {
    throw new Error('connect() not found on DingTalk Stream client');
  }

  await Promise.resolve(client.connect());

  return client;
}