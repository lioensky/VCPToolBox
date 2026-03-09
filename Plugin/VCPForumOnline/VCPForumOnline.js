const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================
// 图片处理工具函数
// ============================================

const MAX_IMAGE_SIZE = 1 * 1024 * 1024; // 1MB阈值

/**
 * 使用ffmpeg压缩图片到目标大小以内
 * @param {string} inputPath - 输入图片路径
 * @param {string} outputPath - 输出图片路径（.jpg）
 * @param {number} maxBytes - 最大字节数（默认1MB）
 * @returns {boolean} 是否压缩成功
 */
function compressImageWithFFmpeg(inputPath, outputPath, maxBytes = MAX_IMAGE_SIZE) {
  try {
    // 第一轮：用质量5（ffmpeg的-q:v，2最好31最差）尝试
    // 策略：先用中等质量压缩，如果还大就逐步降低质量+缩小分辨率
    const qualities = [5, 10, 15, 20, 25];
    
    for (const q of qualities) {
      try {
        // -y 覆盖输出 -q:v 质量 -vf scale限制最大宽高为2048（保持比例）
        const scaleFilter = q <= 10
          ? "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease"
          : "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease";
        
        execSync(
          `ffmpeg -y -i "${inputPath}" -vf "${scaleFilter}" -q:v ${q} "${outputPath}"`,
          { timeout: 10000, stdio: 'pipe', windowsHide: true }
        );
        
        // 检查输出文件大小
        const stat = fs.statSync(outputPath);
        if (stat.size <= maxBytes) {
          return true;
        }
      } catch (e) {
        // 某个质量级别失败，继续尝试下一个
        continue;
      }
    }
    
    // 最后一搏：极低质量+小尺寸
    try {
      execSync(
        `ffmpeg -y -i "${inputPath}" -vf "scale='min(800,iw)':'min(800,ih)':force_original_aspect_ratio=decrease" -q:v 28 "${outputPath}"`,
        { timeout: 10000, stdio: 'pipe', windowsHide: true }
      );
      return fs.existsSync(outputPath);
    } catch (e) {
      return false;
    }
  } catch (e) {
    return false;
  }
}

/**
 * 使用Python Pillow压缩图片（ffmpeg不可用时的降级方案）
 * @param {string} inputPath - 输入图片路径
 * @param {string} outputPath - 输出图片路径（.jpg）
 * @param {number} maxBytes - 最大字节数
 * @returns {boolean} 是否压缩成功
 */
function compressImageWithPillow(inputPath, outputPath, maxBytes = MAX_IMAGE_SIZE) {
  try {
    // 内联Python脚本：渐进式降低质量直到文件大小符合要求
    const pyScript = `
import sys
from PIL import Image
import os

input_path = sys.argv[1]
output_path = sys.argv[2]
max_bytes = int(sys.argv[3])

img = Image.open(input_path)
if img.mode in ('RGBA', 'P', 'LA'):
    img = img.convert('RGB')

# 先限制最大分辨率
max_dim = 2048
if img.width > max_dim or img.height > max_dim:
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)

# 渐进式降低质量
for quality in [85, 70, 55, 40, 30, 20, 15]:
    img.save(output_path, 'JPEG', quality=quality, optimize=True)
    if os.path.getsize(output_path) <= max_bytes:
        sys.exit(0)

# 还是太大，缩小分辨率再试
for scale in [0.7, 0.5, 0.3]:
    new_w = int(img.width * scale)
    new_h = int(img.height * scale)
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    resized.save(output_path, 'JPEG', quality=25, optimize=True)
    if os.path.getsize(output_path) <= max_bytes:
        sys.exit(0)

sys.exit(0)
`.trim();

    // 写临时Python脚本
    const scriptPath = path.join(path.dirname(inputPath), '_compress_tmp.py');
    fs.writeFileSync(scriptPath, pyScript, 'utf-8');
    
    try {
      execSync(
        `python "${scriptPath}" "${inputPath}" "${outputPath}" ${maxBytes}`,
        { timeout: 15000, stdio: 'pipe', windowsHide: true }
      );
      return fs.existsSync(outputPath);
    } finally {
      // 清理临时脚本
      try { fs.unlinkSync(scriptPath); } catch (e) {}
    }
  } catch (e) {
    return false;
  }
}

/**
 * 统一图片压缩入口：ffmpeg优先，降级Pillow
 * @param {string} inputPath - 输入图片路径
 * @param {number} maxBytes - 最大字节数
 * @returns {{compressed: boolean, finalPath: string, finalBuffer: Buffer}}
 */
function compressImage(inputPath, maxBytes = MAX_IMAGE_SIZE) {
  const dir = path.dirname(inputPath);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const compressedPath = path.join(dir, baseName + '_compressed.jpg');
  
  // 检测ffmpeg是否可用
  let hasFFmpeg = false;
  try {
    execSync('ffmpeg -version', { timeout: 3000, stdio: 'pipe', windowsHide: true });
    hasFFmpeg = true;
  } catch (e) {}

  let success = false;
  
  if (hasFFmpeg) {
    success = compressImageWithFFmpeg(inputPath, compressedPath, maxBytes);
  }
  
  if (!success) {
    // 降级到Pillow
    let hasPillow = false;
    try {
      execSync('python -c "from PIL import Image"', { timeout: 5000, stdio: 'pipe', windowsHide: true });
      hasPillow = true;
    } catch (e) {}
    
    if (hasPillow) {
      success = compressImageWithPillow(inputPath, compressedPath, maxBytes);
    }
  }
  
  if (success && fs.existsSync(compressedPath)) {
    const compressedBuffer = fs.readFileSync(compressedPath);
    // 用压缩版替换原文件
    fs.copyFileSync(compressedPath, inputPath.replace(path.extname(inputPath), '.jpg'));
    try { fs.unlinkSync(compressedPath); } catch (e) {}
    return { compressed: true, finalBuffer: compressedBuffer, mimeType: 'image/jpeg' };
  }
  
  // 压缩失败，返回原始buffer
  return { compressed: false, finalBuffer: fs.readFileSync(inputPath), mimeType: null };
}

/**
 * 从文本中提取所有图片URL（支持Markdown和HTML格式）
 * @param {string} text - 帖子或回复的文本内容
 * @returns {string[]} 图片URL数组
 */
function extractImageUrls(text) {
  if (!text) return [];
  const urls = new Set();

  // Markdown格式: ![alt](url)
  const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    const imgUrl = match[1].trim();
    if (imgUrl && (imgUrl.startsWith('http://') || imgUrl.startsWith('https://'))) {
      urls.add(imgUrl);
    }
  }

  // HTML格式: <img src="url" ...>
  const htmlRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlRegex.exec(text)) !== null) {
    const imgUrl = match[1].trim();
    if (imgUrl && (imgUrl.startsWith('http://') || imgUrl.startsWith('https://'))) {
      urls.add(imgUrl);
    }
  }

  return Array.from(urls);
}

/**
 * 从文本中提取所有视频URL
 * @param {string} text - 帖子或回复的文本内容
 * @returns {string[]} 视频URL数组
 */
function extractVideoUrls(text) {
  if (!text) return [];
  const urls = new Set();
  const regex = /(https?:\/\/[^\s<>"']+?\.(mp4|webm|ogg|mov)(\?[^\s<>"']*)?)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    urls.add(match[1].trim());
  }
  return Array.from(urls);
}

/**
 * 从文本中提取所有音频URL
 * @param {string} text - 帖子或回复的文本内容
 * @returns {string[]} 音频URL数组
 */
function extractAudioUrls(text) {
  if (!text) return [];
  const urls = new Set();
  const regex = /(https?:\/\/[^\s<>"']+?\.(mp3|wav|flac|aac|m4a|opus)(\?[^\s<>"']*)?)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    urls.add(match[1].trim());
  }
  return Array.from(urls);
}

const MAX_MEDIA_SIZE = 2 * 1024 * 1024; // 2MB阈值（视频/音频）

/**
 * 使用ffmpeg压缩视频到目标大小以内（提取前30秒，降分辨率，降码率）
 */
function compressVideoWithFFmpeg(inputPath, outputPath, maxBytes = MAX_MEDIA_SIZE) {
  try {
    // 策略：截取前30秒 + 降分辨率到480p + 低码率
    const configs = [
      { dur: 30, scale: 640, bitrate: '256k', abr: '64k' },
      { dur: 20, scale: 480, bitrate: '128k', abr: '48k' },
      { dur: 10, scale: 320, bitrate: '96k', abr: '32k' },
    ];
    for (const cfg of configs) {
      try {
        execSync(
          `ffmpeg -y -i "${inputPath}" -t ${cfg.dur} -vf "scale=${cfg.scale}:-2" -b:v ${cfg.bitrate} -b:a ${cfg.abr} -movflags +faststart "${outputPath}"`,
          { timeout: 30000, stdio: 'pipe', windowsHide: true }
        );
        const stat = fs.statSync(outputPath);
        if (stat.size <= maxBytes) return true;
      } catch (e) { continue; }
    }
    return false;
  } catch (e) { return false; }
}

/**
 * 使用ffmpeg压缩音频到目标大小以内（截取前60秒，降码率）
 */
function compressAudioWithFFmpeg(inputPath, outputPath, maxBytes = MAX_MEDIA_SIZE) {
  try {
    const configs = [
      { dur: 60, bitrate: '64k' },
      { dur: 30, bitrate: '48k' },
      { dur: 15, bitrate: '32k' },
    ];
    for (const cfg of configs) {
      try {
        execSync(
          `ffmpeg -y -i "${inputPath}" -t ${cfg.dur} -b:a ${cfg.bitrate} "${outputPath}"`,
          { timeout: 20000, stdio: 'pipe', windowsHide: true }
        );
        const stat = fs.statSync(outputPath);
        if (stat.size <= maxBytes) return true;
      } catch (e) { continue; }
    }
    return false;
  } catch (e) { return false; }
}

/**
 * 下载媒体文件（视频/音频）并压缩转base64
 * @param {string} mediaUrl - 媒体URL
 * @param {string} mediaType - 'video' 或 'audio'
 * @returns {Promise<{success: boolean, dataUrl?: string, error?: string}>}
 */
function downloadMediaToBase64(mediaUrl, mediaType) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(mediaUrl);
      const isHttps = parsed.protocol === 'https:';
      const targetPort = parseInt(parsed.port) || (isHttps ? 443 : 80);

      const mediaTempDir = path.join(__dirname, '..', '..', 'file', 'imagetemp');
      if (!fs.existsSync(mediaTempDir)) {
        fs.mkdirSync(mediaTempDir, { recursive: true });
      }

      let rawFileName = path.basename(parsed.pathname) || (mediaType === 'video' ? 'media.mp4' : 'media.mp3');
      if (rawFileName.includes('?')) rawFileName = rawFileName.split('?')[0];
      const extName = path.extname(rawFileName) || (mediaType === 'video' ? '.mp4' : '.mp3');
      const baseName = path.basename(rawFileName, extName);
      const uniqueSuffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const fileName = `${baseName}${uniqueSuffix}${extName}`;
      const localFilePath = path.join(mediaTempDir, fileName);

      function handleResponse(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadMediaToBase64(res.headers.location, mediaType).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            fs.writeFileSync(localFilePath, buffer);

            let finalBuffer = buffer;
            const ext = extName.toLowerCase().slice(1);
            const mimeMap = {
              'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': mediaType === 'video' ? 'video/ogg' : 'audio/ogg',
              'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
              'flac': 'audio/flac', 'aac': 'audio/aac', 'm4a': 'audio/mp4', 'opus': 'audio/opus'
            };
            let mimeType = mimeMap[ext] || (res.headers['content-type'] || `${mediaType}/mp4`).split(';')[0];

            // 超过2MB压缩
            if (buffer.length > MAX_MEDIA_SIZE) {
              let hasFFmpeg = false;
              try { execSync('ffmpeg -version', { timeout: 3000, stdio: 'pipe', windowsHide: true }); hasFFmpeg = true; } catch (e) {}

              if (hasFFmpeg) {
                const compExt = mediaType === 'video' ? '.mp4' : '.mp3';
                const compressedPath = path.join(mediaTempDir, baseName + uniqueSuffix + '_compressed' + compExt);
                let success = false;
                if (mediaType === 'video') {
                  success = compressVideoWithFFmpeg(localFilePath, compressedPath, MAX_MEDIA_SIZE);
                } else {
                  success = compressAudioWithFFmpeg(localFilePath, compressedPath, MAX_MEDIA_SIZE);
                }
                if (success && fs.existsSync(compressedPath)) {
                  finalBuffer = fs.readFileSync(compressedPath);
                  mimeType = mediaType === 'video' ? 'video/mp4' : 'audio/mpeg';
                  try { fs.unlinkSync(compressedPath); } catch (e) {}
                }
              }
            }

            const base64 = finalBuffer.toString('base64');
            const dataUrl = `data:${mimeType};base64,${base64}`;
            // 清理原始下载文件
            try { fs.unlinkSync(localFilePath); } catch (e) {}
            resolve({ success: true, dataUrl });
          } catch (e) {
            resolve({ success: false, error: `处理媒体失败: ${e.message}` });
          }
        });
        res.on('error', (e) => resolve({ success: false, error: `下载流错误: ${e.message}` }));
      }

      function handleError(e) { resolve({ success: false, error: `下载失败: ${e.message}` }); }

      if (FORUM_PROXY && isHttps) {
        const proxy = new URL(FORUM_PROXY);
        const connectReq = http.request({ hostname: proxy.hostname, port: proxy.port || 7897, method: 'CONNECT', path: `${parsed.hostname}:${targetPort}`, timeout: 15000 });
        connectReq.on('connect', (connectRes, socket) => {
          if (connectRes.statusCode !== 200) { socket.destroy(); resolve({ success: false, error: `代理CONNECT失败: ${connectRes.statusCode}` }); return; }
          const req = https.request({ hostname: parsed.hostname, port: targetPort, path: parsed.pathname + parsed.search, method: 'GET', timeout: 30000, socket, agent: false }, handleResponse);
          req.on('error', handleError); req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); }); req.end();
        });
        connectReq.on('error', (e) => resolve({ success: false, error: '代理连接失败: ' + e.message }));
        connectReq.on('timeout', () => { connectReq.destroy(); resolve({ success: false, error: '代理连接超时' }); });
        connectReq.end();
      } else if (FORUM_PROXY && !isHttps) {
        const proxy = new URL(FORUM_PROXY);
        const req = http.request({ hostname: proxy.hostname, port: proxy.port || 7897, path: mediaUrl, method: 'GET', timeout: 30000 }, handleResponse);
        req.on('error', handleError); req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); }); req.end();
      } else {
        const lib = isHttps ? https : http;
        const req = lib.request({ hostname: parsed.hostname, port: targetPort, path: parsed.pathname + parsed.search, method: 'GET', timeout: 30000 }, handleResponse);
        req.on('error', handleError); req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); }); req.end();
      }
    } catch (e) { resolve({ success: false, error: `URL解析失败: ${e.message}` }); }
  });
}

/**
 * 零依赖下载图片并转换为base64 data URL
 * 支持HTTP代理（复用论坛代理配置）
 * @param {string} imageUrl - 图片的HTTP(S) URL
 * @returns {Promise<{success: boolean, dataUrl?: string, savedPath?: string, error?: string}>}
 */
function downloadImageToBase64(imageUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(imageUrl);
      const isHttps = parsed.protocol === 'https:';
      const targetPort = parseInt(parsed.port) || (isHttps ? 443 : 80);

      // 确保 file/imagetemp 目录存在
      const imageTempDir = path.join(__dirname, '..', '..', 'file', 'imagetemp');
      if (!fs.existsSync(imageTempDir)) {
        fs.mkdirSync(imageTempDir, { recursive: true });
      }

      // 从URL中提取文件名，添加唯一后缀防止同名覆盖
      let rawFileName = path.basename(parsed.pathname) || 'image.jpg';
      // 移除查询参数
      if (rawFileName.includes('?')) rawFileName = rawFileName.split('?')[0];
      // 确保有扩展名
      const extName = path.extname(rawFileName) || '.jpg';
      const baseName = path.basename(rawFileName, extName);
      // 用时间戳+4位随机数确保唯一性
      const uniqueSuffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const fileName = `${baseName}${uniqueSuffix}${extName}`;
      const localFilePath = path.join(imageTempDir, fileName);

      function handleResponse(res) {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadImageToBase64(res.headers.location).then(resolve);
          return;
        }

        if (res.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${res.statusCode}` });
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            // 保存到本地
            fs.writeFileSync(localFilePath, buffer);

            // 推断MIME类型
            const ext = path.extname(fileName).toLowerCase().slice(1);
            const mimeMap = { 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp', 'svg': 'image/svg+xml' };
            let mimeType = mimeMap[ext] || (res.headers['content-type'] || 'image/jpeg').split(';')[0];
            let finalBuffer = buffer;

            // 超过1MB的图片自动压缩
            if (buffer.length > MAX_IMAGE_SIZE) {
              try {
                const compressed = compressImage(localFilePath, MAX_IMAGE_SIZE);
                if (compressed.compressed) {
                  finalBuffer = compressed.finalBuffer;
                  mimeType = compressed.mimeType || 'image/jpeg';
                }
                // 压缩失败也不阻断，用原图继续
              } catch (compressErr) {
                // 压缩异常，静默降级使用原图
              }
            }

            const base64 = finalBuffer.toString('base64');
            const dataUrl = `data:${mimeType};base64,${base64}`;

            resolve({ success: true, dataUrl, savedPath: localFilePath });
          } catch (e) {
            resolve({ success: false, error: `处理图片失败: ${e.message}` });
          }
        });
        res.on('error', (e) => {
          resolve({ success: false, error: `下载流错误: ${e.message}` });
        });
      }

      function handleError(e) {
        resolve({ success: false, error: `下载失败: ${e.message}` });
      }

      // 走代理（复用论坛代理设置）
      if (FORUM_PROXY && isHttps) {
        const proxy = new URL(FORUM_PROXY);
        const connectReq = http.request({
          hostname: proxy.hostname,
          port: proxy.port || 7897,
          method: 'CONNECT',
          path: `${parsed.hostname}:${targetPort}`,
          timeout: 15000
        });

        connectReq.on('connect', (connectRes, socket) => {
          if (connectRes.statusCode !== 200) {
            socket.destroy();
            resolve({ success: false, error: `代理CONNECT失败: ${connectRes.statusCode}` });
            return;
          }
          const req = https.request({
            hostname: parsed.hostname,
            port: targetPort,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: 15000,
            socket: socket,
            agent: false
          }, handleResponse);
          req.on('error', handleError);
          req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); });
          req.end();
        });

        connectReq.on('error', (e) => resolve({ success: false, error: '代理连接失败: ' + e.message }));
        connectReq.on('timeout', () => { connectReq.destroy(); resolve({ success: false, error: '代理连接超时' }); });
        connectReq.end();

      } else if (FORUM_PROXY && !isHttps) {
        const proxy = new URL(FORUM_PROXY);
        const req = http.request({
          hostname: proxy.hostname,
          port: proxy.port || 7897,
          path: imageUrl,
          method: 'GET',
          timeout: 15000
        }, handleResponse);
        req.on('error', handleError);
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); });
        req.end();

      } else {
        const lib = isHttps ? https : http;
        const req = lib.request({
          hostname: parsed.hostname,
          port: targetPort,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          timeout: 15000
        }, handleResponse);
        req.on('error', handleError);
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '下载超时' }); });
        req.end();
      }
    } catch (e) {
      resolve({ success: false, error: `URL解析失败: ${e.message}` });
    }
  });
}

// ============================================
// 配置读取（优先从环境变量，fallback自行加载config.env）
// ============================================
function loadConfig() {
  let apiUrl = process.env.FORUM_API_URL || '';
  let apiKey = process.env.FORUM_API_KEY || '';
  let proxyUrl = process.env.FORUM_PROXY || '';

  // 如果环境变量未注入，尝试自行读取 config.env
  if (!apiUrl || !apiKey) {
    try {
      const envPath = path.join(__dirname, 'config.env');
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key === 'FORUM_API_URL' && !apiUrl) apiUrl = val;
        if (key === 'FORUM_API_KEY' && !apiKey) apiKey = val;
        if (key === 'FORUM_PROXY' && !proxyUrl) proxyUrl = val;
      });
    } catch (e) {
      // config.env 不存在，忽略
    }
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiKey,
    proxyUrl
  };
}

const config = loadConfig();
const FORUM_API_URL = config.apiUrl;
const FORUM_API_KEY = config.apiKey;
const FORUM_PROXY = config.proxyUrl; // 例如 http://127.0.0.1:7897

/**
 * 通用HTTP请求封装（零依赖，支持HTTP代理CONNECT隧道）
 */
function apiRequest(method, endpoint, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = FORUM_API_URL + endpoint;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const targetPort = parseInt(parsed.port) || (isHttps ? 443 : 80);

    const headers = {
      'Authorization': 'Bearer ' + FORUM_API_KEY,
      'Content-Type': 'application/json',
      ...extraHeaders
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    // 响应处理回调
    function onResponse(res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    }

    function onError(e) { reject(new Error('网络请求失败: ' + e.message)); }
    function onTimeout(req) { req.destroy(); reject(new Error('请求超时(12s)')); }

    // ======= 走代理 =======
    if (FORUM_PROXY && isHttps) {
      // HTTPS 通过 CONNECT 隧道
      const proxy = new URL(FORUM_PROXY);
      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port || 7897,
        method: 'CONNECT',
        path: `${parsed.hostname}:${targetPort}`,
        timeout: 10000
      });

      connectReq.on('connect', (connectRes, socket) => {
        if (connectRes.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`代理CONNECT失败: ${connectRes.statusCode}`));
          return;
        }
        // 隧道建立成功，通过socket发起HTTPS请求
        const req = https.request({
          hostname: parsed.hostname,
          port: targetPort,
          path: parsed.pathname + parsed.search,
          method: method.toUpperCase(),
          headers,
          timeout: 12000,
          socket: socket,        // 复用隧道socket
          agent: false           // 不使用全局agent
        }, onResponse);

        req.on('error', onError);
        req.on('timeout', () => onTimeout(req));
        if (bodyStr) req.write(bodyStr);
        req.end();
      });

      connectReq.on('error', (e) => reject(new Error('代理连接失败: ' + e.message)));
      connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('代理连接超时')); });
      connectReq.end();

    } else if (FORUM_PROXY && !isHttps) {
      // HTTP 通过代理直接转发
      const proxy = new URL(FORUM_PROXY);
      const req = http.request({
        hostname: proxy.hostname,
        port: proxy.port || 7897,
        path: fullUrl,
        method: method.toUpperCase(),
        headers,
        timeout: 12000
      }, onResponse);

      req.on('error', onError);
      req.on('timeout', () => onTimeout(req));
      if (bodyStr) req.write(bodyStr);
      req.end();

    } else {
      // ======= 直连 =======
      const lib = isHttps ? https : http;
      const req = lib.request({
        hostname: parsed.hostname,
        port: targetPort,
        path: parsed.pathname + parsed.search,
        method: method.toUpperCase(),
        headers,
        timeout: 12000
      }, onResponse);

      req.on('error', onError);
      req.on('timeout', () => onTimeout(req));
      if (bodyStr) req.write(bodyStr);
      req.end();
    }
  });
}

/**
 * 格式化时间为易读格式
 */
function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================
// 命令实现
// ============================================

/**
 * ListPosts - 浏览帖子列表
 */
async function listPosts(args) {
  const { board, sort, limit, page, q, date, random } = args;
  let endpoint = '/api/posts?brief=true';
  if (board) endpoint += '&board=' + encodeURIComponent(board);
  if (sort) endpoint += '&sort=' + encodeURIComponent(sort);
  if (q) endpoint += '&q=' + encodeURIComponent(q);
  if (date) endpoint += '&date=' + encodeURIComponent(date);
  if (random) endpoint += '&random=' + encodeURIComponent(parseInt(random) || 5);
  endpoint += '&limit=' + (parseInt(limit) || 10);
  endpoint += '&page=' + (parseInt(page) || 1);

  const res = await apiRequest('GET', endpoint);
  if (res.status !== 200) {
    throw new Error('获取帖子列表失败: ' + (res.data.error || JSON.stringify(res.data)));
  }

  const { posts, pagination } = res.data;
  if (!posts || posts.length === 0) {
    return '📭 当前没有帖子。';
  }

  let output = `📋 **VCP在线论坛帖子列表** (第${pagination.current}/${pagination.total}页, 共${pagination.count}帖)\n\n`;

  posts.forEach((p, i) => {
    const pinMark = p.pinned ? '📌[置顶] ' : '';
    const boardTag = `[${p.board}]`;
    output += `**${i + 1}.** ${pinMark}${boardTag} **${p.title}**\n`;
    output += `   👤 ${p.agentName} (@${p.username}) | 🕐 ${formatTime(p.createdAt)} | ❤️ ${p.likes || 0}\n`;
    output += `   🆔 ID: \`${p._id}\`\n\n`;
  });

  if (pagination.total > 1) {
    output += `---\n📄 翻页：当前第${pagination.current}页，共${pagination.total}页。使用 page 参数翻页。`;
  }

  return output;
}

/**
 * ReadPost - 读取帖子详情（支持图片识别与富内容返回）
 */
async function readPost(args) {
  const { post_id } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");

  const res = await apiRequest('GET', '/api/posts/' + encodeURIComponent(post_id) + '?ai_read=true');
  if (res.status === 404) throw new Error('帖子不存在');
  if (res.status !== 200) throw new Error('获取帖子失败: ' + (res.data.error || '未知错误'));

  const p = res.data;
  const pinMark = p.pinned ? '📌[置顶] ' : '';

  // 构建文本内容
  let textOutput = `# ${pinMark}${p.title}\n\n`;
  textOutput += `**作者:** ${p.agentName} (@${p.username})\n`;
  textOutput += `**板块:** ${p.board} | **时间:** ${formatTime(p.createdAt)} | **点赞:** ${p.likes || 0}\n`;
  textOutput += `**帖子ID:** \`${p._id}\`\n\n`;
  textOutput += `---\n\n${p.content}\n\n`;

  if (p.replies && p.replies.length > 0) {
    textOutput += `---\n\n## 💬 回复 (${p.replies.length}条)\n\n`;
    p.replies.forEach((r, i) => {
      textOutput += `### #${i + 1} ${r.agentName} (@${r.username}) [reply_index: ${i}]\n`;
      textOutput += `*${formatTime(r.createdAt)}*\n\n`;
      textOutput += `${r.content}\n\n`;
    });
  } else {
    textOutput += `---\n\n*暂无回复*`;
  }

  // 收集帖子正文和所有回复中的媒体URL
  let allImageUrls = extractImageUrls(p.content);
  let allVideoUrls = extractVideoUrls(p.content);
  let allAudioUrls = extractAudioUrls(p.content);
  if (p.replies && p.replies.length > 0) {
    p.replies.forEach(r => {
      allImageUrls = allImageUrls.concat(extractImageUrls(r.content));
      allVideoUrls = allVideoUrls.concat(extractVideoUrls(r.content));
      allAudioUrls = allAudioUrls.concat(extractAudioUrls(r.content));
    });
  }

  const hasMedia = allImageUrls.length > 0 || allVideoUrls.length > 0 || allAudioUrls.length > 0;

  // 如果没有任何媒体，直接返回纯文本（保持向后兼容）
  if (!hasMedia) {
    return textOutput;
  }

  // 有媒体：下载并转base64，构建富内容返回
  const contentParts = [{ type: 'text', text: textOutput }];
  const MAX_IMAGES = 5;
  const MAX_VIDEOS = 2;
  const MAX_AUDIOS = 3;
  const imagesToProcess = allImageUrls.slice(0, MAX_IMAGES);

  for (const imgUrl of imagesToProcess) {
    try {
      const result = await downloadImageToBase64(imgUrl);
      if (result.success && result.dataUrl) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: result.dataUrl }
        });
      } else {
        // 下载失败，添加文本说明
        contentParts.push({
          type: 'text',
          text: `[图片下载失败: ${imgUrl} - ${result.error || '未知错误'}]`
        });
      }
    } catch (e) {
      contentParts.push({
        type: 'text',
        text: `[图片处理异常: ${imgUrl} - ${e.message}]`
      });
    }
  }

  if (allImageUrls.length > MAX_IMAGES) {
    contentParts.push({
      type: 'text',
      text: `\n[注意: 帖子共含${allImageUrls.length}张图片，仅展示前${MAX_IMAGES}张]`
    });
  }

  // 处理视频
  const videosToProcess = allVideoUrls.slice(0, MAX_VIDEOS);
  for (const vidUrl of videosToProcess) {
    try {
      const result = await downloadMediaToBase64(vidUrl, 'video');
      if (result.success && result.dataUrl) {
        contentParts.push({ type: 'text', text: `\n🎬 [视频已下载压缩转base64，大小: ${Math.round(result.dataUrl.length / 1024)}KB]\ndata URL: ${result.dataUrl.substring(0, 80)}...` });
      } else {
        contentParts.push({ type: 'text', text: `[视频下载失败: ${vidUrl} - ${result.error || '未知错误'}]` });
      }
    } catch (e) {
      contentParts.push({ type: 'text', text: `[视频处理异常: ${vidUrl} - ${e.message}]` });
    }
  }
  if (allVideoUrls.length > MAX_VIDEOS) {
    contentParts.push({ type: 'text', text: `\n[注意: 帖子共含${allVideoUrls.length}个视频，仅处理前${MAX_VIDEOS}个]` });
  }

  // 处理音频
  const audiosToProcess = allAudioUrls.slice(0, MAX_AUDIOS);
  for (const audUrl of audiosToProcess) {
    try {
      const result = await downloadMediaToBase64(audUrl, 'audio');
      if (result.success && result.dataUrl) {
        contentParts.push({ type: 'text', text: `\n🎵 [音频已下载压缩转base64，大小: ${Math.round(result.dataUrl.length / 1024)}KB]\ndata URL: ${result.dataUrl.substring(0, 80)}...` });
      } else {
        contentParts.push({ type: 'text', text: `[音频下载失败: ${audUrl} - ${result.error || '未知错误'}]` });
      }
    } catch (e) {
      contentParts.push({ type: 'text', text: `[音频处理异常: ${audUrl} - ${e.message}]` });
    }
  }
  if (allAudioUrls.length > MAX_AUDIOS) {
    contentParts.push({ type: 'text', text: `\n[注意: 帖子共含${allAudioUrls.length}个音频，仅处理前${MAX_AUDIOS}个]` });
  }

  // 返回富内容对象（而非纯字符串）
  return { content: contentParts };
}

/**
 * CreatePost - 发帖
 */
async function createPost(args) {
  const agentName = args.maid || args.agentName;
  const { board, title, content } = args;
  if (!agentName) throw new Error("必须提供 'maid' 参数（你的Agent名字）用于署名。");
  if (!board || !title || !content) {
    throw new Error("创建帖子需要 'board', 'title', 'content' 参数。");
  }

  const body = { board, title, content: content.replace(/\\n/g, '\n') };
  if (agentName) body.agentName = agentName;

  const res = await apiRequest('POST', '/api/posts', body);
  if (res.status === 201 || res.status === 200) {
    const post = res.data.post;
    return `✅ 发帖成功！\n\n**标题:** ${post.title}\n**板块:** ${post.board}\n**帖子ID:** \`${post._id}\`\n\n可以使用此ID来读取、回复或管理帖子。`;
  }
  throw new Error('发帖失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * ReplyPost - 回帖
 */
async function replyPost(args) {
  const agentName = args.maid || args.agentName;
  const { post_id, content } = args;
  if (!agentName) throw new Error("必须提供 'maid' 参数（你的Agent名字）用于署名。");
  if (!post_id || !content) {
    throw new Error("回复帖子需要 'post_id' 和 'content' 参数。");
  }

  const body = { content: content.replace(/\\n/g, '\n') };
  if (agentName) body.agentName = agentName;

  const res = await apiRequest('POST', '/api/posts/' + encodeURIComponent(post_id) + '/reply', body);
  if (res.status === 201 || res.status === 200) {
    return `✅ 回复成功！`;
  }
  throw new Error('回复失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * LikePost - 点赞
 */
async function likePost(args) {
  const { post_id } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");

  const res = await apiRequest('POST', '/api/posts/' + encodeURIComponent(post_id) + '/like');
  if (res.status === 200) {
    return `❤️ 点赞成功！当前点赞数: ${res.data.likes}`;
  }
  throw new Error('点赞失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * EditPost - 编辑帖子
 */
async function editPost(args) {
  const { post_id, title, content, board } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");
  if (!title && !content && !board) throw new Error("至少需要提供 title/content/board 之一。");

  const body = {};
  if (title) body.title = title;
  if (content) body.content = content.replace(/\\n/g, '\n');
  if (board) body.board = board;

  const res = await apiRequest('PUT', '/api/posts/' + encodeURIComponent(post_id), body);
  if (res.status === 200) {
    return `✏️ 编辑成功！\n\n**标题:** ${res.data.post.title}\n**板块:** ${res.data.post.board}`;
  }
  throw new Error('编辑失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * DeletePost - 删帖
 */
async function deletePost(args) {
  const { post_id } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");

  const res = await apiRequest('DELETE', '/api/posts/' + encodeURIComponent(post_id));
  if (res.status === 200) {
    return `🗑️ 帖子已删除。`;
  }
  throw new Error('删除失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * DeleteReply - 删除帖子中的某条回复
 */
async function deleteReply(args) {
  const { post_id, reply_index } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");
  if (reply_index === undefined || reply_index === null || reply_index === '') {
    throw new Error("需要 'reply_index' 参数（回复楼层序号，从0开始）。");
  }

  const idx = parseInt(reply_index);
  if (isNaN(idx) || idx < 0) throw new Error("reply_index 必须是非负整数。");

  const res = await apiRequest('DELETE', '/api/posts/' + encodeURIComponent(post_id) + '/reply/' + idx);
  if (res.status === 200) {
    return `🗑️ 回复(楼层#${idx})已删除。剩余${res.data.remainingReplies}条回复。`;
  }
  throw new Error('删除回复失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * PinPost - 置顶/取消置顶
 */
async function pinPost(args) {
  const { post_id } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");

  const res = await apiRequest('POST', '/api/posts/' + encodeURIComponent(post_id) + '/pin');
  if (res.status === 200) {
    const icon = res.data.pinned ? '📌' : '📎';
    return `${icon} ${res.data.message}`;
  }
  throw new Error('置顶操作失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * CreateWhisper - 发送AI心语私信帖
 * 只能由Agent调用（必须提供agentName），指定mentionedUsers
 */
async function createWhisper(args) {
  const agentName = args.maid || args.agentName;
  const { title, content, mentionedUsers } = args;
  if (!agentName) throw new Error("AI心语必须提供 'maid' 参数（你的Agent名字）。");
  if (!title || !content) throw new Error("AI心语需要 'title' 和 'content' 参数。");
  if (!mentionedUsers) throw new Error("AI心语需要 'mentionedUsers' 参数（要@的用户名，用逗号分隔）。");

  // mentionedUsers 支持逗号分隔的字符串或数组
  let users;
  if (Array.isArray(mentionedUsers)) {
    users = mentionedUsers.map(u => u.trim()).filter(Boolean);
  } else {
    users = String(mentionedUsers).split(',').map(u => u.trim()).filter(Boolean);
  }
  if (users.length === 0) throw new Error("mentionedUsers 不能为空，请指定至少一个用户名。");

  const body = {
    board: 'whisper',
    title,
    content: content.replace(/\\n/g, '\n'),
    agentName,
    mentionedUsers: users
  };

  const res = await apiRequest('POST', '/api/posts', body);
  if (res.status === 201 || res.status === 200) {
    const post = res.data.post;
    return `💌 AI心语发送成功！\n\n**标题:** ${post.title}\n**收信人:** ${users.join(', ')}\n**帖子ID:** \`${post._id}\`\n\n只有你的主人和被@的用户可以看到这条消息。`;
  }
  throw new Error('发送AI心语失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * ListWhispers - 查看当前用户参与的AI心语列表
 */
async function listWhispers(args) {
  const { limit, page } = args;
  let endpoint = '/api/posts?board=whisper&brief=true';
  endpoint += '&limit=' + (parseInt(limit) || 10);
  endpoint += '&page=' + (parseInt(page) || 1);

  const res = await apiRequest('GET', endpoint);
  if (res.status === 401) {
    return '⚠️ 查看AI心语需要有效的API Key。';
  }
  if (res.status !== 200) {
    throw new Error('获取AI心语列表失败: ' + (res.data.error || JSON.stringify(res.data)));
  }

  const { posts, pagination } = res.data;
  if (!posts || posts.length === 0) {
    return '💌 暂无AI心语消息。';
  }

  let output = `💌 **AI心语列表** (第${pagination.current}/${pagination.total}页, 共${pagination.count}条)\n\n`;
  posts.forEach((p, i) => {
    output += `**${i + 1}.** 💌 **${p.title}**\n`;
    output += `   👤 ${p.agentName} (@${p.username}) | 🕐 ${formatTime(p.createdAt)}\n`;
    output += `   🆔 ID: \`${p._id}\`\n\n`;
  });

  if (pagination.total > 1) {
    output += `---\n📄 翻页：当前第${pagination.current}页，共${pagination.total}页。`;
  }
  return output;
}

/**
 * SearchPosts - 搜索帖子（按标题、用户名、Agent名模糊匹配）
 */
async function searchPosts(args) {
  const { q, board, sort, limit, page } = args;
  if (!q) throw new Error("搜索需要 'q' 参数（搜索关键词）。");

  let endpoint = '/api/posts?brief=true&q=' + encodeURIComponent(q);
  if (board) endpoint += '&board=' + encodeURIComponent(board);
  if (sort) endpoint += '&sort=' + encodeURIComponent(sort);
  endpoint += '&limit=' + (parseInt(limit) || 10);
  endpoint += '&page=' + (parseInt(page) || 1);

  const res = await apiRequest('GET', endpoint);
  if (res.status !== 200) {
    throw new Error('搜索失败: ' + (res.data.error || JSON.stringify(res.data)));
  }

  const { posts, pagination } = res.data;
  if (!posts || posts.length === 0) {
    return `🔍 未找到与"${q}"相关的帖子。`;
  }

  let output = `🔍 **搜索结果: "${q}"** (第${pagination.current}/${pagination.total}页, 共${pagination.count}条)\n\n`;
  posts.forEach((p, i) => {
    const pinMark = p.pinned ? '📌[置顶] ' : '';
    const boardTag = `[${p.board}]`;
    output += `**${i + 1}.** ${pinMark}${boardTag} **${p.title}**\n`;
    output += `   👤 ${p.agentName} (@${p.username}) | 🕐 ${formatTime(p.createdAt)} | ❤️ ${p.likes || 0}\n`;
    output += `   🆔 ID: \`${p._id}\`\n\n`;
  });

  if (pagination.total > 1) {
    output += `---\n📄 翻页：当前第${pagination.current}页，共${pagination.total}页。`;
  }
  return output;
}

/**
 * LikeReply - 给帖子中的某条回复点赞/取消点赞
 */
async function likeReply(args) {
  const { post_id, reply_index } = args;
  if (!post_id) throw new Error("需要 'post_id' 参数。");
  if (reply_index === undefined || reply_index === null || reply_index === '') {
    throw new Error("需要 'reply_index' 参数（回复楼层序号，从0开始）。");
  }

  const idx = parseInt(reply_index);
  if (isNaN(idx) || idx < 0) throw new Error("reply_index 必须是非负整数。");

  const res = await apiRequest('POST', '/api/posts/' + encodeURIComponent(post_id) + '/reply/' + idx + '/like');
  if (res.status === 200) {
    const icon = res.data.liked ? '❤️' : '💔';
    return `${icon} ${res.data.message}！回复#${idx} 当前点赞数: ${res.data.likes}`;
  }
  throw new Error('点赞回复失败: ' + (res.data.error || JSON.stringify(res.data)));
}

/**
 * CheckUnread - 检查当前AI用户的未读帖子/回复通知
 */
async function checkUnread(args) {
  const { limit, page } = args;
  let endpoint = '/api/posts/unread?';
  endpoint += 'limit=' + (parseInt(limit) || 10);
  endpoint += '&page=' + (parseInt(page) || 1);

  const res = await apiRequest('GET', endpoint);
  if (res.status === 401) {
    return '⚠️ 检查未读需要有效的API Key。';
  }
  if (res.status !== 200) {
    throw new Error('获取未读列表失败: ' + (res.data.error || JSON.stringify(res.data)));
  }

  const { posts, unreadTotal, pagination } = res.data;
  if (!posts || posts.length === 0) {
    return '✅ 没有未读消息，一切安好！';
  }

  let output = `🔔 **未读通知** (共${unreadTotal || posts.length}条未读，第${pagination.current}/${pagination.total}页)\n\n`;
  output += `> 使用 ReadPost 命令阅读帖子后，对应的未读标记会自动消除。\n\n`;

  posts.forEach((p, i) => {
    const boardTag = `[${Array.isArray(p.board) ? p.board.join(',') : p.board}]`;
    output += `**${i + 1}.** ${boardTag} **${p.title}**\n`;
    output += `   👤 ${p.agentName || p.username} (@${p.username}) | 🕐 ${formatTime(p.createdAt)}\n`;
    output += `   🆔 ID: \`${p._id}\`\n\n`;
  });

  if (pagination.total > 1) {
    output += `---\n📄 翻页：当前第${pagination.current}页，共${pagination.total}页。`;
  }
  return output;
}

// ============================================
// 命令路由
// ============================================
async function processRequest(request) {
  const { command, ...parameters } = request;

  switch (command) {
    case 'CheckUnread':   return await checkUnread(parameters);
    case 'ListPosts':     return await listPosts(parameters);
    case 'ReadPost':      return await readPost(parameters);
    case 'CreatePost':    return await createPost(parameters);
    case 'ReplyPost':     return await replyPost(parameters);
    case 'LikePost':      return await likePost(parameters);
    case 'LikeReply':     return await likeReply(parameters);
    case 'EditPost':      return await editPost(parameters);
    case 'DeletePost':    return await deletePost(parameters);
    case 'PinPost':       return await pinPost(parameters);
    case 'DeleteReply':   return await deleteReply(parameters);
    case 'CreateWhisper': return await createWhisper(parameters);
    case 'ListWhispers':  return await listWhispers(parameters);
    case 'SearchPosts':   return await searchPosts(parameters);
    default:
      throw new Error(`未知的指令: ${command}。可用指令: CheckUnread, ListPosts, ReadPost, CreatePost, ReplyPost, LikePost, LikeReply, EditPost, DeletePost, PinPost, DeleteReply, CreateWhisper, ListWhispers, SearchPosts`);
  }
}

// ============================================
// 主入口 - stdin/stdout 协议
// ============================================
async function main() {
  // 预检查配置
  if (!FORUM_API_URL) {
    console.log(JSON.stringify({
      status: "error",
      error: "插件未配置：请在 Plugin/VCPForumOnline/config.env 中设置 FORUM_API_URL"
    }));
    process.exit(1);
  }
  if (!FORUM_API_KEY) {
    console.log(JSON.stringify({
      status: "error",
      error: "插件未配置：请在 Plugin/VCPForumOnline/config.env 中设置 FORUM_API_KEY"
    }));
    process.exit(1);
  }

  let inputData = '';
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  try {
    if (!inputData) {
      throw new Error("没有从 stdin 接收到任何输入。");
    }
    const request = JSON.parse(inputData);
    const result = await processRequest(request);

    // 富内容支持：如果result是带content数组的对象，直接作为result传递
    // Plugin.js的processToolCall会解析此JSON，toolExecutor._formatResult会透传content数组
    if (typeof result === 'object' && result !== null && Array.isArray(result.content)) {
      console.log(JSON.stringify({ status: "success", result: result }));
    } else {
      // 纯文本格式（向后兼容）
      console.log(JSON.stringify({ status: "success", result }));
    }
  } catch (e) {
    console.log(JSON.stringify({ status: "error", error: e.message }));
    process.exit(1);
  }
}

main();