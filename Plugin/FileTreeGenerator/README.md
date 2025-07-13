# 插件：文件树生成器 (FileTreeGenerator)

## 1. 功能简介

本插件是一个静态插件，其主要功能是扫描服务器上指定目录的文件夹结构，并将生成的目录树通过占位符 `{{VCPFilestructureInfo}}` 提供给 AI。

这对于需要让 AI 了解特定项目或文件夹组织结构的任务非常有用。

插件具有以下特性：
- **纯 Node.js 实现**：无需任何外部命令（如 `tree`），完全跨平台。
- **自动刷新**：可以配置刷新周期，定期在后台更新目录树信息。
- **目录排除**：可以配置需要排除的文件夹列表，避免扫描不必要的目录（如 `node_modules`, `.git` 等）。
- **Docker 兼容**：通过卷挂载，可以安全地扫描宿主机上的目录。

## 2. 占位符

本插件提供以下占位符：

- `{{VCPFilestructureInfo}}`: 替换为指定目录的文件夹结构树字符串。

## 3. 配置方法

本插件的所有配置均在插件目录下的 `config.env` 文件中进行。

**配置文件路径**: `Plugin/FileTreeGenerator/config.env`

| 键 (Key)           | 描述                                                                                                                                                             | 示例                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `TARGET_DIRECTORY` | **必需**。需要扫描的目标文件夹的**绝对路径**。                                                                                                                   | `TARGET_DIRECTORY=C:\Users\YourUser\Documents`  |
| `EXCLUDE_DIRS`     | **可选**。扫描时需要排除的文件夹名称列表，用逗号分隔，名称之间不要有空格。                                                                                         | `EXCLUDE_DIRS=.git,node_modules,.obsidian`      |

---

### **重要：在 Docker 环境下使用**

如果你的 VCP 服务器运行在 Docker 容器中，你**必须**使用 Docker 的卷挂载（Volume Mount）功能，将你电脑（宿主机）上的文件夹映射到容器内部。

**步骤如下:**

1.  **修改 `docker-compose.yml` 或 `docker-compose.override.yml`**:
    在 `volumes:` 部分，添加一行，将你的目标文件夹映射到容器内的一个路径（例如 `/scandata`）。我们推荐使用 `:ro` (read-only) 模式以增加安全性。

    **示例**:
    ```yaml
    services:
      app:
        volumes:
          # 其他挂载...
          - "D:\\Your\\Folder\\On\\Host:/scandata:ro"
    ```

2.  **修改本插件的 `config.env`**:
    将 `TARGET_DIRECTORY` 的值设置为**容器内部的路径**。

    **示例**:
    ```
    TARGET_DIRECTORY=/scandata
    ```

---

## 4. 刷新频率

本插件支持后台自动刷新，刷新频率由 `plugin-manifest.json` 文件中的 `refreshIntervalCron` 字段控制。

**配置文件路径**: `Plugin/FileTreeGenerator/plugin-manifest.json`

默认配置为每5分钟刷新一次：
```json
  "refreshIntervalCron": "*/5 * * * *",
```

你可以修改这个标准的 **Cron 表达式** 来定义你自己的刷新周期。修改后需要重启 VCP 服务器才能生效。