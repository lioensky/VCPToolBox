# VCPToolBox 更新指南

本文档记录了更新 VCPToolBox 项目的步骤。

## 准备工作

- 确保您已安装 Git 和 Docker Compose。
- 打开终端或命令行界面。
- 导航到您的 VCPToolBox 项目根目录 (例如 `/opt/VCPToolBox`)。

## 更新步骤

1.  **停止当前运行的服务 (如果正在运行)**：
    ```bash
    docker-compose down --volumes --remove-orphans
    ```
    *用户通常会在更新前执行此步骤。*

2.  **拉取最新的代码**：
    这些命令会确保您的本地 `main` 分支与官方 `lioensky/VCPToolBox` 仓库的 `main` 分支（通常在您本地命名为 `upstream`）完全同步。

    ```bash
    # 1. 从名为 'upstream' 的远程仓库获取最新的分支信息和提交记录
    git fetch upstream

    # 2. 确保您当前在本地的 'main' 分支上
    git checkout main

    # 3. 将本地 'main' 分支强制重置为 'upstream/main' 的状态。
    # 这会使您的本地 'main' 分支与远程的 'upstream/main' 完全一致。
    # 重要：此命令会丢弃您在本地 'main' 分支上任何未推送到您自己 fork (origin) 的提交。
    # 如果您在本地 'main' 分支上有不想丢失的更改，请先进行备份或推送到您的 fork。
    git reset --hard upstream/main
    ```

    **解释与替代方案：**
    - `git fetch upstream`：从远程仓库 `upstream` 下载最新的历史记录，但不会修改您本地的工作文件或当前分支。
    - `git checkout main`：切换到您的本地 `main` 分支。
    - `git reset --hard upstream/main`：这是保持与上游仓库严格同步的一种方式。它使您的本地 `main` 分支的 HEAD 指针、索引和工作目录都与 `upstream/main` 完全一样。这对于确保您拥有最新的官方代码非常有效，尤其是在您不打算向官方 `main` 分支贡献更改，而只是想运行最新版本时。

    **替代拉取方式 (使用 `git pull`)**:
    如果您更习惯使用 `git pull`，并且已经正确设置了本地 `main` 分支跟踪 `upstream/main`（即 `git branch -vv` 显示 `main xxxxxx [upstream/main] ...`），您可以运行：
    ```bash
    git checkout main
    git pull upstream main  # 或者如果跟踪已设置好，可以直接用 git pull
    ```
    `git pull` 实际上是 `git fetch` 后跟 `git merge` (或 `git rebase`，取决于您的 Git 配置)。如果您的本地 `main` 分支上有与 `upstream/main` 不同的提交（例如，您自己的实验性提交），这可能会导致创建一个合并提交或需要您解决合并冲突。对于仅仅是同步官方更新而言，前述的 `reset --hard` 方法通常更直接简单，因为它避免了不必要的本地合并历史。

    **检查远程仓库和分支跟踪设置**：
    如果您不确定远程仓库的名称和跟踪设置，可以使用以下命令检查：
    ```bash
    git remote -v 
    # 预期输出应包含类似:
    # upstream  https://github.com/lioensky/VCPToolBox.git (fetch)
    # upstream  https://github.com/lioensky/VCPToolBox.git (push)
    # origin    https://github.com/YOUR_USERNAME/VCPToolBox.git (fetch)
    # origin    https://github.com/YOUR_USERNAME/VCPToolBox.git (push)

    git branch -vv
    # 预期输出应包含类似 (星号表示当前分支):
    # * main xxxxxxx [upstream/main] Commit message... 
    ```
    如果您的 `main` 分支没有跟踪 `upstream/main`，您可以使用以下命令设置它：
    ```bash
    git branch --set-upstream-to=upstream/main main
    ```

3.  **检查并更新 `config.env` 文件**：
    a.  在拉取最新代码后，查看项目根目录下的 `config.env.example` 文件。这个文件包含了最新的配置格式和选项。
    b.  根据 `config.env.example` 的改动，手动更新您项目中的 `config.env` 文件。
        - **重要**：保留您在 `config.env` 中已设置的自定义值（如 API 密钥、密码、特定路径等）。
        - 只添加 `config.env.example` 中新增的配置项，或根据示例更新现有配置项的结构/注释。
        - 如果某个配置项在 `config.env.example` 中是 `YOUR_KEY` 或 `Your Url` 这样的占位符，而在您的 `config.env` 中已有具体值，请保留您的具体值。
        - 如果有疑问，可以备份您当前的 `config.env` 文件后再进行修改。

4.  **重新构建 Docker 镜像并启动服务**：
    ```bash
    docker-compose build --no-cache
    docker-compose up -d
    ```
    或者合并为一条命令：
    ```bash
    docker-compose build --no-cache && docker-compose up -d
    ```
    如果遇到 `KeyError: 'ContainerConfig'` 或类似的启动错误，请先确保执行了步骤 1 中的 `docker-compose down --volumes --remove-orphans`，然后再尝试此步骤。

## （可选）清理 Docker 资源

定期清理未使用的 Docker 资源可以释放磁盘空间。
```bash
docker system prune
```
如果想更彻底地清理（包括未使用的卷），请谨慎使用，因为它会删除所有未使用的 Docker 对象：
```bash
docker system prune -a --volumes 
```

---
*请根据您的实际项目配置和需求调整上述步骤。*