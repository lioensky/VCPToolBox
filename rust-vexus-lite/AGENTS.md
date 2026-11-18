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

## 本地向量平台，用于调用本地向量探针

本地 Python 谷歌向量化探针交付，供 VCP 开发实验使用；不要与后端 payembeddingserver:3286 混淆。
脚本：H:\VCP\VCPMain\google-embedding-2-dev\embed.py
最短命令：
python "H:\VCP\VCPMain\google-embedding-2-dev\embed.py" --text "苹果" --dimensions 3072 --execute --out .\apple-vector.json
Python 标准库零 pip 依赖；默认调用 %LOCALAPPDATA%\VCP-CLI\pay-v0.30.0\pay.exe，可通过 --pay 或 PAY_EXE 指定程序，--account 指定已有钱包。
正式版 gemini-embedding-2 写死(和数据库对应)，无其他模型回退。--dimensions 必填且校验返回长度；不自动归一化、不切块、不重试。--file 读取整份 UTF-8 文件。输出 embedding 数组、请求模型、维度、输入哈希及上游用量（如有）；若上游未返回模型身份，不能独立证明其实际执行模型。
实测：本地“苹果”成功返回 3072 维。关键故障修复：file 存储与授权策略独立；原账户 keystore:file / auth_required:true 仍触发不可用的 Windows Hello。经莱恩授权、备份后，仅将目标实验钱包 auth_required 改为 false，调用成功。此设置允许自动签名，不应存重要资产。
网关目录与实时报价为零，但 MPP session 挑战声明最低/建议预存 0.25 USDC；不能等同于每次调用扣费，也未核实最终结算成本。
中文经 PowerShell 管道传给 Node 曾出现输出差异疑点；用 Unicode 转义固定“苹果”字节后，两次串行请求的 3072 分量完全一致、余弦为1。探针实验应固定编码、模型、维度和任务参数，不将测试链路误差归因于模型。