# SpecStreamSearch

用 [SpecStream](https://specstream.ai) 做网页搜索，返回标题、链接、站点和摘要组成的 Markdown 列表。事实类问题（例如“澳大利亚首都”）会在列表前给出答案和它的来源页。

插件默认是禁用状态（`plugin-manifest.json.block`）。需要时改名为 `plugin-manifest.json` 即可启用，不影响其他搜索插件。

- 需要 `SpecStreamKey`：调用 `POST https://api.specstream.ai/v1/web-search`（请求头 `Authorization: Bearer <key>`）。未填写 Key 时插件直接返回错误，不发出任何请求
- 价格：标准档每千次 5 美元，`SpecStreamSpeed=fast` 的快速档每千次 1 美元（每次不超过 10 条结果）；新账号自带 10 美元额度

可选参数：`max_results`、`site`（只搜某个域名）、`published_after`（YYYY-MM-DD）。`site` 和 `published_after` 以 `site:`、`after:` 运算符写进查询，由服务端对每条结果强制执行。

## 测试

```bash
node --test Plugin/SpecStreamSearch/SpecStreamSearch.test.js
echo '{"query":"VCPToolBox"}' | node Plugin/SpecStreamSearch/SpecStreamSearch.js
```

English: opt-in SpecStream web search plugin, shipped disabled. Needs `SpecStreamKey` and sends no request without it; `SpecStreamSpeed=fast` selects the fast tier. Docs: https://specstream.ai/docs
