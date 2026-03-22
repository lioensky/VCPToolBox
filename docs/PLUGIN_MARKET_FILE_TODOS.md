# VCPToolBox 插件市场逐文件 TODO 清单

**版本:** Draft 1.0  
**创建日期:** 2026-03-23  
**关联文档:**  
- [PLUGIN_MARKET_DESIGN.md](./PLUGIN_MARKET_DESIGN.md)  
- [PLUGIN_MARKET_IMPLEMENTATION_PLAN.md](./PLUGIN_MARKET_IMPLEMENTATION_PLAN.md)

---

## 1. 文档目的

本文档把插件市场模块进一步拆到“逐文件”粒度，明确：

- 每个文件负责什么
- 每个文件建议导出哪些方法
- 每个方法的输入输出
- 每个文件的完成标准
- 文件间依赖关系

这份文档适合直接拿来排开发顺序、拆 worker 任务和做阶段验收。

---

## 2. 后端文件 TODO

## 2.1 `modules/pluginMarket/constants.js`

### 目标

集中维护插件市场相关常量，避免散落在各个模块里。

### 建议导出

```js
module.exports = {
  MARKET_STATE_VERSION,
  MARKET_TASKS_VERSION,
  MARKET_REPOSITORIES_VERSION,
  MARKET_POLICY_VERSION,
  MARKET_CACHE_DIRNAME,
  MARKET_TRASH_DIRNAME,
  DEFAULT_POLICY,
  TASK_STATUS,
  TASK_TYPES,
  RISK_LEVELS
};
```

### TODO

- 定义状态文件版本号
- 定义默认目录名
- 定义任务状态枚举
- 定义任务类型枚举
- 定义风险等级枚举
- 定义默认安全策略

### 完成标准

- 其他模块不再重复写字符串常量
- 任务状态、任务类型、目录名都有唯一来源

---

## 2.2 `modules/pluginMarket/errors.js`

### 目标

统一插件市场错误类型，避免到处扔通用 `Error`。

### 建议导出

```js
class PluginMarketError extends Error {}
class ValidationError extends PluginMarketError {}
class RepositoryError extends PluginMarketError {}
class InstallPlanError extends PluginMarketError {}
class InstallExecutionError extends PluginMarketError {}
class ConflictError extends PluginMarketError {}
class SecurityPolicyError extends PluginMarketError {}

module.exports = {
  PluginMarketError,
  ValidationError,
  RepositoryError,
  InstallPlanError,
  InstallExecutionError,
  ConflictError,
  SecurityPolicyError
};
```

### TODO

- 定义错误基类
- 定义可映射到 HTTP 状态码的错误子类
- 给错误加 `code` 和 `details`

### 完成标准

- 路由层可以根据错误类型返回明确状态码
- 任务中心可以保存结构化错误

---

## 2.3 `modules/pluginMarket/utils.js`

### 目标

提供插件市场通用工具方法。

### 建议导出

```js
module.exports = {
  ensureDir,
  readJsonFile,
  writeJsonFile,
  pathExists,
  sanitizeFolderName,
  resolvePathInside,
  createTaskId,
  nowIso,
  normalizeVersion,
  compareVersionsSafe
};
```

### TODO

- 封装 JSON 文件读写
- 封装安全路径解析
- 封装 taskId 生成
- 封装版本号比较
- 封装目录存在性检查

### 完成标准

- 文件读写逻辑从服务类中抽离
- 目录和路径处理有统一安全工具

---

## 2.4 `modules/pluginMarket/StateStore.js`

### 目标

成为插件市场状态文件的唯一读写入口。

### 管理文件

- `plugin-market.repositories.json`
- `plugin-market.state.json`
- `plugin-market.tasks.json`
- `plugin-market.policy.json`

### 建议导出

```js
class StateStore {
  constructor(options) {}

  async initialize() {}

  async getRepositories() {}
  async saveRepositories(data) {}

  async getInstalledState() {}
  async saveInstalledState(data) {}
  async upsertInstalledPlugin(pluginName, patch) {}
  async removeInstalledPlugin(pluginName) {}

  async getTasks() {}
  async appendTask(task) {}
  async updateTask(taskId, patch) {}
  async getTaskById(taskId) {}

  async getPolicy() {}
  async savePolicy(policy) {}
}

module.exports = StateStore;
```

### TODO

- 自动创建缺失状态文件
- 保证默认结构合法
- 提供安装状态增删改查
- 提供任务增删改查
- 提供策略文件读写
- 预留简单锁或串行写入策略

### 输入输出

- 输入：项目根目录、状态文件路径
- 输出：统一结构化 JSON 数据

### 完成标准

- 插件市场所有状态都能从这里读写
- 不同服务不再直接写状态 JSON

---

## 2.5 `modules/pluginMarket/TrashManager.js`

### 目标

统一处理卸载到回收站、列出回收站、恢复和永久删除。

### 建议导出

```js
class TrashManager {
  constructor(options) {}

  async listTrashedPlugins() {}
  async movePluginToTrash(pluginInfo) {}
  async restoreFromTrash(trashedFolderName) {}
  async deleteTrashedPlugin(trashedFolderName) {}
  async inspectTrashEntry(trashedFolderName) {}
}

module.exports = TrashManager;
```

### TODO

- 定义回收站命名规则
- 从回收站条目解析 plugin manifest
- 恢复前做冲突检查
- 支持永久删除
- 返回结构化回收站条目

### 依赖

- `utils.js`
- `errors.js`

### 完成标准

- 当前散落在路由里的回收站逻辑迁移完成
- 回收站所有操作都由该类接管

---

## 2.6 `modules/pluginMarket/DependencyInspector.js`

### 目标

检测插件目录中的依赖描述文件并输出提示。

### 建议导出

```js
class DependencyInspector {
  async inspectPluginRoot(pluginRoot) {}
}

module.exports = DependencyInspector;
```

### 输出建议

```js
{
  dependencyHints: [
    { type: 'npm', file: 'package.json', message: '...' },
    { type: 'pip', file: 'requirements.txt', message: '...' }
  ],
  runtimeHints: {
    node: true,
    python: true,
    cargo: false
  }
}
```

### TODO

- 检测 `package.json`
- 检测 `requirements.txt`
- 检测 `pyproject.toml`
- 预留 `Cargo.toml`
- 输出统一的提示结构

### 完成标准

- 安装预检和安装结果都能复用同一套依赖提示

---

## 2.7 `modules/pluginMarket/ManifestValidator.js`

### 目标

校验仓库索引和安装包内 manifest。

### 建议导出

```js
class ManifestValidator {
  validateRepositoryIndex(indexData) {}
  validateCatalogPlugin(pluginData) {}
  validatePluginManifest(manifest) {}
  validateCompatibility(pluginData, runtimeContext) {}
}

module.exports = ManifestValidator;
```

### TODO

- 校验仓库索引最外层结构
- 校验 catalog 单插件字段
- 校验 `plugin-manifest.json`
- 校验版本兼容性和平台兼容性
- 返回结构化校验结果

### 完成标准

- 仓库同步前能拦住坏 catalog
- 安装前能拦住坏插件包

---

## 2.8 `modules/pluginMarket/RepositoryManager.js`

### 目标

统一管理仓库配置、仓库同步和索引缓存。

### 建议导出

```js
class RepositoryManager {
  constructor(options) {}

  async listRepositories() {}
  async addRepository(input) {}
  async updateRepository(repositoryId, patch) {}
  async removeRepository(repositoryId) {}
  async refreshRepository(repositoryId) {}
  async refreshAllRepositories() {}
  async getCachedRepositoryIndex(repositoryId) {}
}

module.exports = RepositoryManager;
```

### TODO

- 从状态文件读取仓库配置
- 拉取远程 `plugins.json`
- 调用 `ManifestValidator`
- 写入缓存
- 记录同步时间、状态和错误

### 依赖

- `StateStore`
- `ManifestValidator`
- `errors.js`

### 完成标准

- 能配置多个仓库
- 能刷新单仓库和全仓库
- 错误状态可追踪

---

## 2.9 `modules/pluginMarket/CatalogService.js`

### 目标

聚合多个仓库索引，输出统一 catalog。

### 建议导出

```js
class CatalogService {
  constructor(options) {}

  async listCatalog(query) {}
  async getPluginDetails(pluginName) {}
  async rebuildCatalogCache() {}
  async getUpgradeablePlugins() {}
}

module.exports = CatalogService;
```

### TODO

- 聚合多个仓库的插件数据
- 处理同名插件冲突
- 合并本地安装状态
- 支持搜索和筛选
- 输出详情页结构

### 输入输出

- 输入：仓库缓存、已安装状态、查询参数
- 输出：前端直接可用的 catalog 列表和详情对象

### 完成标准

- 前端无需自己拼装仓库数据和安装数据

---

## 2.10 `modules/pluginMarket/SecurityPolicy.js`

### 目标

统一判断哪些插件需要审批或阻断。

### 建议导出

```js
class SecurityPolicy {
  constructor(options) {}

  async getPolicy() {}
  async evaluateInstallRisk(input) {}
  async requiresApproval(input) {}
  async isRepositoryAllowed(repositoryId) {}
}

module.exports = SecurityPolicy;
```

### TODO

- 读取策略文件
- 按权限声明计算风险等级
- 判断仓库是否白名单
- 判断是否需要人工确认

### 完成标准

- 高风险安装有统一判断入口
- 不再在路由里写散乱 if/else

---

## 2.11 `modules/pluginMarket/InstallPlanner.js`

### 目标

为安装和升级生成预检结果与执行计划。

### 建议导出

```js
class InstallPlanner {
  constructor(options) {}

  async planLocalZipInstall(input) {}
  async planRepositoryInstall(input) {}
  async planUpgrade(input) {}
}

module.exports = InstallPlanner;
```

### 输出建议

```js
{
  ok: true,
  sourceType: 'repository',
  pluginName: 'DailyHot',
  targetVersion: '1.2.0',
  targetFolder: 'DailyHot',
  conflicts: [],
  dependencyHints: [],
  permissions: ['network'],
  riskLevel: 'medium',
  requiresApproval: false,
  compatibility: {
    toolbox: 'ok',
    runtime: 'ok',
    platform: 'ok'
  }
}
```

### TODO

- 做同名冲突检查
- 做目标目录冲突检查
- 做兼容性判断
- 做权限风险聚合
- 输出安装计划对象

### 完成标准

- 所有安装和升级动作都先有 plan

---

## 2.12 `modules/pluginMarket/PackageFetcher.js`

### 目标

负责远程安装包的下载和校验。

### 建议导出

```js
class PackageFetcher {
  constructor(options) {}

  async downloadPackage(input) {}
  async verifyPackageHash(filePath, hashInfo) {}
  async getCachedPackage(input) {}
  async clearOldCache() {}
}

module.exports = PackageFetcher;
```

### TODO

- 下载 zip 到 `.market-cache`
- 限制包大小
- 校验 hash
- 支持缓存命中
- 支持缓存清理

### 完成标准

- 远程安装包不直接落到正式插件目录

---

## 2.13 `modules/pluginMarket/InstallManager.js`

### 目标

成为安装、升级、卸载、恢复的总事务执行器。

### 建议导出

```js
class InstallManager {
  constructor(options) {}

  async installFromLocalZip(input) {}
  async installFromRepository(input) {}
  async upgradeInstalledPlugin(input) {}
  async uninstallPlugin(input) {}
  async restorePlugin(input) {}

  async createTask(input) {}
  async updateTask(taskId, patch) {}
  async rollbackTask(taskId, rollbackContext) {}
}

module.exports = InstallManager;
```

### TODO

- 管理任务生命周期
- 管理解压临时目录
- 执行本地安装
- 执行远程安装
- 执行升级
- 执行卸载和恢复
- 在成功后调用 `pluginManager.loadPlugins()`
- 在失败时执行回滚

### 依赖

- `StateStore`
- `TrashManager`
- `DependencyInspector`
- `InstallPlanner`
- `PackageFetcher`

### 完成标准

- 所有磁盘写入型动作都经由该类
- 安装、升级失败可回滚

---

## 2.14 `routes/admin/pluginMarket.js`

### 目标

成为插件市场的薄路由层。

### 建议导出

```js
module.exports = function createPluginMarketRouter(options) {}
```

### TODO

- 注册全部 `/admin_api/plugin-market/*` 路由
- 做参数校验
- 调对应 service
- 统一错误映射

### 具体子路由

- `GET /repositories`
- `POST /repositories`
- `POST /repositories/:repositoryId/refresh`
- `POST /repositories/refresh-all`
- `GET /catalog`
- `GET /catalog/:pluginName`
- `POST /plan/install`
- `POST /install/local-zip`
- `POST /install/repository`
- `GET /installed`
- `POST /installed/:pluginName/toggle`
- `POST /installed/:pluginName/uninstall`
- `POST /installed/:pluginName/upgrade`
- `GET /trash`
- `POST /trash/:trashedFolderName/restore`
- `DELETE /trash/:trashedFolderName`
- `GET /tasks`
- `GET /tasks/:taskId`

### 完成标准

- 路由文件只做路由职责
- 业务逻辑都下沉到 `modules/pluginMarket/`

---

## 3. 前端文件 TODO

## 3.1 `AdminPanel/js/plugin-market.js`

### 目标

作为插件市场前端总入口。

### 建议导出

```js
export function initializePluginMarket() {}
export function navigatePluginMarketView(viewName, payload = {}) {}
```

### TODO

- 初始化市场模块
- 负责视图切换
- 协调子模块刷新

### 完成标准

- 插件市场所有子页都从这里进入

---

## 3.2 `AdminPanel/js/plugin-market-repositories.js`

### 目标

承载仓库管理页交互。

### 建议导出

```js
export async function loadPluginMarketRepositories() {}
export function initializePluginMarketRepositoryForm() {}
```

### TODO

- 加载仓库列表
- 新增仓库
- 刷新单仓库
- 刷新全部仓库
- 切换启用状态

### 完成标准

- 仓库管理页可独立工作

---

## 3.3 `AdminPanel/js/plugin-market-catalog.js`

### 目标

承载市场浏览页交互。

### 建议导出

```js
export async function loadPluginMarketCatalog(query = {}) {}
export function initializePluginMarketCatalogFilters() {}
```

### TODO

- 搜索框
- 分类筛选
- 标签筛选
- 已安装筛选
- 可升级筛选
- 渲染插件卡片

### 完成标准

- 市场列表可筛选、可进入详情

---

## 3.4 `AdminPanel/js/plugin-market-details.js`

### 目标

承载详情页交互和操作按钮。

### 建议导出

```js
export async function loadPluginMarketDetails(pluginName) {}
export function bindPluginMarketDetailActions() {}
```

### TODO

- 渲染详情
- 触发预检
- 触发安装
- 触发升级
- 触发卸载
- 触发启用/禁用

### 完成标准

- 用户可从详情页完成主操作

---

## 3.5 `AdminPanel/js/plugin-market-installed.js`

### 目标

承载已安装插件页。

### 建议导出

```js
export async function loadInstalledPluginMarketItems() {}
export async function loadPluginMarketTrashItems() {}
```

### TODO

- 渲染已安装列表
- 渲染可升级列表
- 渲染回收站列表
- 绑定启用/禁用/卸载/恢复

### 完成标准

- 已安装插件和回收站都可统一管理

---

## 3.6 `AdminPanel/js/plugin-market-tasks.js`

### 目标

承载任务中心。

### 建议导出

```js
export async function loadPluginMarketTasks(query = {}) {}
export async function loadPluginMarketTaskDetails(taskId) {}
```

### TODO

- 渲染任务列表
- 筛选任务
- 展示任务详情
- 展示失败和回滚信息

### 完成标准

- 安装、升级、卸载、恢复都有可追踪记录

---

## 3.7 `AdminPanel/index.html`

### 目标

承载插件市场导航和 section 容器。

### TODO

- 新增“插件市场”一级入口
- 新增 6 个 section
- 为每个 section 预留容器
- 保持与现有 AdminPanel 风格一致

### 建议 section id

- `plugin-market-home-section`
- `plugin-market-catalog-section`
- `plugin-market-details-section`
- `plugin-market-tasks-section`
- `plugin-market-installed-section`
- `plugin-market-repositories-section`

### 完成标准

- `script.js` 能正常导航到各 section

---

## 3.8 `AdminPanel/script.js`

### 目标

把插件市场模块接入现有导航体系。

### TODO

- 引入 `initializePluginMarket`
- 在初始加载时注册插件市场模块
- 在 `navigateTo` 中支持插件市场各 section

### 完成标准

- 插件市场不需要另起新页面也能工作

---

## 4. schema 文件 TODO

## 4.1 `repository-index.schema.json`

### TODO

- 定义仓库索引根结构
- 定义 `repository` 对象
- 定义 `plugins[]` 字段约束
- 定义必填字段

## 4.2 `local-state.schema.json`

### TODO

- 定义 `installedPlugins` 结构
- 定义每个已安装插件条目结构
- 定义依赖提示结构

## 4.3 `task-state.schema.json`

### TODO

- 定义 `tasks[]`
- 定义 `steps[]`
- 定义 `rollback` 结构
- 定义 `error` 结构

## 4.4 `install-plan.schema.json`

### TODO

- 定义预检输出结构
- 定义 `compatibility`
- 定义 `conflicts`
- 定义 `riskLevel`

---

## 5. 文件间依赖图

```text
pluginMarket.js
  |- RepositoryManager
  |- CatalogService
  |- InstallManager
  |- StateStore

RepositoryManager
  |- StateStore
  `- ManifestValidator

CatalogService
  |- RepositoryManager
  `- StateStore

InstallPlanner
  |- ManifestValidator
  |- DependencyInspector
  |- SecurityPolicy
  `- StateStore

InstallManager
  |- InstallPlanner
  |- PackageFetcher
  |- TrashManager
  |- DependencyInspector
  |- StateStore
  `- Plugin.js runtime instance
```

---

## 6. 推荐编码顺序

建议按文件顺序这样写：

1. `constants.js`
2. `errors.js`
3. `utils.js`
4. `StateStore.js`
5. `TrashManager.js`
6. `DependencyInspector.js`
7. `ManifestValidator.js`
8. `RepositoryManager.js`
9. `CatalogService.js`
10. `SecurityPolicy.js`
11. `InstallPlanner.js`
12. `PackageFetcher.js`
13. `InstallManager.js`
14. `routes/admin/pluginMarket.js`
15. `AdminPanel` 对应前端模块

理由：

- 先打基础工具和状态层
- 再写只读服务
- 最后写写磁盘和事务最重的安装服务

---

## 7. 逐文件验收口径

## 7.1 `StateStore.js`

- 能自动初始化四个状态文件
- 能正确 append/update task
- 能 upsert/remove installed plugin

## 7.2 `TrashManager.js`

- 能卸载到 `.trash`
- 能列出回收站
- 能恢复和永久删除

## 7.3 `DependencyInspector.js`

- 对典型 Node/Python 插件输出正确依赖提示

## 7.4 `RepositoryManager.js`

- 能配置仓库
- 能刷新仓库
- 能保存同步状态

## 7.5 `CatalogService.js`

- 能完成搜索/筛选/详情输出

## 7.6 `InstallPlanner.js`

- 能识别冲突、兼容性和风险等级

## 7.7 `PackageFetcher.js`

- 能缓存 zip
- 能校验 hash

## 7.8 `InstallManager.js`

- 本地安装、远程安装、升级、卸载、恢复可用
- 失败时可回滚

## 7.9 `pluginMarket.js`

- 所有接口返回结构统一
- 错误状态码合理

## 7.10 前端模块

- 每个页面模块职责单一
- 视图切换和数据加载清晰

---

## 8. 建议的第一批实际开发任务

如果要从这份文档直接开干，建议第一批只做下面 6 个文件：

1. `modules/pluginMarket/constants.js`
2. `modules/pluginMarket/utils.js`
3. `modules/pluginMarket/StateStore.js`
4. `modules/pluginMarket/TrashManager.js`
5. `modules/pluginMarket/DependencyInspector.js`
6. `modules/pluginMarket/InstallManager.js`

这 6 个文件完成后，就能把当前已经有的本地安装/卸载/恢复逻辑收口成真正可扩展的服务层。

