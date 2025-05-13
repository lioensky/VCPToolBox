# 使用官方 Node.js 18 Alpine 镜像作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 复制项目中的所有文件到工作目录
COPY . .

# 暴露应用程序使用的端口 (从 config.env 获取)
EXPOSE 6005

# 定义容器启动时运行的命令
CMD [ "node", "server.js" ]