"use strict";

// TicktickManager OAuth authentication CLI
// Run this on your LOCAL machine (where browser can open) to get a TICKTICK_ACCESS_TOKEN.
// Then copy TICKTICK_ACCESS_TOKEN from config.env to your VCP deployment.
//
// Usage:
//   node auth-cli.js
//   node auth-cli.js --domestic    (force Dida365/国内版)
//   node auth-cli.js --port 3000   (custom callback port)
//
// Requires TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET in config.env.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const childProcess = require("child_process");

const DIR = __dirname;
const CONFIG_ENV_PATH = path.join(DIR, "config.env");

// ── helpers ──────────────────────────────────────────────

function parseConfigEnv() {
  if (!fs.existsSync(CONFIG_ENV_PATH)) return {};
  const env = {};
  const content = fs.readFileSync(CONFIG_ENV_PATH, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = rawLine.indexOf("=");
    if (eq < 0) continue;
    const key = rawLine.slice(0, eq).trim();
    if (!key) continue;
    let value = rawLine.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function saveToConfigEnv(updates) {
  let lines = [];
  if (fs.existsSync(CONFIG_ENV_PATH)) {
    lines = fs.readFileSync(CONFIG_ENV_PATH, "utf8").split(/\r?\n/);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  fs.writeFileSync(
    CONFIG_ENV_PATH,
    `${lines.join("\n").replace(/\n+$/, "")}\n`,
    "utf8"
  );
}

function openUrl(url) {
  const plat = process.platform;
  const cmd =
    plat === "win32" ? "rundll32" : plat === "darwin" ? "open" : "xdg-open";
  const args = plat === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const c = childProcess.spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    c.unref();
  } catch (e) {
    console.log(`无法自动打开浏览器，请手动访问：${url}`);
  }
}

// ── resolve endpoints ────────────────────────────────────

function resolveEndpoints(config, isDomestic) {
  const isDida =
    isDomestic || (config.TICKTICK_BASE_URL || "").includes("dida365.com");
  return {
    authUrl:
      config.TICKTICK_AUTH_URL ||
      (isDida
        ? "https://dida365.com/oauth/authorize"
        : "https://ticktick.com/oauth/authorize"),
    tokenUrl:
      config.TICKTICK_TOKEN_URL ||
      (isDida
        ? "https://dida365.com/oauth/token"
        : "https://ticktick.com/oauth/token"),
    baseUrl:
      config.TICKTICK_BASE_URL ||
      (isDida
        ? "https://api.dida365.com/open/v1"
        : "https://api.ticktick.com/open/v1"),
  };
}

// ── main ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isDomestic = args.includes("--domestic") || args.includes("--dida");
  const portArgIdx = args.indexOf("--port");
  const customPort =
    portArgIdx >= 0 ? parseInt(args[portArgIdx + 1], 10) : null;

  console.log("TicktickManager OAuth 授权工具\n");

  // 1. load config
  const config = parseConfigEnv();
  const clientId = config.TICKTICK_CLIENT_ID;
  const clientSecret = config.TICKTICK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "错误：config.env 中缺少 TICKTICK_CLIENT_ID 或 TICKTICK_CLIENT_SECRET。"
    );
    console.error("请先在 config.env 中填写这两个值，然后重新运行此脚本。");
    process.exit(1);
  }

  // 2. resolve endpoints
  const ep = resolveEndpoints(config, isDomestic);
  console.log(`服务端：${ep.baseUrl}`);
  console.log(`授权端点：${ep.authUrl}`);
  console.log(`Token 端点：${ep.tokenUrl}`);

  // 3. parse redirect URI
  const redirectRaw =
    config.TICKTICK_REDIRECT_URI || "http://localhost:8000/callback";
  let redirectUrl;
  try {
    redirectUrl = new URL(redirectRaw);
  } catch (e) {
    console.error(`错误：TICKTICK_REDIRECT_URI 格式不正确：${redirectRaw}`);
    process.exit(1);
  }
  const port = customPort || parseInt(redirectUrl.port || "80", 10);

  console.log(
    `回调地址：http://localhost:${port}${redirectUrl.pathname || "/"}`
  );
  console.log("");

  // 4. build auth URL
  const state = crypto.randomBytes(30).toString("base64url");
  const scope = config.TICKTICK_OAUTH_SCOPE || "tasks:read tasks:write";

  const authParams = new URL(ep.authUrl);
  authParams.searchParams.set("client_id", clientId);
  authParams.searchParams.set(
    "redirect_uri",
    `http://localhost:${port}${redirectUrl.pathname || "/"}`
  );
  authParams.searchParams.set("response_type", "code");
  authParams.searchParams.set("scope", scope);
  authParams.searchParams.set("state", state);
  const authUrl = authParams.toString();

  // 5. start callback server
  const callbackPath = redirectUrl.pathname || "/";
  let server;
  let settled = false;
  let timeout = null;

  const promise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost:${port}`);
        if (reqUrl.pathname !== callbackPath) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        if (settled) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>已处理</h1></body></html>");
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const code = reqUrl.searchParams.get("code") || "";
        const err = reqUrl.searchParams.get("error") || "";
        const errDesc = reqUrl.searchParams.get("error_description") || "";
        const retState = reqUrl.searchParams.get("state") || "";

        if (retState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h1 style='color:red'>State 校验失败</h1><p>请重新运行授权脚本。</p></body></html>"
          );
          reject(new Error("OAuth state 不匹配，可能存在 CSRF 攻击。"));
          return;
        }

        if (err) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body><h1 style='color:red'>授权失败</h1><p>${
              errDesc || err
            }</p></body></html>`
          );
          reject(new Error(`OAuth 授权被拒绝：${errDesc || err}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h1 style='color:red'>未收到授权码</h1></body></html>"
          );
          reject(new Error("回调中未收到授权码。"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1 style='color:green'>授权成功！</h1><p>Token 已写入 config.env，可以关闭此窗口。</p></body></html>"
        );
        resolve(code);
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(e);
        }
      }
    });

    server.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(e);
      }
    });

    timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("等待回调超时（300 秒）。"));
      }
    }, 300 * 1000);

    server.listen(port, "localhost", () => {
      console.log(`回调服务器已启动：http://localhost:${port}${callbackPath}`);
      console.log("正在打开浏览器...");
      console.log(`如果浏览器未打开，请手动访问：${authUrl}`);
      console.log("");
      openUrl(authUrl);
    });
  });

  // 6. wait for callback
  let authCode;
  try {
    authCode = await promise;
  } catch (e) {
    console.error(`\n授权失败：${e.message}`);
    if (server && server.listening) server.close();
    process.exit(1);
  } finally {
    clearTimeout(timeout);
    if (server && server.listening) server.close();
  }

  // 7. exchange code for token
  console.log("正在交换 access token...");
  const auth = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString(
    "base64"
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: `http://localhost:${port}${callbackPath}`,
    scope,
  });

  const tokenRes = await fetch(ep.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const tokenText = await tokenRes.text();
  let tokens;
  try {
    tokens = JSON.parse(tokenText);
  } catch (e) {
    tokens = { raw: tokenText };
  }

  if (!tokenRes.ok || !tokens.access_token) {
    console.error("Token 交换失败：", tokens);
    process.exit(1);
  }

  // 8. save to config.env
  const updates = {
    TICKTICK_BASE_URL: ep.baseUrl,
    TICKTICK_AUTH_URL: ep.authUrl,
    TICKTICK_TOKEN_URL: ep.tokenUrl,
    TICKTICK_REDIRECT_URI: `http://localhost:${port}${callbackPath}`,
    TICKTICK_ACCESS_TOKEN: tokens.access_token,
    TICKTICK_CLIENT_ID: clientId,
    TICKTICK_CLIENT_SECRET: clientSecret,
  };
  saveToConfigEnv(updates);

  console.log("\n授权成功！TICKTICK_ACCESS_TOKEN 已写入 config.env：");
  console.log(`  TICKTICK_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`  有效期：${Math.round((tokens.expires_in || 0) / 86400)} 天`);
  console.log("");
  console.log("插件运行时只需要将以下字段同步到 VCP 部署机器：");
  console.log("  TICKTICK_BASE_URL");
  console.log("  TICKTICK_ACCESS_TOKEN");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
