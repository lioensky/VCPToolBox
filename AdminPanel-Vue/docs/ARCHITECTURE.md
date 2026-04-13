# AdminPanel-Vue 架构总览

本文档详细说明 AdminPanel-Vue 的整体架构设计、模块职责和代码组织方式。

## 目录

- [架构概览](#架构概览)
- [分层架构](#分层架构)
- [目录结构详解](#目录结构详解)
- [模块依赖关系](#模块依赖关系)
- [数据流向](#数据流向)
- [设计原则](#设计原则)

---

## 架构概览

AdminPanel-Vue 采用**分层架构**设计，代码按职责垂直拆分，每一层都有明确的职责边界。

```
┌─────────────────────────────────────────────────────────┐
│                      View Layer                         │
│                  (views/ + components/)                 │
├─────────────────────────────────────────────────────────┤
│                    Feature Layer                        │
│                    (features/)                          │
├─────────────────────────────────────────────────────────┤
│                     App Layer                           │
│              (app/ + router/ + stores/)                 │
├─────────────────────────────────────────────────────────┤
│                   Platform Layer                        │
│           (platform/ + api/ + composables/)             │
├─────────────────────────────────────────────────────────┤
│                   Utility Layer                         │
│              (utils/ + constants/ + types/)             │
└─────────────────────────────────────────────────────────┘
```

### 架构特点

1. **垂直切片** - 按功能域而非技术类型组织代码
2. **依赖倒置** - 上层依赖下层，下层不依赖上层
3. **单一职责** - 每个模块只负责一种类型的任务
4. **可测试性** - 分层设计便于单元测试

---

## 分层架构

### 1. Platform Layer（平台层）

**职责**: 提供与业务无关的基础设施能力

**目录**: `src/platform/`

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| `auth/` | 认证基础设施 | `session.ts` - Session管理和401处理 |
| `feedback/` | 反馈基础设施 | `feedbackBus.ts` - 全局消息总线 |
| `http/` | HTTP基础设施 | `errors.ts` - 错误类型定义 |

**设计原则**:
- 不依赖任何业务代码
- 通过回调或事件与上层通信
- 提供统一的接口供上层使用

**示例**:
```typescript
// platform/auth/session.ts
export function setAuthExpiredListener(listener: AuthExpiredListener): void
export function notifyAuthExpired(event: AuthExpiredEvent): void
```

### 2. App Layer（应用层）

**职责**: 应用核心配置和全局状态

**目录**: `src/app/`、`src/router/`、`src/stores/`

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| `app/routes/` | 路由配置 | `manifest.ts` - 路由注册表 |
| `router/` | 路由实例 | `index.ts` - 路由守卫 |
| `stores/` | 全局状态 | `auth.ts`、`app.ts` |

**设计原则**:
- 定义应用级配置
- 管理全局状态
- 协调各功能模块

### 3. Feature Layer（功能层）

**职责**: 页面级业务逻辑封装

**目录**: `src/features/`

每个功能目录包含：
- 业务组合式函数（如 `useThinkingChainsEditor.ts`）
- 辅助函数（如 `reorderClusters.ts`）

**设计原则**:
- 将复杂的页面逻辑提取到可复用的组合式函数
- 保持视图组件简洁
- 便于单元测试

**示例结构**:
```
features/thinking-chains-editor/
├── useThinkingChainsEditor.ts    # 主逻辑
└── reorderClusters.ts            # 辅助函数
```

### 4. View Layer（视图层）

**职责**: UI渲染和用户交互

**目录**: `src/views/`、`src/components/`

| 类型 | 位置 | 说明 |
|------|------|------|
| 页面视图 | `views/` | 路由对应的页面组件 |
| 布局组件 | `layouts/` | 页面布局骨架 |
| 公共组件 | `components/` | 跨页面复用的组件 |
| 仪表盘组件 | `components/dashboard/` | 仪表盘专用组件 |

**设计原则**:
- 只负责渲染和事件转发
- 复杂逻辑委托给 Feature Layer
- 使用 Composition API 组织代码

---

## 目录结构详解

### `src/api/` - API层

按业务域拆分，每个文件对应一个后端模块：

```
api/
├── index.ts           # 统一导出
├── auth.ts            # 认证相关
├── diary.ts           # 日记管理
├── system.ts          # 系统监控
├── plugin.ts          # 插件管理
├── agent.ts           # Agent管理
└── ...
```

每个API模块提供：
- 请求函数
- 请求/响应类型定义
- 错误处理

### `src/app/` - 应用核心

```
app/
├── routes/
│   ├── manifest.ts     # 路由注册表
│   ├── components.ts   # 路由组件映射
│   ├── navigation.ts   # 导航工具
│   ├── redirect.ts     # 重定向逻辑
│   └── base.ts         # 基础路径配置
└── shell/
    └── useMainLayoutShellEffects.ts  # 布局副作用
```

### `src/platform/` - 平台层

```
platform/
├── auth/
│   └── session.ts      # Session管理
├── feedback/
│   ├── feedbackBus.ts  # 消息总线
│   └── feedbackState.ts # 状态实现
└── http/
    └── errors.ts       # HTTP错误类型
```

### `src/stores/` - 状态管理

使用 Pinia Composition API 风格：

```
stores/
├── auth.ts             # 认证状态
├── app.ts              # 应用状态
├── diary.ts            # 日记数据
├── loading.ts          # 全局加载
└── pluginConfig.ts     # 插件配置
```

Store设计模式：
```typescript
export const useAuthStore = defineStore('auth', () => {
  // State
  const isAuthenticated = ref(false)
  
  // Getters (computed)
  const isLoggedIn = computed(() => isAuthenticated.value)
  
  // Actions
  async function login(credentials: LoginCredentials) { ... }
  function logout() { ... }
  
  return { isAuthenticated, isLoggedIn, login, logout }
})
```

### `src/composables/` - 组合式函数

可复用的业务无关逻辑：

```
composables/
├── useRequest.ts       # API请求封装
├── useLocalStorage.ts  # 响应式LocalStorage
├── useDebounceFn.ts    # 防抖函数
├── usePagination.ts    # 分页逻辑
├── usePolling.ts       # 轮询
└── ...
```

### `src/utils/` - 工具函数

纯函数工具集：

```
utils/
├── index.ts            # 统一导出
├── api.ts              # API客户端
├── auth.ts             # 认证工具
├── format.ts           # 格式化
├── logger.ts           # 日志
├── navigation.ts       # 导航工具
├── ui.ts               # UI工具
└── ...
```

---

## 模块依赖关系

### 依赖规则

```
View Layer ───────┐
                  ├───> Feature Layer ───> App Layer ───> Platform Layer
Feature Layer ────┘

App Layer ──────────────────────────────────────────────> Platform Layer

Platform Layer ────────X───────> (不依赖任何上层)
```

### 允许的直接依赖

| 模块 | 可依赖的下层模块 |
|------|------------------|
| `views/` | `components/`、`features/`、`stores/`、`api/`、`utils/`、`platform/` |
| `features/` | `stores/`、`api/`、`utils/`、`composables/`、`platform/` |
| `stores/` | `api/`、`utils/`、`platform/` |
| `api/` | `utils/`、`platform/` |
| `platform/` | `utils/`（仅基础工具） |

### 禁止的依赖

- ❌ `platform/` 依赖 `stores/`、`views/`、`features/`
- ❌ `api/` 依赖 `stores/`、`views/`
- ❌ 同层模块间直接依赖（通过统一出口导入）

---

## 数据流向

### 典型数据流

```
用户操作
    │
    ▼
View Component ──emit──> Feature Composable
    │                         │
    │                         ▼
    │                   Store (Pinia)
    │                         │
    │                         ▼
    │                   API Layer
    │                         │
    │                         ▼
    │                   HTTP Client
    │                         │
    │                         ▼
    │                   Backend API
    │
    ▼
UI Update (Reactive)
```

### 示例：获取用户列表

```typescript
// 1. View Layer: 触发操作
// views/UserList.vue
template>
  <button @click="handleLoad">加载用户</button>
  <ul>
    <li v-for="user in users" :key="user.id">{{ user.name }}</li>
  </ul>
</template

<script setup>
import { useUserList } from '@/features/user-list/useUserList'

const { users, handleLoad } = useUserList()
</script

// 2. Feature Layer: 业务逻辑
// features/user-list/useUserList.ts
export function useUserList() {
  const users = ref<User[]>([])
  
  async function handleLoad() {
    users.value = await userApi.getUsers()
  }
  
  return { users, handleLoad }
}

// 3. API Layer: 后端通信
// api/user.ts
export const userApi = {
  async getUsers(): Promise<User[]> {
    return apiFetch('/api/users')
  }
}
```

---

## 设计原则

### 1. 关注点分离 (Separation of Concerns)

每个模块只负责一种类型的任务：

- **View**: 渲染UI
- **Feature**: 业务逻辑
- **Store**: 状态管理
- **API**: 数据获取
- **Platform**: 基础设施

### 2. 组合优于继承 (Composition over Inheritance)

使用组合式函数而非类继承：

```typescript
// ✅ 推荐：组合
function useUserForm() {
  const { data, execute } = useRequest(createUser)
  const { validate } = useValidation()
  
  return { data, execute, validate }
}

// ❌ 避免：继承
class UserForm extends BaseForm {
  // ...
}
```

### 3. 显式优于隐式 (Explicit over Implicit)

依赖注入优于全局状态：

```typescript
// ✅ 推荐：显式传递
function useFeature(api: ApiClient) { }

// ❌ 避免：隐式依赖全局状态
function useFeature() {
  const api = getGlobalApi() // 隐式依赖
}
```

### 4. 单一职责 (Single Responsibility)

一个函数/组件只做一件事：

```typescript
// ✅ 推荐：拆分职责
function useUserSearch() { /* 搜索逻辑 */ }
function useUserFilter() { /* 过滤逻辑 */ }
function useUserSort() { /* 排序逻辑 */ }

// ❌ 避免：一个函数做多件事
function useUserManagement() {
  // 搜索 + 过滤 + 排序 + 分页...
}
```

### 5. 可测试性 (Testability)

设计时考虑测试：

- 纯函数优先
- 副作用隔离
- 依赖可注入
- 避免全局状态

```typescript
// ✅ 易于测试
export function formatDate(date: Date, format: string): string {
  // 纯函数，输入确定则输出确定
}

// ❌ 难以测试
export function formatDate(date: Date): string {
  return date.toLocaleString(getUserLocale()) // 依赖全局状态
}
```

---

## 扩展阅读

- [路由系统](ROUTING.md) - 路由架构和导航设计
- [平台层](PLATFORM.md) - 认证、反馈、HTTP基础设施
- [API层](API_LAYER.md) - 后端接口封装规范
- [状态管理](STATE_MANAGEMENT.md) - Pinia Store设计
- [仪表盘系统](DASHBOARD_SYSTEM.md) - 卡片式仪表盘架构
