# NewAPI 监控功能前端接入与配置说明

## 1. 功能简介

本功能为 VCP 管理面板新增了一组面向前端展示的 NewAPI 用量监控接口，用于给网页前端、管理面板页面、桌面挂件等场景提供统计数据。

当前实现严格遵循最小可用原则，只提供前端已经明确需要的能力：

- 总请求数统计
- 总 Token 数统计
- 总 Quota 统计
- 当前实时 RPM / TPM
- 按时间范围的趋势数据
- 按模型维度的聚合数据
- 按模型筛选 summary / trend

当前**不包含**以下能力：

- 区分 `/v1/chat/completions`、`/v1/responses` 等端点级统计
- 用户排行
- 渠道排行
- Token 名排行
- WebSocket 实时推送
- 其他前端未明确需要的占位接口

---

## 2. 后端接入位置

本功能对应的核心文件如下：

- `routes/admin/newapiMonitor.js`
- `routes/adminPanelRoutes.js`
- `config.env.example`

其中：

### 2.1 `routes/admin/newapiMonitor.js`
负责：

- 解析查询参数
- 连接 NewAPI 管理员接口
- 管理 session 或账号密码登录
- 拉取统计数据
- 聚合并输出给前端

### 2.2 `routes/adminPanelRoutes.js`
负责把监控路由挂载到 VCP 管理接口下。

### 2.3 `config.env.example`
负责提供配置示例，说明如何填写 NewAPI 监控功能所需环境变量。

---

## 3. 前端应该请求哪个地址

前端**不要直接请求 NewAPI**，而是请求 VCP 的管理接口。

可用接口如下：

- `GET /admin_api/newapi-monitor/summary`
- `GET /admin_api/newapi-monitor/trend`
- `GET /admin_api/newapi-monitor/models`

这三个接口都由 VCP 后端代持 NewAPI 的管理员鉴权信息。

也就是说：

- 前端不需要持有 NewAPI 的 session cookie
- 前端不需要自己拼 `New-Api-User`
- 前端不需要自己处理 NewAPI 登录逻辑

---

## 4. 配置说明

需要在 VCP 的运行配置中填写以下项目。

参考配置写在 `config.env.example` 中。

### 4.1 必填配置

```env
NEWAPI_MONITOR_BASE_URL=http://127.0.0.1:3000
```

含义：

- 目标 NewAPI 后台地址

### 4.2 可选配置：请求超时

```env
NEWAPI_MONITOR_TIMEOUT_MS=15000
```

含义：

- VCP 调用 NewAPI 时的超时时间，单位毫秒

### 4.3 鉴权方式二选一

#### 方式 A：直接填写管理员 session cookie（推荐）

适用于：

- 开启验证码
- 开启 2FA
- 不方便让后端自动登录的实例

```env
NEWAPI_MONITOR_SESSION_COOKIE=
```

#### 方式 B：填写管理员用户名密码

适用于：

- 允许后端直接调用登录接口
- 无验证码或交互式校验阻碍

```env
NEWAPI_MONITOR_USERNAME=
NEWAPI_MONITOR_PASSWORD=
```

### 4.4 特殊兼容配置（可选）

某些经过定制的 NewAPI 实例，除了 session 外，还会额外要求 `New-Api-User` 请求头。

这类实例可以补充：

```env
NEWAPI_MONITOR_API_USER_ID=
```

说明：

- 只有当目标实例明确要求 `New-Api-User` 时才需要填写
- 普通标准实例可以留空

---

## 5. 数据来源说明

VCP 侧会使用以下策略获取数据：

### 5.1 优先使用 `/api/data/`
优先从 NewAPI 的聚合数据接口拉取：

- 请求数
- token_used
- quota
- created_at
- model_name

优点：

- 已按小时聚合
- 性能更好
- 更适合前端统计

### 5.2 使用 `/api/log/stat` 获取实时值
用于获取：

- 当前 RPM
- 当前 TPM

### 5.3 `/api/data/` 无数据时自动回退到 `/api/log/`
如果目标实例没有可用的 quota_data，则 VCP 会自动回退到消费日志分页拉取，再在本地聚合。

因此本功能兼容两类 NewAPI：

- 已启用聚合数据导出的实例
- 仅有日志数据的实例

---

## 6. 接口说明

## 6.1 summary 接口

### 请求地址

```text
GET /admin_api/newapi-monitor/summary
```

### 支持参数

| 参数 | 是否必填 | 说明 |
|---|---:|---|
| `start_timestamp` | 否 | 开始时间，默认最近 24 小时 |
| `end_timestamp` | 否 | 结束时间，默认当前时间 |
| `model_name` | 否 | 按模型筛选 |

### 返回内容

- 总请求数
- 总 Token 数
- 总 Quota
- 当前 RPM
- 当前 TPM

### 示例响应

```json
{
  "success": true,
  "data": {
    "source": "quota_data",
    "start_timestamp": 1711584000,
    "end_timestamp": 1711670400,
    "model_name": null,
    "total_requests": 123,
    "total_tokens": 456789,
    "total_quota": 987654,
    "current_rpm": 12,
    "current_tpm": 34567
  }
}
```

---

## 6.2 trend 接口

### 请求地址

```text
GET /admin_api/newapi-monitor/trend
```

### 支持参数

| 参数 | 是否必填 | 说明 |
|---|---:|---|
| `start_timestamp` | 否 | 开始时间，默认最近 24 小时 |
| `end_timestamp` | 否 | 结束时间，默认当前时间 |
| `model_name` | 否 | 按模型筛选 |

### 返回内容

返回趋势数组，每个时间桶包含：

- `created_at`
- `requests`
- `token_used`
- `quota`

### 示例响应

```json
{
  "success": true,
  "data": {
    "source": "quota_data",
    "start_timestamp": 1711584000,
    "end_timestamp": 1711670400,
    "model_name": null,
    "items": [
      {
        "created_at": 1711584000,
        "requests": 10,
        "token_used": 20000,
        "quota": 30000
      }
    ]
  }
}
```

---

## 6.3 models 接口

### 请求地址

```text
GET /admin_api/newapi-monitor/models
```

### 支持参数

| 参数 | 是否必填 | 说明 |
|---|---:|---|
| `start_timestamp` | 否 | 开始时间，默认最近 24 小时 |
| `end_timestamp` | 否 | 结束时间，默认当前时间 |

### 返回内容

返回按模型聚合后的统计数据：

- `model_name`
- `requests`
- `token_used`
- `quota`

### 示例响应

```json
{
  "success": true,
  "data": {
    "source": "quota_data",
    "start_timestamp": 1711584000,
    "end_timestamp": 1711670400,
    "items": [
      {
        "model_name": "gpt-4o",
        "requests": 100,
        "token_used": 123456,
        "quota": 789012
      }
    ]
  }
}
```

---

## 7. 前端如何调用

## 7.1 基础原则

前端应该：

- 只调用 VCP 的 `/admin_api/newapi-monitor/*`
- 尽量使用同源请求
- 使用浏览器原生 `fetch`
- 不直接连接 NewAPI 后台接口
- 不在前端保存 NewAPI 管理员鉴权信息

---

## 7.2 推荐封装一个通用请求函数

```js
async function requestMonitorJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin'
  });

  const result = await response.json();

  if (!response.ok || result.success === false) {
    throw new Error(result.error || result.message || '请求失败');
  }

  return result.data;
}
```

---

## 7.3 获取 summary

```js
async function fetchSummary({ startTimestamp, endTimestamp, modelName }) {
  const params = new URLSearchParams();

  if (startTimestamp) params.set('start_timestamp', String(startTimestamp));
  if (endTimestamp) params.set('end_timestamp', String(endTimestamp));
  if (modelName) params.set('model_name', modelName);

  return requestMonitorJson(`/admin_api/newapi-monitor/summary?${params.toString()}`);
}
```

---

## 7.4 获取 trend

```js
async function fetchTrend({ startTimestamp, endTimestamp, modelName }) {
  const params = new URLSearchParams();

  if (startTimestamp) params.set('start_timestamp', String(startTimestamp));
  if (endTimestamp) params.set('end_timestamp', String(endTimestamp));
  if (modelName) params.set('model_name', modelName);

  return requestMonitorJson(`/admin_api/newapi-monitor/trend?${params.toString()}`);
}
```

---

## 7.5 获取 models

```js
async function fetchModels({ startTimestamp, endTimestamp }) {
  const params = new URLSearchParams();

  if (startTimestamp) params.set('start_timestamp', String(startTimestamp));
  if (endTimestamp) params.set('end_timestamp', String(endTimestamp));

  return requestMonitorJson(`/admin_api/newapi-monitor/models?${params.toString()}`);
}
```

---

## 8. 前端页面建议结构

建议页面分成三块：

### 8.1 筛选区域
建议包含：

- 时间范围选择器
- 模型选择器
- 手动刷新按钮

### 8.2 顶部统计卡片
建议展示：

- 总请求数
- 总 Token
- 总 Quota
- 当前 RPM
- 当前 TPM

### 8.3 趋势与模型排行区域
建议展示：

- 趋势图
- 模型排行表格

---

## 9. 页面初始化建议

推荐初始化流程如下：

1. 计算默认时间范围（最近 24 小时）
2. 请求 `models`
3. 请求 `summary`
4. 请求 `trend`
5. 渲染下拉框、卡片、图表和表格

示例：

```js
async function initMonitorPage() {
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - 24 * 60 * 60;

  const [modelsData, summaryData, trendData] = await Promise.all([
    fetchModels({ startTimestamp, endTimestamp }),
    fetchSummary({ startTimestamp, endTimestamp }),
    fetchTrend({ startTimestamp, endTimestamp })
  ]);

  renderModelOptions(modelsData.items);
  renderSummaryCards(summaryData);
  renderTrendChart(trendData.items);
  renderModelTable(modelsData.items);
}
```

---

## 10. 一个最小可用前端示例

```html
<div>
  <label>模型：</label>
  <select id="model-select">
    <option value="">全部模型</option>
  </select>
  <button id="refresh-btn">刷新</button>
</div>

<div id="summary"></div>
<pre id="trend"></pre>
<pre id="models"></pre>

<script>
  async function requestMonitorJson(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin'
    });
    const result = await response.json();
    if (!response.ok || result.success === false) {
      throw new Error(result.error || result.message || '请求失败');
    }
    return result.data;
  }

  function getDefaultRange() {
    const endTimestamp = Math.floor(Date.now() / 1000);
    const startTimestamp = endTimestamp - 24 * 60 * 60;
    return { startTimestamp, endTimestamp };
  }

  async function loadModels() {
    const { startTimestamp, endTimestamp } = getDefaultRange();
    const data = await requestMonitorJson(
      `/admin_api/newapi-monitor/models?start_timestamp=${startTimestamp}&end_timestamp=${endTimestamp}`
    );

    const select = document.getElementById('model-select');
    select.innerHTML = '<option value="">全部模型</option>';

    for (const item of data.items) {
      const option = document.createElement('option');
      option.value = item.model_name;
      option.textContent = `${item.model_name} (${item.requests})`;
      select.appendChild(option);
    }
  }

  async function loadDashboard() {
    const { startTimestamp, endTimestamp } = getDefaultRange();
    const modelName = document.getElementById('model-select').value;

    const summaryParams = new URLSearchParams({
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp)
    });
    if (modelName) summaryParams.set('model_name', modelName);

    const trendParams = new URLSearchParams({
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp)
    });
    if (modelName) trendParams.set('model_name', modelName);

    const modelsParams = new URLSearchParams({
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp)
    });

    const [summary, trend, models] = await Promise.all([
      requestMonitorJson(`/admin_api/newapi-monitor/summary?${summaryParams.toString()}`),
      requestMonitorJson(`/admin_api/newapi-monitor/trend?${trendParams.toString()}`),
      requestMonitorJson(`/admin_api/newapi-monitor/models?${modelsParams.toString()}`)
    ]);

    document.getElementById('summary').innerHTML = `
      <div>总请求数：${summary.total_requests}</div>
      <div>总 Token：${summary.total_tokens}</div>
      <div>总 Quota：${summary.total_quota}</div>
      <div>当前 RPM：${summary.current_rpm}</div>
      <div>当前 TPM：${summary.current_tpm}</div>
    `;

    document.getElementById('trend').textContent = JSON.stringify(trend.items, null, 2);
    document.getElementById('models').textContent = JSON.stringify(models.items, null, 2);
  }

  async function init() {
    await loadModels();
    await loadDashboard();
  }

  document.getElementById('refresh-btn').addEventListener('click', loadDashboard);
  document.getElementById('model-select').addEventListener('change', loadDashboard);

  init().catch(error => {
    console.error(error);
    alert(error.message || '加载失败');
  });
</script>
```

---

## 11. 如何验证功能是否可用

在前端正式接入前，建议先手动验证：

1. 修改配置
2. 重启 VCP
3. 登录 VCP 管理面板
4. 浏览器访问以下地址，确认返回 JSON：

- `/admin_api/newapi-monitor/summary`
- `/admin_api/newapi-monitor/trend`
- `/admin_api/newapi-monitor/models`

如果这三个接口都能正常返回数据，前端接入基本不会有问题。

---

## 12. 推荐刷新策略

建议：

- 页面初始化时加载全部数据
- `summary` 每 30 秒自动刷新一次
- `trend` 和 `models` 在筛选条件变化时刷新
- 同时保留一个手动刷新按钮

示例：

```js
let summaryTimer = null;

function startSummaryAutoRefresh(getFilters) {
  stopSummaryAutoRefresh();

  summaryTimer = setInterval(async () => {
    try {
      const filters = getFilters();
      const summaryData = await fetchSummary(filters);
      renderSummaryCards(summaryData);
    } catch (error) {
      console.error('summary 自动刷新失败:', error);
    }
  }, 30000);
}

function stopSummaryAutoRefresh() {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}
```

---

## 13. 前端错误处理建议

后端错误通常返回：

```json
{
  "success": false,
  "error": "错误信息"
}
```

前端建议：

- 显示 loading 状态
- 请求失败时显示错误提示
- 提供重试按钮
- 尽可能保留上一次成功的数据

---

## 14. 使用流程总结

整个功能的典型使用流程如下：

1. 在 VCP 中配置 NewAPI 监控所需环境变量
2. 重启 VCP
3. 用浏览器验证三个管理接口是否可返回 JSON
4. 前端通过 `fetch` 请求 `/admin_api/newapi-monitor/*`
5. 将 `summary` 渲染为统计卡片
6. 将 `trend` 渲染为趋势图
7. 将 `models` 渲染为模型排行表或模型下拉框

---

## 15. 维护注意事项

- `NEWAPI_MONITOR_BASE_URL` 为必填项
- 推荐优先使用 `NEWAPI_MONITOR_SESSION_COOKIE`
- 用户名密码方式仅作备选
- `NEWAPI_MONITOR_API_USER_ID` 只在某些特殊实例中需要
- 前端不要根据 `source` 的单一取值写死逻辑
- 若未来前端新增明确需求，再扩展接口，不要预埋无用能力

---

## 16. 一句话总结

这套功能的核心原则只有一句话：

**前端只请求 VCP 的 `/admin_api/newapi-monitor/*`，不要直接碰 NewAPI 管理员鉴权。**