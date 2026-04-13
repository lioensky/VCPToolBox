# AdminPanel-Vue 仪表盘系统

本文档详细说明 AdminPanel-Vue 的仪表盘卡片系统架构，包括核心概念、卡片类型、布局系统和扩展方法。

## 目录

- [架构概览](#架构概览)
- [核心概念](#核心概念)
- [卡片类型](#卡片类型)
- [目录结构](#目录结构)
- [布局系统](#布局系统)
- [状态管理](#状态管理)
- [添加新卡片](#添加新卡片)
- [高级主题](#高级主题)

---

## 架构概览

仪表盘系统采用**卡片化架构**，支持可拖拽排序、可调整大小的响应式布局。

```
┌─────────────────────────────────────────────────────────────┐
│                     Dashboard View                          │
│                  (views/Dashboard.vue)                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  Dashboard Core                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Catalog   │  │   Layout    │  │    State    │         │
│  │ (useDashboard│  │ (useDashboard│  │ (useDashboard│        │
│  │  Catalog)   │  │  LayoutV2)  │  │   State)    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Card Hosts                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Builtin   │  │ WebComponent│  │   Missing   │         │
│  │    Host     │  │    Host     │  │    Host     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

### 设计特点

1. **插件化卡片** - 支持内置卡片和插件卡片
2. **响应式布局** - 12列网格，支持桌面/平板/移动端
3. **状态持久化** - 布局自动保存到 localStorage
4. **拖拽交互** - 指针事件驱动的拖拽排序
5. **大小调整** - 右下角拖拽调整卡片大小

---

## 核心概念

### Contribution（卡片定义）

Contribution 定义了卡片的基本信息和渲染方式：

```typescript
interface DashboardCardContributionBase {
  typeId: string           // 卡片类型唯一标识
  title: string            // 卡片标题
  description: string      // 卡片描述
  source: 'builtin' | 'plugin'  // 来源
  pluginName?: string      // 插件名称（如果是插件卡片）
  singleton: boolean       // 是否单例（只能添加一个）
  defaultEnabled: boolean  // 默认是否启用
  legacyId?: string        // 旧版ID（用于迁移）
  
  // 尺寸限制
  defaultSize: DashboardCardSize
  minSize: DashboardCardSize
  maxSize: DashboardCardSize
}
```

### Instance（卡片实例）

Instance 代表一个具体的卡片实例：

```typescript
interface DashboardCardInstance {
  instanceId: string       // 实例唯一ID
  typeId: string           // 关联的 Contribution typeId
  enabled: boolean         // 是否启用
  order: number            // 排序顺序
  size: DashboardCardSize  // 当前尺寸
  config: Record<string, unknown>  // 自定义配置
}
```

### Size（尺寸定义）

```typescript
interface DashboardCardSize {
  desktopCols: number  // 桌面端列数 (1-12)
  tabletCols: number   // 平板端列数 (1-6)
  rows: number         // 行数（行高由 CSS 变量控制）
}
```

尺寸约束：
- 桌面端：1-12 列
- 平板端：1-6 列（不超过桌面端）
- 行数：最小 4 行，最大 60 行

---

## 卡片类型

### 1. 内置卡片 (Builtin)

**定义**: `BuiltinDashboardCardContribution`

内置卡片使用 Vue 组件渲染，由主应用直接提供。

```typescript
interface BuiltinDashboardCardContribution extends DashboardCardContributionBase {
  source: 'builtin'
  renderer: {
    kind: 'builtin'
    componentKey: string           // 组件标识
    buildProps: (state: Record<string, unknown>) => Record<string, unknown>
  }
}
```

**示例**: CPU 卡片、内存卡片、活动图表卡片

```typescript
// dashboard/core/builtinCards.ts
{
  typeId: 'builtin:cpu',
  title: 'CPU 使用率',
  description: '显示系统 CPU 使用率',
  source: 'builtin',
  singleton: true,
  defaultEnabled: true,
  defaultSize: { desktopCols: 3, tabletCols: 3, rows: 8 },
  minSize: { desktopCols: 2, tabletCols: 2, rows: 6 },
  maxSize: { desktopCols: 6, tabletCols: 4, rows: 12 },
  renderer: {
    kind: 'builtin',
    componentKey: 'cpu',
    buildProps: (state) => ({ resources: state.resources })
  }
}
```

### 2. 插件内置卡片 (Plugin Builtin)

**定义**: `PluginBuiltinDashboardCardContribution`

插件提供的内置类型卡片，渲染逻辑由插件控制。

```typescript
interface PluginBuiltinDashboardCardContribution extends DashboardCardContributionBase {
  source: 'plugin'
  pluginName: string
  renderer: {
    kind: 'builtin'
    componentKey: string
    buildProps: (state: Record<string, unknown>) => Record<string, unknown>
  }
}
```

### 3. WebComponent 卡片

**定义**: `WebComponentDashboardCardContribution`

使用 Web Component 技术实现的卡片，支持完全隔离的插件 UI。

```typescript
interface WebComponentDashboardCardContribution extends DashboardCardContributionBase {
  source: 'plugin'
  pluginName: string
  renderer: {
    kind: 'web-component'
    tagName: string        // Web Component 标签名
    publicPath: string     // 资源路径
  }
}
```

**优势**:
- 完全隔离的 CSS
- 独立的 JavaScript 运行时
- 支持任何前端框架

---

## 目录结构

```
dashboard/
├── core/                       # 核心逻辑
│   ├── types.ts               # 类型定义
│   ├── builtinCards.ts        # 内置卡片注册
│   ├── useDashboardCatalog.ts # 卡片目录管理
│   └── useDashboardLayoutV2.ts # 布局状态管理
├── hosts/                      # 卡片宿主组件
│   ├── BuiltinCardHost.vue    # 内置卡片宿主
│   ├── WebComponentCardHost.vue # WebComponent 宿主
│   └── MissingCardHost.vue    # 缺失卡片宿主
└── ...

components/dashboard/           # UI 组件
├── CardManager.vue            # 卡片管理器
├── CpuCard.vue                # CPU 卡片
├── MemoryCard.vue             # 内存卡片
├── ActivityChartCard.vue      # 活动图表卡片
├── CalendarCard.vue           # 日历卡片
└── ...
```

---

## 布局系统

### 网格布局

采用 CSS Grid 12列网格系统：

```css
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-flow: dense;
  grid-auto-rows: var(--dashboard-grid-row-size);
  column-gap: var(--dashboard-grid-column-gap);
  row-gap: var(--dashboard-grid-row-gap);
}
```

### 响应式断点

| 断点 | 宽度 | 列数 | CSS 变量 |
|------|------|------|----------|
| 桌面端 | > 1279px | 12列 | --dashboard-card-cols-desktop |
| 平板端 | 768-1279px | 6列 | --dashboard-card-cols-tablet |
| 移动端 | < 768px | 1列 | - |

### 卡片尺寸

```vue
<!-- Dashboard.vue -->
<div
  class="dashboard-item"
  :style="{
    '--dashboard-card-cols-desktop': String(size.desktopCols),
    '--dashboard-card-cols-tablet': String(size.tabletCols),
    '--dashboard-card-rows': String(size.rows)
  }"
>
```

### 拖拽排序

使用指针事件（Pointer Events）实现拖拽：

```typescript
// 拖拽状态
interface DashboardPointerDragState {
  mode: 'reorder'
  pointerId: number
  instanceId: string
  startX: number
  startY: number
  currentX: number
  currentY: number
  offsetX: number
  offsetY: number
  cardWidth: number
  cardHeight: number
  dragging: boolean
  rafId: number | null
  captureElement: HTMLElement | null
}

// 拖拽处理
function handleReorderPointerDown(instanceId: string, event: PointerEvent) {
  // 捕获指针
  currentTarget.setPointerCapture(event.pointerId)
  
  // 初始化拖拽状态
  pointerState.value = {
    mode: 'reorder',
    pointerId: event.pointerId,
    instanceId,
    // ...
  }
}
```

### 调整大小

```typescript
interface DashboardPointerResizeState {
  mode: 'resize'
  pointerId: number
  instanceId: string
  startX: number
  startY: number
  startSize: DashboardCardSize
  nextSize: DashboardCardSize
  breakpoint: 'desktop' | 'tablet' | 'mobile'
  metrics: DashboardGridMetrics
  // ...
}

// 计算新尺寸
function updatePreviewSize(state: DashboardPointerResizeState) {
  const deltaX = state.currentX - state.startX
  const deltaY = state.currentY - state.startY
  
  const columnDelta = Math.round(deltaX / columnStep)
  const rowDelta = Math.round(deltaY / rowStep)
  
  state.nextSize = {
    desktopCols: clamp(startSize.desktopCols + columnDelta, minCols, maxCols),
    tabletCols: clamp(startSize.tabletCols + columnDelta, minTabletCols, maxTabletCols),
    rows: clamp(startSize.rows + rowDelta, minRows, maxRows)
  }
}
```

---

## 状态管理

### 布局状态

```typescript
// dashboard/core/types.ts
interface DashboardLayoutStateV2 {
  version: 2
  instances: DashboardCardInstance[]
  dismissedTypeIds: string[]  // 用户移除的卡片类型
}
```

### 状态持久化

```typescript
const DASHBOARD_LAYOUT_V2_STORAGE_KEY = 'dashboard.layout.v2'

// useDashboardLayoutV2.ts
const savedState = localStorage.getItem(DASHBOARD_LAYOUT_V2_STORAGE_KEY)
if (savedState) {
  const parsed = JSON.parse(savedState) as DashboardLayoutStateV2
  instances.value = parsed.instances
}

// 自动保存
watch(instances, (newInstances) => {
  const state: DashboardLayoutStateV2 = {
    version: 2,
    instances: newInstances,
    dismissedTypeIds: dismissedTypeIds.value
  }
  localStorage.setItem(DASHBOARD_LAYOUT_V2_STORAGE_KEY, JSON.stringify(state))
}, { deep: true })
```

### 状态迁移

支持从旧版本布局迁移：

```typescript
const DASHBOARD_LEGACY_ORDER_STORAGE_KEY = 'dashboard.card-order'
const DASHBOARD_LEGACY_SIZES_STORAGE_KEY = 'dashboard.card-sizes'

function migrateFromLegacy(
  legacyOrder: string[],
  legacySizes: Record<string, DashboardCardSize>
): DashboardCardInstance[] {
  return legacyOrder.map((typeId, index) => ({
    instanceId: generateId(),
    typeId,
    enabled: true,
    order: index,
    size: legacySizes[typeId] || defaultSize,
    config: {}
  }))
}
```

---

## 添加新卡片

### 步骤 1：创建卡片组件

创建 `src/components/dashboard/MyCard.vue`：

```vue
<template>
  <div class="dashboard-card my-card">
    <div class="card-header">
      <span class="card-title">{{ title }}</span>
    </div>
    <div class="card-content">
      <!-- 卡片内容 -->
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  title: string
  data?: any
}

defineProps<Props>()
</script>

<style scoped>
.my-card {
  /* 卡片样式 */
}
</style>
```

### 步骤 2：注册卡片

在 `src/dashboard/core/builtinCards.ts` 中添加：

```typescript
import MyCard from '@/components/dashboard/MyCard.vue'

export function getBuiltinDashboardCards(
  state: Record<string, unknown>
): DashboardCardContribution[] {
  return [
    // ... 已有卡片
    {
      typeId: 'builtin:my-card',
      title: '我的卡片',
      description: '这是一个示例卡片',
      source: 'builtin',
      singleton: false,        // 可添加多个
      defaultEnabled: true,    // 默认启用
      defaultSize: {
        desktopCols: 4,
        tabletCols: 3,
        rows: 10
      },
      minSize: {
        desktopCols: 2,
        tabletCols: 2,
        rows: 6
      },
      maxSize: {
        desktopCols: 6,
        tabletCols: 4,
        rows: 20
      },
      renderer: {
        kind: 'builtin',
        componentKey: 'my-card',
        buildProps: () => ({
          title: '我的卡片',
          data: state.myData
        })
      }
    }
  ]
}
```

### 步骤 3：更新卡片宿主

在 `src/dashboard/hosts/BuiltinCardHost.vue` 中添加组件映射：

```vue
<script setup lang="ts">
import CpuCard from '@/components/dashboard/CpuCard.vue'
import MemoryCard from '@/components/dashboard/MemoryCard.vue'
import MyCard from '@/components/dashboard/MyCard.vue'
// ... 其他导入

const componentMap: Record<string, Component> = {
  'cpu': CpuCard,
  'memory': MemoryCard,
  'my-card': MyCard,  // 添加新卡片
  // ...
}
</script>
```

### 步骤 4：测试

1. 启动开发服务器
2. 进入仪表盘页面
3. 点击"管理卡片"
4. 找到并添加"我的卡片"
5. 测试拖拽排序和调整大小

---

## 高级主题

### 卡片间通信

通过 Dashboard State 实现卡片间通信：

```typescript
// composables/useDashboardState.ts
export function useDashboardState() {
  // 共享状态
  const resources = ref<SystemResources | null>(null)
  const events = ref<DashboardEvent[]>([])
  
  // 事件总线
  function emit(event: DashboardEvent) {
    events.value.push(event)
  }
  
  function on(eventType: string, handler: (event: DashboardEvent) => void) {
    watch(events, (newEvents) => {
      const event = newEvents[newEvents.length - 1]
      if (event?.type === eventType) {
        handler(event)
      }
    })
  }
  
  return { resources, events, emit, on }
}
```

### 卡片配置持久化

支持卡片级别的配置持久化：

```typescript
// 在卡片组件中
const props = defineProps<{
  instance: DashboardCardInstance
}>()

// 读取配置
const config = computed(() => props.instance.config)

// 更新配置（需要实现 updateConfig 方法）
function updateCardConfig(newConfig: Partial<CardConfig>) {
  Object.assign(props.instance.config, newConfig)
  // 触发保存
}
```

### 性能优化

1. **虚拟滚动** - 大量卡片时使用虚拟滚动
2. **懒加载** - 非可视区域卡片延迟渲染
3. **防抖保存** - 布局变化防抖保存
4. **shallowRef** - 大数据使用 shallowRef

```typescript
// 防抖保存
import { useDebounceFn } from '@/composables/useDebounceFn'

const saveLayout = useDebounceFn((state: DashboardLayoutStateV2) => {
  localStorage.setItem(DASHBOARD_LAYOUT_V2_STORAGE_KEY, JSON.stringify(state))
}, 300)

watch(instances, () => {
  saveLayout({ version: 2, instances: instances.value, dismissedTypeIds: dismissedTypeIds.value })
}, { deep: true })
```

### 自定义卡片宿主

可以实现自定义的卡片宿主来支持特殊的渲染需求：

```typescript
// CustomCardHost.vue
<template>
  <div class="custom-host">
    <Suspense>
      <AsyncCardComponent :data="props" />
      <template #fallback>
        <LoadingSkeleton />
      </template>
    </Suspense>
  </div>
</template>
```

---

## 相关文档

- [架构总览](ARCHITECTURE.md) - 仪表盘在整体架构中的位置
- [状态管理](STATE_MANAGEMENT.md) - 仪表盘状态管理
- [组合式函数](../src/composables/README.md) - 可复用的组合式函数
