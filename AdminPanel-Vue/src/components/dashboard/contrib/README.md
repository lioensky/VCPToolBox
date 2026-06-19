# 仪表盘第三方贡献卡片指南

本目录是 VCPToolBox AdminPanel 仪表盘的**第三方卡片贡献区**。

只要把一个 `.vue` 文件放进这个目录，它就会自动出现在仪表盘的"管理卡片"面板里——无需改任何其他文件、无需改后端。

---

## 快速开始（3 步）

### 1. 新建卡片文件

在本目录下创建一个以 `Card.vue` 结尾的文件，例如 `DiskInfoCard.vue`。

### 2. 导出 `cardMeta`

在文件顶部用**普通 `<script lang="ts">`**（与 `<script setup>` 共存）导出元信息：

```vue
<script lang="ts">
import type { CardMeta } from "./_types";
export const cardMeta: CardMeta = {
  typeId: "contrib.disk-info",          // 必须以 contrib. 开头
  title: "磁盘信息",
  description: "显示系统磁盘使用情况。",
  defaultEnabled: false,                // 建议默认不启用
  singleton: true,
  defaultSize: { desktopCols: 3, tabletCols: 3, rows: 11 },
  minSize:     { desktopCols: 3, tabletCols: 3, rows: 7 },
  maxSize:     { desktopCols: 6, tabletCols: 6, rows: 16 },
  author: "YourName",
  version: "1.0.0",
};
</script>
```

### 3. 写组件本体

在 `<script setup>` 中通过 `cardSdk` 取数据：

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { cardSdk } from "./_sdk";

const cpuUsage = ref(0);

onMounted(async () => {
  const res = await cardSdk.system.getSystemResources();
  cpuUsage.value = res.cpu.usage;
});
</script>

<template>
  <div class="dashboard-card-shell dashboard-card-shell--teal">
    <h3 class="dashboard-card-title">磁盘信息</h3>
    <p>CPU: {{ cpuUsage.toFixed(1) }}%</p>
  </div>
</template>

<style scoped>
@import "../dashboard-card.css";
/* 你的自定义样式 */
</style>
```

保存后，Vite HMR 会自动热更新，卡片立刻出现在"管理卡片"面板。

---

## 文件命名约定

| 规则 | 说明 |
|------|------|
| 文件名必须以 `Card.vue` 结尾 | `DiskInfoCard.vue` ✓，`DiskInfo.vue` ✗ |
| `typeId` 必须以 `contrib.` 开头 | 避免与官方 `builtin.*` 冲突 |
| `defaultEnabled` 建议 `false` | 不污染默认布局，让用户主动启用 |

---

## 可用 API（`cardSdk` 白名单）

第三方卡片**只能**通过 `./_sdk` 暴露的 `cardSdk` 访问后端数据。直接 `import "@/api/*"` 不被允许。

| 命名空间 | 方法 | 说明 |
|----------|------|------|
| `cardSdk.system` | `getSystemResources()` | CPU/内存/Node 进程信息 |
| | `getPM2Processes()` | PM2 受管进程列表 |
| | `getServerLog()` | 完整 server.log |
| | `getIncrementalServerLog(offset)` | 增量日志 |
| `cardSdk.weather` | `getWeather()` | 天气预报 |
| `cardSdk.news` | `getNews()` | 热点新闻原始列表 |
| | `getGroupedNews(limit, total)` | 按来源分组新闻 |
| `cardSdk.newApiMonitor` | `getSummary()` | NewAPI 调用摘要 |
| | `getTrend()` | 调用趋势 |
| | `getModels()` | 模型列表 |
| | `getDashboardSnapshot()` | 三件套一次性拉取 |
| `cardSdk.schedule` | `getSchedules()` | 日程列表 |
| `cardSdk.utils` | `usePolling(fn, opts)` | 轮询 hook（自动卸载停止） |
| | `useRequest(fn, opts)` | 单次请求 hook |
| | `createLogger(prefix)` | 前缀日志器 |
| | `sanitizeExternalUrl(url)` | 外链净化 |

> ⚠️ **写操作不在白名单内**：`save*` / `delete*` / `restart*` / `create*` / `activate*` 等方法一律不可调用。

---

## 样式约定

- 必须使用 `dashboard-card-shell` 外壳类名（保持与官方卡片视觉一致）
- 必须 `<style scoped>`（避免样式泄漏）
- 可选颜色变体：`--sky` / `--emerald` / `--amber` / `--teal` / `--rose`
- 引入共享样式：`@import "../dashboard-card.css";`
- 卡片内部使用 Container Query 断点适配（`@container dashboard-card`）

---

## 轮询示例

```ts
const polling = cardSdk.utils.usePolling(
  async () => {
    const res = await cardSdk.system.getSystemResources();
    cpuUsage.value = res.cpu.usage;
  },
  { interval: 5000, immediate: true }
);

onMounted(() => polling.start());
onUnmounted(() => polling.stop());
```

---

## 目录结构

```
contrib/
├── README.md          ← 你正在读的这份文档
├── _types.ts          ← CardMeta 类型定义
├── _sdk.ts            ← 白名单 API SDK
├── ExampleCard.vue    ← 示例卡片（服务器运行时长）
└── YourCard.vue       ← 你的卡片！
```

---

## 完整开发文档

详见项目根目录：[`docs/DASHBOARD_CONTRIB_GUIDE.md`](../../../docs/DASHBOARD_CONTRIB_GUIDE.md)