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
  freetype-dev \
  python3-dev \
  linux-headers \
  libffi-dev \
  openssl-dev \ffmpeg

# 在 npm install 之前设置环境变量，跳过 puppeteer 的 chromium 下载
ARG PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=${PUPPETEER_SKIP_DOWNLOAD}

# 复制 Node.js 依赖定义文件并安装依赖 (包含 pm2)
COPY package*.json ./
# 如果遇到 npm install 速度过慢的问题，可以尝试更换下面的镜像源。
# 国内常用镜像:
# --registry=https://registry.npm.taobao.org (淘宝旧版)
# --registry=https://registry.npmmirror.com (淘宝新版)
# --registry=https://mirrors.huaweicloud.com/repository/npm/ (华为云)
# 国际通用 (如果服务器在海外):
# (默认，无需指定)
RUN npm cache clean --force && npm install --registry=https://registry.npmmirror.com

# 复制 Python 依赖定义文件并安装
COPY requirements.txt ./
# 在 Linux 环境下构建时，注释掉仅适用于 Windows 的 win10toast 包
RUN sed -i '/^win10toast/s/^/#/' requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages --target=/usr/src/app/pydeps -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 复制所有源代码
COPY . .

# 查找所有插件目录下的 requirements.txt 并安装依赖
# 使用 find 命令查找所有名为 requirements.txt 的文件
# 然后使用 for 循环遍历这些文件并用 pip 安装
RUN find Plugin -name requirements.txt -exec sh -c ' \
    for req_file do \
        echo ">>> Installing Python dependencies from $req_file"; \
        pip3 install --no-cache-dir --break-system-packages --target=/usr/src/app/pydeps -i https://pypi.tuna.tsinghua.edu.cn/simple -r "$req_file" || \
            { echo "!!! Failed to install Python dependencies from $req_file"; exit 1; }; \
    done' sh {} +

# 查找所有插件目录下的 package.json 并安装 npm 依赖
# 使用 find 命令查找所有名为 package.json 的文件
# 然后使用 for 循环遍历这些文件，并在其所在目录运行 npm install
RUN find Plugin -name package.json -exec sh -c ' \
    for pkg_file do \
        plugin_dir=$(dirname "$pkg_file"); \
        echo ">>> Installing Node.js dependencies in $plugin_dir"; \
        (cd "$plugin_dir" && npm install --registry=https://registry.npmmirror.com --legacy-peer-deps) || \
            { echo "!!! Failed to install Node.js dependencies in $plugin_dir"; exit 1; }; \
    done' sh {} +

# =================================================================
# Stage 2: Production Stage - 最终的轻量运行环境
# =================================================================
FROM node:20-alpine

# 设置工作目录
WORKDIR /usr/src/app

# 仅安装运行时的系统依赖
# 添加 chromium 及其所需依赖，以供 UrlFetch (Puppeteer) 工具使用
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
  apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  tzdata \
  python3 \
  openblas \
  jpeg-dev \
  zlib-dev \
  freetype-dev \
  libffi \
ffmpeg
# 设置 PYTHONPATH 环境变量，让 Python 能找到我们安装的依赖
ENV PYTHONPATH=/usr/src/app/pydeps
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 设置时区：依赖于运行时传入的 TZ 环境变量（例如 docker-compose.yml 中的配置）。
# 基础镜像 node:20-alpine 已安装 tzdata，运行时设置 TZ 即可生效。

# 从构建阶段复制应用代码和 node_modules
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package*.json ./
COPY --from=build /usr/src/app/pydeps ./pydeps
COPY --from=build /usr/src/app/*.js ./
COPY --from=build /usr/src/app/Plugin ./Plugin
COPY --from=build /usr/src/app/Agent ./Agent
COPY --from=build /usr/src/app/routes ./routes
COPY --from=build /usr/src/app/requirements.txt ./

# 创建所有应用可能需要写入的持久化目录，以增强镜像的健壮性
# 这样即使用户的宿主机目录不完整，容器也能正常启动。
# 卷挂载会覆盖这些空目录。
RUN mkdir -p /usr/src/app/VCPTimedContacts \
             /usr/src/app/dailynote \
             /usr/src/app/image \
             /usr/src/app/file \
             /usr/src/app/TVStxt \
             /usr/src/app/VCPAsyncResults \
             /usr/src/app/Plugin/VCPLog/log \
             /usr/src/app/Plugin/EmojiListGenerator/generated_lists


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
