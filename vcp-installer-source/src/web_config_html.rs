/// VCP Web 配置向导 — HTML 页面
/// 由 Rosa 自动生成，内嵌完整 HTML/CSS/JS

pub const CONFIG_PAGE_HTML: &str = r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VCP 配置向导</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --accent: #7c5cfc;
    --accent-hover: #9b7fff;
    --text: #e4e4e7;
    --text-dim: #8b8d97;
    --danger: #ef4444;
    --success: #22c55e;
    --warn: #f59e0b;
    --input-bg: #12141c;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 40px 20px;
  }
  .container {
    max-width: 720px;
    width: 100%;
  }
  /* Header */
  .header {
    text-align: center;
    margin-bottom: 36px;
  }
  .header h1 {
    font-size: 28px;
    font-weight: 700;
    background: linear-gradient(135deg, #7c5cfc, #c084fc);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }
  .header p {
    color: var(--text-dim);
    font-size: 14px;
  }
  /* Section */
  .section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: 16px;
    overflow: hidden;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    cursor: pointer;
    user-select: none;
    transition: background 0.2s;
  }
  .section-header:hover { background: rgba(124,92,252,0.05); }
  .section-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
    font-weight: 600;
  }
  .section-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 500;
  }
  .badge-required { background: rgba(239,68,68,0.15); color: var(--danger); }
  .badge-recommended { background: rgba(245,158,11,0.15); color: var(--warn); }
  .badge-optional { background: rgba(34,197,94,0.15); color: var(--success); }
  .section-arrow {
    transition: transform 0.3s;
    color: var(--text-dim);
    font-size: 12px;
  }
  .section-arrow.open { transform: rotate(180deg); }
  .section-body {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.4s ease;
  }
  .section-body.open { max-height: 2000px; }
  .section-content { padding: 0 20px 20px; }
  /* Form */
  .field {
    margin-bottom: 16px;
  }
  .field:last-child { margin-bottom: 0; }
  .field label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--text);
  }
  .field label .hint {
    font-weight: 400;
    color: var(--text-dim);
    font-size: 12px;
    margin-left: 4px;
  }
  .field .guide {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 6px;
    line-height: 1.6;
  }
  .field .guide a {
    color: var(--accent);
    text-decoration: none;
  }
  .field .guide a:hover { text-decoration: underline; }
  .field input, .field textarea {
    width: 100%;
    padding: 10px 14px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    transition: border-color 0.2s;
    outline: none;
  }
  .field input:focus, .field textarea:focus {
    border-color: var(--accent);
  }
  .field textarea { resize: vertical; min-height: 64px; }
  .field input::placeholder, .field textarea::placeholder {
    color: #4a4d5a;
  }
  .pw-wrap {
    position: relative;
  }
  .pw-wrap input { padding-right: 44px; }
  .pw-toggle {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
  }
  /* Generate button */
  .gen-row {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 16px;
  }
  .btn-gen {
    padding: 6px 14px;
    background: rgba(124,92,252,0.12);
    border: 1px solid rgba(124,92,252,0.3);
    border-radius: 8px;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s;
  }
  .btn-gen:hover {
    background: rgba(124,92,252,0.2);
    border-color: var(--accent);
  }
  /* Submit */
  .submit-area {
    margin-top: 28px;
    text-align: center;
  }
  .btn-submit {
    padding: 14px 48px;
    background: linear-gradient(135deg, #7c5cfc, #9b7fff);
    border: none;
    border-radius: 12px;
    color: white;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    box-shadow: 0 4px 20px rgba(124,92,252,0.3);
  }
  .btn-submit:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 28px rgba(124,92,252,0.5);
  }
  .btn-submit:active { transform: translateY(0); }
  .submit-hint {
    margin-top: 12px;
    font-size: 12px;
    color: var(--text-dim);
  }
  /* Toast */
  .toast {
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 14px 20px;
    border-radius: 10px;
    color: white;
    font-size: 14px;
    font-weight: 500;
    z-index: 9999;
    transform: translateX(120%);
    transition: transform 0.4s ease;
    max-width: 360px;
  }
  .toast.show { transform: translateX(0); }
  .toast-success { background: #16a34a; }
  .toast-error { background: #dc2626; }
  /* Result panel */
  .result-panel {
    display: none;
    background: var(--card);
    border: 1px solid var(--success);
    border-radius: 12px;
    padding: 24px;
    margin-top: 20px;
    text-align: center;
  }
  .result-panel.show { display: block; }
  .result-panel h2 {
    color: var(--success);
    font-size: 22px;
    margin-bottom: 16px;
  }
  .result-info {
    text-align: left;
    background: var(--input-bg);
    border-radius: 8px;
    padding: 16px;
    font-family: monospace;
    font-size: 13px;
    line-height: 1.8;
    margin: 16px 0;
  }
  .result-info .key { color: var(--accent); }
  .result-info .val { color: var(--success); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>&#x2728; VCP 配置向导</h1>
    <p>填写下方配置信息，完成后将自动生成 config.env 并链接前后端</p>
  </div>

  <form id="configForm" autocomplete="off">

  <!-- ====== 第一组: API核心 ====== -->
  <div class="section" data-open="true">
    <div class="section-header" onclick="toggleSection(this)">
      <div class="section-title">
        &#x1F511; API 核心配置
        <span class="section-badge badge-required">必填</span>
      </div>
      <span class="section-arrow open">&#x25BC;</span>
    </div>
    <div class="section-body open">
      <div class="section-content">
        <div class="field">
          <label>NewAPI 地址 <span class="hint">(API_URL)</span></label>
          <div class="guide">
            你的 API 聚合网关地址。自建请部署
            <a href="https://github.com/songquanpeng/new-api" target="_blank">New-API</a>；
            或使用聚合商如 <a href="https://openrouter.ai" target="_blank">OpenRouter</a>
          </div>
          <input type="text" name="API_URL" placeholder="http://127.0.0.1:3000" required>
        </div>
        <div class="field">
          <label>NewAPI 密钥 <span class="hint">(API_Key)</span></label>
          <div class="guide">
            在 NewAPI 控制台创建的 API Key，格式如 sk-xxxx
          </div>
          <div class="pw-wrap">
            <input type="password" name="API_Key" placeholder="sk-xxxx" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ====== 第二组: 服务安全 ====== -->
  <div class="section" data-open="true">
    <div class="section-header" onclick="toggleSection(this)">
      <div class="section-title">
        &#x1F512; 服务安全配置
        <span class="section-badge badge-required">必填</span>
      </div>
      <span class="section-arrow open">&#x25BC;</span>
    </div>
    <div class="section-body open">
      <div class="section-content">
        <div class="gen-row">
          <button type="button" class="btn-gen" onclick="generateAllKeys()">&#x2728; 一键生成全部密钥</button>
        </div>
        <div class="field">
          <label>VCP 访问密钥 <span class="hint">(Key)</span></label>
          <div class="guide">聊天 API 鉴权密钥，VCPChat 连接时需填此值</div>
          <div class="pw-wrap">
            <input type="password" name="Key" placeholder="设置一个强密码" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
        <div class="field">
          <label>图片服务密钥 <span class="hint">(Image_Key)</span></label>
          <div class="guide">表情包/图片/相册服务的访问密钥</div>
          <div class="pw-wrap">
            <input type="password" name="Image_Key" placeholder="设置一个强密码" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
        <div class="field">
          <label>文件服务密钥 <span class="hint">(File_Key)</span></label>
          <div class="guide">文件上传下载服务的访问密钥</div>
          <div class="pw-wrap">
            <input type="password" name="File_Key" placeholder="设置一个强密码" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
        <div class="field">
          <label>WebSocket 密钥 <span class="hint">(VCP_Key)</span></label>
          <div class="guide">实时通信鉴权，VCPChat 的 WS 日志连接用</div>
          <div class="pw-wrap">
            <input type="password" name="VCP_Key" placeholder="设置一个强密码" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
        <div class="field">
          <label>管理面板用户名 <span class="hint">(AdminUsername)</span></label>
          <input type="text" name="AdminUsername" placeholder="admin" value="admin" required>
        </div>
        <div class="field">
          <label>管理面板密码 <span class="hint">(AdminPassword)</span></label>
          <div class="guide">VCP 管理后台的登录密码，请牢记</div>
          <div class="pw-wrap">
            <input type="password" name="AdminPassword" placeholder="设置管理员密码" required>
            <button type="button" class="pw-toggle" onclick="togglePw(this)">&#x1F441;</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ====== 第三组: 个人信息 ====== -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <div class="section-title">
        &#x1F464; 个人信息配置
        <span class="section-badge badge-recommended">建议填写</span>
      </div>
      <span class="section-arrow">&#x25BC;</span>
    </div>
    <div class="section-body">
      <div class="section-content">
        <div class="field">
          <label>所在城市 <span class="hint">(VarCity)</span></label>
          <div class="guide">用于天气查询等本地化服务，填英文城市名</div>
          <input type="text" name="VarCity" placeholder="Shanghai">
        </div>
        <div class="field">
          <label>你的称呼 <span class="hint">(VarUser)</span></label>
          <div class="guide">AI Agent 将以此称呼你</div>
          <input type="text" name="VarUser" placeholder="你的名字或昵称">
        </div>
        <div class="field">
          <label>个人简介 <span class="hint">(VarUserInfo)</span></label>
          <div class="guide">让 Agent 了解你，提供更贴心的服务</div>
          <textarea name="VarUserInfo" placeholder="例如：大二CS学生，喜欢折腾AI和开源项目"></textarea>
        </div>
        <div class="field">
          <label>系统信息 <span class="hint">(VarSystemInfo)</span></label>
          <input type="text" name="VarSystemInfo" placeholder="Windows 11 x64" value="{{SYSTEM_INFO}}">
        </div>
        <div class="field">
          <label>家的描述 <span class="hint">(VarHome)</span></label>
          <textarea name="VarHome" placeholder="随便写，聊天用的环境信息"></textarea>
        </div>
        <div class="field">
          <label>VCPChat 安装路径 <span class="hint">(VarVchatPath)</span></label>
          <div class="guide">VCPChat 的实际安装路径，Agent 操作文件时需要</div>
          <input type="text" name="VarVchatPath" placeholder="{{VCHAT_PATH}}" value="{{VCHAT_PATH}}">
        </div>
        <div class="field">
          <label>团队介绍 <span class="hint">(VarTeam)</span></label>
          <div class="guide">你的 Agent 阵容介绍，初次安装可留空</div>
          <textarea name="VarTeam" placeholder="例如：Nova 是默认AI助手"></textarea>
        </div>
      </div>
    </div>
  </div>

  <!-- ====== 第四组: 扩展功能 ====== -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <div class="section-title">
        &#x1F50C; 扩展功能配置
        <span class="section-badge badge-optional">可选</span>
      </div>
      <span class="section-arrow">&#x25BC;</span>
    </div>
    <div class="section-body">
      <div class="section-content">
        <div class="field">
          <label>&#x1F324; 和风天气 API Key <span class="hint">(WeatherKey)</span></label>
          <div class="guide">
            注册 <a href="https://console.qweather.com/" target="_blank">和风天气控制台</a>
            免费领取，统一按量计费每月 5 万次免费
          </div>
          <input type="text" name="WeatherKey" placeholder="你的和风天气 API Key">
        </div>
        <div class="field">
          <label>&#x1F324; 和风天气 API 地址 <span class="hint">(WeatherUrl)</span></label>
          <div class="guide">
            2025年4月起已统一计费，控制台 V4 分配的独立 API Host；
            过渡期可填 api.qweather.com
          </div>
          <input type="text" name="WeatherUrl" placeholder="api.qweather.com 或你的独立Host">
        </div>
        <div class="field">
          <label>&#x1F4FA; B站 Cookie <span class="hint">(BILIBILI_COOKIE)</span></label>
          <div class="guide">
            获取B站视频字幕/弹幕/评论需要。浏览器 F12 &rarr; Network &rarr; 找任意 bilibili.com 请求 &rarr; Headers 里的 Cookie 字段整行复制
          </div>
          <textarea name="BILIBILI_COOKIE" placeholder="粘贴你的 B站 Cookie"></textarea>
        </div>
        <div class="field">
          <label>&#x1F50D; Tavily 搜索密钥 <span class="hint">(TavilyKey)</span></label>
          <div class="guide">
            联网搜索功能。注册 <a href="https://www.tavily.com/" target="_blank">Tavily</a>
            免费 1000 次/月
          </div>
          <input type="text" name="TavilyKey" placeholder="tvly-xxxx">
        </div>
        <div class="field">
          <label>&#x1F3A8; 硅基流动密钥 <span class="hint">(SILICONFLOW_API_KEY)</span></label>
          <div class="guide">
            图片/视频生成。注册 <a href="https://cloud.siliconflow.cn/i/sTBU7Yzn" target="_blank">硅基流动</a>
            送免费额度
          </div>
          <input type="text" name="SILICONFLOW_API_KEY" placeholder="sk-xxxx">
        </div>
      </div>
    </div>
  </div>

  <!-- Submit -->
  <div class="submit-area">
    <button type="submit" class="btn-submit">&#x2705; 完成配置</button>
    <div class="submit-hint">将自动生成 config.env 并配置 VCPChat 前后端链接</div>
  </div>

  </form>

  <!-- Result -->
  <div class="result-panel" id="resultPanel">
    <h2>&#x1F389; 配置完成！</h2>
    <p>以下信息已自动生成，请妥善保管：</p>
    <div class="result-info" id="resultInfo"></div>
    <p style="margin-top:16px;color:var(--text-dim);font-size:13px;">
      现在可以关闭此页面，回到终端启动 VCP 服务。
    </p>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function toggleSection(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector('.section-arrow');
  body.classList.toggle('open');
  arrow.classList.toggle('open');
}

function togglePw(btn) {
  const input = btn.previousElementSibling;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '\u{1F648}';
  } else {
    input.type = 'password';
    btn.textContent = '\u{1F441}';
  }
}

function genKey(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) result += chars[arr[i] % chars.length];
  return result;
}

function generateAllKeys() {
  const fields = ['Key', 'Image_Key', 'File_Key', 'VCP_Key', 'AdminPassword'];
  fields.forEach(name => {
    const input = document.querySelector(`input[name="${name}"]`);
    if (input) {
      input.value = genKey(24);
      input.type = 'text';
      const toggle = input.nextElementSibling;
      if (toggle) toggle.textContent = '\u{1F648}';
    }
  });
  showToast('已为所有密钥字段生成随机强密码！请记住或截图保存。', 'success');
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 4000);
}

document.getElementById('configForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const formData = new FormData(this);
  const data = {};
  formData.forEach((v, k) => { data[k] = v; });

  // Validate required
  const required = ['API_URL', 'API_Key', 'Key', 'Image_Key', 'File_Key', 'VCP_Key', 'AdminUsername', 'AdminPassword'];
  for (const f of required) {
    if (!data[f] || !data[f].trim()) {
      showToast('请填写必填项: ' + f, 'error');
      document.querySelector(`[name="${f}"]`).focus();
      return;
    }
  }

  try {
    const resp = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await resp.json();
    if (result.success) {
      document.getElementById('configForm').style.display = 'none';
      const panel = document.getElementById('resultPanel');
      panel.classList.add('show');
      document.getElementById('resultInfo').innerHTML = result.summary || '配置文件已生成。';
      showToast('配置成功！', 'success');
    } else {
      showToast('配置失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('请求失败: ' + err.message, 'error');
  }
});
</script>
</body>
</html>"##;