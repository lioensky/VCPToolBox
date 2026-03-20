async function parseResponse(resp) {
  const raw = await resp.text();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createDingAuthClient({
  appKey = process.env.DING_APP_KEY,
  appSecret = process.env.DING_APP_SECRET,
  logger = console,
} = {}) {
  let accessToken = '';
  let expireAt = 0;
  let pending = null;

  async function getAccessToken(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && accessToken && now < expireAt) {
      return accessToken;
    }

    if (pending) {
      return pending;
    }

    if (!appKey || !appSecret) {
      throw new Error('Missing DING_APP_KEY or DING_APP_SECRET');
    }

    pending = (async () => {
      const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          appKey,
          appSecret,
        }),
      });

      const data = await parseResponse(resp);

      if (!resp.ok || !data?.accessToken) {
        throw new Error(
          `Get DingTalk access_token failed: ${
            typeof data === 'string' ? data : JSON.stringify(data)
          }`
        );
      }

      const ttlSeconds = Number(data.expireIn || data.expiresIn || 7200);
      accessToken = data.accessToken;
      expireAt = Date.now() + Math.max(300, ttlSeconds - 300) * 1000;

      logger.info('[dingAuth] access_token refreshed');
      return accessToken;
    })().finally(() => {
      pending = null;
    });

    return pending;
  }

  return {
    getAccessToken,
  };
}