# YouSearch

You.com Research API 同步插件，支持 lite、standard、deep；默认 standard。不创建后台任务，不轮询，不进行二次模型总结。

## 配置

将 [配置模板](config.env.example) 复制为同目录的私有配置后填写密钥。通过插件管理器执行时也支持根环境配置，插件级配置优先。

| 配置 | 说明 |
|---|---|
| YouSearchKey | API 密钥，必填 |
| YouSearchUrl | 完整 API 地址，默认官方 Research 端点；可改为兼容中转接口 |
| YouSearchEffort | 默认档位，standard |
| YouSearchTimeout | 请求超时毫秒数，默认 240000；deep 建议至少 180000 |
| YouSearchProxy | 可选 HTTP(S) 网络代理，支持用户名密码，留空直连 |

API 中转地址与网络代理相互独立，可分别配置。不自动继承系统代理环境变量。为避免密钥被转发至未知地址，不跟随 HTTP 重定向。配置的 API 中转和网络代理必须可信。

## 调用

直接调用参数见 [插件清单](plugin-manifest.json)。研究问题使用 SearchTopic（兼容 input），档位使用 research_effort（兼容 ResearchEffort）。可选 source_control 支持对象或 JSON 字符串，包含域名白名单/黑名单、时间范围与国家代码。

JEV 使用联网搜索目录，显式选择 YouSearch：

- {联网搜索} 'YouSearch' 【比较 RISC-V 与 ARM】[deep]
- {联网搜索} 'YouSearch' 【今日芯片新闻】[档位:lite][优先官方来源]
- {联网搜索} 'YouSearch' 【全球电动车市场趋势】

档位标签支持 lite/轻量/快速、standard/标准、deep/深度/深度研究；未标注则使用 standard。非档位约束按原文追加到研究问题，不自动转换为来源过滤器。精确的来源过滤应使用直接插件调用的 source_control。现有默认搜索器不变。

## 返回及错误

实现见 [插件入口](YouSearch.js:1)。返回与 VSearch 相同的同步成功信封，正文位于文本内容数组中，包含 Markdown 报告、原始引用标记和对应编号的来源列表。来源不去重、不重排，避免破坏引用对应关系。

空正文、参数错误、网络失败、超时、认证错误、额度不足及限流都返回错误状态。API 错误不自动重试，以避免重复计费；不输出请求头、密钥或原始上游错误对象。请求超时始终低于 [清单](plugin-manifest.json) 中的插件硬超时，预留 15 秒返回余量。

无需安装新增依赖，复用根项目现有依赖。真实 API 调用会产生费用，本地模拟测试不访问付费 API。