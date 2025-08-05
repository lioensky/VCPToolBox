# VCP ToolBox 部署指南

## 目录

- [环境要求](#环境要求)
- [依赖安装](#依赖安装)
  - [方式一：Poetry 虚拟环境 (推荐)](#方式一poetry-虚拟环境-推荐)
  - [方式二：系统环境直接安装](#方式二系统环境直接安装)
  - [方式三：Docker 容器化部署](#方式三docker-容器化部署)
- [配置文件设置](#配置文件设置)
- [启动服务](#启动服务)
- [验证部署](#验证部署)
- [常见问题](#常见问题)
- [维护管理](#维护管理)

---

## 环境要求

### 系统要求
- **操作系统**: Windows 10/11, Linux, macOS
- **Node.js**: 版本 20 或更高
- **Python**: 版本 3.11 或更高 (用于科学计算插件)
- **内存**: 建议 4GB 以上
- **存储**: 建议 2GB 以上可用空间

### 必需软件
- [Node.js](https://nodejs.org/) (包含 npm)
- [Python](https://www.python.org/downloads/)
- [Poetry](https://python-poetry.org/docs/#installation) (推荐用于 Python 依赖管理)
- [Git](https://git-scm.com/) (用于克隆项目)

---

## 依赖安装

### 方式一：NPM 直接安装 (推荐)

这是最简单快捷的安装方式，适合大多数用户。

```bash
# 克隆项目
git clone <项目地址>
cd VCPToolBox

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖 (使用系统 Python)
pip install -r requirements.txt
```

### 方式二：Poetry 虚拟环境

如果你希望使用虚拟环境隔离 Python 依赖，可以使用这种方式。**注意：Poetry 在 Windows 环境下的 shell 激活存在兼容性问题。**

#### 1. 安装 Poetry (如果尚未安装)

**Windows (PowerShell):**
```powershell
(Invoke-WebRequest -Uri https://install.python-poetry.org -UseBasicParsing).Content | py -
```

**Linux/macOS:**
```bash
curl -sSL https://install.python-poetry.org | python3 -
```

**或使用 pip:**
```bash
pip install poetry
```

#### 2. 克隆项目并安装依赖

```bash
# 克隆项目
git clone <项目地址>
cd VCPToolBox

# 验证 Poetry 安装
poetry --version

# 安装 Python 依赖 (会自动创建虚拟环境)
poetry install

# 安装 Node.js 依赖
npm install
```

#### 3. 验证安装

```bash
# 验证 Python 依赖
poetry run python -c "import sympy, scipy, numpy, requests, dotenv, PIL; print('✅ Python 依赖安装成功')"

# 验证 Node.js 依赖
node -e "console.log('✅ Node.js 环境正常'); console.log('PM2版本:', require('./node_modules/pm2/package.json').version)"
```

### 方式三：系统环境完整安装

传统的系统级安装方式：

```bash
# 克隆项目
git clone <项目地址>
cd VCPToolBox

# 安装 Python 依赖
pip install -r requirements.txt

# 安装 Node.js 依赖
npm install
```

### 方式四：Docker 容器化部署

```bash
# 构建镜像
docker build -t vcp-toolbox .

# 运行容器
docker run -d \
  --name vcp-toolbox \
  -p 6005:6005 \
  -v ./data:/usr/src/app/data \
  -v ./config.env:/usr/src/app/config.env \
  vcp-toolbox
```

---

## 配置文件设置

### 1. 创建配置文件

```bash
# 复制配置模板
cp config.env.example config.env

# 或在 Windows 上
copy config.env.example config.env
```

### 2. 编辑核心配置

使用文本编辑器打开 `config.env`，配置以下必要参数：

#### 基础配置
```env
# AI 服务配置 (必须)
API_Key=sk-xxxxxxxxxxxxxxxxxxxxxxxx        # 你的 AI API 密钥
API_URL=https://api.openai.com             # AI 服务地址

# VCP 服务配置 (必须)
PORT=6005                                   # 服务端口
Key=your_secure_key_here                   # API 访问密钥
Image_Key=your_image_key_here              # 图片服务密钥
File_Key=your_file_key_here                # 文件服务密钥
VCP_Key=your_vcp_key_here                  # WebSocket 鉴权密钥

# 管理员配置 (必须)
AdminUsername=admin                         # 管理后台用户名
AdminPassword=your_complex_password_here    # 管理后台密码
```

#### 个性化配置
```env
# 用户信息
VarUser=你的名字
VarCity=你的城市
VarSystemInfo=Windows_11  # 或 Ubuntu_22.04 等

# 回调地址
CALLBACK_BASE_URL="http://localhost:6005/plugin-callback"
```

#### 可选配置
```env
# 调试模式
DebugMode=False                            # 生产环境建议 False

# 第三方服务 API (按需配置)
WeatherKey=your_weather_key                # 和风天气
TavilyKey=your_tavily_key                  # Tavily 搜索
SILICONFLOW_API_KEY=your_siliconflow_key   # 硅基流动
```

### 3. 配置验证

检查配置文件语法：
```bash
# 使用 Poetry 环境
poetry run python -c "from dotenv import load_dotenv; load_dotenv('config.env'); print('✅ 配置文件格式正确')"

# 或直接运行
python -c "from dotenv import load_dotenv; load_dotenv('config.env'); print('✅ 配置文件格式正确')"
```

---

## 启动服务

### NPM + PM2 启动 (推荐)

**这是最推荐的启动方式**，使用 npx 可以直接使用项目本地安装的 PM2，无需全局安装。

#### 生产运行模式 (推荐)
```bash
# 使用 npx 启动 PM2 (推荐)
npx pm2 start server.js --name vcp-toolbox

# 查看服务状态
npx pm2 status

# 查看日志
npx pm2 logs vcp-toolbox

# 重启服务
npx pm2 restart vcp-toolbox

# 停止服务
npx pm2 stop vcp-toolbox
```

#### 开发调试模式
```bash
# 前台运行，便于调试
node server.js
```

### Poetry 环境启动

**注意：Poetry shell 在 Windows 环境下存在兼容性问题，不推荐在 Windows 上使用。**

#### 开发调试模式
```bash
# 激活 Poetry 环境
poetry shell

# 启动服务 (前台运行，便于调试)
node server.js
```

#### 生产运行模式 (Linux/macOS)
```bash
# 使用 PM2 在 Poetry 环境中启动 (仅适用于 Linux/macOS)
poetry run pm2 start server.js --name vcp-toolbox

# 查看服务状态
poetry run pm2 status

# 查看日志
poetry run pm2 logs vcp-toolbox
```

**Windows 用户请使用 NPM + PM2 启动方式。**

### 全局 PM2 启动

#### 开发调试模式
```bash
# 直接启动
node server.js
```

#### 生产运行模式 (需要全局安装 PM2)
```bash
# 全局安装 PM2 (如果未安装)
npm install -g pm2

# 使用全局 PM2 启动
pm2 start server.js --name vcp-toolbox

# 设置开机自启
pm2 startup
pm2 save
```

### Docker 启动

```bash
# 使用 docker-compose (推荐)
docker-compose up -d

# 或直接运行
docker run -d \
  --name vcp-toolbox \
  -p 6005:6005 \
  -v $(pwd)/data:/usr/src/app/data \
  -v $(pwd)/config.env:/usr/src/app/config.env \
  vcp-toolbox
```

---

## 验证部署

### 1. 服务健康检查

```bash
# 检查服务是否启动
curl http://localhost:6005/health

# 或在浏览器中访问
# http://localhost:6005
```

### 2. API 测试

```bash
# 测试聊天 API
curl -X POST http://localhost:6005/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_key_here" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 3. 管理后台访问

在浏览器中访问：`http://localhost:6005/admin`

使用配置文件中设置的用户名和密码登录。

---

## 常见问题

### Q1: Python 依赖安装失败
**错误**: `numpy requires Python >=3.11`

**解决**: 确保使用 Python 3.11+ 版本
```bash
python --version  # 检查版本
poetry env use python3.11  # 指定 Python 版本
```

### Q2: Node.js 模块找不到
**错误**: `Cannot find module 'xxx'`

**解决**: 重新安装 Node.js 依赖
```bash
rm -rf node_modules package-lock.json
npm install
```

### Q3: 端口被占用
**错误**: `Port 6005 is already in use`

**解决**: 
1. 修改 `config.env` 中的 `PORT` 值
2. 或停止占用端口的进程：
```bash
# Windows
netstat -ano | findstr :6005
taskkill /PID <PID> /F

# Linux/macOS
lsof -ti:6005 | xargs kill -9
```

### Q4: API 调用失败
**错误**: `401 Unauthorized` 或连接超时

**解决**: 
1. 检查 `config.env` 中的 `API_Key` 和 `API_URL`
2. 验证网络连接
3. 检查 AI 服务商的 API 状态

### Q5: WebSocket 连接失败

**解决**: 
1. 检查 `VCP_Key` 配置
2. 确保防火墙允许 WebSocket 连接
3. 检查代理设置

---

## 维护管理

### 日志管理

#### NPM + PM2 环境 (推荐)
```bash
# 查看 PM2 日志
npx pm2 logs vcp-toolbox

# 清空日志
npx pm2 flush

# 重启服务
npx pm2 restart vcp-toolbox

# 停止服务
npx pm2 stop vcp-toolbox
```

#### Poetry + PM2 环境 (Linux/macOS)
```bash
# 查看 PM2 日志 (仅适用于 Linux/macOS)
poetry run pm2 logs vcp-toolbox

# 清空日志
poetry run pm2 flush

# 重启服务
poetry run pm2 restart vcp-toolbox
```

#### Docker 环境
```bash
# 查看容器日志
docker logs vcp-toolbox

# 重启容器
docker restart vcp-toolbox
```

### 更新项目

```bash
# 拉取最新代码
git pull origin main

# 更新依赖
poetry install  # Python 依赖 (可选)
npm install     # Node.js 依赖

# 重启服务 (推荐使用 npx)
npx pm2 restart vcp-toolbox

# 或使用 Poetry (仅 Linux/macOS)
poetry run pm2 restart vcp-toolbox
```

### 备份配置

```bash
# 备份重要文件
cp config.env config.env.backup
cp -r data data.backup
cp -r Plugin Plugin.backup
```

### 性能监控

```bash
# 使用 PM2 监控 (推荐)
npx pm2 monit

# 查看系统资源使用
npx pm2 show vcp-toolbox

# 或使用 Poetry (仅 Linux/macOS)
poetry run pm2 monit
poetry run pm2 show vcp-toolbox
```

---

## 安全提醒

1. **保护 API 密钥**: 不要将包含真实 API 密钥的 `config.env` 文件提交到版本控制
2. **强密码**: 为管理后台设置复杂密码
3. **防火墙**: 适当配置防火墙规则
4. **定期更新**: 保持依赖库和系统的最新状态
5. **监控日志**: 定期检查运行日志，及时发现异常

---

如果遇到其他问题，请查看项目的 [README.md](README.md) 或提交 Issue。