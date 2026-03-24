/**
 * 企业微信回调服务器 - 处理企业微信回调消息
 */

import crypto from 'crypto';
import xml2js from 'xml2js';

const parser = new xml2js.Parser({ explicitArray: false, trim: true });

/**
 * 创建企业微信回调服务器
 */
export function createCallbackServer(config) {
  const { port, onMessage, logger, corpId, token, aesKey } = config;

  if (!token) {
    throw new Error('WECOM_CALLBACK_TOKEN is required');
  }

  let app;
  try {
    app = require('express')();
  } catch (e) {
    throw new Error('express not installed, run: npm install express');
  }

  app.use(require('express').json({ verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  } }));

  // 验证 URL 接口（企业微信验证回调服务器
  app.get('/webhook', (req, res) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    if (!echostr) {
      return res.status(200).send('success');
    }

    // 验证并解密echostr
    try {
      const decrypted = decryptEchostr(echostr, timestamp, nonce, token, aesKey);
      res.send(decrypted);
    } catch (error) {
      logger.error('Failed to decrypt echostr:', error);
      res.status(400).send('signature error');
    }
  });

  // 接收消息回调
  app.post('/webhook', async (req, res) => {
    try {
      const { msg_signature, timestamp, nonce } = req.query;
      const rawBody = req.rawBody;

      // 验证签名
      const signature = crypto.createHmac('sha1', token)
        .update(rawBody + token)
        .digest('hex');

      const expectedSignature = crypto.createHash('sha1')
        .update([rawBody, token, timestamp].sort().join(''))
        .digest('hex');

      if (msg_signature !== expectedSignature) {
        logger.warn('signature mismatch');
        return res.send('success'); // 避免重复回调
      }

      // 解析消息
      const msg = await parser.parseStringPromise(rawBody.xml);
      logger.debug('received wecom message:', JSON.stringify(msg));

      // 转换为统一消息格式
      const message = parseWecomMessage(msg);

      if (message) {
        await onMessage(message, { fromCallback: true });
      }

      res.send('success');
    } catch (error) {
      logger.error('callback error:', error);
      res.send('success'); // 即使出错也返回 success 避免企业微信重复回调
    }
  });

  const server = app.listen(port, () => {
    logger.info(`Wecom callback server listening on port ${port}`);
  });

  return server;
}

/**
 * 解密 echostr
 */
function decryptEchostr(echostr, timestamp, nonce, token, aesKey) {
  if (!aesKey) {
    // 无加密模式
    return echostr;
  }

  // 解密模式（企业微信加密回调
  const encodingAesKey = aesKey + '==';
  const key = Buffer.from(encodingAesKey, 'base64');
  const iv = key;
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  let decrypted = decipher.update(echostr, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  // 验证并提取消息
  const errMsg = decrypted.substring(0, 16);
  const msgLen = parseInt(errMsg.slice(16, 20), 16);
  const msg = errMsg.slice(20, 20 + msgLen).trim();

  return msg;
}

/**
 * 解析企业微信消息为统一格式
 */
export function parseWecomMessage(wecomXml) {
  const msg = wecomXml?.xml;
  if (!msg) return null;

  const msgType = msg?.MsgType?.[0] || msg?.MsgType;

  // 文本消息
  if (msgType === 'text') {
    return {
      type: 'text',
      content: msg?.Content?.[0] || '',
      from: {
        userId: msg?.FromUserName?.[0] || '',
        conversationId: '',
        nick: '',
      },
    };
  }

  // 图片消息
  if (msgType === 'image') {
    return {
      type: 'image',
      imageUrl: msg?.PicUrl?.[0] || '',
      from: {
        userId: msg?.FromUserName?.[0] || '',
        conversationId: '',
        nick: '',
      },
    };
  }

  // 事件消息
  if (msgType === 'event') {
    const event = msg?.Event?.[0] || msg?.Event;
    const eventKey = msg?.EventKey?.[0] || msg?.EventKey;

    return {
      type: 'event',
      event,
      eventKey,
      from: {
        userId: msg?.FromUserName?.[0] || '',
        conversationId: '',
        nick: '',
      },
    };
  }

  return null;
}