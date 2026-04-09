# AdminPanel Docker PM2 Design

**背景**

提交 `275b366` 将 `AdminPanel` 从主进程中解耦出来：

- `server.js` 不再直接静态托管 `/AdminPanel/*`
- 主端口访问 `/AdminPanel/*` 会 302 跳转到 `PORT + 1`
- 新增 `adminServer.js` 作为独立后台管理进程

这套设计在本地双进程或 PM2 场景可工作，但仓库当前 Docker 默认部署仍然只围绕单进程 `server.js`：

- `Dockerfile` 默认 `CMD` 仅启动 `server.js`
- `docker-compose.yml` 默认只映射 `6005:6005`
- 没有为 `adminServer.js` 提供稳定的进程托管

因此线上在采用 `275b366` 后，容易出现以下问题：

- `6005/AdminPanel/*` 跳转到 `6006` 后不可达
- 为了临时托管两个进程而使用 `sh -c "node server.js & node adminServer.js & wait -n"` 时，任一进程退出会导致整个容器生命周期异常
- 主服务 `6005` 不稳定时，`VCPChat` 的 `/v1/chat/completions` 与 `/v1/models` 也会同时失效

**目标**

- 让 `6005` 的主服务稳定提供 `v1/chat/completions`、`v1/models` 与 `/admin_api/*`
- 让 `6006` 稳定提供 `AdminPanel` 页面
- 保持 `6005/AdminPanel/* -> 6006` 的自动跳转语义
- 不修改 `VCPChat` 的服务器配置格式
- 不要求本次重构 `adminServer.js` 的跨容器代理逻辑

**现状约束**

- `adminServer.js` 当前通过 `http://127.0.0.1:${MAIN_PORT}` 转发部分 `/admin_api/*` 请求到主服务
- 这意味着 `server.js` 与 `adminServer.js` 默认假设运行在同一个容器/同一网络命名空间中
- 如果直接拆成两个 Docker service，则 `127.0.0.1` 指向各自容器自己，当前实现会失效

**方案评估**

方案 A：单容器 + shell 后台命令

- 形式：`sh -c "node server.js & node adminServer.js & wait -n"`
- 优点：临时改动最少
- 缺点：脆弱。任一子进程退出都会使主命令结束，容器随之重启；信号转发、退出管理、日志治理都差
- 结论：不采用

方案 B：单容器 + `pm2-runtime`

- 形式：通过 PM2 ecosystem 在一个容器内托管 `server.js` 与 `adminServer.js`
- 优点：与当前代码结构匹配，不需要先改 `adminServer.js` 的 `127.0.0.1` 假设；进程托管、拉起与日志明显优于 shell 后台方式
- 缺点：仍是单容器多进程，不是最纯粹的 Docker 风格
- 结论：本次采用

方案 C：双容器拆分

- 形式：`vcp-main` 与 `vcp-admin` 两个 service
- 优点：职责最清晰，生命周期完全独立
- 缺点：需要修改 `adminServer.js` 中所有转发主服务的地址，改为可配置内部服务地址，例如 `MAIN_SERVER_INTERNAL_URL`
- 结论：作为后续架构优化，不在本次范围

**最终设计**

采用方案 B：单容器 + `pm2-runtime` 双进程托管。

具体设计如下：

1. 保持主服务职责不变

- `server.js` 继续监听 `PORT`
- 继续提供：
  - `/v1/chat/completions`
  - `/v1/models`
  - `/admin_api/*`
- 继续将 `/AdminPanel/*` 302 到 `PORT + 1`

2. 保持后台面板职责不变

- `adminServer.js` 继续监听 `PORT + 1`
- 继续静态托管 `/AdminPanel/*`
- 继续本地处理一部分轻量 `/admin_api/*`
- 继续通过 `127.0.0.1:${MAIN_PORT}` 转发依赖主进程运行态的接口

3. Docker 启动模型改为 PM2 托管

- 新增 `ecosystem.config.js`
- 由 `pm2-runtime` 同时启动：
  - `vcp-main -> server.js`
  - `vcp-admin -> adminServer.js`
- 避免使用 shell 后台命令

4. Docker 端口暴露修正

- `docker-compose.yml` 暴露：
  - `6005:6005`
  - `6006:6006`
- `Dockerfile` 可同步补充 `EXPOSE 6006`
- `EXPOSE` 不是功能前提，但作为镜像元数据应与部署保持一致

5. VCPChat 兼容性策略

- `VCPChat` 继续配置主服务地址为 `http://host:6005/v1/chat/completions`
- 不改为 `6006`
- `VCPChat` 中基于主端口派生 `/admin_api/*` 的逻辑保持不变
- 若存在“打开管理面板”入口，应继续优先打开主端口 `/AdminPanel`，由后端跳转，不在客户端硬编码 `+1`

**需要修改的文件**

- 修改：`Dockerfile`
- 修改：`docker-compose.yml`
- 新增：`ecosystem.config.js`
- 修改：`README.md`

**验证标准**

- 容器启动后，`6005` 和 `6006` 均处于监听状态
- `curl http://127.0.0.1:6005/v1/models` 可返回正常 HTTP 响应
- `curl http://127.0.0.1:6005/v1/chat/completions` 至少不再是连接失败
- `curl -I http://127.0.0.1:6005/AdminPanel/index.html` 返回 302，目标为 `:6006`
- `curl -I http://127.0.0.1:6006/AdminPanel/index.html` 可返回页面相关响应
- `VCPChat` 继续使用 `6005` 配置即可拉取模型并发起请求

**非目标**

- 本次不将 `server.js` 与 `adminServer.js` 拆分为两个 Docker service
- 本次不改造 `adminServer.js` 的跨容器代理地址配置
- 本次不修改 `VCPChat` 的业务接口协议
