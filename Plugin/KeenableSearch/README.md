# KeenableSearch

用 [Keenable](https://keenable.ai) 做网页搜索，返回标题、链接和摘要组成的 Markdown 列表。

插件默认是禁用状态（`plugin-manifest.json.block`）。需要时改名为 `plugin-manifest.json` 即可启用，不影响其他搜索插件。

- 不填 Key：调用 `POST https://api.keenable.ai/v1/search/public`（请求头 `X-Keenable-Title`），每个 IP 每小时 1,000 次、每秒 10 次
- 填写 `KeenableKey`：调用 `POST https://api.keenable.ai/v1/search`（请求头 `X-API-Key`），每月 10 万次免费额度

可选参数：`max_results`、`site`（只搜某个域名）、`published_after`（YYYY-MM-DD）。

## 测试

```bash
node --test Plugin/KeenableSearch/KeenableSearch.test.js
echo '{"query":"VCPToolBox"}' | node Plugin/KeenableSearch/KeenableSearch.js
```

English: opt-in Keenable web search plugin, shipped disabled. Works without a key; `KeenableKey` switches to the keyed API. Docs: https://docs.keenable.ai
