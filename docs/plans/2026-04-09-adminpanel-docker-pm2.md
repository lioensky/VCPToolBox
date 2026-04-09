# AdminPanel Docker PM2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Docker 部署下的 `server.js` 与 `adminServer.js` 在同一容器中被稳定托管，恢复 `6005` 主服务与 `6006` AdminPanel 的双端口可用性。

**Architecture:** 保持现有单容器结构不变，引入 `pm2-runtime + ecosystem.config.js` 统一托管双进程。`server.js` 继续提供主 API 与 `/admin_api/*`，`adminServer.js` 继续提供 `PORT+1` 的 AdminPanel 页面并通过 `127.0.0.1:${MAIN_PORT}` 访问主服务。

**Tech Stack:** Node.js, PM2, Docker, Docker Compose, Express

---

### Task 1: 固化 PM2 双进程启动配置

**Files:**
- Create: `ecosystem.config.js`
- Modify: `Dockerfile`

**Step 1: 创建 PM2 ecosystem 配置文件**

创建 `ecosystem.config.js`，定义两个 app：

```js
module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
      cwd: '/usr/src/app',
      autorestart: true,
      watch: false
    },
    {
      name: 'vcp-admin',
      script: 'adminServer.js',
      cwd: '/usr/src/app',
      autorestart: true,
      watch: false
    }
  ]
};
```

**Step 2: 修改 Dockerfile 默认启动命令**

将默认 `CMD` 从：

```dockerfile
CMD [ "node_modules/.bin/pm2-runtime", "start", "server.js" ]
```

改为：

```dockerfile
CMD [ "node_modules/.bin/pm2-runtime", "start", "ecosystem.config.js" ]
```

并同步补充：

```dockerfile
EXPOSE 6005
EXPOSE 6006
```

**Step 3: 检查镜像内 `ecosystem.config.js` 被复制**

如果 Dockerfile 当前仅复制 `*.js` 根文件，确认 `ecosystem.config.js` 会被一并包含；若复制规则不覆盖，则显式添加 `COPY ecosystem.config.js ./`。

**Step 4: 进行最小验证**

运行：

```bash
docker compose build
```

预期：镜像可成功构建，无 `ecosystem.config.js not found` 错误。

### Task 2: 修正 Compose 双端口与启动方式

**Files:**
- Modify: `docker-compose.yml`

**Step 1: 暴露 AdminPanel 端口**

确保 `ports` 包含：

```yml
ports:
  - "6005:6005"
  - "6006:6006"
```

**Step 2: 删除不稳定的 shell 后台命令**

删除类似：

```yml
command: sh -c "node server.js & node adminServer.js & wait -n"
```

让 Compose 回退到 Dockerfile 中的 `CMD`，或显式改为：

```yml
command: ["node_modules/.bin/pm2-runtime", "start", "ecosystem.config.js"]
```

优先推荐不写 `command`，保持 Dockerfile 与 Compose 行为一致。

**Step 3: 重建并启动容器**

运行：

```bash
docker compose down
docker compose up --build -d
```

预期：容器启动成功，不进入异常频繁重启状态。

### Task 3: 验证双进程是否都被托管

**Files:**
- No code changes

**Step 1: 查看容器状态**

运行：

```bash
docker compose ps
docker compose logs --tail=200
```

预期：

- 容器处于 `Up`
- 日志中能看到 `vcp-main` 与 `vcp-admin` 均已启动

**Step 2: 在容器内检查监听端口**

运行：

```bash
docker compose exec app sh -c "ss -tlnp | grep 600"
```

预期：

- `6005` 被监听
- `6006` 被监听

**Step 3: 如果某个进程未起来，单独看 PM2 状态**

运行：

```bash
docker compose exec app sh -c "node_modules/.bin/pm2 list"
docker compose exec app sh -c "node_modules/.bin/pm2 logs --lines 100"
```

预期：能够定位是 `server.js` 还是 `adminServer.js` 启动失败。

### Task 4: 验证主服务 API 恢复

**Files:**
- No code changes

**Step 1: 验证模型列表接口**

运行：

```bash
curl -i "http://127.0.0.1:6005/v1/models"
```

预期：返回非连接失败；允许出现鉴权或业务层响应，但不能是 `Connection refused`。

**Step 2: 验证聊天接口监听**

运行：

```bash
curl -i "http://127.0.0.1:6005/v1/chat/completions"
```

预期：返回非连接失败；允许出现 `401/405/400` 等业务相关响应。

**Step 3: 验证 VCPChat 配置无需变更**

确认客户端继续使用：

```text
http://<host>:6005/v1/chat/completions
```

预期：模型列表与聊天连接恢复。

### Task 5: 验证 AdminPanel 跳转链路恢复

**Files:**
- No code changes

**Step 1: 验证主端口跳转**

运行：

```bash
curl -I "http://127.0.0.1:6005/AdminPanel/index.html"
```

预期：`302`，且 `Location` 指向 `:6006/AdminPanel/index.html`。

**Step 2: 验证面板端口页面可达**

运行：

```bash
curl -I "http://127.0.0.1:6006/AdminPanel/index.html"
```

预期：返回页面相关响应，不再是连接失败。

**Step 3: 验证外部访问**

从宿主机或外部机器验证：

```bash
curl -I "http://<server-ip>:6006/AdminPanel/index.html"
```

预期：可访问；若宿主机可访问但外部不可访问，则转入防火墙/安全组排查，不回退代码。

### Task 6: 更新部署文档

**Files:**
- Modify: `README.md`

**Step 1: 更新 Docker 部署说明**

在 Docker 相关章节补充：

- Docker 下需要同时暴露主端口与 AdminPanel 端口
- 默认运行结构为单容器双进程，由 PM2 托管
- `VCPChat` 继续连接 `6005`
- `AdminPanel` 页面走 `6006`，主端口访问 `/AdminPanel` 会自动跳转

**Step 2: 明确故障排查命令**

补充示例命令：

```bash
docker compose ps
docker compose logs -f
docker compose exec app sh -c "node_modules/.bin/pm2 list"
docker compose exec app sh -c "ss -tlnp | grep 600"
```

### Task 7: 最终回归验证

**Files:**
- No code changes

**Step 1: 复查变更范围**

运行：

```bash
git diff -- Dockerfile docker-compose.yml ecosystem.config.js README.md
```

预期：只包含预期部署与文档改动。

**Step 2: 手工回归**

验证：

- `VCPChat` 模型列表可拉取
- `VCPChat` 聊天请求可连通
- `http://<server>:6006/AdminPanel/` 可访问
- `http://<server>:6005/AdminPanel/` 可自动跳转

**Step 3: 记录仍存在的架构债**

在交付说明中明确：

- 当前仍为单容器双进程
- 如后续要拆成双容器，需先改 `adminServer.js` 内对 `127.0.0.1:${MAIN_PORT}` 的依赖
