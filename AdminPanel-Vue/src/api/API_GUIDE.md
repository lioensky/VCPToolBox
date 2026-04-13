# API 使用指南

## 概览

`src/api/` 是当前 AdminPanel-Vue 的统一 API 抽象层。

目标：

- 统一把 `/admin_api/*` 请求从页面、组件、store 中收口到 `src/api/*`
- 复用 `apiFetch` / `fetchWithRetry` 的鉴权、错误处理、超时、Loading 能力
- 让业务代码只依赖领域 API，而不是直接拼接后端路径

统一入口：

```ts
import { diaryApi, systemApi, weatherApi } from '@/api'
```

底层工具：

- `apiFetch`: 常规请求
- `fetchWithRetry`: 需要重试的请求
- `ApiFetchUiOptions`: 控制 Loading / timeout 等 UI 行为

---

## 当前模块清单

当前 `src/api/` 已包含以下模块：

- `admin-config.ts`
- `agent.ts`
- `auth.ts`
- `diary.ts`
- `dream.ts`
- `forum.ts`
- `media-cache.ts`
- `news.ts`
- `newapi-monitor.ts`
- `placeholder.ts`
- `plugin.ts`
- `rag.ts`
- `schedule.ts`
- `system.ts`
- `toolbox.ts`
- `toolList.ts`
- `tvs.ts`
- `vcptavern.ts`
- `weather.ts`

统一导出文件：

- `index.ts`

---

## 使用约定

### 1. 页面层不要直接请求 `/admin_api/*`

推荐：

```ts
import { scheduleApi } from '@/api'

const schedules = await scheduleApi.getSchedules(false)
```

不推荐：

```ts
const data = await apiFetch('/admin_api/schedules', {}, false)
```

### 2. 新接口先落到 `src/api/*.ts`

推荐流程：

1. 在对应领域新增或扩展 API 模块
2. 在 `src/api/index.ts` 导出
3. 页面 / store / composable 通过 `@/api` 使用
4. 再更新本文件

### 3. UI 选项通过 `uiOptions` 传入

常见写法：

```ts
await pluginApi.getPlugins(false)
await adminConfigApi.saveMainConfig(content, true)
```

---

## API 列表

### `adminConfigApi`

文件：`src/api/admin-config.ts`

- `getMainConfig()`
- `saveMainConfig(content)`
- `getToolApprovalConfig()`
- `saveToolApprovalConfig(config)`
- `getPreprocessorOrder()`
- `savePreprocessorOrder(order)`

### `agentApi`

文件：`src/api/agent.ts`

- `getAgentConfig()`
- `saveAgentConfig(config)`
- `getAgentMap()`
- `saveAgentMap(agentMap)`
- `getAgentFiles()`
- `getAgentFileContent(filename)`
- `saveAgentFile(filename, content)`
- `createAgentFile(filename, folderPath?)`
- `getAgentScores()`

### `authApi`

文件：`src/api/auth.ts`

说明：认证请求已从 `utils/auth.ts` 收口到 API 层。

- `verifyLogin()`
- `checkAuthStatus()`
- `getCurrentUserInfo()`
- `login({ username, password })`

### `diaryApi`

文件：`src/api/diary.ts`

- `getDiaryList(params?)`
- `getDiaryContent(file)`
- `saveDiary(file, content)`
- `deleteDiary(files)`
- `getRagTagsConfig(folder)`
- `saveRagTagsConfig(folder, config)`
- `getFolders()`
- `moveDiaries(notes, targetFolder)`
- `associativeDiscovery(payload)`

### `dreamApi`

文件：`src/api/dream.ts`

- `getDreamLogSummaries()`
- `getDreamLogDetail(filename)`
- `reviewDreamOperation(filename, operationId, action)`

### `forumApi`

文件：`src/api/forum.ts`

- `getPosts()`
- `getPostContent(uid)`
- `submitReply(uid, payload)`

### `mediaCacheApi`

文件：`src/api/media-cache.ts`

- `getCache()`
- `saveCache(data)`
- `reidentify(base64Key)`

### `newsApi`

文件：`src/api/news.ts`

- `getNews()`
- `getGroupedNews(limitPerSource?, totalLimit?)`

### `placeholderApi`

文件：`src/api/placeholder.ts`

- `getPlaceholders()`
- `getPlaceholderDetail(type, name)`

### `pluginApi`

文件：`src/api/plugin.ts`

- `getPlugins()`
- `savePluginConfig(pluginName, content)`
- `togglePlugin(pluginName, enable)`
- `saveInvocationCommandDescription(pluginName, commandIdentifier, description)`

### `ragApi`

文件：`src/api/rag.ts`

- `getRagParams()`
- `saveRagParams(params)`
- `getSemanticGroups()`
- `saveSemanticGroups(payload)`
- `getThinkingChains()`
- `saveThinkingChains(payload)`
- `getAvailableClusters()`

### `scheduleApi`

文件：`src/api/schedule.ts`

- `getSchedules()`
- `createSchedule(payload)`
- `deleteSchedule(id)`

### `systemApi`

文件：`src/api/system.ts`

- `getSystemResources(requestInit?, uiOptions?)`
- `getPM2Processes(requestInit?, uiOptions?)`
- `getUserAuthCode(requestInit?, uiOptions?)`
- `getServerLog(requestInit?, uiOptions?, retryOptions?)`
- `restartServer()`
- `logout()`

### `toolboxApi`

文件：`src/api/toolbox.ts`

- `getToolboxMap()`
- `saveToolboxMap(payload)`
- `createToolboxFile(fileName, folderPath?)`
- `getToolboxFile(fileName)`
- `saveToolboxFile(fileName, content)`

### `toolListApi`

文件：`src/api/toolList.ts`

- `getTools()`
- `getConfigs()`
- `getConfig(name)`
- `saveConfig(name, tools)`
- `deleteConfig(name)`

### `tvsApi`

文件：`src/api/tvs.ts`

- `getTvsFiles()`
- `getTvsFileContent(fileName)`
- `saveTvsFile(fileName, content)`

### `vcptavernApi`

文件：`src/api/vcptavern.ts`

- `getPresets()`
- `getPreset(name)`
- `savePreset(name, payload)`
- `deletePreset(name)`

### `weatherApi`

文件：`src/api/weather.ts`

- `getWeather()`

---

## 已移除 / 不应再使用的方法

以下方法曾经存在于前端抽象层，但已确认未接入业务或后端不支持，现已移除，不要再写入文档或继续调用：

### `diaryApi`

- `createFolder()`
- `deleteFolder()`
- `diaryApiRaw`

### `pluginApi`

- `getPluginConfig()`
- `getEnabledPlugins()`
- `getDisabledPlugins()`

### `systemApi`

- `getFullMonitorData()`

### `weatherApi`

- `getCurrentWeather()`
- `getDailyForecast()`

---

## 已完成的业务接入

以下原先存在页面直连 `/admin_api/*` 的能力，现已接入抽象层：

- 认证链路接入 `authApi`
- 日程卡片接入 `scheduleApi`
- 日记联想弹窗接入 `diaryApi`
- 服务日志查看接入 `systemApi`
- 多模态缓存页接入 `mediaCacheApi`
- 占位符查看页接入 `placeholderApi`

---

## NewAPI Monitor 状态

### 结论

父目录后端已经提供了 NewAPI 监控接口，当前前端 **已完成基础接入**。

### 后端已存在的接口

来源：

- `../routes/admin/newapiMonitor.js`
- `../routes/adminPanelRoutes.js`
- `../NEWAPI_MONITOR_前端接入与配置说明.md`

当前可用路由：

- `GET /admin_api/newapi-monitor/summary`
- `GET /admin_api/newapi-monitor/trend`
- `GET /admin_api/newapi-monitor/models`

### 当前前端状态

已确认：

- 已新增 `src/api/newapi-monitor.ts`
- 已在 `src/api/index.ts` 导出 `newApiMonitorApi`
- 已在 Dashboard 中接入基础监控卡片
- 当前仍没有独立的 `NewApiMonitor` 页面

也就是说：

- 后端能力已具备
- 前端已经开始消费 `summary / trend / models`
- 当前是“Dashboard 总览已接入，独立监控页未接入”

### 建议接入方式

当前已实现的方法：

- `getSummary(query)`
- `getTrend(query)`
- `getModels(query)`
- `getDashboardSnapshot(query)`

建议后续补充位置：

- 独立的 `NewApiMonitor` 页面
- 更细的时间范围筛选与模型筛选

---

## 推荐模板

新增一个 API 模块时，建议使用下面的模式：

```ts
import { apiFetch, type ApiFetchUiOptions } from '@/utils/api'

type ApiUiOptions = boolean | ApiFetchUiOptions

export interface ExampleResponse {
  message?: string
}

export const exampleApi = {
  async getExample(uiOptions: ApiUiOptions = false): Promise<ExampleResponse> {
    return apiFetch('/admin_api/example', {}, uiOptions)
  },
}
```

然后在 `src/api/index.ts` 中导出：

```ts
export { exampleApi } from './example'
export type * from './example'
```

---

## 检查清单

每次新增或调整 API 后，建议同步检查：

1. `src/api/*.ts` 是否已完成封装
2. `src/api/index.ts` 是否已导出
3. 页面 / store / composable 是否仍有直连 `/admin_api/*`
4. 本文档是否已同步更新
5. `npm run build` 是否通过
