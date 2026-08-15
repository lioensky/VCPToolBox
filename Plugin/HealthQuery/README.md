# HealthQuery

HealthQuery 是一个同步 `stdio` 插件，通过 Fitbit Web API 查询个人活动、心率和睡眠数据。它使用标准 OAuth 2.0 授权，令牌仅保存在本机。

## 隐私与安全

健康数据、OAuth Client Secret 和 `tokens.json` 都属于敏感信息。请仅在你明确授权的个人 VCP 环境中启用此插件；不要提交、分享或发送 `config.env`、`tokens.json`、日志或本地健康数据库。默认关闭调试日志，避免把健康查询内容写入磁盘。

## 准备工作

1. 在 [Fitbit Developer Portal](https://dev.fitbit.com/apps) 注册个人 OAuth 应用。
2. 在应用设置中登记一个本机回调地址，例如 `http://localhost:8129/`，并记录 Client ID 与 Client Secret。
3. 安装依赖并复制示例配置：

```powershell
python -m pip install -r requirements.txt
Copy-Item config.env.example config.env
```

4. 在 `config.env` 设置 `CLIENT_ID`、`CLIENT_SECRET` 和与 Fitbit 应用设置完全一致的 `REDIRECT_URI`。
5. 调用 `trigger_auth`，在浏览器中完成 Fitbit 授权。插件会在本地回调地址接收授权结果并保存令牌。

## 命令

| 命令 | 说明 |
| --- | --- |
| `auth_status` | 检查本地 OAuth 令牌是否可用。 |
| `trigger_auth` | 启动 Fitbit OAuth 授权流程。 |
| `query_daily_summary` | 查询活动摘要；可传 `date`（`today` 或 `YYYY-MM-DD`）。 |
| `query_heart_rate_trend` | 查询静息心率、区间和统计；可传 `date`。 |
| `query_sleep_analysis` | 查询睡眠与睡眠阶段；可传 `date`。 |

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name: HealthQuery
command: query_daily_summary
date: today
<<<[END_TOOL_REQUEST]>>>
```

## 配置说明

`config.env.example` 列出了代码实际读取的全部插件配置。除 OAuth 凭证外，你可以按需关闭返回字段、设置数据质量阈值和调整请求超时。`TOKEN_FILE` 默认为插件目录中的 `tokens.json`；改用绝对路径时应确保文件权限只允许当前用户访问。

Fitbit 的可用数据取决于账号授权范围、设备同步状态和 Fitbit API 权限。请遵守 Fitbit 服务条款并审慎处理查询结果。
