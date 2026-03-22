# VCPToolBox 插件市场模块实施清单

**版本:** Draft 1.0  
**创建日期:** 2026-03-23  
**关联文档:** [PLUGIN_MARKET_DESIGN.md](./PLUGIN_MARKET_DESIGN.md)

---

## 1. 文档目的

本文档把 [PLUGIN_MARKET_DESIGN.md](./PLUGIN_MARKET_DESIGN.md) 进一步拆成可执行的实施清单，重点覆盖：

- 接口清单
- 文件清单
- 页面清单
- 状态文件清单
- 分阶段开发任务拆分
- 每阶段验收点

本文档的目标不是再次描述架构，而是让后续实现能直接按清单推进。

---

## 2. 实施范围总览

```text
Phase 0
  |- schema 与状态格式冻结
  `- 基础目录与文件骨架

Phase 1
  |- 本地插件状态存储
  |- 本地 zip 安装服务整理
  |- 卸载/恢复服务整理
  `- 已安装插件页

Phase 2
  |- 仓库管理
  |- catalog 拉取与缓存
  |- 市场列表页
  `- 插件详情页

Phase 3
  |- 远程下载安装
  |- 预检/安装计划
  `- 安装任务中心

Phase 4
  |- 检查更新
  |- 升级
  `- 升级回滚

Phase 5
  |- 安全策略
  |- 风险提示
  `- 审批与审计
```

---

## 3. 接口清单

## 3.1 路由文件

建议新增：

- `routes/admin/pluginMarket.js`

现有：

- `routes/admin/plugins.js`

建议策略：

- 旧路由继续保留，作为兼容层
- 新市场接口全部进入 `pluginMarket.js`
- 后续只在兼容需要时调用旧接口

---

## 3.2 仓库接口

### `GET /admin_api/plugin-market/repositories`

用途：

- 获取仓库列表和同步状态

输入：

- 无

输出字段：

- `repositories[].id`
- `repositories[].name`
- `repositories[].url`
- `repositories[].enabled`
- `repositories[].priority`
- `repositories[].type`
- `repositories[].lastSyncAt`
- `repositories[].lastSyncStatus`
- `repositories[].lastSyncError`

依赖模块：

- `RepositoryManager`
- `StateStore`

### `POST /admin_api/plugin-market/repositories`

用途：

- 新增仓库

请求体：

- `name`
- `url`
- `type`
- `enabled`
- `priority`

校验：

- URL 必须合法
- `id` 自动生成或后端规范化
- 同 URL 不允许重复

依赖模块：

- `RepositoryManager`
- `StateStore`

### `POST /admin_api/plugin-market/repositories/:repositoryId/refresh`

用途：

- 刷新单个仓库

输出字段：

- `repositoryId`
- `status`
- `pluginCount`
- `fetchedAt`
- `error`

依赖模块：

- `RepositoryManager`
- `CatalogService`
- `ManifestValidator`
- `StateStore`

### `POST /admin_api/plugin-market/repositories/refresh-all`

用途：

- 刷新全部仓库

输出字段：

- `results[]`
- `successCount`
- `failedCount`

---

## 3.3 Catalog 接口

### `GET /admin_api/plugin-market/catalog`

用途：

- 获取聚合后的插件列表

查询参数：

- `q`
- `category`
- `tag`
- `repositoryId`
- `installed`
- `upgradable`
- `page`
- `pageSize`
- `sortBy`

输出字段：

- `items[].pluginName`
- `items[].displayName`
- `items[].description`
- `items[].latestVersion`
- `items[].installedVersion`
- `items[].isInstalled`
- `items[].hasUpdate`
- `items[].repositoryId`
- `items[].category`
- `items[].tags`
- `items[].riskLevel`
- `items[].pluginType`
- `pagination`

依赖模块：

- `CatalogService`
- `StateStore`

### `GET /admin_api/plugin-market/catalog/:pluginName`

用途：

- 获取插件详情

输出字段：

- 基础信息
- 版本信息
- 仓库来源
- 权限声明
- 兼容性信息
- 依赖提示
- 是否已安装
- 是否可升级
- changelog
- screenshots

依赖模块：

- `CatalogService`
- `StateStore`

---

## 3.4 安装与预检接口

### `POST /admin_api/plugin-market/plan/install`

用途：

- 生成安装预检结果

请求体：

- `sourceType`
- `repositoryId`
- `pluginName`
- `version`
- `zipPath`

输出字段：

- `ok`
- `riskLevel`
- `requiresApproval`
- `conflicts`
- `permissions`
- `dependencyHints`
- `compatibility`
- `targetFolder`

依赖模块：

- `InstallPlanner`
- `ManifestValidator`
- `DependencyInspector`
- `SecurityPolicy`

### `POST /admin_api/plugin-market/install/local-zip`

用途：

- 本地 zip 安装

请求体：

- `zipPath`

输出字段：

- `taskId`
- `pluginName`
- `installedPath`
- `warnings`
- `dependencyHints`

依赖模块：

- `InstallManager`
- `DependencyInspector`
- `StateStore`

### `POST /admin_api/plugin-market/install/repository`

用途：

- 从仓库安装

请求体：

- `repositoryId`
- `pluginName`
- `version`

输出字段：

- `taskId`
- `pluginName`
- `downloadedPackagePath`
- `warnings`
- `dependencyHints`

依赖模块：

- `PackageFetcher`
- `InstallPlanner`
- `InstallManager`
- `StateStore`

---

## 3.5 已安装插件接口

### `GET /admin_api/plugin-market/installed`

用途：

- 获取本地已安装插件及状态

输出字段：

- `items[].pluginName`
- `items[].displayName`
- `items[].installedVersion`
- `items[].enabled`
- `items[].sourceType`
- `items[].sourceRepositoryId`
- `items[].hasUpdate`
- `items[].dependencyHints`
- `items[].pluginFolder`

依赖模块：

- `StateStore`
- `CatalogService`

### `POST /admin_api/plugin-market/installed/:pluginName/toggle`

用途：

- 启用/禁用插件

请求体：

- `enable`

依赖模块：

- 兼容调用现有插件启停逻辑
- `StateStore`

### `POST /admin_api/plugin-market/installed/:pluginName/uninstall`

用途：

- 卸载插件到 `.trash`

输出字段：

- `taskId`
- `pluginName`
- `trashedPath`

依赖模块：

- `TrashManager`
- `StateStore`
- `InstallManager`

### `POST /admin_api/plugin-market/installed/:pluginName/upgrade`

用途：

- 升级插件

请求体：

- `targetVersion`

输出字段：

- `taskId`
- `pluginName`
- `fromVersion`
- `toVersion`
- `rollbackAvailable`

依赖模块：

- `InstallPlanner`
- `PackageFetcher`
- `InstallManager`
- `StateStore`

---

## 3.6 回收站接口

### `GET /admin_api/plugin-market/trash`

用途：

- 获取回收站条目

输出字段：

- `items[].trashedFolderName`
- `items[].pluginName`
- `items[].displayName`
- `items[].version`
- `items[].removedAt`
- `items[].originalFolderName`

依赖模块：

- `TrashManager`

### `POST /admin_api/plugin-market/trash/:trashedFolderName/restore`

用途：

- 恢复插件

输出字段：

- `taskId`
- `pluginName`
- `restoredPath`

依赖模块：

- `TrashManager`
- `StateStore`
- `InstallManager`

### `DELETE /admin_api/plugin-market/trash/:trashedFolderName`

用途：

- 永久删除回收站条目

输出字段：

- `deleted`
- `trashedFolderName`

依赖模块：

- `TrashManager`

---

## 3.7 任务中心接口

### `GET /admin_api/plugin-market/tasks`

用途：

- 获取任务列表

查询参数：

- `type`
- `status`
- `pluginName`
- `page`
- `pageSize`

输出字段：

- `items[].taskId`
- `items[].type`
- `items[].status`
- `items[].pluginName`
- `items[].createdAt`
- `items[].finishedAt`

依赖模块：

- `StateStore`

### `GET /admin_api/plugin-market/tasks/:taskId`

用途：

- 获取任务详情

输出字段：

- `taskId`
- `steps`
- `error`
- `rollback`
- `context`

依赖模块：

- `StateStore`

---

## 4. 文件清单

## 4.1 后端文件

### 必需文件

- `modules/pluginMarket/StateStore.js`
- `modules/pluginMarket/TrashManager.js`
- `modules/pluginMarket/DependencyInspector.js`
- `modules/pluginMarket/InstallManager.js`
- `modules/pluginMarket/RepositoryManager.js`
- `modules/pluginMarket/CatalogService.js`
- `modules/pluginMarket/InstallPlanner.js`
- `modules/pluginMarket/ManifestValidator.js`
- `modules/pluginMarket/PackageFetcher.js`
- `modules/pluginMarket/SecurityPolicy.js`
- `routes/admin/pluginMarket.js`

### 可选辅助文件

- `modules/pluginMarket/errors.js`
- `modules/pluginMarket/constants.js`
- `modules/pluginMarket/utils.js`

### schema 文件

- `modules/pluginMarket/schemas/repository-index.schema.json`
- `modules/pluginMarket/schemas/local-state.schema.json`
- `modules/pluginMarket/schemas/task-state.schema.json`
- `modules/pluginMarket/schemas/install-plan.schema.json`

---

## 4.2 前端文件

### 必需文件

- `AdminPanel/js/plugin-market.js`
- `AdminPanel/js/plugin-market-repositories.js`
- `AdminPanel/js/plugin-market-catalog.js`
- `AdminPanel/js/plugin-market-details.js`
- `AdminPanel/js/plugin-market-tasks.js`
- `AdminPanel/js/plugin-market-installed.js`

### 继续复用的文件

- `AdminPanel/index.html`
- `AdminPanel/script.js`
- `AdminPanel/js/utils.js`
- `AdminPanel/js/plugins.js`

### 前端 section / 容器

建议新增这些 section：

- `plugin-market-home-section`
- `plugin-market-catalog-section`
- `plugin-market-details-section`
- `plugin-market-tasks-section`
- `plugin-market-installed-section`
- `plugin-market-repositories-section`

---

## 4.3 状态文件

### 必需状态文件

- `plugin-market.repositories.json`
- `plugin-market.state.json`
- `plugin-market.tasks.json`
- `plugin-market.policy.json`

### 目录

- `Plugin/.market-cache/`
- `Plugin/.trash/`

---

## 5. 页面清单

## 5.1 插件市场首页

页面目标：

- 让用户一眼看到市场状态

页面模块：

- 推荐插件
- 最新更新
- 可升级数量
- 最近任务
- 仓库同步状态

必需交互：

- 点击推荐项进入详情
- 点击“查看全部”进入 catalog
- 点击“刷新仓库”触发 refresh-all

---

## 5.2 浏览插件页

页面目标：

- 浏览和筛选插件

页面模块：

- 搜索框
- 分类筛选
- 标签筛选
- 仓库筛选
- 已安装 / 可升级切换
- 插件卡片列表

必需交互：

- 搜索触发 catalog 查询
- 分类和标签组合筛选
- 点击卡片进入详情

---

## 5.3 插件详情页

页面目标：

- 承载全部操作入口

页面模块：

- 基础信息
- 版本信息
- 权限声明
- 依赖提示
- 兼容性
- changelog
- screenshots
- 操作按钮组

必需交互：

- 安装
- 预检
- 升级
- 启用
- 禁用
- 卸载

---

## 5.4 安装任务中心

页面目标：

- 让用户看到任务状态，不再“点了按钮没反馈”

页面模块：

- 正在执行任务
- 历史任务
- 任务详情抽屉/面板

必需交互：

- 点击任务查看详情
- 失败任务查看错误
- 查看回滚结果

---

## 5.5 已安装插件页

页面目标：

- 聚焦“本地管理”

页面模块：

- 已安装列表
- 已禁用列表
- 可升级列表
- 回收站入口

必需交互：

- 启用/禁用
- 升级
- 卸载
- 打开详情

---

## 5.6 仓库管理页

页面目标：

- 管理远程与私有仓库

页面模块：

- 仓库列表
- 新增仓库表单
- 刷新状态
- 错误状态提示

必需交互：

- 新增
- 编辑
- 启用/禁用
- 刷新单个仓库
- 刷新全部仓库

---

## 6. 模块实现顺序

## 6.1 第一批：状态与本地事务

顺序：

1. `StateStore.js`
2. `TrashManager.js`
3. `DependencyInspector.js`
4. `InstallManager.js`

目标：

- 先把“本地 zip 安装、卸载、恢复、状态写入”统一起来

完成标准：

- 能通过服务层完成安装、卸载、恢复
- 不再把复杂逻辑直接堆在路由文件里

## 6.2 第二批：仓库与 catalog

顺序：

1. `ManifestValidator.js`
2. `RepositoryManager.js`
3. `CatalogService.js`

目标：

- 打通远程索引获取和聚合 catalog

完成标准：

- 能从至少一个远程仓库获取 catalog
- 能按名称、标签、分类检索

## 6.3 第三批：安装预检与下载

顺序：

1. `SecurityPolicy.js`
2. `InstallPlanner.js`
3. `PackageFetcher.js`

目标：

- 建立“预检 -> 下载 -> 校验 -> 安装”的正式链路

完成标准：

- 远程安装有预检结果
- 下载失败不会污染本地目录

## 6.4 第四批：前端页面

顺序：

1. `plugin-market-repositories.js`
2. `plugin-market-catalog.js`
3. `plugin-market-details.js`
4. `plugin-market-installed.js`
5. `plugin-market-tasks.js`
6. `plugin-market.js`

目标：

- 让市场模块形成可操作的 UI

完成标准：

- 6 个主页面都可进入
- 主要操作都有反馈

---

## 7. 分阶段任务拆分表

## 7.1 Phase 0 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P0-01 | 创建 `modules/pluginMarket/` 目录 | 目录骨架 |
| P0-02 | 创建 schema 文件 | 4 个 schema |
| P0-03 | 创建空状态文件模板 | repositories/state/tasks/policy |
| P0-04 | 在 docs 中登记文档入口 | 文档可追踪 |

## 7.2 Phase 1 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P1-01 | 实现 `StateStore.js` | 状态读写 API |
| P1-02 | 实现 `TrashManager.js` | 卸载/恢复/删除 |
| P1-03 | 实现 `DependencyInspector.js` | 依赖提示结果 |
| P1-04 | 实现 `InstallManager.js` 本地安装链路 | 本地 zip 安装服务 |
| P1-05 | 新增 `routes/admin/pluginMarket.js` 本地管理接口 | 本地市场 API |
| P1-06 | 新增“已安装插件页”前端 | 本地管理 UI |

## 7.3 Phase 2 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P2-01 | 实现 `ManifestValidator.js` | manifest/schema 校验 |
| P2-02 | 实现 `RepositoryManager.js` | 仓库管理服务 |
| P2-03 | 实现 `CatalogService.js` | 聚合 catalog |
| P2-04 | 新增仓库管理 API | repositories 接口 |
| P2-05 | 新增 catalog API | catalog 接口 |
| P2-06 | 新增市场首页 / 浏览页 / 详情页 | 市场浏览 UI |

## 7.4 Phase 3 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P3-01 | 实现 `SecurityPolicy.js` | 风险策略服务 |
| P3-02 | 实现 `InstallPlanner.js` | 预检服务 |
| P3-03 | 实现 `PackageFetcher.js` | 下载和 hash 校验 |
| P3-04 | 新增远程安装 API | install/repository |
| P3-05 | 新增任务中心 API | tasks 接口 |
| P3-06 | 新增安装任务中心前端 | 任务 UI |

## 7.5 Phase 4 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P4-01 | 实现检查更新逻辑 | update check |
| P4-02 | 实现升级事务 | upgrade service |
| P4-03 | 新增升级 API | installed/:pluginName/upgrade |
| P4-04 | 在 catalog/installed UI 中显示升级状态 | 升级入口 |

## 7.6 Phase 5 任务表

| 编号 | 任务 | 输出 |
|------|------|------|
| P5-01 | 实现高风险权限拦截 | 风险分级 |
| P5-02 | 实现仓库白名单 | 仓库控制 |
| P5-03 | 实现审批记录 | 审计数据 |
| P5-04 | 在前端显示权限提示 | 安全确认 UI |

---

## 8. 验收清单

## 8.1 Phase 1 验收

- 本地 zip 安装成功
- 安装后状态写入 `plugin-market.state.json`
- 卸载进入 `.trash`
- 恢复成功后插件可再次加载
- 任务被记录到 `plugin-market.tasks.json`

## 8.2 Phase 2 验收

- 至少可配置 1 个远程仓库
- 能拉取 catalog 并缓存
- 能显示插件列表
- 能进入详情页

## 8.3 Phase 3 验收

- 远程插件可预检
- 下载包可 hash 校验
- 安装失败不破坏现有插件
- 任务中心能显示执行状态

## 8.4 Phase 4 验收

- 已安装插件可检测更新
- 可从旧版本升级到新版本
- 升级失败后自动回滚

## 8.5 Phase 5 验收

- 高风险插件安装前有明确确认
- 非白名单仓库有阻断或警告
- 审计记录可追踪

---

## 9. 建议的首轮落地范围

如果要立刻开始实现，建议先限定为：

### 首轮范围

- `StateStore.js`
- `TrashManager.js`
- `DependencyInspector.js`
- `InstallManager.js`
- `routes/admin/pluginMarket.js`
- `AdminPanel` 中的“已安装插件页”

### 暂缓范围

- 私有仓库
- 远程下载
- 升级
- 审批系统
- 自动依赖安装

原因：

- 这样能先把市场模块最危险的本地事务打稳
- 一旦本地链路稳定，远程市场能力再往上叠会更稳

---

## 10. 推荐执行顺序

建议下一步编码时严格按这个顺序推进：

1. 建目录和 schema
2. 写 `StateStore.js`
3. 写 `TrashManager.js`
4. 写 `DependencyInspector.js`
5. 写 `InstallManager.js`
6. 写 `pluginMarket.js` 路由
7. 接前端“已安装插件页”
8. 再进入仓库和 catalog 阶段

这能保证我们先把“会写磁盘、会改插件目录、会触发重载”的地方做稳。

