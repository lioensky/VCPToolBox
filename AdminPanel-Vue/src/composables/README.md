# Composables 使用指南

本目录包含可复用的组合式函数（Composables），遵循 Vue 3 Composition API 最佳实践。

## 目录

### 核心 Composables

- [useRequest](#userequest) - API 请求封装
- [usePolling](#usepolling) - 轮询请求
- [useLocalStorage](#uselocalstorage) - 本地存储
- [useDebounceFn](#usedebouncefn) - 防抖/节流函数
- [usePagination](#usepagination) - 分页逻辑
- [useVirtualScroll](#usevirtualscroll) - 虚拟滚动
- [useEventListener](#useeventlistener) - 事件监听
- [useMarkdownRenderer](#usemarkdownrenderer) - Markdown 渲染

### 业务 Composables

- [useDashboardState](#usedashboardstate) - 仪表盘状态管理
- [useRecentVisits](#userecentvisits) - 最近访问记录
- [usePointerDragSession](#usepointerdragsession) - 指针拖拽交互

### 布局 Composables

- [useMainLayoutState](#usemainlayoutstate) - 主布局状态

---

## useRequest

**文件路径**: `src/composables/useRequest.ts`

**功能**: 统一处理 API 请求、加载状态、错误处理和自动重试。

### API

```typescript
interface UseRequestOptions<T = unknown> {
  immediate?: boolean              // 是否立即执行请求
  globalLoadingKey?: string        // 全局加载状态键
  onSuccess?: (data: T) => void    // 成功回调
  onError?: (error: Error) => void // 错误回调
}

interface UseRequestReturn<T> {
  data: Ref<T | null>              // 响应数据
  isLoading: Ref<boolean>          // 加载状态
  error: Ref<Error | null>         // 错误信息
  execute: (options?: { retry?: boolean }) => Promise<RequestResult<T>>
  cancel: () => void               // 取消请求
  reset: () => void                // 重置状态
}
```

### 使用示例

```typescript
import { useRequest } from '@/composables/useRequest'
import { apiFetch } from '@/platform/http/apiFetch'

// 基本使用 - 手动执行
const { data, isLoading, error, execute } = useRequest(() =>
  apiFetch('/api/users')
)

// 立即执行
const { data } = useRequest(() => apiFetch('/api/users'), { immediate: true })

// 带回调
const { execute } = useRequest(
  () => apiFetch('/api/users'),
  {
    onSuccess: (data) => console.log('获取成功:', data),
    onError: (error) => console.error('获取失败:', error)
  }
)

// 手动执行（带重试）
await execute()           // 默认启用重试（最多3次，指数退避）
await execute({ retry: false }) // 不重试
```

### 重试机制

- **默认启用**: 请求失败时自动重试
- **重试次数**: 最多3次
- **退避策略**: 指数退避（1s, 2s, 4s）
- **不重试场景**: 传入 `{ retry: false }`

---

## usePolling

**文件路径**: `src/composables/usePolling.ts`

**功能**: 创建轮询请求，支持自动启停和错误处理。

### API

```typescript
interface UsePollingOptions {
  interval: number                 // 轮询间隔（毫秒）
  immediate?: boolean              // 是否立即执行（默认true）
  onError?: (error: unknown) => void // 错误回调
}

interface UsePollingReturn {
  isRunning: Ref<boolean>          // 是否运行中
  tick: () => Promise<void>        // 立即执行一次
  start: () => void                // 开始轮询
  stop: () => void                 // 停止轮询
}
```

### 使用示例

```typescript
import { usePolling } from '@/composables/usePolling'

const { isRunning, start, stop } = usePolling(
  async () => {
    const data = await fetchData()
    console.log('轮询数据:', data)
  },
  {
    interval: 5000,  // 每5秒执行一次
    immediate: true,
    onError: (error) => console.error('轮询失败:', error)
  }
)

// 手动控制
start()  // 开始轮询
stop()   // 停止轮询
```

---

## useLocalStorage

**文件路径**: `src/composables/useLocalStorage.ts`

**功能**: 提供响应式的 localStorage 读写能力，自动持久化。

### API

```typescript
interface UseLocalStorageOptions<T> {
  serializer?: (value: T) => string    // 自定义序列化函数
  parser?: (value: string) => T        // 自定义解析函数
  listenExternal?: boolean             // 是否监听外部变化（多标签页同步）
  sync?: boolean                       // 是否监听 storage 事件
  deep?: boolean                       // 是否深度监听
}
```

### 使用示例

```typescript
import { useLocalStorage, useSessionStorage } from '@/composables/useLocalStorage'

// 基本使用
const theme = useLocalStorage<'dark' | 'light'>('theme', 'dark')

// 修改值（自动持久化）
theme.value = 'light'

// 使用自定义序列化
const date = useLocalStorage<Date>('lastLogin', new Date(), {
  serializer: (v) => v.toISOString(),
  parser: (v) => new Date(v)
})

// 多标签页同步
const count = useLocalStorage<number>('count', 0, { sync: true })

// SessionStorage
const session = useSessionStorage('session', { userId: '' })
```

### 辅助函数

```typescript
import {
  removeLocalStorage,
  removeSessionStorage,
  clearLocalStorage,
  clearSessionStorage
} from '@/composables/useLocalStorage'

// 移除项
removeLocalStorage('theme')

// 清空存储
clearLocalStorage()
```

---

## useDebounceFn

**文件路径**: `src/composables/useDebounceFn.ts`

**功能**: 创建防抖/节流函数，延迟执行直到等待期结束。

### API

```typescript
interface UseDebounceOptions {
  delay: number                    // 延迟时间（毫秒）
  immediate?: boolean              // 是否立即执行首次调用
}

interface UseDebounceReturn<T> {
  (...args: Parameters<T>): void   // 防抖处理后的函数
  cancel: () => void               // 取消待执行的调用
  isPending: Ref<boolean>          // 是否有待执行的调用
}

interface UseThrottleOptions {
  limit: number                    // 时间间隔（毫秒）
  immediate?: boolean              // 是否立即执行首次调用
}
```

### 使用示例

```typescript
import { useDebounceFn, useThrottleFn } from '@/composables/useDebounceFn'

// 搜索输入防抖
const searchFn = useDebounceFn((query: string) => {
  console.log('搜索:', query)
}, { delay: 300 })

// 在输入框中使用
// <input @input="searchFn($event.target.value)" />

// 取消待执行的调用
searchFn.cancel()

// 检查是否有待执行的调用
if (searchFn.isPending.value) {
  console.log('有搜索请求待执行')
}

// 滚动处理节流
const scrollHandler = useThrottleFn(() => {
  // 处理滚动
}, { limit: 200 })
```

---

## usePagination

**文件路径**: `src/composables/usePagination.ts`

**功能**: 分页逻辑封装，处理页码、页大小、总数计算。

### API

```typescript
interface UsePaginationOptions {
  pageSize?: MaybeRefOrGetter<number>    // 每页项目数量（默认20）
  initialPage?: number                   // 初始页码（默认1）
}

interface UsePaginationReturn<T> {
  items: ComputedRef<T[]>               // 当前页的项目列表
  currentPage: Ref<number>               // 当前页码
  totalPages: ComputedRef<number>       // 总页数
  hasNext: ComputedRef<boolean>         // 是否有下一页
  hasPrev: ComputedRef<boolean>         // 是否有上一页
  nextPage: () => void                   // 前往下一页
  prevPage: () => void                   // 前往上一页
  goToPage: (page: number) => void       // 跳转到指定页
  reset: () => void                      // 重置到第一页
  allItems: ComputedRef<T[]>            // 所有项目（原始数据）
  total: ComputedRef<number>            // 总项目数
}
```

### 使用示例

```typescript
import { usePagination } from '@/composables/usePagination'

const {
  items,
  currentPage,
  totalPages,
  hasNext,
  hasPrev,
  nextPage,
  prevPage,
  goToPage,
  reset,
  total
} = usePagination(filteredNotes, {
  pageSize: 20,
  initialPage: 1
})

// 下一页
nextPage()

// 跳转到第5页
goToPage(5)

// 数据变化时自动重置页码
// watch(itemsValue, () => { if (currentPage > totalPages) currentPage = 1 })
```

---

## useVirtualScroll

**文件路径**: `src/composables/useVirtualScroll.ts`

**功能**: 虚拟滚动，用于优化长列表渲染性能，只渲染可见区域的项目。

### API

```typescript
interface UseVirtualScrollOptions {
  itemHeight: MaybeRefOrGetter<number>       // 每个项目的高度（像素）
  containerHeight: MaybeRefOrGetter<number>  // 容器高度
  overscan?: MaybeRefOrGetter<number>        // 缓冲项目数量（双向，默认4）
}

interface UseVirtualScrollReturn<T> {
  containerRef: Ref<HTMLElement | null>      // 容器元素引用
  onScroll: (event: Event) => void           // 滚动事件处理器
  setScrollTop: (value: number) => void      // 设置滚动位置
  syncContainerScroll: () => void            // 同步容器滚动位置
  visibleItems: ComputedRef<Array<{ item: T; index: number }>> // 可见项目
  totalHeight: ComputedRef<number>           // 总高度
  scrollTop: Ref<number>                     // 当前滚动位置
  offsetY: ComputedRef<number>               // Y轴偏移量
  startIndex: ComputedRef<number>            // 起始索引
  endIndex: ComputedRef<number>              // 结束索引
  maxScrollTop: ComputedRef<number>          // 最大可滚动距离
}
```

### 使用示例

```typescript
import { useVirtualScroll } from '@/composables/useVirtualScroll'

const {
  containerRef,
  onScroll,
  visibleItems,
  totalHeight,
  offsetY
} = useVirtualScroll(items, {
  itemHeight: 50,        // 每项50px
  containerHeight: 400,  // 容器400px
  overscan: 4            // 上下各多渲染4项作为缓冲
})

// 在模板中使用
// <div ref="containerRef" @scroll="onScroll" :style="{ height: '400px', overflow: 'auto' }">
//   <div :style="{ height: totalHeight + 'px', position: 'relative' }">
//     <div
//       v-for="{ item, index } in visibleItems"
//       :key="index"
//       :style="{ height: itemHeight + 'px', transform: `translateY(${offsetY}px)` }"
//     >
//       {{ item }}
//     </div>
//   </div>
// </div>
```

---

## useEventListener

**文件路径**: `src/composables/useEventListener.ts`

**功能**: 统一管理 DOM 事件监听器的添加和移除，防止内存泄漏。支持 Vue 生命周期自动清理。

### API

```typescript
// 基础用法（自动绑定生命周期）
function useEventListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document | null,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions & { enabled?: boolean }
): void

// 动态事件监听（手动管理）
function useDynamicEventListener(): {
  add: (target, event, handler, options?) => void
  remove: (target, event, handler) => void
  removeAll: () => void
}
```

### 使用示例

```typescript
import { useEventListener, useDynamicEventListener } from '@/composables/useEventListener'

// 基础用法（自动清理）
useEventListener(window, 'scroll', handleScroll)

// 带选项
useEventListener(element, 'click', handleClick, { passive: true })

// 条件监听
useEventListener(document, 'keydown', handleKeydown, { enabled: isModalOpen })

// 动态事件监听（手动管理）
const { add, remove, removeAll } = useDynamicEventListener()

// 添加监听
add(window, 'scroll', handleScroll)

// 移除监听
remove(window, 'scroll', handleScroll)

// 移除所有
removeAll() // 组件卸载时自动调用
```

---

## useMarkdownRenderer

**文件路径**: `src/composables/useMarkdownRenderer.ts`

**功能**: 提供统一的 Markdown 解析和 HTML 消毒功能。使用懒加载策略，按需导入 marked 和 DOMPurify。

### API

```typescript
interface UseMarkdownRendererReturn {
  isReady: Ref<boolean>              // 渲染引擎是否已就绪
  renderedMarkdown: ComputedRef<string> // 最后渲染的 HTML 内容
  renderMarkdownSync: (content: string) => string  // 同步渲染（要求库已加载）
  renderMarkdown: (content: string) => Promise<string> // 异步渲染（自动加载库）
  initializeRenderer: () => Promise<void> // 初始化渲染引擎
}
```

### 使用示例

```typescript
import { useMarkdownRenderer } from '@/composables/useMarkdownRenderer'

const { renderedMarkdown, isReady, renderMarkdown } = useMarkdownRenderer()

// 异步渲染 Markdown（自动加载库）
const html = await renderMarkdown('# Hello World')

// 同步渲染（库已加载时）
if (isReady.value) {
  const html = renderMarkdownSync('# Hello World')
}

// 在模板中使用
// <div v-html="renderedMarkdown"></div>
```

---

## useDashboardState

**文件路径**: `src/composables/useDashboardState.ts`

**功能**: 仪表盘状态管理，包括系统监控、天气、新闻、NewAPI监控、活动图表等数据的获取和轮询。

### API

```typescript
interface UseDashboardStateOptions {
  activeComponentKeys?: MaybeRefOrGetter<readonly string[]>
}

interface UseDashboardStateReturn {
  // 系统监控
  cpuUsage: Ref<number>
  cpuPlatform: Ref<string>
  cpuArch: Ref<string>
  memUsage: Ref<number>
  memInfo: Ref<string>
  vcpMemUsage: Ref<number>
  pm2Processes: Ref<PM2ProcessInfo[]>
  nodeInfo: Ref<Partial<NodeProcessInfo>>
  userAuthCode: Ref<string>
  
  // 天气
  weather: Ref<DashboardWeatherDisplay>
  
  // 新闻
  newsItems: Ref<NewsItem[]>
  
  // NewAPI监控
  newApiMonitorSummary: Ref<NewApiMonitorSummary | null>
  newApiMonitorTrend: Ref<NewApiMonitorTrendItem[]>
  newApiMonitorModels: Ref<NewApiMonitorModelItem[]>
  newApiMonitorStatus: Ref<'loading' | 'ready' | 'unavailable' | 'error'>
  newApiMonitorError: Ref<string>
  
  // 活动图表
  activityCanvas: Ref<HTMLCanvasElement | null>
}
```

### 使用示例

```typescript
import { useDashboardState } from '@/composables/useDashboardState'

const activeKeys = ref(['cpu', 'memory', 'weather', 'news'])

const {
  cpuUsage,
  memUsage,
  weather,
  newsItems,
  activityCanvas
} = useDashboardState(activeKeys)

// 在模板中使用
// <canvas ref="activityCanvas"></canvas>
// <div>{{ cpuUsage }}%</div>
// <div>{{ weather.temp }}°C</div>
```

### 组件键名

用于 `activeComponentKeys` 来控制哪些数据需要轮询：

- `cpu`, `memory`, `process`, `node-info` - 系统监控
- `weather` - 天气数据
- `news` - 新闻数据
- `newapi-monitor` - NewAPI 监控
- `activity-chart` - 活动图表

---

## useRecentVisits

**文件路径**: `src/composables/useRecentVisits.ts`

**功能**: 管理最近访问记录和导航使用统计，支持本地持久化。

### API

```typescript
interface RecentVisit {
  target: string
  label: string
  icon?: string
  pluginName?: string
}

interface NavigationUsageRecord {
  count: number
  lastVisitedAt: number
}

// Hook
function useRecentVisits(): Ref<RecentVisit[]>
function useNavigationUsage(): Ref<NavigationUsageMap>

// 工具函数
function createRecentVisit(options): RecentVisit | null
function pushRecentVisit(recentVisits, nextVisit, limit?): RecentVisit[]
function recordNavigationVisit(options): { recentVisits, navigationUsage }
```

### 使用示例

```typescript
import {
  useRecentVisits,
  useNavigationUsage,
  recordNavigationVisit
} from '@/composables/useRecentVisits'

const recentVisits = useRecentVisits()        // 自动持久化
const navigationUsage = useNavigationUsage()  // 自动持久化

// 记录访问
const result = recordNavigationVisit({
  target: 'dashboard',
  navItems: appStore.navItems,
  plugins: appStore.plugins,
  recentVisits: recentVisits.value,
  navigationUsage: navigationUsage.value
})

recentVisits.value = result.recentVisits
navigationUsage.value = result.navigationUsage
```

---

## usePointerDragSession

**文件路径**: `src/composables/usePointerDragSession.ts`

**功能**: 指针拖拽交互管理，支持创建拖拽会话、幽灵元素、动画效果。

### API

```typescript
interface UsePointerDragSessionOptions<TItem, TGhost> {
  activationDistance?: number       // 触发拖拽的最小移动距离（默认8px）
  ghostScale?: number               // 幽灵元素缩放比例（默认1.016）
  ghostRotateDivisor?: number       // 旋转计算除数（默认34）
  commitOnPointerCancel?: boolean   // 取消时是否提交
  commitOnWindowBlur?: boolean      // 窗口失焦时是否提交（默认true）
  commitOnVisibilityHidden?: boolean // 页面隐藏时是否提交（默认true）
  createGhost: (item: TItem) => TGhost | null  // 创建幽灵元素
  onActivate?: (state) => void      // 激活时回调
  onFrame?: (state) => void         // 每帧回调
  onCommit?: (state) => void        // 提交时回调
  onCancel?: (state) => void        // 取消时回调
  onClear?: () => void              // 清理时回调
}

interface UsePointerDragSessionReturn {
  pointerState: ShallowRef<PointerDragSessionState<TItem> | null>
  dragGhost: ShallowRef<TGhost | null>
  dragGhostElement: Ref<HTMLElement | null>
  startPointerDrag: (options) => boolean
  // ... 其他内部方法
}
```

### 使用示例

```typescript
import { usePointerDragSession } from '@/composables/usePointerDragSession'

const { pointerState, dragGhost, dragGhostElement, startPointerDrag } = usePointerDragSession({
  activationDistance: 8,
  ghostScale: 1.016,
  createGhost: (item) => ({ ...item }), // 创建幽灵数据
  onActivate: (state) => {
    console.log('拖拽开始', state.item)
  },
  onCommit: (state) => {
    console.log('拖拽提交', state.item, '新位置:', state.currentX, state.currentY)
  },
  onCancel: (state) => {
    console.log('拖拽取消')
  }
})

// 在模板中使用
// <div
//   @pointerdown="(e) => startPointerDrag({ item, event: e, itemElement: el, captureElement: el })"
// >
//   可拖拽内容
// </div>
// <div ref="dragGhostElement" v-if="dragGhost">
//   幽灵元素
// </div>
```

---

## useMainLayoutState

**文件路径**: `src/composables/useMainLayoutState.ts`

**功能**: 主布局状态管理，整合导航、控制和 DOM 效果。

### API

```typescript
interface UseMainLayoutStateReturn {
  // 来自 useMainLayoutControls
  isMobileMenuOpen: Ref<boolean>
  isImmersiveMode: Ref<boolean>
  isSidebarCollapsed: Ref<boolean>
  isHoveringSidebar: Ref<boolean>
  isHoverEnabled: Ref<boolean>
  isCommandPaletteOpen: Ref<boolean>
  isSystemMenuOpen: Ref<boolean>
  isUserMenuOpen: Ref<boolean>
  hasNotifications: Ref<boolean>
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleMobileMenu: () => void
  closeMobileMenu: () => void
  toggleSidebarCollapse: () => void
  toggleSystemMenu: () => void
  toggleUserMenu: () => void
  closeAllMenus: () => void
  closeTransientUi: () => void
  enterImmersiveMode: () => void
  exitImmersiveMode: () => void
  
  // 来自 useMainLayoutNavigation
  currentPageTitle: ComputedRef<string>
  recentVisits: Ref<RecentVisit[]>
  navigationUsage: Ref<NavigationUsageMap>
  navigateTo: (target: string, pluginName?: string) => void
  
  // 来自 useMainLayoutDomEffects
  showBackToTop: Ref<boolean>
  scrollToTop: () => void
  
  // 其他
  contentRef: Ref<HTMLElement | null>
}
```

### 子模块

主布局状态由三个子 composable 组合而成：

#### useMainLayoutControls
- **路径**: `src/composables/main-layout/useMainLayoutControls.ts`
- **职责**: 管理所有 UI 控件状态（菜单、命令面板、沉浸模式等）

#### useMainLayoutNavigation
- **路径**: `src/composables/main-layout/useMainLayoutNavigation.ts`
- **职责**: 处理导航逻辑、页面标题解析、最近访问记录

#### useMainLayoutDomEffects
- **路径**: `src/composables/main-layout/useMainLayoutDomEffects.ts`
- **职责**: DOM 事件绑定、响应式布局、键盘快捷键、沉浸模式同步

### 使用示例

```typescript
import { useMainLayoutState } from '@/composables/useMainLayoutState'

const {
  // 布局状态
  isSidebarCollapsed,
  toggleSidebarCollapse,
  isImmersiveMode,
  
  // 导航
  currentPageTitle,
  navigateTo,
  recentVisits,
  
  // UI 控制
  isCommandPaletteOpen,
  openCommandPalette,
  closeTransientUi,
  
  // DOM
  contentRef,
  showBackToTop,
  scrollToTop
} = useMainLayoutState()
```

---

## 最佳实践

### 1. 命名规范

- Composable 函数名必须以 `use` 开头
- 返回值解构时保持语义清晰

```typescript
// 推荐
const { data, isLoading, execute } = useRequest(...)
const { message, show, clear } = useStatusMessage()

// 避免
const { data: d, isLoading: l } = useRequest(...)
```

### 2. 类型注解

- 为泛型参数提供明确类型
- 返回值使用接口定义

```typescript
// 推荐
interface User { id: number; name: string }
const { data } = useRequest<User>(() => apiFetch('/api/user'))

// 避免
const { data } = useRequest(() => apiFetch('/api/user')) // data 类型为 unknown
```

### 3. 错误处理

- 使用 `useRequest` 的 `onError` 回调
- 或在 `execute()` 后检查 `error.value`

```typescript
const { data, error, execute } = useRequest(() => apiFetch('/api/data'))

await execute()
if (error.value) {
  console.error('请求失败:', error.value.message)
}
```

### 4. 内存管理

- Composable 内部的副作用会在组件卸载时自动清理
- 手动创建的定时器/监听器需要在 `onUnmounted` 中清理

---

## 更新记录

| 日期 | 更新内容 |
|------|----------|
| 2026-04-13 | 修复过时内容：移除 useStatusMessage，添加缺失的 composables（usePolling, useMarkdownRenderer, useEventListener, useDashboardState, useMainLayoutState, useRecentVisits, usePointerDragSession, useVirtualScroll），添加 main-layout 子模块文档 |
| 2026-03-28 | 创建本文档 |