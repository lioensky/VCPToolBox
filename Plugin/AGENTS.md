# 插件目录知识库

## 概览
`Plugin/` 是本仓库规模最大的功能域，按 manifest 驱动插件加载与执行，覆盖 Node/Python/原生可执行等多种运行方式。插件运行规则由根层 `Plugin.js` 统一编排。

## 目录结构
```text
Plugin/
|- <PluginName>/plugin-manifest.json        # 启用态插件契约
|- <PluginName>/plugin-manifest.json.block  # 禁用态插件标记
|- <PluginName>/config.env.example          # 插件配置模板
|- <PluginName>/package.json                # 可选 Node 依赖与脚本
`- <PluginName>/requirements.txt            # 可选 Python 依赖
```

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| 理解插件协议字段 | `README.md`（开发者指南） | pluginType、entryPoint、capabilities 等规范 |
| 查看加载与执行流程 | `Plugin.js` | 插件发现、配置合并、调用分发 |
| 静态占位符样例 | `Plugin/WeatherReporter/plugin-manifest.json` | `systemPromptPlaceholders` + 定时刷新 |
| 同步/异步执行样例 | `Plugin.js` + 各插件 manifest | 超时、回调、返回结构 |
| hybrid/direct 样例 | `Plugin/ChromeBridge/plugin-manifest.json` | `hybridservice` + `direct` 协议 |
| 禁用插件处理 | `Plugin/*/plugin-manifest.json.block` | 当前约 8 个禁用插件 |

## 约定
- 启用插件必须使用 `plugin-manifest.json` 固定文件名。
- 需要禁用插件时使用 `.block` 后缀，不要删除 manifest。
- 优先提交 `config.env.example`，避免提交真实 `config.env` 私密值。
- `displayName`、`description`、`pluginType`、`entryPoint`、`communication`、`capabilities` 应保持一致且可解释。
- 插件构建脚本与依赖管理默认插件内自治，不强制单一 monorepo 构建规范。
- `synchronous` 插件数量最多，返回结构应对齐 stdio JSON 契约。
- 目录命名以 PascalCase 为主，新插件尽量沿用该风格。

## 已知例外
- `Plugin/UserAuth/plugin-manifest.json` 缺少 `version` 与 `communication`，属于历史兼容项。
- `Plugin/DailyNoteWrite/plugin-manifest.json` 为 `synchronous`，但未走常规 `invocationCommands` 形态。
- 少量插件 manifest 会省略 `capabilities`；不要直接用“一刀切” lint 规则强制失败。

## 反模式
- 不要在 manifest 或源码中硬编码密钥。
- 不要引入加载器未支持的自定义字段并假设会生效。
- 不要假设所有插件都是 Node 运行时（大量插件依赖 Python/原生二进制）。
- 不要在未核对依赖与配置前直接启用 `.block` 插件。
- 不要随意切换 `entryPoint` 形态（`command`/`script`），需先核对 `Plugin.js` 对应执行分支。
