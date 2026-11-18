# Docker Release Workflow

VCPToolBox 更新频率很高，不能在每次 `main` push 时都触发完整 Docker 多架构构建。当前 CI 采用“快速验证常态化、Docker 构建事件化”的策略。

## 触发规则

- `main` 分支普通 push：
  - 只执行 Node.js 依赖安装验证。
  - 不自动构建 Docker 镜像。
  - 同一分支的新提交会取消旧的未完成 CI，避免排队浪费。

- Pull Request：
  - 执行 Node.js 依赖安装验证。
  - 执行 `linux/amd64` Docker 构建验证，不推送镜像。
  - 用于提前发现 Dockerfile、原生依赖、系统依赖问题。

- tag `v*`：
  - 执行正式 Docker 发布。
  - 构建 `linux/amd64,linux/arm64` 多架构镜像。
  - 推送到 Docker Hub，并生成 semver / latest 标签。

- 手动 `workflow_dispatch`：
  - 可选择是否推送镜像。
  - 可选择构建平台。
  - 日常快速验证建议 `linux/amd64`。
  - 正式手动发布建议 `linux/amd64,linux/arm64`。

## Rust Vexus 编译策略

Dockerfile 会在镜像构建时编译 `rust-vexus-lite`，保证 native addon 与当前源码一致。

为避免每次普通文件变更都触发 Rust 全量重编，Dockerfile 先单独复制并编译以下文件：

- `rust-vexus-lite/package.json`
- `rust-vexus-lite/Cargo.toml`
- `rust-vexus-lite/build.rs`
- `rust-vexus-lite/src/**`

之后再复制全仓库源码，并用容器内现编的 `.node` 产物覆盖仓库中可能滞后的预编译文件。

这意味着：

- 修改 README、插件、图片、普通 JS 文件时，Rust 编译层可复用 Docker cache。
- 修改 `rust-vexus-lite/src/**` 或 Cargo/NAPI 配置时，才会重新编译 Vexus。
- CI 的 Buildx cache 会跨 workflow 尽量复用这些层。

## 推荐发布节奏

高频开发时只推 `main`，让 CI 做快速验证即可。

需要给 Docker 用户发布时再打版本 tag：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

如果需要临时手动构建，可在 GitHub Actions 页面运行 `CI & Docker Publish`，选择 `workflow_dispatch`。