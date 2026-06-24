# Plugin 目录知识库

## 概览

Plugin/ 是 VCPToolBox 的核心能力扩展层。所有插件行为由 plugin-manifest.json
声明式驱动，支持 6 种类型（static / synchronous / asynchronous / service /
messagePreprocessor / hybridservice）和 3 种执行模式（stdio / direct / distributed）。
插件运行规则由根层 Plugin.js 统一编排。

## 开工前必读

| 任务 | 文档 |
|------|------|
| 理解插件协议与类型 | docs/PLUGIN_ECOSYSTEM.md §1-3 |
| 理解配置级联机制 | docs/PLUGIN_ECOSYSTEM.md §4 |
| 写一个新插件 | docs/VCP同步异步插件开发手册.md |
| 理解生命周期与执行模式 | docs/PLUGIN_ECOSYSTEM.md §5-6 |
| 接入向量/RAG 能力 | docs/CONTEXT_BRIDGE.md |
| 注册 API 路由 | docs/API_ROUTES.md + PLUGIN_ECOSYSTEM.md §2.4 |
| 全局配置参数 | docs/CONFIGURATION.md |

## 目录结构

```text
Plugin/
├── <PluginName>/
│   ├── plugin-manifest.json      # 启用态（必需）
│   ├── plugin-manifest.json.block # 禁用态
│   ├── config.env                 # 私密配置（勿提交）
│   ├── config.env.example         # 配置模板（提交）
│   └── ...源码
```

## 开发规范

- manifest 必选字段：name, pluginType, entryPoint, communication
- 目录命名以 PascalCase 为主
- synchronous 插件返回格式：{ status, result, error, messageForAI }
- 推荐采用 content 数组格式返回（详见开发手册 §3.3）

## 常用命令

- 安装依赖：`cd Plugin/<Name> && npm install`
- 测试插件：`echo '{"arg":"val"}' | node <Entry>.js`
- 禁用插件：重命名 `plugin-manifest.json` → `.json.block`
- 启用插件：重命名 `.json.block` → `plugin-manifest.json`
- 热重载：manifest 文件变更自动触发（direct 协议除外）

## 开发规范与常见陷阱

- 如需使用 API 密钥，写入 config.env 并在 configSchema 中声明类型；
  不要在 manifest 或源码中硬编码。
- 如需扩展 manifest 字段，先查 Plugin.js 是否有对应处理逻辑；
  不要引入加载器未支持的自定义字段并假设生效。
- 如需判断插件运行时，检查 entryPoint.type（nodejs / python / native）；
  不要假设所有插件都是 Node。
- 如需启用已禁用插件，先核对 config.env.example 中所有必需项已配置；
  不要盲目重命名 .block 文件。
- 如需切换 entryPoint 形态（command ↔ script），先确认 Plugin.js 的
  executePlugin（stdio）或 processToolCall（direct）分支与之匹配。
- 如需输出调试信息，使用 stderr（console.error）；
  stdout 仅输出标准 JSON 结果。

## 安全边界

- 如需修改 config.env 或密钥配置，向项目维护者确认后操作。
- 如需执行批量文件删除或目录重命名，先说明影响范围和回退方案。
- 如需变更认证/权限逻辑，列出受影响的调用链后再动手。