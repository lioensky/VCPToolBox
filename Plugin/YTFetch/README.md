# YTFetch

YTFetch 是一个同步 `stdio` 插件，通过 Gemini API 直接读取公开 YouTube URL 并返回视频、音频和时间线分析。它不在本地下载或上传视频文件；URL 会发送给 Google Gemini 服务处理。

## 参数

- `url`（必需）：YouTube watch 或 `youtu.be` URL。
- `prompt`（可选）：分析要求；默认返回简体中文结构化摘要。
- `model`（可选）：非 Pro Gemini 模型，默认 `gemini-2.5-flash-lite`。
- `fallbackModels`（可选）：逗号分隔的回退模型。
- `maxOutputTokens`（可选）：默认 `40000`。
- `thinkingBudget`（可选）：传 `0` 可关闭支持该选项的模型的思考预算。
- `raw`（可选）：返回结构化结果而不是 Markdown。
- `command=list_models`：列出支持 `generateContent` 的非 Pro 模型。

## 配置

复制 `config.env.example` 为 `config.env`，并设置 `GEMINI_API_KEY`。也支持 `GEMINI_API_KEYS` 轮换多个密钥，以及 `GEMINI_API_BASE_URL` 和 `YTFETCH_MODEL` 覆盖默认值。真实密钥只保存在本机 `config.env` 或系统环境变量中，绝不提交。

```text
<<<[TOOL_REQUEST]>>>
tool_name: YTFetch
url: https://www.youtube.com/watch?v=BClcpTpEyn4
prompt: 使用简体中文总结视频主题、画面、音频和关键时间线。
model: gemini-2.5-flash-lite
maxOutputTokens: 40000
<<<[END_TOOL_REQUEST]>>>
```

## 安装与测试

```powershell
python -m pip install -r requirements.txt
'{"url":"https://www.youtube.com/watch?v=BClcpTpEyn4"}' | python YTFetch.py
```

需要联网、有效 Gemini API 密钥和可由 Gemini 访问的公开 YouTube URL。请确认视频内容、URL 和分析结果符合平台条款与隐私要求。
