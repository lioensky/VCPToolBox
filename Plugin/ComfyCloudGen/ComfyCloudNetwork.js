/**
 * ComfyCloudNetwork.js - Comfy Cloud网络交互层
 * 负责：提交工作流、轮询任务状态、下载图片
 * 所有HTTPS请求支持CONNECT隧道代理
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMFY_HOST = 'cloud.comfy.org';
const COMFY_API_HOST = 'api.comfy.org';

class ComfyCloudNetwork {
  constructor(auth, proxy, imageDir) {
    this.auth = auth;
    this.proxy = proxy;
    this.imageDir = imageDir;
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
  }

  /**
   * 提交工作流到 POST /api/prompt
   * @param {object} workflow - 完整的API格式工作流JSON
   * @returns {{ prompt_id: string }}
   */
  async submitWorkflow(workflow) {
    const jwt = await this.auth.getValidToken();
    const clientId = crypto.randomUUID();

    const payload = {
      client_id: clientId,
      prompt: workflow,
      extra_data: {
        auth_token_comfy_org: jwt,
        extra_pnginfo: {}
      }
    };

    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
      'Content-Length': Buffer.byteLength(body)
    };

    process.stderr.write(`[SUBMIT] Posting workflow (${Object.keys(workflow).length} nodes)...\n`);
    const raw = await this._request(COMFY_HOST, '/api/prompt', 'POST', headers, body);
    const data = JSON.parse(raw);

    if (data.error) {
      throw new Error(`Submit error: ${JSON.stringify(data.error)}`);
    }
    if (data.node_errors && Object.keys(data.node_errors).length > 0) {
      throw new Error(`Node errors: ${JSON.stringify(data.node_errors)}`);
    }

    process.stderr.write(`[SUBMIT] prompt_id: ${data.prompt_id}\n`);
    return { prompt_id: data.prompt_id, client_id: clientId };
  }

  /**
   * 轮询任务状态直到完成
   * @param {string} promptId
   * @param {number} intervalMs - 轮询间隔，默认3000ms
   * @param {number} maxAttempts - 最大尝试次数，默认60
   * @returns {object} completed job object
   */
  async pollForCompletion(promptId, intervalMs = 3000, maxAttempts = 60) {
    const jwt = await this.auth.getValidToken();
    const headers = { 'Authorization': `Bearer ${jwt}` };

    for (let i = 0; i < maxAttempts; i++) {
      await this._sleep(intervalMs);

      // 先检查是否完成
      const completedRaw = await this._request(COMFY_HOST,
        '/api/jobs?status=completed,failed,cancelled&limit=10&offset=0',
        'GET', headers);
      const completedData = JSON.parse(completedRaw);

      if (completedData.jobs) {
        const done = completedData.jobs.find(j => j.workflow_id === promptId || j.id === promptId);
        if (done) {
          if (done.status === 'failed' || done.status === 'cancelled') {
            throw new Error(`Job ${done.status}: ${JSON.stringify(done)}`);
          }
          process.stderr.write(`[POLL] Completed! (attempt ${i + 1})\n`);
          return done;
        }
      }

      // 检查是否还在进行中
      const pendingRaw = await this._request(COMFY_HOST,
        '/api/jobs?status=in_progress,pending&limit=10&offset=0',
        'GET', headers);
      const pendingData = JSON.parse(pendingRaw);

      if (pendingData.jobs) {
        const active = pendingData.jobs.find(j => j.workflow_id === promptId || j.id === promptId);
        if (active) {
          process.stderr.write(`[POLL] ${active.status} (attempt ${i + 1}/${maxAttempts})\n`);
          continue;
        }
      }

      process.stderr.write(`[POLL] Waiting... (attempt ${i + 1}/${maxAttempts})\n`);
    }

    throw new Error(`Polling timeout after ${maxAttempts} attempts`);
  }

  /**
   * 下载生成的图片
   * @param {object} job - completed job对象
   * @returns {{ localPath: string, filename: string }}
   */
  async downloadImage(job) {
    const jwt = await this.auth.getValidToken();

    // 从job中提取filename
    let filename = null;
    if (job.preview_output && job.preview_output.filename) {
      filename = job.preview_output.filename;
    }
    if (!filename) {
      throw new Error('No output filename found in job');
    }

    // GET /api/view → 302重定向到CDN
    const viewPath = `/api/view?filename=${encodeURIComponent(filename)}&subfolder=&type=output`;
    const headers = { 'Authorization': `Bearer ${jwt}` };

    process.stderr.write(`[DOWNLOAD] Fetching: ${filename}\n`);
    const imageBuffer = await this._requestFollowRedirect(COMFY_HOST, viewPath, headers);

    // 保存到本地
    const ext = path.extname(filename) || '.png';
    const localName = `comfycloud_${Date.now()}${ext}`;
    const localPath = path.join(this.imageDir, localName);
    fs.writeFileSync(localPath, imageBuffer);

    process.stderr.write(`[DOWNLOAD] Saved: ${localPath} (${imageBuffer.length} bytes)\n`);
    return { localPath, filename: localName, size: imageBuffer.length };
  }

  /**
   * 查询订阅状态/积分
   */
  async getSubscriptionStatus() {
    const jwt = await this.auth.getValidToken();
    const headers = { 'Authorization': `Bearer ${jwt}` };
    const raw = await this._request(COMFY_API_HOST,
      '/customers/cloud-subscription-status', 'GET', headers);
    return JSON.parse(raw);
  }

  // ============ 内部方法 ============

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 基础HTTPS请求，支持CONNECT隧道代理
   */
  _request(host, urlPath, method, headers, body) {
    return new Promise((resolve, reject) => {
      const safePath = this._normalizePath(urlPath);

      const doReq = (socket) => {
        const opts = {
          hostname: host,
          port: 443,
          path: safePath,
          method: method || 'GET',
          headers: { ...headers, Host: host },
        };
        if (socket) { opts.socket = socket; opts.agent = false; }

        const req = https.request(opts, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (body) req.write(body);
        req.end();
      };

      if (this.proxy) {
        this._connectProxy(host, doReq, reject);
      } else {
        doReq(null);
      }
    });
  }

  /**
   * 跟随302重定向下载二进制内容
   */
  _requestFollowRedirect(host, urlPath, headers, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
      const safePath = this._normalizePath(urlPath);

      const doReq = (socket) => {
        const opts = {
          hostname: host,
          port: 443,
          path: safePath,
          method: 'GET',
          headers: { ...headers, Host: host },
        };
        if (socket) { opts.socket = socket; opts.agent = false; }

        const req = https.request(opts, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
            // 重定向到CDN（不同host），直接用https.get
            const cdnUrl = res.headers.location;
            process.stderr.write(`[DOWNLOAD] Redirect → ${cdnUrl.substring(0, 80)}...\n`);
            this._downloadUrl(cdnUrl).then(resolve).catch(reject);
            return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
        req.end();
      };

      if (this.proxy) {
        this._connectProxy(host, doReq, reject);
      } else {
        doReq(null);
      }
    });
  }

  /**
   * 直接下载CDN URL（可能不需要代理，CDN通常国内可达）
   */
  _downloadUrl(urlStr) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const safePath = this._normalizePath(parsed.pathname + parsed.search);

      const doReq = (socket) => {
        const opts = {
          hostname: parsed.hostname,
          port: 443,
          path: safePath,
          method: 'GET',
          headers: { Host: parsed.hostname },
        };
        if (socket) { opts.socket = socket; opts.agent = false; }

        const req = https.request(opts, (res) => {
          // 处理CDN二次重定向
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            return this._downloadUrl(res.headers.location).then(resolve).catch(reject);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('CDN download timeout')); });
        req.end();
      };

      if (this.proxy) {
        this._connectProxy(parsed.hostname, doReq, reject);
      } else {
        doReq(null);
      }
    });
  }

  /**
   * 建立CONNECT隧道
   */
  _connectProxy(targetHost, onConnect, onError) {
    const proxyUrl = new URL(this.proxy);
    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      method: 'CONNECT',
      path: `${targetHost}:443`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return onError(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
      onConnect(socket);
    });
    connectReq.on('error', onError);
    connectReq.setTimeout(15000, () => { connectReq.destroy(); onError(new Error('Proxy timeout')); });
    connectReq.end();
  }

  /**
   * URL path安全化：处理未转义字符
   */
  _normalizePath(p) {
    try {
      const u = new URL('https://x' + p);
      return u.pathname + u.search;
    } catch {
      return p;
    }
  }
}

module.exports = ComfyCloudNetwork;