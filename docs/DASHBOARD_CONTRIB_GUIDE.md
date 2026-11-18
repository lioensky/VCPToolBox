# VCPToolBox 仪表盘第三方贡献卡片开发指南

**版本**：1.0.0  
**最后更新**：2026-06-19  
**适用范围**：VCPToolBox AdminPanel-Vue 仪表盘  
**本功能目标**：允许社区开发者只通过新增一个 Vue 卡片文件，就能把新卡片贡献到主页仪表盘。

---

## 1. 功能概述

AdminPanel 仪表盘现在支持“发现式第三方卡片”：

- 贡献者把卡片文件放到 [`AdminPanel-Vue/src/components/dashboard/contrib/`](../AdminPanel-Vue/src/components/dashboard/contrib/)。
- 文件名以 `Card.vue` 结尾。
- 在卡片中导出 `cardMeta`。
- 卡片通过 [`cardSdk`](../AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts) 读取后端已有 API。
- 不需要修改后端。
- 不需要修改路由。
- 不需要改 [`routes/adminPanelRoutes.js`](../routes/adminPanelRoutes.js)。
- 不需要注册新 API。

核心原则是：**第三方卡片 = 现有 Admin API 的只读 UI 视图组合**。

---

## 2. 文件结构

```text
AdminPanel-Vue/src/components/dashboard/
├── CpuCard.vue
├── WeatherCard.vue
├── dashboard-card.css
└── contrib/
    ├── README.md
    ├── _types.ts
    ├── _sdk.ts
    ├── ExampleCard.vue
    └── YourCard.vue
```

核心改造文件：

| 文件 | 职责 |
|------|------|
| [`builtinComponentMap.ts`](../AdminPanel-Vue/src/dashboard/core/builtinComponentMap.ts) | 使用 `import.meta.glob` 自动发现卡片组件 |
| [`builtinCards.ts`](../AdminPanel-Vue/src/dashboard/core/builtinCards.ts) | 合并官方核心卡片与自描述第三方卡片 |
| [`_types.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_types.ts) | 定义第三方卡片的 `CardMeta` 协议 |
| [`_sdk.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts) | 暴露只读白名单 API |
| [`ExampleCard.vue`](../AdminPanel-Vue/src/components/dashboard/contrib/ExampleCard.vue) | 示例第三方卡片 |
| [`README.md`](../AdminPanel-Vue/src/components/dashboard/contrib/README.md) | 贡献区快速说明 |

---

## 3. 自动发现机制

[`builtinComponentMap.ts`](../AdminPanel-Vue/src/dashboard/core/builtinComponentMap.ts) 会扫描两个目录：

```ts
const componentLoaders = import.meta.glob([
  "@/components/dashboard/*Card.vue",
  "@/components/dashboard/contrib/*Card.vue",
]);
```

同时通过 eager glob 读取每个模块导出的 `cardMeta`：

```ts
const metaModules = import.meta.glob(
  [
    "@/components/dashboard/*Card.vue",
    "@/components/dashboard/contrib/*Card.vue",
  ],
  { eager: true, import: "cardMeta" }
);
```

因此，第三方贡献者只需要新增文件：

```text
AdminPanel-Vue/src/components/dashboard/contrib/MyCard.vue
```

只要这个文件导出了 `cardMeta`，就会自动进入仪表盘卡片目录。

---

## 4. 第三方卡片最小模板

```vue
<script lang="ts">
import type { CardMeta } from "./_types";

export const cardMeta: CardMeta = {
  typeId: "contrib.my-card",
  title: "我的卡片",
  description: "显示一些基于现有 API 的信息。",
  defaultEnabled: false,
  singleton: true,
  defaultSize: { desktopCols: 4, tabletCols: 4, rows: 12 },
  minSize: { desktopCols: 3, tabletCols: 3, rows: 7 },
  maxSize: { desktopCols: 6, tabletCols: 6, rows: 18 },
  author: "YourName",
  version: "1.0.0",
};
</script>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { cardSdk } from "./_sdk";

const cpuUsage = ref(0);

onMounted(async () => {
  const resources = await cardSdk.system.getSystemResources();
  cpuUsage.value = resources.cpu.usage;
});
</script>

<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal">
    <h3 class="dashboard-card-title">我的卡片</h3>
    <p>CPU：{{ cpuUsage.toFixed(1) }}%</p>
  </div>
</template>

<style scoped>
@import "../dashboard-card.css";
</style>
```

---

## 5. `CardMeta` 协议

`CardMeta` 定义在 [`_types.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_types.ts)。

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `typeId` | `string` | 是 | 无 | 全局唯一 ID，必须以 `contrib.` 开头 |
| `title` | `string` | 是 | 无 | 卡片标题 |
| `description` | `string` | 是 | 无 | 卡片描述 |
| `defaultEnabled` | `boolean` | 否 | `false` | 是否默认启用 |
| `singleton` | `boolean` | 否 | `true` | 是否只允许添加一个实例 |
| `defaultSize` | `DashboardCardSize` | 是 | 无 | 默认尺寸 |
| `minSize` | `DashboardCardSize` | 是 | 无 | 最小尺寸 |
| `maxSize` | `DashboardCardSize` | 是 | 无 | 最大尺寸 |
| `author` | `string` | 否 | 无 | 贡献者署名 |
| `version` | `string` | 否 | 无 | 卡片版本号 |

尺寸结构：

```ts
interface DashboardCardSize {
  desktopCols: number;
  tabletCols: number;
  rows: number;
}
```

建议：

- `typeId` 使用 `contrib.your-name.card-name`，避免社区卡片之间撞名。
- `defaultEnabled` 默认保持 `false`，避免污染用户默认布局。
- `singleton` 默认保持 `true`。

---

## 6. `cardSdk` 白名单 API

第三方卡片只能通过 [`_sdk.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts) 暴露的 `cardSdk` 读取数据。

不要直接导入 `@/api/*`。  
不要直接请求未审核的外部 URL。  
不要调用写操作。

### 6.1 系统监控

| 方法 | 说明 |
|------|------|
| `cardSdk.system.getSystemResources()` | CPU、内存、Node 进程信息 |
| `cardSdk.system.getPM2Processes()` | PM2 进程列表 |
| `cardSdk.system.getServerLog()` | 完整 server log |
| `cardSdk.system.getIncrementalServerLog(offset)` | 增量日志 |

### 6.2 天气

| 方法 | 说明 |
|------|------|
| `cardSdk.weather.getWeather()` | 读取天气预报 |

### 6.3 新闻

| 方法 | 说明 |
|------|------|
| `cardSdk.news.getNews()` | 热点新闻原始列表 |
| `cardSdk.news.getGroupedNews(limitPerSource, totalLimit)` | 按来源分组后的热点新闻 |

### 6.4 NewAPI 监控

| 方法 | 说明 |
|------|------|
| `cardSdk.newApiMonitor.getSummary()` | 调用摘要 |
| `cardSdk.newApiMonitor.getTrend()` | 调用趋势 |
| `cardSdk.newApiMonitor.getModels()` | 模型统计 |
| `cardSdk.newApiMonitor.getDashboardSnapshot()` | 一次性读取摘要、趋势、模型统计 |

### 6.5 日程

| 方法 | 说明 |
|------|------|
| `cardSdk.schedule.getSchedules()` | 读取日程列表 |

### 6.6 工具

| 方法 | 说明 |
|------|------|
| `cardSdk.utils.usePolling()` | 轮询 hook |
| `cardSdk.utils.useRequest()` | 请求状态 hook |
| `cardSdk.utils.createLogger()` | 日志器 |
| `cardSdk.utils.sanitizeExternalUrl()` | 外链净化 |

---

## 7. 不允许的操作

第三方仪表盘卡片定位为只读展示，不允许直接进行系统修改。

以下操作不应暴露给第三方卡片：

- `restartServer`
- `save*`
- `delete*`
- `create*`
- `update*`
- `activate*`
- `deactivate*`
- `logout`
- 任何插件安装、插件启停、配置写入、文件写入类操作

如确实需要写操作，应设计为官方功能或后端插件，而不是第三方仪表盘卡片。

---

## 8. 样式规范

每个第三方卡片必须：

1. 使用 `dashboard-card-shell` 外壳类。
2. 使用 `<style scoped>`。
3. 引入共享样式：`@import "../dashboard-card.css";`。
4. 避免影响全局样式。
5. 使用容器查询适配不同卡片宽度。

推荐结构：

```vue
<template>
  <div class="dashboard-card-shell dashboard-card-shell--emerald">
    <h3 class="dashboard-card-title">标题</h3>
    <div class="dashboard-card-panel">内容</div>
  </div>
</template>
```

可用颜色变体：

| 类名 | 色调 |
|------|------|
| `dashboard-card-shell--sky` | 蓝色 |
| `dashboard-card-shell--emerald` | 绿色 |
| `dashboard-card-shell--amber` | 橙色 |
| `dashboard-card-shell--teal` | 青色 |
| `dashboard-card-shell--rose` | 红色 |

容器查询示例：

```css
@container dashboard-card (max-width: 360px) {
  .my-grid {
    grid-template-columns: 1fr;
  }
}
```

---

## 9. 轮询与生命周期

基础轮询示例：

```ts
const polling = cardSdk.utils.usePolling(
  async () => {
    const resources = await cardSdk.system.getSystemResources();
    cpuUsage.value = resources.cpu.usage;
  },
  { interval: 5000, immediate: true }
);

onMounted(() => {
  polling.start();
});

onUnmounted(() => {
  polling.stop();
});
```

注意：

- 卡片被隐藏时会从 DOM 卸载，`onUnmounted` 会触发。
- 卡片重新显示时会重新 `onMounted`。
- 不建议使用过短轮询间隔。
- 一般监控类卡片建议 `5000ms` 到 `30000ms`。

---

## 10. 调试方法

### 10.1 卡片没出现在管理面板

检查：

1. 文件是否位于 [`contrib/`](../AdminPanel-Vue/src/components/dashboard/contrib/)。
2. 文件名是否以 `Card.vue` 结尾。
3. 是否正确导出 `cardMeta`。
4. `typeId` 是否以 `contrib.` 开头。
5. 浏览器控制台是否有 Vite 或 TypeScript 报错。

### 10.2 卡片能添加但不显示内容

检查：

1. API 是否调用失败。
2. 是否已登录 AdminPanel。
3. 是否使用 `cardSdk`。
4. 是否有运行时异常。

建议使用：

```ts
const logger = cardSdk.utils.createLogger("MyCard");
logger.info("loaded", data.value);
logger.warn("failed", error);
```

### 10.3 卡片样式异常

检查：

1. 是否引入 `dashboard-card.css`。
2. 是否使用 `dashboard-card-shell`。
3. 是否使用 `<style scoped>`。
4. 是否使用全局选择器污染了其他元素。

---

## 11. PR 规范

一个社区卡片 PR 通常只需要包含一个文件：

```text
AdminPanel-Vue/src/components/dashboard/contrib/YourCard.vue
```

PR 描述建议包含：

```markdown
## 卡片名称

## 功能说明

## 使用的 cardSdk 方法

## 截图

## 测试结果
- [ ] 能在管理卡片面板中看到
- [ ] 能添加到仪表盘
- [ ] 数据加载正常
- [ ] 隐藏后轮询停止
- [ ] 拖拽排序正常
- [ ] 缩放正常
```

代码审查重点：

- `typeId` 唯一。
- `defaultEnabled` 为 `false`。
- 只使用 `cardSdk`。
- 无写操作。
- 无外部脚本注入。
- 样式 scoped。
- 无过高频率轮询。

---

## 12. 当前实现总结

本功能已经完成以下改造：

| 文件 | 状态 |
|------|------|
| [`builtinComponentMap.ts`](../AdminPanel-Vue/src/dashboard/core/builtinComponentMap.ts) | 已改为自动发现 |
| [`builtinCards.ts`](../AdminPanel-Vue/src/dashboard/core/builtinCards.ts) | 已支持合并自描述卡片 |
| [`_types.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_types.ts) | 已新增 |
| [`_sdk.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts) | 已新增 |
| [`ExampleCard.vue`](../AdminPanel-Vue/src/components/dashboard/contrib/ExampleCard.vue) | 已新增 |
| [`README.md`](../AdminPanel-Vue/src/components/dashboard/contrib/README.md) | 已新增 |
| [`DASHBOARD_CONTRIB_GUIDE.md`](./DASHBOARD_CONTRIB_GUIDE.md) | 已新增 |

后端改动：**0 行**。

---

## 13. 常见问题

### 第三方卡片能开新后端 API 吗？

不能。该机制的目标是复用现有后端 API。如果需要新后端 API，应走独立功能开发或插件开发流程。

### 第三方卡片能写配置吗？

不能。第三方仪表盘卡片只做只读展示。

### 第三方卡片能访问插件数据吗？

目前只有 [`_sdk.ts`](../AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts) 暴露的只读 API 可用。如果未来需要插件只读数据，可由维护者把对应 `get*` 方法加入 SDK 白名单。

### 官方卡片也能迁移到自描述模式吗？

可以。只要官方卡片不依赖 [`useDashboardState.ts`](../AdminPanel-Vue/src/composables/useDashboardState.ts) 的集中式状态注入，就可以导出 `cardMeta` 并从 [`builtinCards.ts`](../AdminPanel-Vue/src/dashboard/core/builtinCards.ts) 的 legacy 段移除。

### 新增卡片是否影响首屏性能？

影响较小。组件通过 `defineAsyncComponent` 和 Vite 动态导入按需加载，首屏不会立即加载所有第三方卡片源码。

---

## 14. 参考示例

请参考 [`ExampleCard.vue`](../AdminPanel-Vue/src/components/dashboard/contrib/ExampleCard.vue)。

它演示了：

- `cardMeta` 元信息导出。
- `cardSdk.system.getSystemResources()` 调用。
- `cardSdk.utils.usePolling()` 轮询。
- `cardSdk.utils.createLogger()` 日志。
- `dashboard-card-shell--teal` 视觉变体。
- `@container dashboard-card` 响应式适配。