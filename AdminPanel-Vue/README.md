# AdminPanel-Vue

VCPToolBox 管理面板前端 - 基于 Vue 3 + TypeScript 的现代管理界面

[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8.0-646CFF?logo=vite)](https://vitejs.dev/)
[![Pinia](https://img.shields.io/badge/Pinia-3.0-yellow?logo=vue.js)](https://pinia.vuejs.org/)

## 功能特性

- 现代化 UI 设计 - 采用玻璃拟态风格的深色主题
- 模块化架构 - 清晰的分层设计，易于维护和扩展
- 仪表盘系统 - 可拖拽、可调整大小的卡片式布局
- 权限管理 - 基于路由的权限控制和登录状态管理
- 插件生态 - 支持动态加载插件配置页面
- 响应式设计 - 适配桌面、平板和移动设备

## 技术栈

- **框架**: Vue 3.5 (Composition API + `<script setup>`)
- **语言**: TypeScript 5.9 (严格模式)
- **状态管理**: Pinia 3.0 (Composition API 风格)
- **路由**: Vue Router 5.0
- **构建工具**: Vite 8.0
- **测试框架**: Vitest
- **代码规范**: ESLint + Prettier
- **UI 组件**: 自定义组件 + Material Symbols 图标

## 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

服务将启动在 `http://localhost:5173`，代理配置指向后端 `http://localhost:3000`

### 生产构建

```bash
# 完整构建（含类型检查）
npm run build

# 快速构建（跳过类型检查）
npm run build:no-type-check
```

### 代码检查

```bash
# 检查
npm run lint

# 自动修复
npm run lint:fix
```

### 测试

```bash
# 运行测试
npm run test

# 监视模式
npm run test:watch
```

## 项目结构

```
AdminPanel-Vue/
├── public/              # 静态资源（不经过构建）
├── docs/                # 项目文档
├── src/
│   ├── api/             # API 层 - 按业务域拆分
│   ├── app/             # 应用核心 - 路由配置、导航
│   ├── assets/          # 静态资源（经过构建）
│   ├── components/      # 公共组件
│   │   ├── dashboard/   # 仪表盘相关组件
│   │   ├── feedback/    # 反馈系统组件
│   │   └── layout/      # 布局组件
│   ├── composables/     # 组合式函数
│   ├── constants/       # 常量定义
│   ├── dashboard/       # 仪表盘系统
│   │   ├── core/        # 核心逻辑
│   │   └── hosts/       # 卡片宿主组件
│   ├── directives/      # 自定义指令
│   ├── features/        # 页面级组合式函数
│   ├── layouts/         # 布局组件
│   ├── platform/        # 平台层（认证、反馈、HTTP）
│   ├── router/          # 路由配置
│   ├── stores/          # Pinia 状态管理
│   ├── style/           # 全局样式
│   ├── types/           # TypeScript 类型定义
│   ├── utils/           # 工具函数
│   └── views/           # 页面视图
└── tests/               # 测试文件
```

## 模块职责

| 模块 | 职责 |
|------|------|
| `platform/` | 平台基础设施，与业务无关（认证、HTTP、反馈） |
| `app/` | 应用核心，路由和导航配置 |
| `api/` | 后端接口封装，按业务域组织 |
| `stores/` | 全局状态管理 |
| `composables/` | 可复用的组合式函数 |
| `features/` | 页面级业务逻辑 |
| `dashboard/` | 仪表盘卡片系统 |

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（端口 5173） |
| `npm run build` | 生产构建（含类型检查） |
| `npm run build:no-type-check` | 生产构建（跳过类型检查） |
| `npm run preview` | 预览生产构建 |
| `npm run test` | 运行单元测试 |
| `npm run test:watch` | 监视模式运行测试 |
| `npm run lint` | ESLint 代码检查 |
| `npm run lint:fix` | ESLint 自动修复 |

## 开发规范

### 代码风格

- 使用 TypeScript 严格模式
- 组件使用 `<script setup lang="ts">` 语法
- 优先使用 Composition API
- 组件名使用 PascalCase
- 组合式函数名使用 camelCase 并以 `use` 开头

### 文件组织

```typescript
// 导入顺序：Vue -> 第三方库 -> 内部模块
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showMessage } from '@/utils'

// 类型导入
import type { User } from '@/types'
```

### 命名规范

- **组件**: `PascalCase` (如 `UserProfile.vue`)
- **组合式函数**: `camelCase` 以 `use` 开头 (如 `useAuth.ts`)
- **工具函数**: `camelCase` (如 `formatDate.ts`)
- **常量**: `SCREAMING_SNAKE_CASE` (如 `MAX_RETRY_COUNT`)
- **类型**: `PascalCase` (如 `UserProfile`)

## 环境变量

项目使用 `.env` 文件管理环境变量：

```bash
# API 基础路径
VITE_API_BASE_URL=/admin_api

# 其他环境变量...
```

## 浏览器支持

- Chrome >= 90
- Firefox >= 88
- Safari >= 14
- Edge >= 90

## 文档索引

- [组合式函数](src/composables/README.md) - 可复用组合式函数使用指南

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## 许可证

[MIT](LICENSE)

---

**AdminPanel-Vue** © 2026 VCPToolBox Team
