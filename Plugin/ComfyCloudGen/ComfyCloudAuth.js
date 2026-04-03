/**
 * ComfyCloudAuth.js - Firebase JWT认证模块
 * 使用refresh_token从Google securetoken API获取id_token(JWT)
 * JWT缓存在内存中，提前60秒刷新
 */
const http = require('http');
const https = require('https');

class ComfyCloudAuth {
  constructor(refreshToken, firebaseApiKey, proxy) {
    this.refreshToken = refreshToken;
    this.firebaseApiKey = firebaseApiKey;
    this.proxy = proxy; // e.g. "http://127.0.0.1:7897"
    this.cachedToken = null;
    this.tokenExpiry = 0;
  }

  async getValidToken() {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiry - 60000) {
      return this.cachedToken;
    }
    return this._refreshJWT();
  }

  async _refreshJWT() {
    const url = `https://securetoken.googleapis.com/v1/token?key=${this.firebaseApiKey}`;
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

    const raw = await this._httpsRequest(url, 'POST', headers, body);
    const data = JSON.parse(raw);

    if (data.error) {
      throw new Error(`Firebase auth error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    this.cachedToken = data.id_token;
    this.tokenExpiry = Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000;

    // 如果返回了新的refresh_token，更新内存值
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      process.stderr.write(`[AUTH] refresh_token rotated\n`);
    }

    process.stderr.write(`[AUTH] JWT refreshed, expires in ${data.expires_in}s\n`);
    return this.cachedToken;
  }

  /**
   * HTTPS请求，支持CONNECT隧道代理
   * Node.js原生https不走系统代理，国内必须手动建隧道
   */
  _httpsRequest(urlStr, method, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);

      const doRequest = (socket) => {
        const options = {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: method || 'GET',
          headers: { ...headers, Host: parsed.hostname },
        };
        if (socket) {
          options.socket = socket;
          options.agent = false;
        }

        const req = https.request(options, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (body) req.write(body);
        req.end();
      };

      if (this.proxy) {
        const proxyUrl = new URL(this.proxy);
        const connectReq = http.request({
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          method: 'CONNECT',
          path: `${parsed.hostname}:443`,
        });
        connectReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          }
          doRequest(socket);
        });
        connectReq.on('error', reject);
        connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });
        connectReq.end();
      } else {
        doRequest(null);
      }
    });
  }
}

module.exports = ComfyCloudAuth;