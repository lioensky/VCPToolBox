# VCPToolBox 运维部署指南

本文档提供 VCPToolBox 的完整部署、配置、监控和故障排查指南。

---

## 目录

1. [环境要求](#1-环境要求)
2. [安装步骤](#2-安装步骤)
3. [启动方式](#3-启动方式)
4. [Docker 部署](#4-docker-部署)
5. [配置检查清单](#5-配置检查清单)
6. [故障排查](#6-故障排查)
7. [性能监控](#7-性能监控)
8. [备份与恢复](#8-备份与恢复)
9. [升级与迁移](#9-升级与迁移)

---

## 1. 环境要求

### 1.1 系统要求

| 组件 | 最低要求 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 20 GB | 50 GB+ (SSD) |
| 操作系统 | Linux / Windows / macOS | Ubuntu 22.04 / Debian 12 |

### 1.2 软件依赖

#### Node.js 环境

```bash
# 必需版本
Node.js >= 20.x (LTS 推荐)
npm >= 9.x

# 验证安装
node --version
npm --version
```

#### Python 环境

```bash
# 必需版本
Python >= 3.10
pip >= 21.x

# 验证安装
python3 --version
pip3 --version
```

#### 系统依赖 (Linux)

```bash
# Alpine Linux (Docker 基础镜像)
apk add --no-cache \
  tzdata \
  python3 \
  py3-pip \
  build-base \
  gfortran \
  musl-dev \
  lapack-dev \
  openblas-dev \
  jpeg-dev \
  zlib-dev \
  freetype-dev \
  python3-dev \
  linux-headers \
  libffi-dev \
  openssl-dev

# Ubuntu/Debian
apt-get install -y \
  build-essential \
  python3-dev \
  python3-pip \
  libopenblas-dev \
  liblapack-dev \
  gfortran \
  libjpeg-dev \
  zlib1g-dev \
  libfreetype6-dev
```

#### Rust 环境 (可选 - 用于向量组件)

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustupp.rs | sh

# 验证安装
rustc --version
cargo --version
```

### 1.3 网络要求

| 端口 | 用途 | 说明 |
|------|------|------|
| 6005 | HTTP API | 主服务端口 (可配置) |
| 8088 | WebSocket | 分布式节点通信 (可配置) |

---

## 2. 安装步骤

### 2.1 获取源码

```bash
# 克隆仓库
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox
```

### 2.2 安装 Node.js 依赖

```bash
# 安装主依赖
npm install

# 国内镜像加速 (可选)
npm install --registry=https://registry.npmmirror.com
```

**核心依赖列表：**
- express (^5.1.0) - Web 框架
- ws (^8.17.0) - WebSocket 服务
- better-sqlite3 (^12.4.1) - SQLite 数据库
- puppeteer (^22.15.0) - 浏览器自动化
- pm2 (^6.0.11) - 进程管理

### 2.3 安装 Python 依赖

```bash
# 安装主依赖
pip install -r requirements.txt

# 国内镜像加速 (可选)
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

**核心 Python 依赖：**
- sympy, scipy, numpy - 科学计算器
- requests, Pillow - 图像处理
- mcpo - MCP 协议兼容
- skyfield - 天文计算

### 2.4 安装插件依赖

```bash
# 安装所有插件的 Node.js 依赖
find Plugin -name package.json -exec sh -c '
    for pkg_file do
        plugin_dir=$(dirname "$pkg_file")
        echo "Installing in $plugin_dir"
        (cd "$plugin_dir" && npm install --legacy-peer-deps)
    done
' sh {} +

# 安装所有插件的 Python 依赖
find Plugin -name requirements.txt -exec sh -c '
    for req_file do
        echo "Installing from $req_file"
        pip install -r "$req_file"
    done
' sh {} +
```

### 2.5 初始化配置

```bash
# 复制配置模板
cp config.env.example config.env

# 编辑配置文件
nano config.env  # 或使用您喜欢的编辑器
```

### 2.6 创建必要目录

```bash
# 创建运行时目录
mkdir -p VCPTimedContacts \
         dailynote \
         image \
         file \
         TVStxt \
         VCPAsyncResults \
         Plugin/VCPLog/log \
         Plugin/EmojiListGenerator/generated_lists \
         VectorStore
```

---

## 3. 启动方式

### 3.1 直接启动 (开发/测试)

```bash
# 前台启动
node server.js

# 指定配置文件
node server.js --config ./config.env
```

### 3.2 PM2 进程管理 (推荐生产环境)

```bash
# 安装 PM2 (如未安装)
npm install -g pm2

# 启动服务
pm2 start server.js --name vcptoolbox

# 查看状态
pm2 status

# 查看日志
pm2 logs vcptoolbox

# 重启服务
pm2 restart vcptoolbox

# 停止服务
pm2 stop vcptoolbox

# 开机自启
pm2 startup
pm2 save
```

**PM2 生态系统配置 (ecosystem.config.js)：**

```javascript
module.exports = {
  apps: [{
    name: 'vcptoolbox',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai'
    }
  }]
};
```

```bash
# 使用配置文件启动
pm2 start ecosystem.config.js
```

### 3.3 Systemd 服务 (Linux)

```bash
# 创建服务文件
sudo nano /etc/systemd/system/vcptoolbox.service
```

```ini
[Unit]
Description=VCPToolBox Service
After=network.target

[Service]
Type=simple
User=vcptoolbox
WorkingDirectory=/opt/VCPToolBox
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai

[Install]
WantedBy=multi-user.target
```

```bash
# 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable vcptoolbox
sudo systemctl start vcptoolbox
sudo systemctl status vcptoolbox
```

---

## 4. Docker 部署

### 4.1 前置条件

```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 验证安装
docker --version
docker-compose --version
```

### 4.2 构建与启动

```bash
# 构建镜像并后台启动
docker-compose up --build -d

# 仅构建镜像
docker-compose build

# 启动服务
docker-compose up -d

# 前台启动 (查看日志)
docker-compose up
```

### 4.3 Docker Compose 配置说明

**docker-compose.yml 核心配置：**

```yaml
services:
  app:
    build: .
    container_name: vcptoolbox
    ports:
      - "6005:6005"          # HTTP API 端口
    environment:
      TZ: ${DEFAULT_TIMEZONE:-Asia/Shanghai}
    volumes:
      - .:/usr/src/app       # 全量挂载 (开发模式)
      - /usr/src/app/pydeps  # Python 依赖 (匿名卷)
      - /usr/src/app/node_modules  # Node 依赖 (匿名卷)
    restart: unless-stopped
```

### 4.4 卷挂载策略

**生产环境推荐配置：**

```yaml
volumes:
  # 配置文件
  - ./config.env:/usr/src/app/config.env:ro
  
  # 数据目录
  - ./dailynote:/usr/src/app/dailynote
  - ./image:/usr/src/app/image
  - ./VectorStore:/usr/src/app/VectorStore
  
  # 日志目录
  - ./Plugin/VCPLog/log:/usr/src/app/Plugin/VCPLog/log
  
  # 保持依赖独立
  - /usr/src/app/node_modules
  - /usr/src/app/pydeps
```

### 4.5 环境变量配置

**创建 .env 文件 (Docker Compose)：**

```bash
# 时区设置
DEFAULT_TIMEZONE=Asia/Shanghai

# 端口映射 (如需修改)
VCP_PORT=6005
```

### 4.6 Docker 常用命令

```bash
# 查看容器状态
docker-compose ps

# 查看实时日志
docker-compose logs -f

# 查看最近 100 行日志
docker-compose logs --tail=100

# 进入容器
docker-compose exec app sh

# 重启容器
docker-compose restart

# 停止并删除容器
docker-compose down

# 完全清理 (包括镜像)
docker-compose down --rmi all -v
```

### 4.7 镜像优化说明

Dockerfile 采用多阶段构建：

1. **构建阶段 (build)**：安装所有编译依赖，编译原生模块
2. **运行阶段 (production)**：仅包含运行时依赖，体积更小

```bash
# 查看镜像大小
docker images vcptoolbox

# 预期大小：约 800MB - 1.2GB
```

---

## 5. 配置检查清单

### 5.1 必需配置项

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `API_Key` | 后端 AI 服务 API 密钥 | `sk-xxxx...` |
| `API_URL` | 后端 AI 服务地址 | `https://api.openai.com` |
| `PORT` | VCP 服务端口 | `6005` |
| `Key` | VCP API 访问密钥 | `your_secret_key` |
| `VCP_Key` | WebSocket 认证密钥 | `your_vcp_key` |
| `AdminUsername` | 管理面板用户名 | `admin` |
| `AdminPassword` | 管理面板密码 | `your_strong_password` |

### 5.2 可选配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `Image_Key` | 图片服务访问密钥 | - |
| `File_Key` | 文件服务访问密钥 | - |
| `WeatherKey` | 和风天气 API 密钥 | - |
| `TavilyKey` | Tavily 搜索 API 密钥 | - |
| `SILICONFLOW_API_KEY` | 硅基流动 API 密钥 | - |
| `BILIBILI_COOKIE` | B站 Cookie | - |
| `DebugMode` | 调试模式 | `false` |

### 5.3 知识库配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `VECTORDB_DIMENSION` | 向量维度 | `3072` |
| `KNOWLEDGEBASE_ROOT_PATH` | 知识库根目录 | `./dailynote` |
| `KNOWLEDGEBASE_STORE_PATH` | 向量存储目录 | `./VectorStore` |
| `KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP` | 启动时全量扫描 | `true` |

### 5.4 安全配置检查

```bash
# 检查配置文件权限
chmod 600 config.env

# 检查敏感配置是否泄露
grep -E "(API_Key|Password|Secret)" config.env

# 确认以下配置已修改默认值
# - AdminPassword (不要使用 123456)
# - Key, VCP_Key (使用强随机字符串)
# - 所有 API 密钥
```

### 5.5 配置验证脚本

```bash
#!/bin/bash
# check_config.sh - 配置检查脚本

CONFIG_FILE="config.env"

# 检查必需配置
check_required() {
    local var_name=$1
    if grep -q "^${var_name}=YOUR_" "$CONFIG_FILE" || ! grep -q "^${var_name}=" "$CONFIG_FILE"; then
        echo "❌ 缺少必需配置: $var_name"
        return 1
    else
        echo "✅ $var_name 已配置"
        return 0
    fi
}

echo "=== VCPToolBox 配置检查 ==="

check_required "API_Key"
check_required "API_URL"
check_required "PORT"
check_required "Key"
check_required "VCP_Key"
check_required "AdminPassword"

echo ""
echo "检查完成!"
```

---

## 6. 故障排查

### 6.1 常见错误

#### 错误 1: 端口被占用

```
Error: listen EADDRINUSE: address already in use :::6005
```

**解决方案：**

```bash
# 查找占用端口的进程
lsof -i :6005
# 或
netstat -tlnp | grep 6005

# 终止进程
kill -9 <PID>

# 或修改配置文件中的 PORT
```

#### 错误 2: 模块未找到

```
Error: Cannot find module 'xxx'
```

**解决方案：**

```bash
# 重新安装依赖
rm -rf node_modules package-lock.json
npm install

# 清除 npm 缓存
npm cache clean --force
npm install
```

#### 错误 3: Python 依赖缺失

```
ModuleNotFoundError: No module named 'xxx'
```

**解决方案：**

```bash
# 重新安装 Python 依赖
pip install -r requirements.txt --force-reinstall

# 检查 Python 版本
python3 --version  # 需要 >= 3.10
```

#### 错误 4: better-sqlite3 编译失败

```
Error: Could not locate the bindings file
```

**解决方案：**

```bash
# 重新构建原生模块
npm rebuild better-sqlite3

# 或完全重装
npm uninstall better-sqlite3
npm install better-sqlite3 --build-from-source
```

#### 错误 5: Puppeteer/Chromium 问题

```
Error: Failed to launch the browser process
```

**解决方案：**

```bash
# Linux 安装 Chromium 依赖
apt-get install -y chromium-browser

# 或设置环境变量
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

#### 错误 6: 权限问题

```
Error: EACCES: permission denied
```

**解决方案：**

```bash
# 修改目录所有者
chown -R $(whoami) ./dailynote ./image ./VectorStore

# 或使用 sudo (不推荐生产环境)
sudo chown -R 1000:1000 ./dailynote ./image ./VectorStore
```

### 6.2 日志位置

| 日志类型 | 位置 | 说明 |
|----------|------|------|
| 主服务日志 | 控制台 / PM2 | 启动、请求、错误 |
| VCPLog 插件 | `Plugin/VCPLog/log/` | 工具调用记录 |
| PM2 日志 | `~/.pm2/logs/` | PM2 管理的进程日志 |

```bash
# 查看实时日志
pm2 logs vcptoolbox --lines 100

# 查看 PM2 错误日志
cat ~/.pm2/logs/vcptoolbox-error.log

# 查看 VCPLog
ls -la Plugin/VCPLog/log/
```

### 6.3 调试方法

#### 启用调试模式

```bash
# 在 config.env 中设置
DebugMode=true
```

#### 详细日志输出

```bash
# 启动时输出详细日志
DEBUG=* node server.js

# 或仅 VCP 相关
DEBUG=VCP* node server.js
```

#### 健康检查

```bash
# 检查服务是否响应
curl http://localhost:6005/health

# 检查 API 连通性
curl -H "Authorization: Bearer YOUR_KEY" \
     http://localhost:6005/v1/models
```

### 6.4 性能问题排查

```bash
# 检查内存使用
free -h

# 检查 Node.js 内存
node --max-old-space-size=4096 server.js

# 检查进程状态
pm2 monit

# 分析内存泄漏
node --inspect server.js
# 然后使用 Chrome DevTools 连接
```

---

## 7. 性能监控

### 7.1 系统资源监控

```bash
# 实时监控
pm2 monit

# 查看进程详情
pm2 show vcptoolbox

# 系统资源
htop
# 或
top -p $(pgrep -f "node server.js")
```

### 7.2 关键指标

| 指标 | 正常范围 | 警告阈值 | 说明 |
|------|----------|----------|------|
| CPU 使用率 | < 50% | > 80% | 持续高 CPU 可能需要扩容 |
| 内存使用 | < 70% | > 85% | Node.js 默认 ~1.4GB 限制 |
| 响应时间 | < 500ms | > 2s | API 响应延迟 |
| 并发连接 | 根据配置 | - | WebSocket 连接数 |

### 7.3 PM2 监控

```bash
# 启用 PM2 监控 (需要 PM2 Plus 账号)
pm2 register

# 本地监控面板
pm2 monit

# 进程状态
pm2 status
```

### 7.4 日志分析

```bash
# 统计错误日志
grep -c "Error" ~/.pm2/logs/vcptoolbox-error.log

# 查找最近错误
tail -100 ~/.pm2/logs/vcptoolbox-error.log | grep -i error

# 分析请求日志
grep "POST /v1/chat" ~/.pm2/logs/vcptoolbox-out.log | wc -l
```

### 7.5 Web 管理面板监控

访问 `http://<服务器IP>:6005/AdminPanel` 查看：

- 实时 CPU/内存使用率
- PM2 进程状态
- 系统日志
- 插件状态

### 7.6 瓶颈识别

**常见瓶颈：**

1. **内存不足**
   - 症状：频繁 GC，响应慢
   - 解决：增加 `--max-old-space-size` 或物理内存

2. **CPU 瓶颈**
   - 症状：高 CPU 使用率，请求排队
   - 解决：启用集群模式或水平扩展

3. **I/O 瓶颈**
   - 症状：数据库/文件操作慢
   - 解决：使用 SSD，优化索引

4. **网络瓶颈**
   - 症状：API 调用超时
   - 解决：检查网络连接，使用 CDN

---

## 8. 备份与恢复

### 8.1 需要备份的数据

| 目录/文件 | 说明 | 优先级 |
|-----------|------|--------|
| `config.env` | 主配置文件 | 高 |
| `dailynote/` | 知识库/日记数据 | 高 |
| `VectorStore/` | 向量索引 | 高 |
| `Agent/` | Agent 配置 | 中 |
| `TVStxt/` | 自定义变量文件 | 中 |
| `image/` | 媒体资源 | 中 |
| `Plugin/*/config.env` | 插件配置 | 中 |

### 8.2 备份脚本

```bash
#!/bin/bash
# backup.sh - VCPToolBox 备份脚本

BACKUP_DIR="/backup/vcptoolbox"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="vcptoolbox_${DATE}"

# 创建备份目录
mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}"

# 备份配置
cp config.env "${BACKUP_DIR}/${BACKUP_NAME}/"

# 备份数据目录
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}/dailynote.tar.gz" dailynote/
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}/vectorstore.tar.gz" VectorStore/
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}/agent.tar.gz" Agent/
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}/tvstxt.tar.gz" TVStxt/

# 清理旧备份 (保留最近 7 天)
find "${BACKUP_DIR}" -type d -name "vcptoolbox_*" -mtime +7 -exec rm -rf {} +

echo "备份完成: ${BACKUP_DIR}/${BACKUP_NAME}"
```

### 8.3 自动备份 (Cron)

```bash
# 编辑 crontab
crontab -e

# 每天凌晨 2 点执行备份
0 2 * * * /opt/VCPToolBox/backup.sh >> /var/log/vcptoolbox_backup.log 2>&1
```

### 8.4 恢复步骤

```bash
# 1. 停止服务
pm2 stop vcptoolbox

# 2. 恢复配置
cp /backup/vcptoolbox/vcptoolbox_YYYYMMDD_HHMMSS/config.env ./

# 3. 恢复数据
tar -xzf /backup/vcptoolbox/vcptoolbox_YYYYMMDD_HHMMSS/dailynote.tar.gz
tar -xzf /backup/vcptoolbox/vcptoolbox_YYYYMMDD_HHMMSS/vectorstore.tar.gz

# 4. 重启服务
pm2 start vcptoolbox
```

### 8.5 分布式备份

VCP 提供专用备份系统：[VCPBackUpDEV](https://github.com/lioensky/VCPBcakUpDEV)

功能：
- 自动备份整个分布式系统
- 支持定时备份和增量备份
- 一键恢复功能

---

## 9. 升级与迁移

### 9.1 升级前准备

```bash
# 1. 备份当前版本
./backup.sh

# 2. 记录当前版本
git log -1 > /backup/vcptoolbox/version_$(date +%Y%m%d).txt

# 3. 检查更新内容
git fetch origin
git log HEAD..origin/main --oneline
```

### 9.2 升级步骤

```bash
# 1. 停止服务
pm2 stop vcptoolbox

# 2. 拉取最新代码
git pull origin main

# 3. 更新依赖
npm install
pip install -r requirements.txt

# 4. 更新插件依赖
find Plugin -name package.json -exec sh -c '
    for pkg_file do
        plugin_dir=$(dirname "$pkg_file")
        (cd "$plugin_dir" && npm install --legacy-peer-deps)
    done
' sh {} +

# 5. 检查配置文件变更
diff config.env.example config.env

# 6. 重启服务
pm2 start vcptoolbox

# 7. 验证服务
curl http://localhost:6005/health
```

### 9.3 Docker 升级

```bash
# 1. 备份配置
cp config.env config.env.bak

# 2. 拉取最新代码
git pull origin main

# 3. 重建镜像
docker-compose build --no-cache

# 4. 重启容器
docker-compose down
docker-compose up -d

# 5. 查看日志确认启动
docker-compose logs -f
```

### 9.4 迁移到新服务器

```bash
# === 源服务器 ===

# 1. 创建完整备份
tar -czf vcptoolbox_full.tar.gz \
    config.env \
    dailynote/ \
    VectorStore/ \
    Agent/ \
    TVStxt/ \
    image/

# 2. 传输备份文件
scp vcptoolbox_full.tar.gz user@new-server:/opt/


# === 目标服务器 ===

# 1. 安装依赖 (参考第 2 节)
# 2. 克隆项目
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox

# 3. 安装依赖
npm install
pip install -r requirements.txt

# 4. 恢复数据
tar -xzf /opt/vcptoolbox_full.tar.gz

# 5. 启动服务
pm2 start server.js --name vcptoolbox
```

### 9.5 版本回滚

```bash
# 1. 停止服务
pm2 stop vcptoolbox

# 2. 回滚到指定版本
git checkout <commit-hash>

# 3. 重装依赖
npm install
pip install -r requirements.txt

# 4. 恢复配置
cp /backup/vcptoolbox/vcptoolbox_YYYYMMDD_HHMMSS/config.env ./

# 5. 重启服务
pm2 start vcptoolbox
```

### 9.6 配置迁移检查

升级/迁移后检查：

```bash
# 检查服务状态
pm2 status

# 检查端口监听
netstat -tlnp | grep 6005

# 检查 API 可用性
curl -H "Authorization: Bearer YOUR_KEY" \
     http://localhost:6005/v1/models

# 检查知识库
ls -la dailynote/
ls -la VectorStore/

# 检查插件加载
curl http://localhost:6005/AdminPanel/api/plugins
```

---

## 附录

### A. 快速命令参考

```bash
# 启动
pm2 start vcptoolbox

# 停止
pm2 stop vcptoolbox

# 重启
pm2 restart vcptoolbox

# 查看日志
pm2 logs vcptoolbox

# Docker 构建
docker-compose up --build -d

# Docker 日志
docker-compose logs -f

# 健康检查
curl http://localhost:6005/health
```

### B. 相关文档

- [配置详解](./CONFIGURATION.md)
- [架构说明](./ARCHITECTURE.md)
- [分布式部署](./DISTRIBUTED_ARCHITECTURE.md)
- [插件生态](./PLUGIN_ECOSYSTEM.md)
- [API 路由](./API_ROUTES.md)

### C. 获取帮助

- GitHub Issues: [VCPToolBox](https://github.com/lioensky/VCPToolBox/issues)
- 官方文档: README.md
- Web 管理面板: `http://<server>:6005/AdminPanel`

---

**最后更新**: 2026-02-13  
**版本**: VCP 6.4
