# AdminPanel-Vue 路由系统

本文档详细说明 AdminPanel-Vue 的路由架构设计、配置方式和使用方法。

## 目录

- [架构概览](#架构概览)
- [路由注册表](#路由注册表)
- [路由分组](#路由分组)
- [组件映射](#组件映射)
- [导航生成](#导航生成)
- [权限控制](#权限控制)
- [工具函数](#工具函数)
- [添加新路由](#添加新路由)
- [动态路由](#动态路由)

---

## 架构概览

AdminPanel-Vue 采用**Manifest + Component**分离的路由架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                      Manifest                               │
│  (app/routes/manifest.ts)                                   │
│  - 路由元数据（路径、标题、图标、权限）                       │
│  - 导航结构定义                                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     Components                              │
│  (app/routes/components.ts)                                 │
│  - 懒加载的页面组件                                          │
│  - 代码分割配置                                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      Router                                 │
│  (router/index.ts)                                          │
│  - 路由守卫（认证检查）                                      │
│  - 路由转换逻辑                                             │
└─────────────────────────────────────────────────────────────┘
```

### 设计优势

1. **单一数据源** - 路由元数据集中管理
2. **类型安全** - TypeScript 严格类型检查
3. **导航同步** - 侧边栏自动从路由生成
4. **懒加载** - 组件按需加载优化性能
5. **权限集成** - 路由级权限控制

---

## 路由注册表

路由元数据定义在 `src/app/routes/manifest.ts`：

### 核心类型

```typescript
// 路由分组
type AppRouteGroup = 'core' | 'agentContent' | 'knowledge' | 'toolsPlugins'

// 路由ID（严格类型）
type AppRouteId = 
  | 'login' 
  | 'dashboard' 
  | 'base-config'
  | 'daily-notes-manager'
  | 'vcp-forum'
  // ... 更多

// 路由元数据
interface AppRouteMeta {
  id: AppRouteId           // 唯一标识
  routeName: string        // 路由名称（用于跳转）
  path: string             // URL路径
  title: string            // 页面标题
  icon?: string            // 图标（Material Symbols）
  requiresAuth: boolean    // 是否需要认证
  navGroup?: AppRouteGroup // 导航分组
  showInSidebar: boolean   // 是否在侧边栏显示
}
```

### 路由注册表示例

```typescript
export const APP_ROUTE_MANIFEST: readonly AppRouteMeta[] = [
  {
    id: 'login',
    routeName: 'Login',
    path: '/login',
    title: '登录',
    icon: 'login',
    requiresAuth: false,
    showInSidebar: false,
  },
  {
    id: 'dashboard',
    routeName: 'Dashboard',
    path: '/dashboard',
    title: '仪表盘',
    icon: 'dashboard',
    requiresAuth: true,
    navGroup: 'core',
    showInSidebar: true,
  },
  {
    id: 'base-config',
    routeName: 'BaseConfig',
    path: '/base-config',
    title: '全局基础配置',
    icon: 'settings',
    requiresAuth: true,
    navGroup: 'core',
    showInSidebar: true,
  },
  // ... 更多路由
] as const
```

### 路由查询工具

```typescript
// 通过ID获取路由元数据
getAppRouteMetaById('dashboard')
// { id: 'dashboard', routeName: 'Dashboard', path: '/dashboard', ... }

// 通过路由名称获取
getAppRouteMetaByRouteName('Dashboard')
// { id: 'dashboard', routeName: 'Dashboard', path: '/dashboard', ... }

// 通过路径获取
getAppRouteMetaByPath('/dashboard')
// { id: 'dashboard', routeName: 'Dashboard', path: '/dashboard', ... }

// 获取路径
getAppRoutePath('dashboard')  // '/dashboard'

// 获取标题
getAppRouteTitle('dashboard') // '仪表盘'

// 类型守卫
isAppRouteId('dashboard') // true
isAppRouteId('unknown')   // false (TypeScript编译错误)
```

---

## 路由分组

路由按功能域分组，用于生成侧边栏导航：

```
核心 (core)
├── 仪表盘
├── 全局基础配置
└── 服务器日志

Agent & 内容 (agentContent)
├── Agent 管理器
├── Agent 通讯配置
├── Agent 积分排行榜
├── 梦境审批
├── 日程管理
├── VCPTavern 预设编辑
├── VCP 论坛
├── 表情包画廊
└── 多媒体 Base64 编辑器

知识 & RAG (knowledge)
├── 日记知识库管理
├── 语义组编辑器
├── 思维链编辑器
└── 浪潮 RAG 调参

工具 & 插件 (toolsPlugins)
├── Toolbox 管理器
├── 高级变量编辑器
├── 工具列表配置编辑器
├── 预处理器顺序管理
├── 插件调用审核管理
├── 插件中心
└── 占位符查看器
```

### 分组标签定义

```typescript
const NAV_GROUP_LABELS: Record<AppRouteGroup, string> = {
  core: '核心',
  agentContent: 'Agent & 内容',
  knowledge: '知识 & RAG',
  toolsPlugins: '工具 & 插件',
}
```

---

## 组件映射

组件映射定义在 `src/app/routes/components.ts`，使用动态导入实现懒加载：

```typescript
export const APP_ROUTE_COMPONENTS = {
  login: () => import('@/views/Login.vue'),
  dashboard: () => import('@/views/Dashboard.vue'),
  'base-config': () => import('@/views/BaseConfig.vue'),
  'daily-notes-manager': () => import('@/views/DailyNotesManager.vue'),
  // ... 更多
} as const
```

### 代码分割优化

Vite 配置中针对路由组件进行代码分割：

```typescript
// vite.config.ts
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        // 将 Dashboard 相关组件拆分到独立 chunk
        if (id.includes('/components/dashboard/')) {
          return 'dashboard-components'
        }
      }
    }
  }
}
```

---

## 导航生成

### 侧边栏导航生成

```typescript
// app/routes/manifest.ts
export function buildSidebarNavItems(): AppNavItem[] {
  const items: AppNavItem[] = []
  let lastGroup: AppRouteGroup | undefined

  for (const route of APP_ROUTE_MANIFEST) {
    if (!route.showInSidebar || !route.navGroup) {
      continue
    }

    // 分组切换时插入分组标题
    if (route.navGroup !== lastGroup) {
      items.push({ category: NAV_GROUP_LABELS[route.navGroup] })
      lastGroup = route.navGroup
    }

    items.push({
      target: route.id,
      label: route.title,
      icon: route.icon,
    })
  }

  return items
}
```

### 生成的导航结构

```typescript
[
  { category: '核心' },
  { target: 'dashboard', label: '仪表盘', icon: 'dashboard' },
  { target: 'base-config', label: '全局基础配置', icon: 'settings' },
  // ...
  { category: 'Agent & 内容' },
  { target: 'agent-files-editor', label: 'Agent 管理器', icon: 'smart_toy' },
  // ...
]
```

---

## 权限控制

### 路由守卫

```typescript
// router/index.ts
router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()

  // 公开路由直接通过
  if (isPublicRoute(to)) {
    // 已登录用户访问登录页，跳转到首页
    if (to.name === 'Login' && authStore.isAuthenticated) {
      next({ name: 'Dashboard' })
      return
    }
    next()
    return
  }

  // 受保护路由检查认证
  const isAuthenticated = await authStore.checkAuth()
  if (!isAuthenticated) {
    next({
      name: 'Login',
      query: { redirect: to.fullPath }
    })
    return
  }

  next()
})
```

### 公开路由定义

```typescript
function isPublicRoute(to: RouteLocationNormalized): boolean {
  return to.meta.requiresAuth === false || to.name === 'Login'
}
```

### 路由元数据中的权限

```typescript
{
  id: 'dashboard',
  routeName: 'Dashboard',
  path: '/dashboard',
  requiresAuth: true,    // 需要登录
  showInSidebar: true,
}
```

---

## 工具函数

### 导航工具

```typescript
// app/routes/manifest.ts

/**
 * 将导航目标解析为 vue-router 的 RouteLocationRaw
 * @param target - 路由 ID（如 'dashboard'）、自定义 target，或 'plugin-<name>-config' 形式
 * @param pluginName - 若为插件配置页，传入插件名
 */
export function resolveAppNavigationLocation(
  target: string,
  pluginName?: string
): RouteLocationRaw

// 使用示例
router.push(resolveAppNavigationLocation('dashboard'))
router.push(resolveAppNavigationLocation('plugin-config', 'MyPlugin'))
```

### 重定向工具

```typescript
// app/routes/redirect.ts

/**
 * 解析安全的重定向路径
 * 仅接受以 '/' 开头的内部路径，且路由必须存在且非 Login
 */
export function resolveSafeAppRedirect(
  router: Router,
  target: unknown,
  fallbackRouteId?: 'dashboard' | 'login'
): string

// 使用示例
const redirect = resolveSafeAppRedirect(router, route.query.redirect, 'dashboard')
```

### 路径解析

```typescript
// app/routes/base.ts

/** 应用基础路径（vue-router base） */
export const APP_ROUTER_BASE = '/AdminPanel'

/** 旧版入口路径，保留用于兼容旧书签 */
export const APP_LEGACY_ROUTER_BASE = '/AdminPanelLegacy'

/** 将 legacy 路径规范化到 canonical 路径 */
export function normalizeLegacyAppPath(pathname: string): string

/** 返回需要跳转的 canonical URL（含 search/hash），否则返回 null */
export function resolveCanonicalAppLocation(location: {
  pathname: string
  search?: string
  hash?: string
}): string | null
```

### 页面标题解析

```typescript
// app/routes/manifest.ts

/**
 * 根据当前路由解析页面标题
 * 对 plugin-config 会附加插件 displayName
 */
export function resolveAppRouteTitle(
  route: RouteLocationNormalizedLoaded,
  context?: {
    navItems?: readonly AppNavItem[]
    plugins?: readonly PluginInfo[]
  }
): string | undefined
```

---

## 添加新路由

### 步骤 1：定义路由元数据

在 `src/app/routes/manifest.ts` 的 `AppRouteId` 类型和 `APP_ROUTE_MANIFEST` 中添加：

```typescript
// 1. 添加路由ID到联合类型
type AppRouteId = 
  | 'login'
  | 'dashboard'
  // ... 已有路由
  | 'my-new-feature'  // 新增

// 2. 添加路由元数据到注册表
export const APP_ROUTE_MANIFEST: readonly AppRouteMeta[] = [
  // ... 已有路由
  {
    id: 'my-new-feature',
    routeName: 'MyNewFeature',
    path: '/my-new-feature',
    title: '我的新功能',
    icon: 'star',
    requiresAuth: true,
    navGroup: 'core',      // 选择分组
    showInSidebar: true,
  },
] as const
```

### 步骤 2：添加组件映射

在 `src/app/routes/components.ts` 中添加：

```typescript
export const APP_ROUTE_COMPONENTS = {
  // ... 已有映射
  'my-new-feature': () => import('@/views/MyNewFeature.vue'),
} as const
```

### 步骤 3：创建页面组件

创建 `src/views/MyNewFeature.vue`：

```vue
<template>
  <div class="my-new-feature">
    <h1>我的新功能</h1>
  </div>
</template>

<script setup lang="ts">
// 页面逻辑
</script>
```

### 步骤 4：验证

1. 启动开发服务器：`npm run dev`
2. 访问 `/AdminPanel/my-new-feature`
3. 检查侧边栏是否正确显示
4. 检查路由跳转是否正常

---

## 动态路由

### 插件配置页面

插件配置使用动态路由，根据插件名称动态加载：

```typescript
// manifest.ts
{
  id: 'plugin-config',
  routeName: 'PluginConfig',
  path: '/plugin/:pluginName/config',  // 动态参数
  title: '插件配置',
  requiresAuth: true,
  showInSidebar: false,  // 不在侧边栏显示
}
```

### 在组件中获取参数

```vue
<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
const pluginName = computed(() => route.params.pluginName as string)
</script>
```

### 导航到动态路由

```typescript
// 方式 1：使用 resolveAppNavigationLocation
router.push(resolveAppNavigationLocation('plugin-config', 'MyPlugin'))

// 方式 2：直接使用 router.push
router.push({
  name: 'PluginConfig',
  params: { pluginName: 'MyPlugin' }
})
```

---

## 最佳实践

### 1. 路由ID命名

- 使用 `kebab-case`（短横线连接）
- 保持语义清晰
- 避免缩写

```typescript
// ✅ 推荐
'agent-files-editor'
'thinking-chains-editor'
'plugin-config'

// ❌ 避免
'agentFilesEditor'  // 非 kebab-case
'afe'               // 缩写不清晰
```

### 2. 路由名称

- 使用 `PascalCase`
- 与组件名保持一致

```typescript
// ✅ 推荐
routeName: 'AgentFilesEditor'

// ❌ 避免
routeName: 'agentFilesEditor'
routeName: 'agent-files-editor'
```

### 3. 路径设计

- 使用小写
- 多个单词用短横线连接
- 保持简洁

```typescript
// ✅ 推荐
path: '/agent-files-editor'

// ❌ 避免
path: '/agentFilesEditor'
path: '/AgentFilesEditor'
```

### 4. 图标选择

- 使用 Material Symbols 图标
- 选择与功能语义匹配的图标
- 参考 [Material Symbols](https://fonts.google.com/icons)

```typescript
// 仪表盘 - dashboard
icon: 'dashboard'

// 设置 - settings
icon: 'settings'

// Agent - smart_toy
icon: 'smart_toy'
```

### 5. 分组选择

根据功能域选择分组：

- `core` - 核心功能，所有用户常用
- `agent` - Agent 相关功能
- `tools` - 工具配置和管理
- `rag` - RAG 系统相关
- `plugins` - 插件中心
- `other` - 其他辅助功能

---

## 相关文档

- [架构总览](ARCHITECTURE.md) - 系统整体架构
- [平台层](PLATFORM.md) - 认证和权限基础设施
- [状态管理](STATE_MANAGEMENT.md) - 路由相关的状态管理
