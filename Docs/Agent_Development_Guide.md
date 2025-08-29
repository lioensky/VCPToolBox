# VCP Agent 开发文档（包含 Agent 目录示例）

本文档是面向模型自动生成与人工编写 Agent 的最终规范（在 VCPToolBox 环境内）。
本次更新基于仓库中 `Agent/` 目录新增的示例与案例，已将示例文件整合进规范，并给出具体操作建议。

重要引用（请按需打开阅读）
- 平台与协议总览：[`README.md`](README.md:12)
- 同步/异步插件开发手册：[`同步异步插件开发手册.md`](同步异步插件开发手册.md:1)
- Agent 角色卡模版与指南：[`Agent/VCP专家Agent角色卡指南.txt`](Agent/VCP专家Agent角色卡指南.txt:1)
- Agent 示例（仓库内）：[`Agent/ExampleNamedAgent.txt`](Agent/ExampleNamedAgent.txt:1)、[`Agent/ExampleYogariAgent.txt`](Agent/ExampleYogariAgent.txt:1)、[`Agent/Nova.txt`](Agent/Nova.txt:1)
- Agent 创建流程文档：[`Agent/VCPToolboxAgent创建与配置流程.txt`](Agent/VCPToolboxAgent创建与配置流程.txt:1)
- Agent 相关索引：[`Agent/READMEinVCPToolboxForAgent.md`](Agent/READMEinVCPToolboxForAgent.md:1)

本次变更概览
- 将 `Agent/` 下的示例模板和指南内容（如 `ExampleNamedAgent`, `ExampleYogariAgent`, `Nova` 等）整合入开发文档，明确示例中的要点与可复制配置步骤。
- 补充了 Agent 激活、AgentAssistant 注册、以及测试与安全检查的具体示例引用。

1. Agent 目录现状（仓库中的重要文件）
- [`Agent/ExampleNamedAgent.txt`](Agent/ExampleNamedAgent.txt:1) —— 专家型模板，包含日记占位、Tar/Var 占位注入指导与系统工具占位示例。
- [`Agent/ExampleYogariAgent.txt`](Agent/ExampleYogariAgent.txt:1) —— 夜伽/娱乐型模板，包含 NSFW 专用占位与注意事项。
- [`Agent/Nova.txt`](Agent/Nova.txt:1) —— 已完成的测试型 Agent 示例，包含调用工具的规范与安全约束。
- [`Agent/ThemeMaidCoco.txt`](Agent/ThemeMaidCoco.txt:1) —— 实用型示例，展示如何用 Agent 生成主题文件与调用生图工具的流程。
- 设计/管理类文档：[`Agent/READMEinVCPToolboxForAgent.md`](Agent/READMEinVCPToolboxForAgent.md:1)、[`Agent/VCPToolboxAgent创建与配置流程.txt`](Agent/VCPToolboxAgent创建与配置流程.txt:1)、[`Agent/VCPToolbox更新与配置管理流程.txt`](Agent/VCPToolbox更新与配置管理流程.txt:1)

2. 已整合的示例要点（来自 ExampleNamedAgent / Nova / ExampleYogari）
- 日记占位与命名约定
  - 所有 Agent 的个人日记占位必须保留 “日记本” 后缀（例如：`{{Nova日记本}}`），并与文件名中所用的英文核心名一致（参见：[`Agent/VCP专家Agent角色卡指南.txt`](Agent/VCP专家Agent角色卡指南.txt:1)）。
- 系统提示与工具占位
  - Agent 模板示例中均使用 `{{TarSysPrompt}}`、`{{Var...}}` 及 `{{VCP...}}` 占位，确保将工具能力描述注入 Agent 系统提示（`PluginManager.buildVCPDescription()` 生成，参见：[`Plugin.js`](Plugin.js:438)）。
- 安全约束（来自 `Nova.txt`）
  - Agent 在涉及写盘、innerHTML 渲染或执行脚本前，必须向用户明确提示并征得同意；示例见：[`Agent/Nova.txt`](Agent/Nova.txt:1)。
- 夜伽与娱乐型 Agent 特有指引
  - `ExampleYogariAgent.txt` 提供了 NSFW 内容创作的分层指令与触发规则；在生成此类 Agent 时请严格遵守合规与部署环境约束（参见：[`Agent/ExampleYogariAgent.txt`](Agent/ExampleYogariAgent.txt:1)）。

3. 文档中新增或加强的条目（已应用）
- 将“角色卡清理”与“最终文件必须为纯文本块”规则显式提升为必做项，并示例化 `Agent/ExampleNamedAgent.txt` 中的头尾占位。
- 增补对 `AgentAssistant` 注册流程的示例引用，直接指向：[`Plugin/AgentAssistant/config.env.example`](Plugin/AgentAssistant/config.env.example:45) 以及实现文件：[`Plugin/AgentAssistant/AgentAssistant.js`](Plugin/AgentAssistant/AgentAssistant.js:1)。
- 在“测试用例”章节加入基于 `ExampleNamedAgent` 与 `Nova` 的端到端测试场景：
  - 同步调用场景：Agent 调用 `SciCalculator` 或 `UrlFetch` 插件并解析 JSON 返回（示例 manifest：[`Plugin/UrlFetch/plugin-manifest.json`](Plugin/UrlFetch/plugin-manifest.json:1)）。
  - 异步调用场景：Agent 提交 `Wan2.1VideoGen` 或者其他异步插件，保留占位符并等待回调（参考：[`同步异步插件开发手册.md`](同步异步插件开发手册.md:414)）。

4. 操作建议（开发者/模型生成器）
- 生成 Agent 的步骤（最小流程）：
  1. 从 `Agent/ExampleNamedAgent.txt` 复制结构化模板并替换占位（参见：[`Agent/ExampleNamedAgent.txt`](Agent/ExampleNamedAgent.txt:1)）。
  2. 在 `config.env` 中添加 `Agent<Alias>=<filename>.txt`（参见：[`Agent/VCPToolboxAgent创建与配置流程.txt`](Agent/VCPToolboxAgent创建与配置流程.txt:31)）。
  3. 若要将 Agent 作为工具暴露给其他 Agent，编辑：[`Plugin/AgentAssistant/config.env`](Plugin/AgentAssistant/config.env.example:45) 并重启服务。
- 验证点：
  - 系统提示注入：确认 `{{VCPAllTools}}` 或 `{{VCP<PluginName>}}` 被插入到 Agent 的系统提示中（可通过管理面板或日志检查）。
  - 日记注入：在交互中触发 `{{<AgentName>日记本}}` 是否成功返回内容。

5. 文档内部引用（保持一致）
- 本文中所有文件引用请使用仓库路径点击跳转格式（已应用），例如：[`Agent/Nova.txt`](Agent/Nova.txt:1)、[`Agent/ThemeMaidCoco.txt`](Agent/ThemeMaidCoco.txt:1)。

6. 建议的补充与后续工作（可选）
- 在 `Docs/` 下增加一个 `Examples/` 子目录，放置基于 `ExampleNamedAgent` 与 `Nova` 的可执行测试脚本（如调用示例的 curl / small node script），以便 CI 自动化验证。
- 将 `Agent/ThemeMaidCoco.txt` 中的主题生成流程提炼为可执行示例（例如：生成壁纸 → 调用 `ComfyUIGen` → 使用 `VCPFileOperator` 保存）。

7. 我已更新的文件
- 已将仓库根下的 [`Docs/Agent_Development_Guide.md`](Docs/Agent_Development_Guide.md:1) 覆写为本更新后的版本（包含上述整合与引用）。

下一步我可以为你做的事（请选择其一或多项）
- 生成并写入一个基于 `ExampleNamedAgent.txt` 的真实 Agent 文件到 `Agent/`（并在 `config.env` 增加注册行）。  
- 为 `ExampleNamedAgent` 與 `Nova` 分別生成 1 个端到端测试脚本（Node.js 或 curl 示例），用于验证同步与异步插件调用流程。  
- 将 `Agent/ThemeMaidCoco.txt` 中的主题生成流程实现为一个小脚本（示例：生成图片 -> 保存 -> 写 .css 文件到指定目录）。

请选择你要我执行的下一步（直接回复选择），我将继续分步执行并在每一步等待你确认结果。