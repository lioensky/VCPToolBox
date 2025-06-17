# =================================================================
# Stage 1: Build Stage - 用于编译和安装所有依赖
# =================================================================
FROM node:18-alpine AS build

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
    freetype-dev # <-- 【修正点】这里移除了重复的 zlib-dev

# 复制 Node.js 依赖定义文件并安装依赖 (包含 pm2)
COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 复制 Python 依赖定义文件并安装
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages --target=/usr/src/app/pydeps -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 复制所有源代码
COPY . .
