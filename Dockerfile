# =================================================================
# Stage 1: Build Stage - 用于编译和安装所有依赖
# =================================================================
FROM node:20-alpine AS build

# 设置工作目录
WORKDIR /usr/src/app

# 更换为国内镜像源以加速
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

# 安装所有运行时和编译时依赖
RUN apk add --no-cache \
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
    freetype-dev

# 复制 Node.js 依赖定义文件并安装依赖 (包含 pm2)
COPY package*.json ./
# 如果遇到 npm install 速度过慢的问题，可以尝试更换下面的镜像源。
# 国内常用镜像:
# --registry=https://registry.npm.taobao.org (淘宝旧版)
# --registry=https://registry.npmmirror.com (淘宝新版)
# --registry=https://mirrors.huaweicloud.com/repository/npm/ (华为云)
# 国际通用 (如果服务器在海外):
# (默认，无需指定)
RUN npm install --registry=https://registry.npm.taobao.org

# 复制 Python 依赖定义文件并安装
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages --target=/usr/src/app/pydeps -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 复制所有源代码
COPY . .

# =================================================================
# Stage 2: Production Stage - 最终的轻量运行环境
# =================================================================
FROM node:20-alpine

# 设置工作目录
WORKDIR /usr/src/app

# 仅安装运行时的系统依赖
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache \
    tzdata \
    python3 \
    openblas \
    jpeg-dev \
    zlib-dev \
    freetype-dev

# 设置 PYTHONPATH 环境变量，让 Python 能找到我们安装的依赖
ENV PYTHONPATH=/usr/src/app/pydeps

# 设置时区
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 从构建阶段复制整个应用目录
COPY --from=build /usr/src/app .


# --- 安全性说明：关于以 root 用户运行 ---
#
# 【!! 警告 !!】
# 以下创建并切换到低权限用户 appuser 的操作已被注释掉。
# 当前容器将以 root 用户身份运行。
#
# 原因: 应用需要写入通过 Docker Volume 挂载到容器内的数据目录（如日志、缓存、图片等）。
#       当使用低权限用户(appuser)时，如果主机上的对应目录所有者是 root，会导致容器内出现 "Permission Denied" 错误。
#
# 风险: 以 root 身份运行容器存在安全风险。如果应用本身存在漏洞被攻击者利用，
#       攻击者将获得容器内的最高权限，可能导致更严重的安全问题。
#
# 长期推荐方案:
# 1. 重新启用下面的三行命令，构建使用 appuser 的镜像。
# 2. 在部署应用的主机上，找到所有挂载给容器的数据目录。
# 3. 执行 `chown -R <UID>:<GID> /path/to/host/dir` 命令，
#    将这些目录的所有权变更为容器内 appuser 的 UID 和 GID (通常是 1000:1000 或 1001:1001)。
#    这样，低权限用户也能安全地读写数据。
#
# RUN addgroup -S appuser && adduser -S appuser -G appuser
# RUN chown -R appuser:appuser /usr/src/app
# USER appuser


# 暴露端口
EXPOSE 6005

# 定义容器启动命令
CMD [ "node_modules/.bin/pm2-runtime", "start", "server.js" ]
