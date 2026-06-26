// bootstrap.js
// VCPToolBox 启动引导程序：用于探测端口可用性并自动降级
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ENV_PATH = path.join(__dirname, "config.env");

// 默认候选端口池（如果 config.env 中未指定或解析失败）
const DEFAULT_PORT_POOLS = [
  6005, // 默认：6005/6006
  5555, // 备用1：5555/5556
  4555, // 备用2：4555/4556
  8605, // 备用3：8605/8606
];

// 检查单个端口是否可用
function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
      } else {
        // 其他错误也认为不可用
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, "0.0.0.0");
  });
}

// 检查连续的两个端口是否可用
async function checkPortPair(basePort) {
  const mainPortAvailable = await checkPort(basePort);
  if (!mainPortAvailable) return false;

  const adminPortAvailable = await checkPort(basePort + 1);
  return adminPortAvailable;
}

// 启动主逻辑
async function bootstrap() {
  console.log("==================================================");
  console.log("🚀 VCPToolBox 启动引导程序 (端口自动降级保护)");
  console.log("==================================================");

  // 1. 读取当前配置的 PORT（支持逗号分隔）
  let queue = [];
  if (fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, "utf8");
    const match = envContent.match(/^PORT\s*=\s*(.+)$/m);
    if (match && match[1]) {
      const portStrings = match[1].split(",").map((s) => s.trim());
      for (const pStr of portStrings) {
        const p = parseInt(pStr, 10);
        if (!isNaN(p)) {
          queue.push(p);
        }
      }
    }
  }

  // 如果没有解析到有效端口，使用默认池
  if (queue.length === 0) {
    queue = [...DEFAULT_PORT_POOLS];
  }

  let availablePort = null;

  // 2. 遍历探测
  for (const port of queue) {
    console.log(
      `[Bootstrap] 正在探测端口对: ${port} (主服务) & ${port + 1} (管理面板)...`
    );
    const isAvailable = await checkPortPair(port);
    if (isAvailable) {
      availablePort = port;
      console.log(`[Bootstrap] ✅ 端口对 ${port}/${port + 1} 可用！`);
      break;
    } else {
      console.log(
        `[Bootstrap] ⚠️ 端口对 ${port}/${
          port + 1
        } 被占用或被系统保留，尝试降级...`
      );
    }
  }

  if (!availablePort) {
    console.error(
      "[Bootstrap] ❌ 致命错误：所有候选端口均不可用。请检查系统网络或手动修改 config.env。"
    );
    process.exit(1);
  }

  // 3. 将最终决定的端口通过环境变量传递给 PM2，而不是修改文件
  // 这样 server.js 和 adminServer.js 通过 process.env.PORT 就能拿到正确的单值端口
  process.env.PORT = availablePort.toString();

  // 动态设置 CALLBACK_BASE_URL (基于主服务端口)
  // 如果环境变量中已经配置了 CALLBACK_BASE_URL，我们尝试替换它的端口部分
  // 否则，我们提供一个默认的基于当前可用端口的回调地址
  let callbackBaseUrl = process.env.CALLBACK_BASE_URL;
  let isDowngraded = queue.length > 0 && availablePort !== queue[0];

  if (callbackBaseUrl) {
    // 尝试匹配并替换端口（例如 http://localhost:6005/plugin-callback -> http://localhost:5555/plugin-callback）
    callbackBaseUrl = callbackBaseUrl.replace(
      /(:\d+)(\/.*)?$/,
      `:${availablePort}$2`
    );
  } else {
    callbackBaseUrl = `http://127.0.0.1:${availablePort}/plugin-callback`;
  }
  process.env.CALLBACK_BASE_URL = callbackBaseUrl;

  console.log(`[Bootstrap] ⚡ 将使用端口 ${availablePort} 启动服务。`);
  if (isDowngraded) {
    console.log(`\n==================================================`);
    console.log(`⚠️  注意: 端口已发生降级！`);
    console.log(`👉  前端/其他程序引用的 CALLBACK_BASE_URL 应当修改为:`);
    console.log(`    ${callbackBaseUrl}`);
    console.log(`==================================================\n`);
  } else {
    console.log(`[Bootstrap] ⚡ 动态配置回调地址: ${callbackBaseUrl}`);
  }

  // 4. 拉起 PM2
  console.log("[Bootstrap] 🚀 正在通过 PM2 启动服务...");
  try {
    // 使用 --update-env 确保 PM2 读取 process.env.PORT
    const output = execSync("pm2 start ecosystem.config.js --update-env", {
      encoding: "utf8",
      stdio: "inherit",
      env: process.env, // 传递当前的环境变量（包含修改后的 PORT）
    });
    console.log("==================================================");
    console.log(`🎉 启动成功！`);
    console.log(`👉 主服务地址: http://127.0.0.1:${availablePort}`);
    console.log(
      `👉 管理面板地址: http://127.0.0.1:${availablePort + 1}/AdminPanel/`
    );
    console.log("==================================================");
  } catch (error) {
    console.error("[Bootstrap] ❌ PM2 启动失败:", error.message);
    process.exit(1);
  }
}

bootstrap();
