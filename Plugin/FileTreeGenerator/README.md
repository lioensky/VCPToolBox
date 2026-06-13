# 插件：文件树生成器 (FileTreeGenerator)

## 1. 功能简介

本插件是一个静态插件，其主要功能是扫描服务器上指定目录的文件夹结构，并将生成的目录树通过占位符 `{{VCPFilestructureInfo}}` 提供给 AI。

这对于需要让 AI 了解特定项目或文件夹组织结构的任务非常有用。

插件具有以下特性：

- **纯 Node.js 实现**：无需任何外部命令（如 `tree`），完全跨平台。
- **自动刷新**：可以配置刷新周期，定期在后台更新目录树信息。
- **目录排除**：可以配置需要排除的文件夹列表，避免扫描不必要的目录（如 `node_modules`, `.git` 等）。
- **深度限制**：可配置最大递归深度，避免过深的目录树占用过多 token。
- **符号链接支持**：完整支持 Linux/macOS 软链接和 Windows 符号链接，并展开链接指向的目录结构。
- **Docker 兼容**：通过卷挂载，可以安全地扫描宿主机上的目录。

## 2. 输出格式

生成的目录树遵循 BSD `ls -F` 标准，使用可读的树状结构：

```
Directory tree for: /root/workspace
(Expanded to depth: 3)
├── project_a/
│   ├── src/
│   └── tests/
├── symlink_to_libs@ -> /usr/local/libs
│   ├── common/
│   └── utils/
└── docs/
```

**格式说明：**

- `name/` - 普通目录（以 `/` 结尾）
- `name@` - 符号链接（以 `@` 结尾）
- ` -> /path` - 符号链接目标路径（箭头前后有空格）
- `(Expanded to depth: N)` - 显示当前展开的层级深度
- `(Fully expanded)` - 无深度限制，完全展开

## 3. 占位符

本插件提供以下占位符：

- `{{VCPFilestructureInfo}}`: 替换为指定目录的文件夹结构树字符串。

## 4. 配置方法

本插件的所有配置均在插件目录下的 `config.env` 文件中进行。

**配置文件路径**: `Plugin/FileTreeGenerator/config.env`

| 键 (Key)           | 描述                                                                             | 示例                                           |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| `TARGET_DIRECTORY` | **必需**。需要扫描的目标文件夹的**绝对路径**。                                   | `TARGET_DIRECTORY=C:\Users\YourUser\Documents` |
| `EXCLUDE_DIRS`     | **可选**。扫描时需要排除的文件夹名称列表，用逗号分隔，名称之间不要有空格。       | `EXCLUDE_DIRS=.git,node_modules,.obsidian`     |
| `MAX_DEPTH`        | **可选**。最大递归深度。`0` 表示无限制（默认行为），正整数表示只展示到对应层级。 | `MAX_DEPTH=3`                                  |

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

## 5. 刷新频率

本插件支持后台自动刷新，刷新频率由 `plugin-manifest.json` 文件中的 `refreshIntervalCron` 字段控制。

**配置文件路径**: `Plugin/FileTreeGenerator/plugin-manifest.json`

默认配置为每 5 分钟刷新一次：

```json
  "refreshIntervalCron": "*/5 * * * *",
```

你可以修改这个标准的 **Cron 表达式** 来定义你自己的刷新周期。修改后需要重启 VCP 服务器才能生效。

---

## 6. 分布式插件使用注意事项

⚠️ **静态占位符命名冲突问题**

如果你计划将本插件作为分布式插件分发，或在同一个 VCP 实例中使用多个静态占位符，请特别注意占位符命名规则：

**问题示例（❌ 错误）：**

```
插件 A 注册: {{VCPFilestructureInfo}}
插件 B 注册: {{VCPFilestructureInfo_xxx}}
```

当两个占位符同时注册时，插件 A 会将插件 B 的占位符破坏，使其变成：

```
{{VCPFilestructureInfo}}_xxx  // 被替换后失效
```

**解决方案（✅ 正确）：**
确保所有占位符名称**互不包含**：

```
插件 A: {{VCPFilestructureInfo}}
插件 B: {{VCPKnowledgeBase}}
插件 C: {{VCPProjectDocs}}
```

**命名建议：**

- 使用完全不同的前缀或后缀
- 避免一个占位符名称是另一个的子串
- 建议使用语义化的独立名称，而非简单的数字或后缀区分
