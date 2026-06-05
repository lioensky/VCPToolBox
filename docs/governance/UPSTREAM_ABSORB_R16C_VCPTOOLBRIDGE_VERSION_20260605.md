# Upstream Absorb R16C VCPToolBridge Version Field - 2026-06-05

本文件记录 R16C 对 upstream commit `1fc2b56c feat(VCPToolBridge): 为插件信息添加版本号字段` 的拆包吸收结果。

本批是一个极窄 manifest 元数据包，不改变桥接执行分发。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `main` |
| 本地基线 | `ea2be412 Merge pull request #122 from JENN2046/codex/r16a-upstream-ignore-rules-20260605` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream commit | `1fc2b56c feat(VCPToolBridge): 为插件信息添加版本号字段` |
| 本地分支 | `codex/r16-candidate-classification-20260605` |

## 2. 吸收内容

| 文件 | 变更 |
|------|------|
| `Plugin/VCPToolBridge/index.js` | `handleGetManifests()` 导出的每个插件 manifest 增加 `version: plugin.version || "1.0.0"`。 |

## 3. 安全边界

- 不 raw merge `upstream/main`。
- 不改变 `PluginManager.processToolCall()` 调用参数或执行分发。
- 不改变 `execute_vcp_tool`、`vcp_tool_result`、`vcp_tool_status` 处理路径。
- 不启用桥接、不启动生产服务、不执行真实远端工具。
- 不修改 `.env`、`config.env`、真实凭据、运行态、缓存、日志或 operator 数据。

## 4. 验证

计划验证：

```powershell
node --check Plugin/VCPToolBridge/index.js
git diff --check
```

## 5. 结论

R16C 可以作为本地安全小包吸收。

该变更只增强 VCPToolBridge manifest 可观测性，便于下游识别插件版本；不扩大工具执行权限。
