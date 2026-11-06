# DynamicToolBridge 维护说明

维护署名：白金喵。此更新延续动态工具自动管理功能，仅修复语义摘要、细分类、小模型输出和专属配置链路。

## 配置入口

在后端管理面板打开 **动态工具清单** 专属 Tab（`/AdminPanel/dynamic-tools-manager`）。注入限制、摘要软预算、细分类规则、embedding 降级、小模型生成/重试参数及逐工具人工说明均在此编辑；点击保存后落盘并热生效，不需要走通用插件 env 编辑页或重启后端。

小模型固定复用后端根配置的 `API_URL` / `API_Key`，只需填写该主 API 支持的模型 ID。插件不再提供独立 API 地址或密钥入口；启用模型分类时需配置有效模型 ID。

## 本次修复

- 摘要不再按单汉字拆分、插空格或在词内硬截断。保留中文能力短语、标点和英文词边界，保护 `GPT-4.1` / `Node.js` 等词内点。摘要 token 预算是软目标，总注入字符上限仍保留。
- 提供23条默认细语义分类规则，覆盖网页/学术/浏览器、文件读写/代码分析/执行/Git、图像/语音/视频、知识检索/笔记、代理/调度、通信及数据处理；规则可在专属 Tab 编辑。保留父类、别名、显式点名和人工覆盖，不用示例中的偶然关键词扩大分类。
- 小模型响应枚举平衡 JSON 候选并校验结构，支持围栏、解释文字、数组候选和尾逗号的确定性修复；不将缺字段或错误类型伪造为成功。不合法输出提供错误反馈重试，默认最多额外2次。
- 400/401/403 不盲重试，429/5xx 有界重试；请求、读取响应和等待共用总超时，取消会传递到实际请求。旧配置任务取消后不能覆盖新配置结果。
- 配置保存与人工覆盖在同一事务队列提交，部分保存保留其他字段；写盘/重载失败保留最后有效配置。轮询不覆盖未保存草稿，人工摘要与自动分类基线分开，清空人工覆盖可恢复自动结果。

## v2 配置与升级

配置文件为 `ToolConfigs/dynamic_tool_bridge.config.json`，版本为 `2`。从旧版本升级时，旧插件 env 仅一次导入启用状态及实际模型 ID，之后专属 JSON 为权威配置，旧 env 不再覆盖保存值。旧独立 endpoint/key 不参与请求，也不保存在专属配置响应中。

主要新增配置组：

| 配置组 | 字段 |
|---|---|
| `summary` | `lightListTokenBudget`、`briefTokenBudget`、`minBriefTokenBudget` |
| `classification` | `maxCategories`、`embeddingThreshold`、`categoryRules` |
| `smallModel` | `enabled`、`model`、`maxRetries`、`retryDelayMs`、`maxTokens`、`temperature` |
| `manualOverrides` | 原排除/置顶/类别别名，以及 `descriptionOverrides` |

新安装默认不启用小模型，模型 ID 为空；已有配置保留有效启用状态和模型。配置接口对字段类型、范围和嵌套结构进行校验，非法保存返回400，不破坏已生效值。

升级前备份专属配置及目录/分类缓存。更新不会自动清空或全量重分类；现有分类按需使用原 **重建分类** 按钮更新。小模型仍仅在后台新增/变化或手动重建时调用，不改变普通注入路径、折叠协议、分布式去重、source hash 增量、注入排序或工具/类别点名。

## 验证

后端聚焦回归（79项）：

```powershell
node --test tests/dynamicToolRegistry.test.js tests/dynamicToolSemantics.test.js tests/dynamicToolsRoutes.test.js
```

管理面测试（15项）、类型及生产构建：

```powershell
Set-Location AdminPanel-Vue
npm test -- tests/dynamicToolsConfig.test.ts
npx vue-tsc --noEmit
npm run build
```

相关回归、类型和构建已通过，真实主 API 的浏览器、学术检索、TTS 三样例均返回完整中文摘要与对应细分类；配置保存200、非法配置400和面板HTTP200已验证。真实浏览器 Tab 保存交互验收按要求跳过，不作为已通过证据。

后续维护需要一起保留语义模块、注册表、管理路由、专属页面/API/配置编辑器及其回归测试；从合并后源码重新构建管理面，不提交生产配置、分类缓存或凭据。
