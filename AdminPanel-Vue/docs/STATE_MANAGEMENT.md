# AdminPanel-Vue 状态管理

本文档详细说明 AdminPanel-Vue 的状态管理设计，包括 Pinia Store 的组织方式、设计模式和使用方法。

## 目录

- [架构概览](#架构概览)
- [Store 列表](#store-列表)
- [设计模式](#设计模式)
- [认证状态 (auth.ts)](#认证状态-authts)
- [应用状态 (app.ts)](#应用状态-appts)
- [日记状态 (diary.ts)](#日记状态-diaryts)
- [加载状态 (loading.ts)](#加载状态-loadingts)
- [插件配置 (pluginConfig.ts)](#插件配置-pluginconfigts)
- [使用示例](#使用示例)
- [最佳实践](#最佳实践)

---

## 架构概览

AdminPanel-Vue 使用 **Pinia** 作为状态管理方案，采用 **Composition API** 风格定义 Store。

```
┌─────────────────────────────────────────────────────────────┐
│                     Vue Components                          │
│                   (views/ + components/)                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     Pinia Stores                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  authStore  │  │   appStore  │  │  diaryStore │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│  ┌─────────────┐  ┌─────────────┐                          │
│  │ loadingStore│  │pluginConfig │                          │
│  └─────────────┘  └─────────────┘                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Persistence Layer                        │
│              (localStorage + sessionStorage)                │
└─────────────────────────────────────────────────────────────┘
```

### 设计特点

1. **Composition API 风格** - 使用 `ref` 和 `computed` 定义状态
2. **单一职责** - 每个 Store 只管理一类状态
3. **类型安全** - 完整的 TypeScript 类型支持
4. **持久化支持** - 关键状态自动持久化到存储

---

## Store 列表

| Store | 文件 | 职责 | 持久化 |
|-------|------|------|--------|
| Auth | `stores/auth.ts` | 认证状态和用户信息 | ❌ |
| App | `stores/app.ts` | 应用配置和导航 | ✅ localStorage |
| Diary | `stores/diary.ts` | 日记数据和编辑器状态 | ❌ |
| Loading | `stores/loading.ts` | 全局加载状态 | ❌ |
| PluginConfig | `stores/pluginConfig.ts` | 插件配置缓存 | ❌ |

---

## 设计模式

### Composition API 风格

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useXXXStore = defineStore('storeId', () => {
  // ========== State ==========
  const state = ref<StateType>(initialValue)
  
  // ========== Getters (computed) ==========
  const derivedState = computed(() => {
    return state.value * 2
  })
  
  // ========== Actions ==========
  function updateState(newValue: StateType) {
    state.value = newValue
  }
  
  async function asyncAction() {
    // 异步操作
  }
  
  // ========== Return ==========
  return {
    state,
    derivedState,
    updateState,
    asyncAction
  }
})
```

### 对比 Options API 风格

```typescript
// ❌ Options API 风格（不推荐）
export const useAuthStore = defineStore('auth', {
  state: () => ({
    isAuthenticated: false
  }),
  getters: {
    isLoggedIn: (state) => state.isAuthenticated
  },
  actions: {
    login() { }
  }
})

// ✅ Composition API 风格（推荐）
export const useAuthStore = defineStore('auth', () => {
  const isAuthenticated = ref(false)
  const isLoggedIn = computed(() => isAuthenticated.value)
  function login() { }
  
  return { isAuthenticated, isLoggedIn, login }
})
```

---

## 认证状态 (auth.ts)

**位置**: `src/stores/auth.ts`

### 职责

- 管理用户认证状态
- 处理登录/登出逻辑
- 缓存认证检查结果
- 同步用户信息

### 状态定义

```typescript
export const useAuthStore = defineStore('auth', () => {
  // ========== State ==========
  const isAuthenticated = ref(false)
  const isLoading = ref(true)
  const error = ref<string | null>(null)
  const user = ref<UserProfile | null>(null)
  const lastAuthCheckAt = ref(0)
  
  // 防止重复检查
  let authCheckPromise: Promise<boolean> | null = null
  
  // 缓存有效期: 5分钟
  const AUTH_CACHE_TTL = 5 * 60 * 1000
})
```

### Getters

```typescript
// 认证缓存是否有效
function isAuthCacheFresh(): boolean {
  if (lastAuthCheckAt.value === 0) {
    return false
  }
  return Date.now() - lastAuthCheckAt.value < AUTH_CACHE_TTL
}

// 用户是否已登录（计算属性）
const isLoggedIn = computed(() => isAuthenticated.value)
```

### Actions

#### checkAuth

检查当前认证状态，带缓存机制。

```typescript
async function checkAuth(options: { force?: boolean } = {}): Promise<boolean> {
  const { force = false } = options
  
  // 使用缓存
  if (!force && isAuthCacheFresh()) {
    return isAuthenticated.value
  }
  
  // 防止重复请求
  if (authCheckPromise) {
    return authCheckPromise
  }
  
  authCheckPromise = (async () => {
    try {
      isLoading.value = true
      error.value = null
      
      const result = await authApi.checkAuthStatus()
      isAuthenticated.value = result
      lastAuthCheckAt.value = Date.now()
      
      if (result) {
        await syncUserProfile()
      }
      
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : '认证检查失败'
      isAuthenticated.value = false
      return false
    } finally {
      isLoading.value = false
      authCheckPromise = null
    }
  })()
  
  return authCheckPromise
}
```

#### login

处理用户登录。

```typescript
async function login(username: string, password: string): Promise<LoginResponse> {
  try {
    isLoading.value = true
    error.value = null
    
    const result = await authApi.login({ username, password })
    
    if (result.success) {
      isAuthenticated.value = true
      lastAuthCheckAt.value = Date.now()
      await syncUserProfile(username)
    } else {
      error.value = result.message || '登录失败'
    }
    
    return result
  } catch (err) {
    error.value = err instanceof Error ? err.message : '登录失败'
    return { success: false, message: error.value }
  } finally {
    isLoading.value = false
  }
}
```

#### logout

处理用户登出。

```typescript
function logout(): void {
  isAuthenticated.value = false
  user.value = null
  error.value = null
  lastAuthCheckAt.value = 0
  authCheckPromise = null
  
  // 清理 sessionStorage
  if (typeof window !== 'undefined') {
    sessionStorage.clear()
  }
}
```

### 使用示例

```vue
<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()

// 访问状态
console.log(authStore.isAuthenticated)
console.log(authStore.user)

// 调用 action
async function handleLogin() {
  const result = await authStore.login('username', 'password')
  if (result.success) {
    router.push('/dashboard')
  }
}

function handleLogout() {
  authStore.logout()
  router.push('/login')
}
</script>
```

---

## 应用状态 (app.ts)

**位置**: `src/stores/app.ts`

### 职责

- 应用主题配置
- 侧边栏导航项
- 插件列表
- 最近访问记录

### 状态定义

```typescript
export const useAppStore = defineStore('app', () => {
  // ========== State ==========
  const theme = ref<'dark' | 'light'>('dark')
  const navItems = ref<AppNavItem[]>([])
  const plugins = ref<PluginInfo[]>([])
  const pluginsLoaded = ref(false)
  const pinnedPluginNames = ref<string[]>([])
})
```

### 持久化

使用 `useLocalStorage` 实现自动持久化：

```typescript
import { useLocalStorage } from '@/composables/useLocalStorage'

const theme = useLocalStorage<'dark' | 'light'>('app.theme', 'dark')
const pinnedPluginNames = useLocalStorage<string[]>('app.pinnedPlugins', [])
```

### Actions

#### loadPlugins

加载插件列表并生成导航。

```typescript
function loadPlugins(loadedPlugins: PluginInfo[]) {
  plugins.value = loadedPlugins
  
  // 生成插件导航项
  navItems.value = buildSidebarNavItems()
  
  // 合并插件页面到导航
  for (const plugin of loadedPlugins) {
    if (plugin.manifest?.pages) {
      navItems.value.push({
        target: `plugin-config`,
        label: plugin.displayName,
        icon: 'extension',
        pluginName: plugin.name
      })
    }
  }
  
  pluginsLoaded.value = true
}
```

#### toggleTheme

切换主题。

```typescript
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
}
```

### 使用示例

```vue
<script setup lang="ts">
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

// 切换主题
function handleToggleTheme() {
  appStore.toggleTheme()
}
</script>
```

---

## 日记状态 (diary.ts)

**位置**: `src/stores/diary.ts`

### 职责

- 日记列表管理
- 当前编辑的日记
- 编辑器状态
- 文件夹列表

### 状态定义

```typescript
export const useDiaryStore = defineStore('diary', () => {
  // ========== State ==========
  const folders = ref<Folder[]>([])
  const diaries = ref<Note[]>([])
  const currentFolder = ref<string>('')
  const currentDiary = ref<Note | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  
  // 编辑器状态
  const editorContent = ref('')
  const isDirty = ref(false)
  const wordCount = ref(0)
})
```

### Actions

#### fetchFolders

获取文件夹列表。

```typescript
async function fetchFolders() {
  isLoading.value = true
  error.value = null
  
  try {
    folders.value = await diaryApi.getFolders()
  } catch (err) {
    error.value = '获取文件夹失败'
  } finally {
    isLoading.value = false
  }
}
```

#### fetchDiaries

获取日记列表。

```typescript
async function fetchDiaries(folder?: string) {
  isLoading.value = true
  error.value = null
  
  try {
    diaries.value = await diaryApi.getDiaryList(folder)
    currentFolder.value = folder || ''
  } catch (err) {
    error.value = '获取日记列表失败'
  } finally {
    isLoading.value = false
  }
}
```

#### loadDiary

加载日记内容。

```typescript
async function loadDiary(file: string) {
  isLoading.value = true
  
  try {
    const content = await diaryApi.getDiaryContent(file)
    currentDiary.value = diaries.value.find(d => d.file === file) || null
    editorContent.value = content
    isDirty.value = false
    updateWordCount()
  } finally {
    isLoading.value = false
  }
}
```

#### saveCurrentDiary

保存当前日记。

```typescript
async function saveCurrentDiary(): Promise<boolean> {
  if (!currentDiary.value) return false
  
  try {
    await diaryApi.saveDiary(
      currentDiary.value.file,
      editorContent.value
    )
    isDirty.value = false
    return true
  } catch (err) {
    return false
  }
}
```

### 辅助函数

```typescript
function updateWordCount() {
  wordCount.value = editorContent.value.trim().split(/\s+/).length
}

function updateContent(content: string) {
  editorContent.value = content
  isDirty.value = true
  updateWordCount()
}
```

### 使用示例

```vue
<script setup lang="ts">
import { useDiaryStore } from '@/stores/diary'

const diaryStore = useDiaryStore()

// 加载日记
async function handleSelectDiary(file: string) {
  await diaryStore.loadDiary(file)
}

// 保存日记
async function handleSave() {
  const success = await diaryStore.saveCurrentDiary()
  if (success) {
    showMessage('保存成功', 'success')
  }
}

// 监听编辑器变化
function handleEditorChange(content: string) {
  diaryStore.updateContent(content)
}
</script>
```

---

## 加载状态 (loading.ts)

**位置**: `src/stores/loading.ts`

### 职责

- 管理全局加载状态
- 支持多个并发加载请求
- 自动计数

### 状态定义

```typescript
export const useLoadingStore = defineStore('loading', () => {
  // 加载计数器
  const loadingCount = ref(0)
  
  // 是否正在加载
  const isLoading = computed(() => loadingCount.value > 0)
  
  // 加载文本
  const loadingText = ref<string>('加载中...')
})
```

### Actions

```typescript
function startLoading(text?: string) {
  loadingCount.value++
  if (text) {
    loadingText.value = text
  }
}

function stopLoading() {
  if (loadingCount.value > 0) {
    loadingCount.value--
  }
  if (loadingCount.value === 0) {
    loadingText.value = '加载中...'
  }
}
```

### 使用示例

```typescript
const loadingStore = useLoadingStore()

// 开始加载
loadingStore.startLoading('保存中...')

// 执行操作
try {
  await saveData()
} finally {
  // 结束加载
  loadingStore.stopLoading()
}
```

---

## 插件配置 (pluginConfig.ts)

**位置**: `src/stores/pluginConfig.ts`

### 职责

- 缓存插件配置
- 管理插件配置编辑状态
- 配置验证

### 状态定义

```typescript
export const usePluginConfigStore = defineStore('pluginConfig', () => {
  // 配置缓存
  const configCache = ref<Record<string, PluginConfig>>({})
  
  // 当前编辑的配置
  const currentConfig = ref<PluginConfig | null>(null)
  const currentPluginName = ref<string>('')
  
  // 编辑状态
  const isEditing = ref(false)
  const hasChanges = ref(false)
  const errors = ref<Record<string, string>>({})
})
```

### Actions

```typescript
async function loadConfig(pluginName: string) {
  // 先检查缓存
  if (configCache.value[pluginName]) {
    currentConfig.value = configCache.value[pluginName]
    currentPluginName.value = pluginName
    return
  }
  
  // 从 API 加载
  const config = await pluginApi.getPluginConfig(pluginName)
  configCache.value[pluginName] = config
  currentConfig.value = config
  currentPluginName.value = pluginName
}

function updateConfig(key: string, value: unknown) {
  if (currentConfig.value) {
    currentConfig.value[key] = value
    hasChanges.value = true
  }
}

async function saveConfig(): Promise<boolean> {
  if (!currentConfig.value || !currentPluginName.value) {
    return false
  }
  
  try {
    await pluginApi.savePluginConfig(
      currentPluginName.value,
      currentConfig.value
    )
    hasChanges.value = false
    errors.value = {}
    return true
  } catch (err) {
    return false
  }
}
```

---

## 使用示例

### 在组件中使用

```vue
<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'

const authStore = useAuthStore()
const appStore = useAppStore()

// 访问状态
const isLoggedIn = computed(() => authStore.isAuthenticated)
const theme = computed(() => appStore.theme)

// 调用 action
async function handleLogin() {
  await authStore.login(username.value, password.value)
}
</script>
```

### 在路由守卫中使用

```typescript
// router/index.ts
import { useAuthStore } from '@/stores/auth'

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()
  
  if (to.meta.requiresAuth) {
    const isAuthenticated = await authStore.checkAuth()
    if (!isAuthenticated) {
      next({ name: 'Login' })
      return
    }
  }
  
  next()
})
```

### Store 间调用

```typescript
// stores/diary.ts
import { useAuthStore } from './auth'

export const useDiaryStore = defineStore('diary', () => {
  async function fetchDiaries() {
    // 使用其他 store
    const authStore = useAuthStore()
    
    if (!authStore.isAuthenticated) {
      throw new Error('未登录')
    }
    
    // ...
  }
})
```

---

## 最佳实践

### 1. Store 命名

```typescript
// ✅ 推荐
export const useAuthStore = defineStore('auth', () => {})
export const useDiaryStore = defineStore('diary', () => {})

// ❌ 避免
export const useAuth = defineStore('auth', () => {})
export const authStore = defineStore('auth', () => {})
```

### 2. State 定义

```typescript
// ✅ 推荐 - 明确类型
const isAuthenticated = ref<boolean>(false)
const user = ref<UserProfile | null>(null)

// ❌ 避免 - 类型不明确
const isAuthenticated = ref(false)
const user = ref(null)
```

### 3. Action 命名

```typescript
// ✅ 推荐 - 动词开头
async function fetchDiaries()
async function saveDiary()
function updateContent()
function resetState()

// ❌ 避免
async function diaries()
async function save()
function update()
```

### 4. 错误处理

```typescript
// ✅ 推荐
async function fetchDiaries() {
  isLoading.value = true
  error.value = null
  
  try {
    diaries.value = await diaryApi.getDiaryList()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
    // 继续抛出供上层处理
    throw err
  } finally {
    isLoading.value = false
  }
}

// ❌ 避免 - 吞掉错误
async function fetchDiaries() {
  try {
    diaries.value = await diaryApi.getDiaryList()
  } catch (err) {
    // 错误被吞掉
  }
}
```

### 5. 计算属性 vs 方法

```typescript
// ✅ 推荐 - 派生状态用 computed
const isLoggedIn = computed(() => isAuthenticated.value)
const fullName = computed(() => `${firstName.value} ${lastName.value}`)

// ✅ 推荐 - 复杂操作用方法
function updateProfile(profile: Partial<UserProfile>) {
  Object.assign(user.value, profile)
}

// ❌ 避免 - 简单派生使用方法
function isLoggedIn() {
  return isAuthenticated.value
}
```

### 6. 持久化策略

```typescript
// ✅ 推荐 - 使用 composable
const theme = useLocalStorage<'dark' | 'light'>('app.theme', 'dark')

// ❌ 避免 - 手动操作 localStorage
const theme = ref('dark')
watch(theme, (val) => {
  localStorage.setItem('app.theme', val)
})
```

### 7. Store 解耦

```typescript
// ✅ 推荐 - 通过参数传递，避免硬依赖
export function useDiaryStore() {
  async function saveDiary(api: DiaryApi) {
    // 使用传入的 API
  }
}

// ❌ 避免 - 硬编码依赖
export function useDiaryStore() {
  async function saveDiary() {
    await diaryApi.saveDiary() // 硬编码
  }
}
```

---

## 相关文档

- [架构总览](ARCHITECTURE.md) - Store 在整体架构中的位置
- [API层](API_LAYER.md) - 在 Store 中调用 API
- [路由系统](ROUTING.md) - 认证状态与路由守卫
