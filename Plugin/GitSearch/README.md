# GitSearch — 代码托管平台聚合搜索插件

## 简介

GitSearch 是 VCPToolBox 的同步插件，聚合了 **GitHub**、**GitLab**、**Gitee** 三大代码托管平台的纯读取操作，提供 14 个统一命名的工具和一致的调用方式。

## 文件结构

```
GitSearch/
├── GitSearch.js          # 插件主入口（stdin/stdout JSON 交互）
├── plugin-manifest.json  # VCP 插件清单
├── config.env            # 配置文件（各平台令牌）
├── README.md             # 本文件
└── adapters/
    ├── github.js         # GitHub REST API v3 适配器
    ├── gitlab.js         # GitLab REST API v4 适配器
    └── gitee.js          # Gitee REST API v5 适配器
```

## 安装方法

1. 将 `GitSearch/` 文件夹复制到 VCPToolBox 的插件目录（如 `plugins/`）
2. 在 `config.env` 中填写对应平台的访问令牌（不需要的平台可留空）
3. 重启 VCPToolBox 服务加载插件

## 配置项

编辑 `config.env`：

```env
# GitHub Personal Access Token
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# GitLab Personal Access Token（自托管请同时修改 GITLAB_URL）
GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
GITLAB_URL=https://gitlab.com

# Gitee 私人令牌
GITEE_TOKEN=xxxxxxxxxxxxxxxxxxxx

# 输出长度限制（可选，设为 0 则不限制）
MAX_OUTPUT_LENGTH=0
```

### 令牌获取地址

- **GitHub**: https://github.com/settings/tokens（需要 `repo` 读取权限）
- **GitLab**: https://gitlab.com/-/profile/personal_access_tokens（需要 `read_api`, `read_repository`）
- **Gitee**: https://gitee.com/profile/personal_access_tokens（需要 `projects`, `pull_requests`, `issues`）

> **注意**: 公开仓库大部分操作可不填令牌即可使用，但速率限制较低。建议配置令牌以获得更好的体验。

## 14个统一工具

| 统一命令 | 说明 | GitHub | GitLab | Gitee |
|---------|------|--------|--------|-------|
| `repo_get` | 获取仓库/项目信息 | ✅ | ✅ | ✅ |
| `repo_list_files` | 获取文件内容或目录列表 | ✅ | ✅ | ✅ |
| `repo_list_branches` | 列出分支 | ✅ | ✅ | ✅ |
| `repo_list_commits` | 列出提交历史 | ✅ | ✅ | ✅ |
| `repo_search_code` | 搜索代码 | ✅ | ❌ | ❌ |
| `repo_list_releases` | 列出 Releases | ✅ | ✅ | ✅ |
| `issue_list` | 列出 Issues | ✅ | ✅ | ✅ |
| `issue_get` | 获取 Issue 详情 | ✅ | ✅ | ✅ |
| `issue_search` | 搜索 Issues | ✅ | ❌ | ❌ |
| `pr_list` | 列出 PRs/MRs | ✅ | ✅ | ✅ |
| `pr_get` | 获取 PR/MR 详情 | ✅ | ✅ | ✅ |
| `pr_get_diff` | 获取 PR/MR 文件变更 | ✅ | ✅ | ❌ |
| `user_get_me` | 获取当前用户信息 | ✅ | ❌ | ✅ |
| `user_search` | 搜索用户 | ✅ | ✅ | ✅ |

## 调用格式

### 单条调用

每次调用必须指定 `platform` 参数（值为 `github`、`gitlab` 或 `gitee`）。

```
<<<[TOOL_REQUEST]>>>
tool_name: GitSearch,
platform: github,
command: repo_get,
repo_owner: facebook,
repo_name: react
<<<[END_TOOL_REQUEST]>>>
```

### 批量调用

通过数字后缀参数同时执行多个操作：

```
<<<[TOOL_REQUEST]>>>
tool_name: GitSearch,
command1: repo_get,
platform1: github,
repo_owner1: facebook,
repo_name1: react,
command2: issue_list,
platform2: gitee,
repo_owner2: doocs,
repo_name2: advanced-java,
state2: open,
per_page2: 5
<<<[END_TOOL_REQUEST]>>>
```

### 通用参数

| 参数 | 说明 |
|------|------|
| `platform` | **必需** — 平台名称：`github` / `gitlab` / `gitee` |
| `command` | **必需** — 统一命令名，见上方14个工具列表 |
| `repo_owner` | 仓库所有者用户名/组织名（仓库相关命令必需） |
| `repo_name` | 仓库名称（仓库相关命令必需） |
| `path` | 文件路径（`repo_list_files` 可选，省略则列出根目录） |
| `ref` | 分支/tag/commit SHA（`repo_list_files` / `repo_list_commits` 可选） |
| `issue_number` | Issue 编号（`issue_get` 必需） |
| `pr_number` | PR/MR 编号（`pr_get` / `pr_get_diff` 必需） |
| `query` | 搜索关键词（搜索类命令必需） |
| `state` | 状态筛选：`open` / `closed` / `all` / `merged` |
| `page` | 页码（列表/搜索类命令可选，默认1） |
| `per_page` | 每页数量（列表/搜索类命令可选，默认30，最大100） |

## API 验证状态

已通过 `curl` 和 `dryrun` 验证所有功能的可用性：

- **GitHub**: 13/14 通过（`repo_search_code` 需要 Token 认证，为预期行为）
- **GitLab**: 11/12 通过（`user_search` 需要 Token 认证，为预期行为）
- **Gitee**: 11/11 全部通过

## 依赖

本插件仅依赖 VCPToolBox 已有的 `axios` 包，未引入任何新依赖。

## 技术细节

- **通信方式**: stdin/stdout JSON 交互（VCP 同步插件规范）
- **HTTP 客户端**: axios
- **错误处理**: 统一的错误码转换（404→资源不存在，401/403→认证失败，429→限流）
- **响应格式**: Markdown 字符串（表格、列表、代码块等）
- **批量调用**: 自动识别 `command1`/`command2`... 数字后缀参数
