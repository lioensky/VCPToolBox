# VCPToolBox 插件归类草稿

> 说明：
> 1. 这是 2026-04-25 按当时 `main` 线变更整理的历史草稿，目的是区分“原作者底座 / 原作者改造 / 我们自制 / 暂不定”。
> 2. 本文尚未作为最终归属清单发布；后续维护者可以在表里调整分类、补备注、删掉不需要的项。
> 3. 当前主线已经在后续整合中前进，本文结论应结合最新仓库状态复核。

## 1. 原作者底座

这些更像仓库里长期存在、这次主要沿用的底层插件或能力。

| 插件 / 目录 | 备注 |
| --- | --- |
| `Plugin/AgentDream` | 原有 Agent 资产 |
| `Plugin/VCPTavern` | 原有 tavern 能力 |
| `Plugin/FileOperator` | 原有文件操作插件 |
| `Plugin/WeatherReporter` | 原有天气插件 |
| `Plugin/SciCalculator` | 原有科学计算插件 |
| `Plugin/Randomness` | 原有随机能力 |
| `Plugin/TagFolder` | 原有标签整理能力 |
| `Plugin/VCPForum` | 原有论坛插件 |
| `Plugin/1PanelInfoProvider` | 原有运维信息插件 |
| `Plugin/FRPSInfoProvider` | 原有运维信息插件 |
| `Plugin/TencentCOSBackup` | 原有备份插件 |
| `Plugin/UserAuth` | 原有认证插件 |
| `Plugin/SkillBridge` | 原有技能仓库底座 |
| `Plugin/GitSearch` | Git 仓库搜索 |
| `Plugin/ImageProcessor` | 原有多模态预处理插件 |
| `Plugin/VCPTaskAssistant` | 原有任务派发中心 |
| `Plugin/ToolBoxFoldMemo` | 原有工具折叠底座 |
| `Plugin/LinuxShellExecutor` | 命令执行底座（Shell AI） |
| `Plugin/PowerShellExecutor` | 命令执行底座（Shell AI） |

## 2. 原作者改造

这些是原有插件上做的结构改造、合同调整或功能增强，不太适合算成全新自制。

| 插件 / 目录 | 这次变化 | 备注 |
| --- | --- | --- |
| `Plugin/DailyNoteManager` | manifest / 运行合同调整 | 日记管理合同升级 |
| `Plugin/DeepWikiVCP` | 入口和 manifest 改造 | 旧实现与新入口并存过一段 |
| `Plugin/ProjectAnalyst` | 配置与实现调整 | 仍是原有分析插件线 |
| `Plugin/RAGDiaryPlugin` | RAG 能力调整 | 原有知识库插件增强 |
| `Plugin/VSearch` | 配置、包、manifest 调整 | 搜索插件改造 |
| `Plugin/AgentAssistant/AgentAssistantConfig.json` | 新资产 | Agent 助手配置 |
| `Plugin/MCPO` | block manifest 迁移 | 迁移为可用 manifest |
| `Plugin/MCPOMonitor` | block manifest 迁移 | 迁移为可用 manifest |
| `Plugin/SynapsePusher` | block manifest 迁移 | 迁移为可用 manifest |
| `Plugin/vcp-dingtalk-adapter` | dingtalk 适配器线 | 更像分支改造资产 |
| `Plugin/RAGMonitor` | 监控脚本 | 更像配套改造脚本 |
| `Plugin/ProjectAnalyst/.gitignore` | 目录治理 | 不计入插件来源 |
| `routes/admin/dynamicTools.js` | 后台路由 | 动态工具管理 |
| `modules/dynamicToolRegistry.js` | 工具注册 | 动态工具注册与调度 |
| `ToolConfigs/dynamic_tool_bridge.config.json` | 配置 | 动态工具桥配置 |
| `AdminPanel-Vue/src/views/DynamicToolsManager.vue` | 管理页 | 动态工具管理视图 |
| `tests/dynamicToolRegistry.test.js` | 测试 | 动态工具注册测试 |

## 3. 我们自制

这些更接近这条分支线里真正新增出来的能力，适合算进“稳定生产线”候选。

| 插件 / 目录 | 类型 | 备注 |
| --- | --- | --- |
| `modules/channelHub/*` | 核心运行时 | ChannelHub 主体 |
| `Plugin/WeeklyReportGenerator` | 我们这条线新增/改造 | 周报链路升级，先按分支资产处理 |
| `routes/admin/channelHub.js` | 后台路由 | ChannelHub 管理面 |
| `routes/internal/channelHub.js` | 内部路由 | ChannelHub 内部接口 |
| `routes/admin/mediaGateway.js` | 后台路由 | 媒体网关管理 |
| `routes/toolExecutionRoutes.js` | 兼容路由 | 启动缺口修复用 |
| `AdminPanel/channelHub.html` | 管理页 | ChannelHub UI |
| `AdminPanel/js/channelHub/*` | 管理页脚本 | ChannelHub 前端逻辑 |
| `Plugin/DingTalkTable` | 新插件 | 钉钉表格能力 |
| `Plugin/WorkLogScheduler` | 新插件 | 工作日志调度 |
| `Plugin/vcp-onebot-adapter` | 新插件 | OneBot 适配器 |
| `Plugin/vcp-wecom-adapter` | 新插件 | 企业微信适配器 |
| `Plugin/vcp-feishu-adapter` | 新插件 | 飞书适配器 |
| `tests/channelHub-hardening.test.js` | 测试 | ChannelHub 回归测试 |

## 4. Photo Studio 线

这些不是单个插件来源的简单分类，而是一整条业务线资产，建议单独看待。

- `modules/photoStudio/`
- `Plugin/PhotoStudioCustomerRecord`
- `Plugin/PhotoStudioProjectRecord`
- `Plugin/PhotoStudioProjectStatus`
- `Plugin/PhotoStudioProjectTasks`
- `Plugin/PhotoStudioDeliveryTasks`
- `Plugin/PhotoStudioDeliveryQueue`
- `Plugin/PhotoStudioDeliveryAuditTrail`
- `Plugin/PhotoStudioDeliveryOperatorReport`
- `Plugin/PhotoStudioReplyDraft`
- `Plugin/PhotoStudioExternalSync`
- `Plugin/PhotoStudioQueueScheduler`
- `Plugin/PhotoStudioSelectionNotice`
- `Plugin/PhotoStudioFollowupReminder`
- `Plugin/PhotoStudioWeeklyProjectDigest`
- `Plugin/PhotoStudioContentPool`
- `Plugin/PhotoStudioAssetArchive`
- `Plugin/PhotoStudioCalendarSync`
- `Plugin/PhotoStudioFieldAudit`
- `Plugin/PhotoStudioCaseContentDraft`
- `Plugin/PhotoStudioDeliveryPriority`
- `plugins/custom/shared/photo_studio_data/PhotoStudioDataStore.js`

## 5. 其他文件夹

这些是文件夹级资产，不适合放回“单个插件来源”里看。

| 文件夹 | 归类 | 备注 |
| --- | --- | --- |
| `modules/SSHManager/` | 命令执行底座 | Shell AI / 远程命令执行共享 SSH 管理 |
| `modules/codexMemory*` | 记忆桥接层 | Codex 记忆检索、概览、常量、适配 |
| `modules/vcpLoop/` | 工具调用循环 | 工具调用解析与执行闭环 |
| `modules/handlers/` | 请求处理层 | 流式/非流式处理器 |
| `routes/admin/` | 管理面路由 | 管理面、插件、日记、任务、系统、动态工具等接口 |
| `routes/internal/` | 内部路由 | 内部调用和通道接口 |
| `AdminPanel/` | 旧管理前端 | 通道页和相关脚本 |
| `AdminPanel-Vue/` | 新管理前端 | Vue 管理面与视图层 |
| `Agent/` | 角色资产 | 各角色提示词与治理资产 |
| `TVStxt/` | 提示词/变量资产 | 各种 TVS/工具箱文本模板 |
| `docs/` | 文档治理层 | 架构、操作、路线图、照片业务文档等 |
| `plugins/custom/shared/` | 共享数据层 | 跨插件共享的业务数据与存储脚本 |

## 6. 稳定生产线最终版

如果需要先圈一条“稳定生产线”，建议先用这组：

- `modules/channelHub/`
- `modules/channelHub/*`
- `modules/dynamicToolRegistry.js`
- `routes/admin/channelHub.js`
- `routes/internal/channelHub.js`
- `routes/admin/dynamicTools.js`
- `Plugin/vcp-onebot-adapter`
- `Plugin/vcp-wecom-adapter`
- `Plugin/vcp-feishu-adapter`
- `Plugin/vcp-dingtalk-adapter`

## 7. 暂不定

| 插件 / 目录 | 暂不定原因 | 后续处理建议 |
| --- | --- | --- |
| `Plugin/DynamicToolBridge` | 此前确认不是自制资产，来源归属还没完全坐实 | 可先保留为“非自有/待确认” |

## 8. 额外建议

- 如果需要把“稳定生产线”单独圈出来，优先放：
  - 见上面的“稳定生产线最终版”
- 如果需要把“自制功能和插件”单独圈出来，优先放：
  - `Plugin/DingTalkTable`
  - `Plugin/WorkLogScheduler`
  - `AdminPanel/channelHub.html`
  - `AdminPanel/js/channelHub/*`
  - `AdminPanel-Vue/src/views/DynamicToolsManager.vue`
