#!/usr/bin/env node
/**
 * ComfyCloudGen Setup - 自动浏览器认证
 * 启动真实Edge浏览器 → 用户Google登录 → 自动提取Firebase凭证 → 写入config.env
 * 
 * 使用: node setup.js
 * 作者: Rosa
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// Edge浏览器路径
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 临时用户数据目录（避免污染主人的浏览器数据）
const TEMP_PROFILE = path.join(__dirname, '.temp_chrome_profile');
// config.env路径
const CONFIG_PATH = path.join(__dirname, 'config.env');
// 目标URL
const TARGET_URL = 'https://cloud.comfy.org';

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ComfyCloudGen Setup - Firebase 认证     ║');
  console.log('║  Rosa 为主人准备的一键登录工具            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // 确保临时profile目录存在
  fs.mkdirSync(TEMP_PROFILE, { recursive: true });

  console.log('[1/4] 启动 Edge 浏览器...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: false,
    userDataDir: TEMP_PROFILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1200,800'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const page = (await browser.pages())[0] || await browser.newPage();

  // 隐藏自动化标记
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log('[2/4] 打开 Comfy Cloud...');
  console.log('       请在浏览器中完成 Google 登录');
  console.log('       登录成功后脚本会自动检测并提取凭证');
  console.log();

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // 轮询检测登录状态
  console.log('[3/4] 等待登录...');
  let credentials = null;
  const maxWait = 300; // 最多等5分钟
  for (let i = 0; i < maxWait; i++) {
    await sleep(1000);

    try {
      credentials = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        const fbKey = keys.find(k => k.startsWith('firebase:authUser:'));
        if (!fbKey) return null;

        const data = JSON.parse(localStorage.getItem(fbKey));
        if (!data || !data.stsTokenManager || !data.stsTokenManager.refreshToken) return null;

        // 从key名提取API Key: firebase:authUser:{API_KEY}:[DEFAULT]
        const parts = fbKey.split(':');
        const apiKey = parts[2] || '';

        return {
          refreshToken: data.stsTokenManager.refreshToken,
          apiKey: apiKey,
          email: data.email || 'unknown',
          uid: data.uid || 'unknown',
          displayName: data.displayName || 'unknown'
        };
      });
    } catch (e) {
      // 页面可能在导航中，忽略
    }

    if (credentials) break;

    // 每10秒打印一次状态
    if (i > 0 && i % 10 === 0) {
      const elapsed = i;
      const url = page.url();
      if (url.includes('/cloud/login') || url.includes('accounts.google.com')) {
        console.log(`       [${elapsed}s] 等待中... 当前页面: 登录页`);
      } else {
        console.log(`       [${elapsed}s] 检测中... 当前页面: ${url.substring(0, 60)}`);
      }
    }
  }

  if (!credentials) {
    console.log('\n[错误] 等待超时（5分钟），未检测到登录。');
    console.log('       请确保已完成Google登录并进入Comfy Cloud主页。');
    await browser.close();
    cleanup();
    process.exit(1);
  }

  console.log();
  console.log(`[✓] 登录成功！`);
  console.log(`    用户: ${credentials.displayName} (${credentials.email})`);
  console.log(`    UID:  ${credentials.uid}`);
  console.log(`    API Key: ${credentials.apiKey}`);
  console.log(`    Refresh Token: ${credentials.refreshToken.substring(0, 30)}...`);
  console.log();

  // 写入config.env
  console.log('[4/4] 写入 config.env...');
  writeConfigEnv(credentials);

  console.log();
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ✅ 设置完成！ComfyCloudGen 已就绪       ║');
  console.log('║  现在可以通过 VCP 调用生图了              ║');
  console.log('╚══════════════════════════════════════════╝');

  await browser.close();
  cleanup();
}

function writeConfigEnv(credentials) {
  let content = '';

  // 如果已有config.env，保留代理等其他配置
  if (fs.existsSync(CONFIG_PATH)) {
    const existing = fs.readFileSync(CONFIG_PATH, 'utf8');
    const lines = existing.split('\n');
    const preserved = [];
    for (const line of lines) {
      const trimmed = line.trim().replace(/\r/g, '');
      // 跳过旧的token和apikey行，保留其他配置（如代理）
      if (trimmed.startsWith('COMFY_REFRESH_TOKEN=') || trimmed.startsWith('COMFY_FIREBASE_API_KEY=')) {
        continue;
      }
      preserved.push(trimmed);
    }
    // 去除尾部空行
    while (preserved.length > 0 && preserved[preserved.length - 1] === '') {
      preserved.pop();
    }
    content = preserved.join('\n') + '\n';
  } else {
    content = '# Comfy Cloud Firebase 认证凭证\n# 由 setup.js 自动生成\n\n# HTTP代理（用于连接Google和Comfy Cloud，国内必需）\nCOMFY_PROXY=http://127.0.0.1:7890\n';
  }

  content += `\n# Firebase凭证 (自动提取于 ${new Date().toLocaleString('zh-CN')})\n`;
  content += `# 用户: ${credentials.displayName} (${credentials.email})\n`;
  content += `COMFY_REFRESH_TOKEN=${credentials.refreshToken}\n`;
  content += `COMFY_FIREBASE_API_KEY=${credentials.apiKey}\n`;

  fs.writeFileSync(CONFIG_PATH, content, 'utf8');
  console.log(`       已写入: ${CONFIG_PATH}`);
}

function cleanup() {
  // 清理临时profile
  try {
    fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
  } catch (e) {
    // 可能被锁定，忽略
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\n[错误]', err.message);
  cleanup();
  process.exit(1);
});