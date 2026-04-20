/**
 * 代理 Agent 工厂
 *
 * 根据代理 URL 的协议自动选择对应的 agent 实现：
 * - http://  / https://  → https-proxy-agent
 * - socks5:// / socks4:// → socks-proxy-agent
 */

function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;

  try {
    if (proxyUrl.startsWith('socks')) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(proxyUrl);
    }
    if (proxyUrl.startsWith('http')) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      const pkg = proxyUrl.startsWith('socks') ? 'socks-proxy-agent' : 'https-proxy-agent';
      throw new Error(`Proxy module "${pkg}" is not installed. Please run: npm install ${pkg}`);
    }
    throw err;
  }

  throw new Error(`Unsupported proxy protocol: ${proxyUrl}`);
}

module.exports = { createProxyAgent };
