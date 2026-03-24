/**
 * 企业微信消息发送器
 */

let accessToken = null;
let tokenExpireTime = 0;

/**
 * 创建企业微信发送器
 */
export function createWecomSender(config) {
  const { logger, corpId, corpSecret, agentId } = config;

  /**
   * 获取 access_token
   */
  async function getAccessToken() {
    const now = Date.now();

    // 缓存有效
    if (accessToken && now < tokenExpireTime - 60000) {
      return accessToken;
    }

    // 重新获取
    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;

    try {
      const resp = await fetch(tokenUrl);
      const data = await resp.json();

      if (data.errcode !== 0) {
        throw new Error(`Failed to get access_token: ${data.errmsg}`);
      }

      accessToken = data.access_token;
      tokenExpireTime = now + (data.expires_in * 1000);

      logger.debug('[wecomSender] access_token refreshed');
      return accessToken;
    } catch (error) {
      logger.error('[wecomSender] getAccessToken error:', error);
      throw error;
    }
  }

  /**
   * 发送文本消息
   */
  async function sendText(params) {
    const { toUser, toParty, toTag, agentId: paramAgentId, content, safe } = params;
    const token = await getAccessToken();
    const apiUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const body = {
      touser: toUser,
      toparty: toParty,
      totag: toTag,
      msgtype: 'text',
      agentid: paramAgentId || agentId,
      text: { content },
      safe: safe || '0',
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (data.errcode !== 0) {
      throw new Error(`send text failed: ${data.errmsg}`);
    }

    logger.debug('[wecomSender] text sent to:', toUser);
    return data;
  }

  /**
   * 发送图片消息
   */
  async function sendImage(params) {
    const { toUser, agentId: paramAgentId, mediaId } = params;
    const token = await getAccessToken();
    const apiUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const body = {
      touser: toUser,
      msgtype: 'image',
      agentid: paramAgentId || agentId,
      image: { media_id: mediaId },
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (data.errcode !== 0) {
      throw new Error(`send image failed: ${data.errmsg}`);
    }

    return data;
  }

  /**
   * 发送卡片消息
   */
  async function sendCard(params) {
    const { toUser, agentId: paramAgentId, title, description, url, btnTxt } = params;
    const token = await getAccessToken();
    const apiUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const body = {
      touser: toUser,
      msgtype: 'textcard',
      agentid: paramAgentId || agentId,
      textcard: {
        title,
        description,
        url,
        btntxt: btnTxt || '详情',
      },
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (data.errcode !== 0) {
      throw new Error(`send card failed: ${data.errmsg}`);
    }

    return data;
  }

  /**
   * 回复消息（通过 userid 发消息）
   */
  async function replyText(params) {
    const { userId, text } = params;
    return await sendText({
      toUser: userId,
      content: text,
    });
  }

  return {
    sendText,
    sendImage,
    sendCard,
    replyText,
    getAccessToken,
  };
}