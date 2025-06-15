# 使用官方 Node.js 18 Alpine 镜像作为基础镜像
FROM node:18-alpine
# FROM docker.mirrors.tuna.tsinghua.edu.cn/library/node:18-alpine

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 安装 Python、pip、时区数据以及 Python 依赖所需的系统构建依赖
# tzdata 用于时区设置
# python3 和 py3-pip 用于运行 Python 脚本和安装 Python 包
# build-base, gfortran, musl-dev, lapack-dev, openblas-dev 是编译 numpy, scipy, Pillow 等库可能需要的依赖
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
    freetype-dev && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 复制项目中的所有文件到工作目录
COPY . .

# 安装根目录下 requirements.txt 中列出的所有 Python 依赖
# requirements.txt 文件已通过上面的 "COPY . ." 指令复制到镜像中
# 使用 --no-cache-dir 避免缓存，可以减小镜像体积
# 使用 --break-system-packages 解决 "externally-managed-environment" 错误
# 注：docker的环境中，在系统级安装，是可以接受的
RUN pip3 install --no-cache-dir --break-system-packages -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 暴露应用程序使用的端口 (从 config.env 获取)
EXPOSE 6005

# 定义容器启动时运行的命令
CMD [ "node", "server.js" ]
