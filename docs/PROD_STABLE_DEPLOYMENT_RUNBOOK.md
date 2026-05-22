# prod/stable 服务区部署 Runbook

**适用范围：** 从 `prod/stable` 或稳定 tag 部署 VCPToolBox 到服务区
**当前稳定锚点：** `prod-stable-2026-04-28-baseline` -> `b9a1a2b139a1c64856e123d7f0495e336a3349a6`
**默认原则：** 先备份、再验证、后切流量；默认不开生产 Flag；不把服务区运行态回流到 Git

---

## 1. 部署前决策

部署前先确认三件事：

1. 本次部署目标是 `prod/stable`，不是开发分支。
2. 本次部署是否需要开启生产 Flag。默认答案应为“不需要”。
3. 是否已经准备好回滚点。当前推荐回滚点是 `prod-stable-2026-04-28-baseline`。

需要人工明确确认后才允许做的事：

- 开启 `ENABLE_AI_IMAGE_AGENTS_ROUTE`
- 开启 `ENABLE_AI_IMAGE_REAL_EXECUTION`
- 开启 `AIGENT_PIPELINE_ALLOW_EXECUTION`
- 运行 `npm run dws:*`
- 推送镜像、部署到公网、切正式流量
- 修改真实密钥、真实 `config.env` 或服务区数据

---

## 2. 服务区预检

在服务区运行前，先记录当前状态，便于回滚和复盘：

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
node --version
npm --version
```

如果服务区已经有正在运行的旧实例，额外记录：

```powershell
pm2 list
docker compose ps
```

检查真实配置文件时只确认“是否存在”和“关键项是否设置”，不要把密钥值打印到日志、聊天、Issue 或 PR 中。

---

## 3. 备份清单

部署前至少备份这些内容：

| 类型 | 示例 | 说明 |
|------|------|------|
| 真实配置 | `config.env`、插件私有 `config.env` | 只备份到服务区安全位置，不提交 Git |
| 运行数据 | `dailynote/`、向量库、运行数据库 | 需要保留原目录权限和时间戳 |
| 生成资源 | `image/`、插件缓存、用户上传内容 | 根据实际使用情况选择 |
| 进程状态 | PM2 进程名、Docker compose 项目名 | 用于快速恢复旧版本 |

不要用 `git clean -fdx`、`git reset --hard` 或递归删除命令处理服务区目录，除非已经有完整备份且得到明确确认。

---

## 4. 获取稳定线

推荐使用干净部署目录：

```powershell
git fetch origin prod/stable --tags
git switch prod/stable
git pull --ff-only origin prod/stable
git rev-parse HEAD
```

确认输出 commit 是当前稳定线：

```text
b9a1a2b139a1c64856e123d7f0495e336a3349a6
```

如果需要部署固定锚点而不是分支头，可以使用：

```powershell
git fetch origin prod-stable-2026-04-28-baseline
git switch --detach prod-stable-2026-04-28-baseline
```

固定 tag 部署更利于复现；分支部署更适合持续跟随 `prod/stable`。

---

## 5. 配置审计

部署前确认：

- `config.env` 来自服务区安全存储，不来自 Git。
- `.env*` 没有被 Git 跟踪。
- 插件私有配置没有提交到仓库。
- `DebugMode=false`。
- `CHAT_LOG_ENABLED=false`，除非本次有明确审计需求。
- AI Image 真执行和管理路由 Flag 默认保持关闭。
- DingTalk 真实写入脚本不在部署流程中自动运行。

可用只读检查：

```powershell
git ls-files config.env .env .env.local
git ls-files "Plugin/*/config.env"
```

这些命令应当没有真实配置文件输出。

---

## 6. 本地验证矩阵

服务区部署前建议至少运行：

```powershell
npm ci
npm run test:baseline
npm test
npm run test:photo-studio
npm run test:dingtalk-cli
```

按部署形态补充：

```powershell
npm run build:admin
```

```powershell
Set-Location rust-vexus-lite
npm run build
Set-Location ..
```

如果使用 Docker：

```powershell
docker compose build
```

不要在默认部署验证里运行 `npm run dws:baseline`、`npm run dws:matrix`、`npm run dws:workflow` 或 `npm run dws:calibrate`。这些命令连接真实外部服务，必须单独确认。

---

## 7. 启动路径

### PM2 路径

先确认旧进程名：

```powershell
pm2 list
```

启动或重启前确认 `config.env` 已就位，并按已登记进程名执行受控启动/重启：

```powershell
pm2 start server.js --name <EXISTING_PM2_PROCESS_NAME>
# 或（进程已存在时）
pm2 restart <EXISTING_PM2_PROCESS_NAME>
pm2 list
```

生产环境如果使用 PM2，应按服务区已有进程名执行受控重启，并保留旧版本回滚目录。不要在不知道进程名的情况下批量停止所有 PM2 进程。

### Docker 路径

Docker 路径建议先 build，不 push：

```powershell
docker compose build
docker compose up -d
docker compose ps
```

如果 compose 文件挂载了大范围宿主目录，先确认挂载源目录是服务区数据目录，不是开发工作区临时目录。

---

## 8. 启动后 smoke check

启动后先做内网只读检查，不立即切正式流量：

```powershell
pm2 list
docker compose ps
```

如果服务端口可访问，检查生命周期接口：

```powershell
curl http://127.0.0.1:<PORT>/admin_api/server/lifecycle
```

观察内容：

- 服务进程没有反复重启。
- 插件加载没有密集报错。
- 管理面板静态资源能返回。
- 核心对话接口只在明确授权后测试，避免误触发外部模型或工具写入。
- DingTalk、AI Image、远程工具执行保持默认关闭或 dry-run。

建议观察窗口：

- 首次启动后 10 分钟看进程稳定性。
- 切小流量后 30 分钟看错误率和日志。
- 全量前确认回滚命令仍可执行。

---

## 9. 回滚路径

优先回滚到稳定 tag：

```powershell
git fetch origin prod-stable-2026-04-28-baseline
git switch --detach prod-stable-2026-04-28-baseline
npm ci
```

然后按原部署形态恢复：

```powershell
pm2 restart <EXISTING_PM2_PROCESS_NAME>
pm2 list
```

或：

```powershell
docker compose build
docker compose up -d
docker compose ps
```

如果故障涉及数据写入，先停止继续写入，再恢复备份。不要直接覆盖运行数据目录，除非已经确认备份版本、目标目录和回滚影响。

---

## 10. 发布记录模板

每次部署都记录：

```text
Date:
Operator:
Target:
Commit:
Tag:
Deploy mode:
Config source:
Production flags enabled:
Validation run:
Skipped validation:
Backup location:
Rollback target:
Smoke result:
Remaining risk:
```

示例：

```text
Target: prod/stable
Commit: b9a1a2b139a1c64856e123d7f0495e336a3349a6
Tag: prod-stable-2026-04-28-baseline
Production flags enabled: none
Validation run: npm run test:baseline, npm test, npm run test:photo-studio, npm run test:dingtalk-cli, docker compose build
Skipped validation: dws real-service scripts
Rollback target: prod-stable-2026-04-28-baseline
```
