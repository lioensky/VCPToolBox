# rust-vexus-lite 子项目知识库

## 概览
`rust-vexus-lite/` 是 Rust N-API 向量/索引子项目，为主 Node 运行时提供性能敏感路径（向量检索与相关计算）的原生能力。

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| 构建脚本 | `rust-vexus-lite/package.json` | `napi build` 发布/调试命令 |
| Rust 源码 | `rust-vexus-lite/src/` | 原生实现细节 |
| 包元数据 | `rust-vexus-lite/Cargo.toml` | 依赖与构建配置 |
| JS 加载边界 | `rust-vexus-lite/index.js` | 平台 `.node` 产物解析与导出 |
| 主调用入口 | `KnowledgeBaseManager.js` | 主运行时集成点 |

## 约定
- 使用 `@napi-rs/cli` 构建（`napi build --platform --release`）。
- Node 兼容范围以 `engines.node` 为准。
- 变更 Rust 导出接口时需保持 JS 侧 ABI/签名兼容。

## 反模式
- 不要修改原生导出符号/接口名而不同步更新 JS 调用方。
- 不要假设单平台构建，当前脚本包含多平台产物策略。
- 不要移除发布链路依赖的原生产物命名与加载约定。
- 不要修改 Rust 侧 DB 恢复/查询假设而不核对 `KnowledgeBaseManager` 调用路径。
