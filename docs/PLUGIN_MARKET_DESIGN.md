# VCPToolBox 插件市场模块技术设计

**版本:** Draft 1.0  
**创建日期:** 2026-03-23  
**适用范围:** VCPToolBox AdminPanel / Plugin Runtime / Admin API  
**目标状态:** 从“本地插件管理器”演进为“完整插件市场系统”

---

## 1. 文档目的

本文档定义 VCPToolBox “插件市场模块”的完整技术设计，覆盖以下内容：

- 系统目标与边界
- 模块拆分与目录结构
- 页面结构与前端交互
- 后端服务层设计
- API 接口契约
- 本地状态文件与远程仓库索引格式
- 安装、升级、卸载、恢复的事务流程
- 安全策略与审批边界
- 分阶段推进计划与验收标准

本文档用于约束后续实现，避免“先做 UI，后补协议”导致的返工。

---

## 2. 现状基线

当前仓库已经具备插件市场的部分基础能力：

- 运行时插件总控仍由 `Plugin.js` 负责
- 管理入口已经位于 `routes/admin/plugins.js`
- AdminPanel 已有插件列表与插件配置页
- 已支持本地 zip 安装、启用/禁用、卸载到 `Plugin/.trash`、从 `.trash` 恢复
- 已支持安装后依赖提示，但尚不支持自动依赖安装

这意味着插件市场模块不应替换当前运行时，而应在其外层新增一层“市场服务层”。

### 2.1 当前职责边界

- `Plugin.js`
  - 负责插件发现、加载、禁用态识别、热重载
- `routes/admin/plugins.js`
  - 负责插件管理类 API
- `AdminPanel/js/plugins.js`
  - 负责插件管理页前端交互
- `AdminPanel/index.html`
  - 负责页面承载与导航入口

### 2.2 当前缺口

- 没有远程仓库 catalog
- 没有统一的本地插件状态存储
- 没有安装任务中心
- 没有升级闭环
- 没有仓库管理
- 没有安全策略中心
- 没有事务式失败回滚规范

---

## 3. 设计目标

### 3.1 总目标

在不破坏当前插件运行时的前提下，为 VCPToolBox 增加一个完整的插件市场能力层，支持：

- 浏览市场
- 搜索、分类、标签筛选
- 查看插件详情
- 从远程仓库下载安装插件
- 本地 zip 安装
- 启用、禁用、卸载、恢复
- 检查更新与升级
- 安装前预检
- 风险提示与审批
- 失败回滚

### 3.2 非目标

以下内容不作为第一阶段强制目标：

- 在线评分、评论、社区讨论
- 自动执行 `npm install` / `pip install`
- 自动编译 Rust / 原生扩展
- 第三方支付、商业授权
- 多租户权限体系

---

## 4. 设计原则

### 4.1 运行时与市场层解耦

插件市场只负责“发现、下载、预检、安装、升级、卸载、恢复、状态记录”，不直接承担插件执行逻辑。  
插件真正的运行与重载仍由 `Plugin.js` 负责。

### 4.2 先事务，再体验

安装链路必须先可回滚、可审计，再去做前端市场体验。  
如果没有事务和失败回滚，市场 UI 越完整，风险越大。

### 4.3 默认保守

默认不自动执行外部依赖安装，不自动执行 shell，不信任任意仓库。

### 4.4 状态显式化

插件市场相关状态必须落盘，不能只依赖内存：

- 仓库状态
- 本地安装状态
- 安装任务状态
- 审批与安全策略

---

## 5. 总体架构

### 5.1 架构分层

```text
AdminPanel UI
  |- 插件市场首页
  |- 插件列表
  |- 插件详情页
  |- 安装任务中心
  |- 本地插件管理
  `- 仓库管理

Admin API Router
  |- /admin_api/plugin-market/repositories
  |- /admin_api/plugin-market/catalog
  |- /admin_api/plugin-market/packages
  |- /admin_api/plugin-market/tasks
  |- /admin_api/plugin-market/installed
  `- /admin_api/plugin-market/trash

Plugin Market Service Layer
  |- RepositoryManager
  |- CatalogService
  |- ManifestValidator
  |- PackageFetcher
  |- InstallPlanner
  |- InstallManager
  |- DependencyInspector
  |- TrashManager
  |- StateStore
  `- SecurityPolicy

Plugin Runtime
  `- Plugin.js

Storage
  |- Plugin/
  |- Plugin/.trash/
  |- Plugin/.market-cache/
  |- plugin-market.repositories.json
  |- plugin-market.state.json
  `- plugin-market.tasks.json
```

### 5.2 调用方向

- AdminPanel 只调用 Admin API
- Router 只做参数校验、鉴权、响应格式化
- 业务逻辑放到 `modules/pluginMarket/`
- `InstallManager` 在成功安装后调用 `pluginManager.loadPlugins()`

---

## 6. 目录规划

建议新增以下目录和文件：

```text
VCPToolBox/
|- modules/
|  `- pluginMarket/
|     |- RepositoryManager.js
|     |- CatalogService.js
|     |- ManifestValidator.js
|     |- PackageFetcher.js
|     |- InstallPlanner.js
|     |- InstallManager.js
|     |- DependencyInspector.js
|     |- TrashManager.js
|     |- StateStore.js
|     |- SecurityPolicy.js
|     `- schemas/
|        |- repository-index.schema.json
|        |- local-state.schema.json
|        |- task-state.schema.json
|        `- install-plan.schema.json
|- routes/
|  `- admin/
|     `- pluginMarket.js
|- AdminPanel/
|  |- plugin_market.html                  # 可选，若继续沿用单页可不新增
|  `- js/
|     |- plugin-market.js
|     |- plugin-market-repositories.js
|     |- plugin-market-catalog.js
|     |- plugin-market-details.js
|     |- plugin-market-tasks.js
|     `- plugin-market-installed.js
|- Plugin/
|  |- .trash/
|  `- .market-cache/
|- plugin-market.repositories.json
|- plugin-market.state.json
`- plugin-market.tasks.json
```

### 6.1 模块职责

#### `RepositoryManager.js`

职责：

- 管理仓库源增删改查
- 拉取远程仓库索引
- 管理索引缓存过期时间
- 对多个仓库的启用状态和优先级排序

#### `CatalogService.js`

职责：

- 聚合多个仓库索引
- 处理重复插件与版本冲突
- 提供搜索、分类、标签筛选
- 输出“前端可直接消费”的 catalog 数据

#### `ManifestValidator.js`

职责：

- 校验仓库索引中的插件声明
- 校验安装包内 `plugin-manifest.json`
- 校验版本兼容性字段
- 校验权限声明字段合法性

#### `PackageFetcher.js`

职责：

- 远程下载 zip
- 本地缓存 zip
- hash 校验
- 文件大小限制
- 下载失败重试

#### `InstallPlanner.js`

职责：

- 生成安装计划
- 冲突检查
- 兼容性检查
- 风险提示生成
- 安装前审批项生成

#### `InstallManager.js`

职责：

- 执行本地 zip 安装
- 执行远程包安装
- 执行升级
- 失败回滚
- 写本地状态
- 调用 `pluginManager.loadPlugins()`

#### `DependencyInspector.js`

职责：

- 检测 `package.json`
- 检测 `requirements.txt`
- 检测 `pyproject.toml`
- 预留 `Cargo.toml` 检测能力
- 输出依赖提示，不直接执行安装

#### `TrashManager.js`

职责：

- 插件卸载到 `.trash`
- 枚举 `.trash`
- 恢复 `.trash`
- 彻底删除回收站条目

#### `StateStore.js`

职责：

- 维护本地安装状态
- 维护任务状态
- 维护仓库缓存元数据
- 提供一致的读写 API

#### `SecurityPolicy.js`

职责：

- 仓库白名单
- 权限审批策略
- 风险级别计算
- 是否允许自动安装依赖

---

## 7. 页面规划

插件市场建议作为 AdminPanel 中的一个一级大项，下面包含 5 个主要页面视图。

### 7.1 页面树

```text
插件市场
  |- 市场首页
  |- 浏览插件
  |- 插件详情
  |- 安装任务
  |- 已安装插件
  `- 仓库管理
```

### 7.2 市场首页

用途：

- 展示官方推荐
- 最新更新
- 仓库同步状态
- 可升级插件数量
- 安装失败任务提示

模块：

- 推荐插件卡片
- 最新更新卡片
- 本地状态摘要卡片
- 仓库同步摘要卡片
- 最近任务卡片

### 7.3 浏览插件

用途：

- 浏览 catalog
- 搜索、分类筛选、标签筛选
- 查看“已安装 / 未安装 / 可升级 / 已禁用”

筛选维度：

- 分类
- 标签
- 运行时
- 平台
- 来源仓库
- 是否已安装
- 是否可升级

列表项信息：

- 图标
- `displayName`
- `name`
- 当前版本
- 最新版本
- 插件类型
- 来源仓库
- 权限风险级别
- 操作按钮

### 7.4 插件详情页

用途：

- 完整展示插件元信息和操作入口

展示内容：

- 插件名称、别名、版本
- 作者、主页、仓库来源
- 详细描述
- changelog
- screenshots
- 权限声明
- 运行时要求
- 兼容的 ToolBox 版本
- 依赖提示
- 安装 / 升级 / 禁用 / 启用 / 卸载 / 恢复按钮

### 7.5 安装任务中心

用途：

- 展示正在进行和历史任务

任务类型：

- refresh-catalog
- install-local
- install-remote
- upgrade
- uninstall
- restore

任务状态：

- queued
- running
- success
- failed
- rolled_back
- cancelled

任务详情：

- 开始时间
- 结束时间
- 插件名
- 来源仓库
- 目标版本
- 失败原因
- 回滚结果

### 7.6 已安装插件页

用途：

- 管理本地插件状态

操作：

- 启用
- 禁用
- 升级
- 卸载
- 打开配置
- 查看安装来源
- 查看回收站可恢复版本

### 7.7 仓库管理页

用途：

- 管理官方仓库和私有仓库

操作：

- 添加仓库
- 编辑仓库
- 启用/禁用仓库
- 刷新仓库
- 调整优先级
- 查看最近同步结果

---

## 8. 数据结构设计

## 8.1 仓库配置文件 `plugin-market.repositories.json`

建议结构：

```json
{
  "version": 1,
  "updatedAt": "2026-03-23T10:00:00.000Z",
  "repositories": [
    {
      "id": "official",
      "name": "VCP Official Market",
      "url": "https://example.com/plugins.json",
      "enabled": true,
      "priority": 100,
      "type": "remote",
      "authType": "none",
      "allowUntrusted": false,
      "cacheTtlSeconds": 3600
    }
  ]
}
```

字段说明：

- `version`
  - 本地配置格式版本
- `repositories`
  - 仓库列表
- `id`
  - 仓库稳定标识
- `priority`
  - 数字越大优先级越高
- `allowUntrusted`
  - 是否允许未签名/未校验仓库

## 8.2 仓库索引 `plugins.json`

建议结构：

```json
{
  "schemaVersion": 1,
  "repository": {
    "id": "official",
    "name": "VCP Official Market",
    "homepage": "https://example.com",
    "generatedAt": "2026-03-23T10:00:00.000Z"
  },
  "plugins": [
    {
      "id": "com.vcp.dailyhot",
      "name": "DailyHot",
      "displayName": "热点聚合器",
      "version": "1.2.0",
      "description": "聚合多源热点信息",
      "pluginType": "service",
      "entryPoint": "index.js",
      "category": "content",
      "tags": ["news", "crawler"],
      "authors": ["VCP Team"],
      "homepage": "https://example.com/plugins/dailyhot",
      "downloadUrl": "https://example.com/packages/DailyHot-1.2.0.zip",
      "hash": {
        "algorithm": "sha256",
        "value": "abc123"
      },
      "size": 123456,
      "minToolBoxVersion": "6.4.0",
      "maxToolBoxVersion": null,
      "platforms": ["win32", "linux"],
      "runtime": {
        "node": ">=18",
        "python": ">=3.10"
      },
      "dependencies": {
        "npm": true,
        "pip": false,
        "cargo": false
      },
      "permissions": [
        "network",
        "filesystem"
      ],
      "screenshots": [],
      "changelog": "新增多源聚合支持"
    }
  ]
}
```

### 8.2.1 必填字段

- `id`
- `name`
- `displayName`
- `version`
- `pluginType`
- `entryPoint`
- `downloadUrl`
- `hash`

### 8.2.2 推荐字段

- `category`
- `tags`
- `authors`
- `runtime`
- `dependencies`
- `permissions`
- `homepage`
- `changelog`

## 8.3 本地状态文件 `plugin-market.state.json`

建议结构：

```json
{
  "version": 1,
  "updatedAt": "2026-03-23T10:00:00.000Z",
  "installedPlugins": {
    "DailyHot": {
      "pluginName": "DailyHot",
      "displayName": "热点聚合器",
      "installedVersion": "1.2.0",
      "sourceType": "repository",
      "sourceRepositoryId": "official",
      "sourcePackageUrl": "https://example.com/packages/DailyHot-1.2.0.zip",
      "pluginFolder": "DailyHot",
      "enabled": true,
      "installedAt": "2026-03-23T10:00:00.000Z",
      "updatedAt": "2026-03-23T10:00:00.000Z",
      "lastCheckResult": {
        "hasUpdate": false,
        "latestVersion": "1.2.0",
        "checkedAt": "2026-03-23T11:00:00.000Z"
      },
      "dependencyHints": [
        {
          "type": "npm",
          "file": "package.json",
          "message": "需要手动执行 npm install"
        }
      ]
    }
  }
}
```

## 8.4 任务状态文件 `plugin-market.tasks.json`

建议结构：

```json
{
  "version": 1,
  "updatedAt": "2026-03-23T10:00:00.000Z",
  "tasks": [
    {
      "taskId": "task_1742724000_001",
      "type": "install-remote",
      "status": "success",
      "pluginName": "DailyHot",
      "pluginVersion": "1.2.0",
      "repositoryId": "official",
      "createdAt": "2026-03-23T10:00:00.000Z",
      "startedAt": "2026-03-23T10:00:02.000Z",
      "finishedAt": "2026-03-23T10:00:12.000Z",
      "steps": [
        { "name": "download", "status": "success" },
        { "name": "verify", "status": "success" },
        { "name": "extract", "status": "success" },
        { "name": "install", "status": "success" },
        { "name": "reload", "status": "success" }
      ],
      "error": null,
      "rollback": null
    }
  ]
}
```

## 8.5 安全策略文件 `plugin-market.policy.json`

建议结构：

```json
{
  "version": 1,
  "allowRemoteRepositories": true,
  "allowLocalZipInstall": true,
  "allowAutomaticDependencyInstall": false,
  "requireApprovalForPermissions": [
    "shell",
    "ssh",
    "filesystem-write",
    "network"
  ],
  "allowedRepositoryIds": ["official"],
  "blockedPluginNames": [],
  "maxPackageSizeBytes": 52428800
}
```

---

## 9. 接口设计

所有接口建议挂载到新前缀：

```text
/admin_api/plugin-market/*
```

原因：

- 与现有 `/admin_api/plugins/*` 区分
- 便于渐进式迁移
- 保持“插件运行管理”和“插件市场管理”分层

### 9.1 仓库接口

#### `GET /admin_api/plugin-market/repositories`

用途：

- 获取仓库列表

响应：

```json
{
  "repositories": [
    {
      "id": "official",
      "name": "VCP Official Market",
      "enabled": true,
      "priority": 100,
      "type": "remote",
      "lastSyncAt": "2026-03-23T10:00:00.000Z",
      "lastSyncStatus": "success"
    }
  ]
}
```

#### `POST /admin_api/plugin-market/repositories`

用途：

- 新增仓库

请求体：

```json
{
  "name": "Private Repo",
  "url": "https://example.com/plugins.json",
  "type": "remote",
  "enabled": true
}
```

#### `POST /admin_api/plugin-market/repositories/:repositoryId/refresh`

用途：

- 刷新单个仓库索引

#### `POST /admin_api/plugin-market/repositories/refresh-all`

用途：

- 刷新全部仓库索引

### 9.2 Catalog 接口

#### `GET /admin_api/plugin-market/catalog`

查询参数：

- `q`
- `category`
- `tag`
- `repositoryId`
- `installed`
- `upgradable`
- `page`
- `pageSize`

响应：

```json
{
  "items": [
    {
      "pluginName": "DailyHot",
      "displayName": "热点聚合器",
      "latestVersion": "1.2.0",
      "installedVersion": "1.1.0",
      "isInstalled": true,
      "hasUpdate": true,
      "repositoryId": "official",
      "category": "content",
      "tags": ["news"]
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 1
  }
}
```

#### `GET /admin_api/plugin-market/catalog/:pluginName`

用途：

- 获取插件详情

### 9.3 安装接口

#### `POST /admin_api/plugin-market/install/local-zip`

用途：

- 通过服务器本机 zip 路径安装插件

请求体：

```json
{
  "zipPath": "C:\\Plugins\\DailyHot.zip"
}
```

响应：

```json
{
  "taskId": "task_001",
  "pluginName": "DailyHot",
  "message": "插件已安装并完成热加载。",
  "dependencyHints": [
    {
      "type": "npm",
      "file": "package.json",
      "message": "需要手动执行 npm install"
    }
  ]
}
```

#### `POST /admin_api/plugin-market/install/repository`

用途：

- 从仓库安装插件

请求体：

```json
{
  "repositoryId": "official",
  "pluginName": "DailyHot",
  "version": "1.2.0"
}
```

### 9.4 预检接口

#### `POST /admin_api/plugin-market/plan/install`

用途：

- 在真正安装前生成预检结果

请求体：

```json
{
  "repositoryId": "official",
  "pluginName": "DailyHot",
  "version": "1.2.0"
}
```

响应：

```json
{
  "ok": true,
  "riskLevel": "medium",
  "requiresApproval": true,
  "conflicts": [],
  "dependencyHints": [
    {
      "type": "npm",
      "file": "package.json",
      "message": "需要手动执行 npm install"
    }
  ],
  "permissions": ["network", "filesystem"],
  "compatibility": {
    "toolbox": "ok",
    "platform": "ok",
    "runtime": "ok"
  }
}
```

### 9.5 已安装插件接口

#### `GET /admin_api/plugin-market/installed`

用途：

- 获取本地已安装插件及状态

#### `POST /admin_api/plugin-market/installed/:pluginName/toggle`

用途：

- 启用或禁用插件

#### `POST /admin_api/plugin-market/installed/:pluginName/uninstall`

用途：

- 卸载到 `.trash`

### 9.6 升级接口

#### `POST /admin_api/plugin-market/installed/:pluginName/upgrade`

用途：

- 升级到最新版本或指定版本

请求体：

```json
{
  "targetVersion": "1.2.0"
}
```

### 9.7 回收站接口

#### `GET /admin_api/plugin-market/trash`

用途：

- 获取可恢复插件列表

#### `POST /admin_api/plugin-market/trash/:trashedFolderName/restore`

用途：

- 恢复插件

#### `DELETE /admin_api/plugin-market/trash/:trashedFolderName`

用途：

- 永久删除回收站条目

### 9.8 任务中心接口

#### `GET /admin_api/plugin-market/tasks`

用途：

- 查询任务历史

查询参数：

- `status`
- `type`
- `pluginName`
- `page`
- `pageSize`

#### `GET /admin_api/plugin-market/tasks/:taskId`

用途：

- 查询任务详情

---

## 10. 核心流程设计

### 10.1 仓库刷新流程

```text
AdminPanel 点击刷新仓库
  -> RepositoryManager 拉取 plugins.json
  -> ManifestValidator 校验 schema
  -> StateStore 写入本地缓存
  -> CatalogService 重建聚合 catalog
  -> 返回同步结果
```

### 10.2 本地 zip 安装流程

```text
选择 zip 路径
  -> InstallPlanner 预检
  -> InstallManager 创建任务
  -> 解压到临时目录
  -> ManifestValidator 校验 manifest
  -> DependencyInspector 生成依赖提示
  -> 复制到 Plugin/<folder>
  -> StateStore 写 installed 状态
  -> pluginManager.loadPlugins()
  -> 记录任务完成
```

### 10.3 仓库安装流程

```text
选择插件版本
  -> InstallPlanner 预检
  -> SecurityPolicy 判断是否需审批
  -> PackageFetcher 下载 zip 到 .market-cache
  -> 校验 hash / size
  -> InstallManager 执行安装
  -> 写本地状态
  -> 重载插件
```

### 10.4 升级流程

```text
检查更新
  -> 目标版本预检
  -> 将旧插件目录转存到临时备份区
  -> 安装新版本
  -> 成功则更新 state
  -> 失败则回滚旧版本并记录 rolled_back
```

### 10.5 卸载流程

```text
点击卸载
  -> TrashManager 生成回收站目录名
  -> 移动 Plugin/<folder> 到 Plugin/.trash/
  -> 更新 state
  -> pluginManager.loadPlugins()
  -> 写任务记录
```

### 10.6 恢复流程

```text
点击恢复
  -> TrashManager 校验回收站条目
  -> 检查当前 Plugin/ 是否存在冲突目录或同名插件
  -> 恢复目录
  -> 更新 state
  -> pluginManager.loadPlugins()
```

---

## 11. 安装事务与回滚

### 11.1 为什么必须事务化

插件市场最危险的操作是“覆盖已安装插件”。  
如果升级失败但旧版本已被删除，系统会进入不一致状态。

### 11.2 事务步骤

对于安装和升级，统一采用以下事务步骤：

1. 创建任务记录
2. 生成临时工作目录
3. 下载或解压到临时目录
4. 校验包与 manifest
5. 生成安装计划
6. 如为升级，先备份旧目录
7. 拷贝或移动到目标目录
8. 调用 `pluginManager.loadPlugins()`
9. 更新本地状态
10. 标记任务成功

### 11.3 回滚条件

以下情况触发回滚：

- manifest 校验失败
- 目标目录写入失败
- 插件热重载失败
- 状态文件写入失败

### 11.4 回滚动作

- 删除新写入的目标目录
- 还原旧目录
- 重新触发 `pluginManager.loadPlugins()`
- 记录回滚结果

---

## 12. 安全设计

### 12.1 风险分级

建议按权限声明计算风险等级：

- `low`
  - 无额外权限
- `medium`
  - `network`
  - `filesystem-read`
- `high`
  - `filesystem-write`
  - `ssh`
  - `shell`

### 12.2 默认安全策略

- 默认不自动执行依赖安装
- 默认只允许白名单仓库
- 默认对高风险权限安装进行审批
- 默认限制包大小
- 默认要求 hash 校验

### 12.3 审批点

以下情况要求显示确认或审批：

- 新增 `shell` 权限
- 新增 `ssh` 权限
- 新增 `filesystem-write` 权限
- 来自非白名单仓库
- hash 缺失或校验失败

### 12.4 日志与审计

应记录：

- 谁安装了插件
- 插件来自哪个仓库
- 下载地址
- 目标版本
- 权限声明
- 是否审批通过
- 安装结果

---

## 13. 与现有系统的集成方式

### 13.1 与 `Plugin.js` 的关系

不修改其主职责，只通过公开实例完成：

- 安装后热重载
- 升级后热重载
- 卸载后热重载
- 恢复后热重载

### 13.2 与现有 `/admin_api/plugins` 的关系

建议保留现有接口用于：

- 简单插件启停
- 插件配置编辑
- 兼容旧前端

新市场接口统一放到 `/admin_api/plugin-market`

### 13.3 与 AdminPanel 的关系

短期：

- 在现有单页中新增“插件市场”入口和 section

中期：

- 逐步拆分为 `plugin-market.js` 等独立模块

---

## 14. 分阶段推进计划

## 14.1 Phase 0：协议冻结

目标：

- 固化 catalog schema
- 固化 state schema
- 固化 task schema
- 固化权限与审批字段

产出：

- 本设计文档
- schema 文件

验收标准：

- schema 经本地校验通过
- 前后端使用同一套字段命名

## 14.2 Phase 1：本地插件中心稳定化

目标：

- 整理现有本地安装、卸载、恢复逻辑
- 引入 `StateStore`

产出：

- `InstallManager`
- `TrashManager`
- `StateStore`
- 已安装插件状态页

验收标准：

- 本地 zip 安装成功
- 卸载到 `.trash` 成功
- 从 `.trash` 恢复成功
- 状态文件正确更新

## 14.3 Phase 2：仓库接入与 catalog 浏览

目标：

- 引入仓库与市场浏览能力，不要求安装

产出：

- `RepositoryManager`
- `CatalogService`
- 仓库管理页
- 市场列表页
- 插件详情页

验收标准：

- 能拉取并缓存远程 catalog
- 能搜索与筛选
- 能查看插件详情

## 14.4 Phase 3：远程下载安装

目标：

- 从仓库下载并安装插件

产出：

- `PackageFetcher`
- `InstallPlanner`
- 远程安装 API
- 任务中心基础版

验收标准：

- 远程 zip 下载成功
- hash 校验成功
- 安装成功并热重载
- 失败时可回滚

## 14.5 Phase 4：升级系统

目标：

- 补齐升级和检查更新能力

产出：

- 检查更新
- 单插件升级
- 批量可升级列表
- 升级回滚

验收标准：

- 本地版本与 catalog 可比较
- 升级成功后状态更新正确
- 升级失败时旧版本可恢复

## 14.6 Phase 5：安全与审批

目标：

- 让插件市场具备生产可用的最小安全性

产出：

- `SecurityPolicy`
- 权限提示
- 仓库白名单
- 审批记录

验收标准：

- 高风险插件默认被拦截或要求审批
- 非白名单仓库有明确提示
- 安装审计记录完整

## 14.7 Phase 6：高级能力

目标：

- 提升可用性与生态体验

产出：

- 本地上传 zip
- changelog 与截图支持
- 私有仓库
- 包签名
- 插件依赖图

---

## 15. 验收矩阵

### 15.1 核心功能验收

| 功能 | 验收条件 |
|------|----------|
| 本地 zip 安装 | 成功安装并可热重载 |
| 远程仓库刷新 | 成功缓存 catalog |
| 市场搜索 | 关键字、分类、标签筛选生效 |
| 插件详情 | 可展示版本、权限、依赖、来源 |
| 卸载 | 插件移动到 `.trash` |
| 恢复 | 可从 `.trash` 恢复并重新加载 |
| 升级 | 新版本生效，旧版本可回滚 |
| 状态落盘 | state/tasks/repositories 正确更新 |

### 15.2 异常验收

| 异常场景 | 预期行为 |
|----------|----------|
| 下载失败 | 任务失败，不污染已安装目录 |
| hash 校验失败 | 安装中止，记录任务失败 |
| manifest 缺失 | 安装中止，提示包不合法 |
| 同名冲突 | 阻止安装，要求用户处理 |
| 热重载失败 | 回滚并记录错误 |
| 状态写入失败 | 回滚安装结果 |

---

## 16. 开发顺序建议

实际编码顺序建议如下：

1. 建 `modules/pluginMarket/`
2. 先写 `StateStore`
3. 再写 `TrashManager`
4. 再写 `DependencyInspector`
5. 再写 `InstallManager`
6. 再写 `RepositoryManager`
7. 再写 `CatalogService`
8. 再写 `InstallPlanner`
9. 最后接 AdminPanel 页面

原因：

- 先稳定本地状态与事务能力
- 再扩到远程仓库
- 避免 UI 先行导致后端协议反复改动

---

## 17. 待确认决策

以下事项建议在实现前确认：

1. 仓库索引是否强制要求 `hash`
2. 是否允许无截图插件进入官方市场
3. 是否允许插件声明 `shell` 权限
4. 升级时旧版本放 `.trash` 还是 `.backup`
5. 任务历史保留上限是多少
6. 是否支持离线 catalog 导入

---

## 18. 推荐里程碑

建议首先完成：

### Milestone A：插件市场骨架可用版

包括：

- `StateStore`
- `TrashManager`
- `RepositoryManager`
- `CatalogService`
- 市场列表页
- 插件详情页
- 本地状态页

不包括：

- 自动依赖安装
- 包签名
- 高级审批流
- 评论评分

该里程碑完成后，系统将具备“看起来像插件市场，底层也足够稳”的基础形态。

