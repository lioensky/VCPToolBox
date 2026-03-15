# P4 - 配置表TUI（代码核对修订版 2026-03-10）

> 本文档已根据实际代码逐行核对修订，与源码100%一致。
> 核对人：Rosa | 核对日期：2026-03-10

---

## 一、P4在项目中的位置

P4负责**安装前的用户配置界面**：9个表单字段收集安装路径、镜像选择、API密钥、端口等配置。用户在此页面填写完成后按Enter确认，触发P3的实际安装流程。

**依赖关系**：P0（TUI骨架）→ **P4（配置表单）** → P3（部署引擎）

---

## 二、文件清单与职责

| 文件 | 大小 | 职责 |
|------|------|------|
| `src/ui/config_form.rs` | 11.17KB | 表单渲染 + 键盘交互逻辑 |
| `src/app.rs`（P4新增部分） | — | 3个方法 + 1个辅助函数 |

---

## 三、共享类型引用（来自P0 app.rs）

### 表单字段类型系统

```rust
/// 表单字段的类型枚举
#[derive(Debug, Clone, Copy)]
pub enum FieldType {
    TextInput(usize, bool),  // (buffer_index, is_password)
    Toggle(ToggleRef),       // 布尔开关
    MirrorSelect,            // GitHub镜像三选一
}

/// 开关引用枚举（指向InstallConfig中的具体字段）
#[derive(Debug, Clone, Copy)]
pub enum ToggleRef {
    NpmMirror,
    PipMirror,
}

/// 单个表单字段的定义
#[derive(Debug, Clone, Copy)]
pub struct FormField {
    pub label: &'static str,       // 字段标签
    pub field_type: FieldType,     // 字段类型
    pub hint: &'static str,        // 底部提示文本
}
```

注意：所有类型都实现了 `Copy` trait，避免不必要的堆分配。

### GitHub镜像枚举

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum GitHubMirror {
    Direct,                    // 直连
    GhProxy,                   // ghproxy.com
    Custom(String),            // 自定义镜像URL
}
```

### App中P4相关字段

```rust
pub struct App {
    // ... P0字段 ...
    
    // P4配置表单
    pub config_form_cursor: usize,       // 当前聚焦的字段索引
    pub config_form_buffers: Vec<String>, // 文本输入缓冲区（6个）
    // [0]=安装路径, [1]=API端点, [2]=API密钥,
    // [3]=管理密码, [4]=工具授权码, [5]=端口
}
```

---

## 四、config_form.rs — 表单渲染与交互

### 编译期字段定义

代码使用 `const` 数组在编译期定义全部9个字段，零运行时开销：

```rust
const FIELDS: [FormField; 9] = [
    FormField { label: "安装路径",       field_type: FieldType::TextInput(0, false), hint: "VCP将安装到此目录" },
    FormField { label: "GitHub 镜像",    field_type: FieldType::MirrorSelect,        hint: "←→切换 | 空格循环" },
    FormField { label: "npm 镜像",       field_type: FieldType::Toggle(ToggleRef::NpmMirror), hint: "空格切换 | 使用淘宝npm镜像" },
    FormField { label: "pip 镜像",       field_type: FieldType::Toggle(ToggleRef::PipMirror),  hint: "空格切换 | 使用清华pip镜像" },
    FormField { label: "API 端点",       field_type: FieldType::TextInput(1, false), hint: "NewAPI或兼容API地址" },
    FormField { label: "API 密钥",       field_type: FieldType::TextInput(2, true),  hint: "你的API Key" },
    FormField { label: "管理员密码",     field_type: FieldType::TextInput(3, true),  hint: "VCP管理面板密码 | 留空自动生成" },
    FormField { label: "工具授权码",     field_type: FieldType::TextInput(4, true),  hint: "VCP工具调用授权码 | 留空自动生成" },
    FormField { label: "端口",           field_type: FieldType::TextInput(5, false), hint: "VCP服务端口(1024-65535)" },
];
```

### 公开接口（2个）

```rust
/// 渲染配置表单页面
pub fn render(frame: &mut Frame, app: &App)

/// 处理键盘输入，返回true表示确认（Enter键）
pub fn handle_input(app: &mut App, key: KeyCode) -> bool
```

### render函数 — 渲染逻辑

#### 布局结构

```
┌─────────────────────────────────┐
│          VCP 安装配置            │ ← 标题区（3行）
├─────────────────────────────────┤
│  ▶ 安装路径:  E:\VCP            │
│    GitHub 镜像: ● 直连 ○ GhProxy│ ← 表单区（每字段2行：标签行+值行）
│    npm 镜像:   [ON]             │
│    ...                          │
├─────────────────────────────────┤
│  提示文本 | 字段 3/9            │ ← 底栏（3行）：提示+字段计数
│  ↑↓/Tab导航 | 空格切换 | Enter  │
└─────────────────────────────────┘
```

#### 字段值渲染逻辑

每个字段的值渲染由独立的 `render_value_line()` 函数处理：

| 字段类型 | 渲染方式 |
|----------|----------|
| TextInput(非密码) | 直接显示buffer内容，聚焦时末尾加`▏`光标 |
| TextInput(密码+聚焦) | 显示明文 + `▏`光标 |
| TextInput(密码+非聚焦) | `*` 重复 `.min(24)` 个；空值显示"(留空自动生成)" |
| MirrorSelect | radio按钮：`● 直连  ○ GhProxy`（聚焦项用●/高亮） |
| Toggle | `[ON]`/`[OFF]`（ON=绿色，OFF=灰色） |

#### radio按钮渲染

独立的 `render_radio()` 辅助函数：

```rust
/// 渲染单个radio选项
fn render_radio(label: &str, selected: bool, focused: bool) -> Span
// selected=true → "●" 前缀
// selected=false → "○" 前缀
// focused+selected → 黄色高亮
// focused+unselected → 白色
// 非聚焦行 → 暗灰色
```

#### 安全措施

- `focused_index` 用 `.min(FIELDS.len().saturating_sub(1))` 限界，防越界crash
- 底栏显示 "字段 X/Y" 计数器，用户知道当前位置

### handle_input函数 — 键盘交互

#### 导航键

| 键 | 行为 |
|----|------|
| `Up` | cursor - 1（到0停止） |
| `Down` | cursor + 1（到末尾停止） |
| `Tab` | cursor + 1（到末尾停止） |
| `BackTab` (Shift+Tab) | cursor - 1（到0停止） |

#### 文本输入

| 键 | 行为 | 安全措施 |
|----|------|----------|
| `Char(c)` | push到对应buffer | `get_mut(idx)` 安全访问，越界不panic |
| `Backspace` | pop最后一个字符 | `get_mut(idx)` 安全访问 |

**端口字段特殊限制**：`buffer_index == 5` 时，只接受 `c.is_ascii_digit()` 的字符。

#### 镜像操作（5个独立函数）

```rust
/// 空格循环切换：Direct → GhProxy → Direct
fn cycle_mirror(app: &mut App)

/// 左方向键：设为Direct
fn set_prev_mirror(app: &mut App)

/// 右方向键：设为GhProxy
fn set_next_mirror(app: &mut App)

/// 空格切换Toggle开关
fn toggle_switch(app: &mut App, toggle_ref: ToggleRef)

/// 方向键直接设值Toggle
fn set_toggle(app: &mut App, toggle_ref: ToggleRef, value: bool)
```

#### 按字段类型的按键分发

| 聚焦字段类型 | Space | Left | Right | Char/Backspace |
|-------------|-------|------|-------|----------------|
| TextInput | 输入空格 | — | — | 正常输入/删除 |
| MirrorSelect | cycle_mirror | set_prev_mirror(Direct) | set_next_mirror(GhProxy) | — |
| Toggle | toggle_switch | set_toggle(false/OFF) | set_toggle(true/ON) | — |

#### 确认与返回

| 键 | 行为 |
|----|------|
| `Enter` | 调用 `app.apply_config_form()` → 返回 `true` |
| `Esc` | 由main.rs处理（prev_page回到组件选择） |

---

## 五、app.rs P4新增方法

### init_config_form — 初始化表单缓冲区

```rust
pub fn init_config_form(&mut self)
```

从 `self.install_config` 的当前值填充表单缓冲区：

| buffer[i] | 来源 | 处理 |
|-----------|------|------|
| [0] 安装路径 | `install_config.install_dir` | `to_string_lossy()` |
| [1] API端点 | `install_config.api_endpoint` | `.clone()` |
| [2] API密钥 | `install_config.api_key` | `.clone()` |
| [3] 管理密码 | `install_config.admin_password` | 空则 `generate_random_password(16)` |
| [4] 授权码 | `install_config.tool_auth_code` | 空则 `generate_random_password(16)` |
| [5] 端口 | `install_config.port` | `to_string()` |

**改进点**：密码空检查使用 `.trim().is_empty()` 而非 `.is_empty()`，纯空格也视为空。

### apply_config_form — 提交表单到配置

```rust
pub fn apply_config_form(&mut self)
```

从缓冲区写回 `self.install_config`：

| 字段 | 来源 | 处理 |
|------|------|------|
| install_dir | buffer[0] | **`.trim()`** + 空检查fallback默认值 + `PathBuf::from` |
| api_endpoint | buffer[1] | **`.trim().to_string()`** |
| api_key | buffer[2] | `.clone()` |
| admin_password | buffer[3] | `.clone()` |
| tool_auth_code | buffer[4] | `.clone()` |
| port | buffer[5] | **`.trim().parse::<u16>()`** 失败fallback 6005 |

**改进点**：所有文本字段都增加了 `.trim()` 处理，防止用户误输入前后空格导致路径错误或端口解析失败。

### config_form_field_count — 字段数量

```rust
pub fn config_form_field_count(&self) -> usize { 9 }
```

与 `FIELDS` 数组长度一致。

### generate_random_password — 随机密码生成

```rust
fn generate_random_password(len: usize) -> String
```

- 字符集：`const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"`
- 使用 `rand::thread_rng().gen_range(0..CHARSET.len())`
- 默认生成16字符

---

## 六、验收标准

| # | 验收项 | 状态 |
|---|--------|------|
| 1 | 表单渲染9个字段 | ✅ |
| 2 | 光标导航 ↑↓/Tab/BackTab | ✅ |
| 3 | 文本输入（Char+Backspace） | ✅ |
| 4 | 密码掩码（非聚焦`*`×24） | ✅ |
| 5 | 密码聚焦显示明文 | ✅ |
| 6 | 端口仅数字 | ✅ |
| 7 | 镜像←→/空格切换 | ✅ |
| 8 | Toggle空格/←→切换 | ✅ |
| 9 | 随机密码自动生成 | ✅ |
| 10 | Enter确认提交 | ✅ |
| 11 | Esc返回上一页 | ✅ |

---

## 七、与文档原版的主要差异

| 项目 | 文档原版 | 实际代码 |
|------|----------|----------|
| 字段定义 | `fn get_fields() -> Vec<FormField>` 运行时函数 | `const FIELDS: [FormField; 9]` 编译期数组 |
| 类型trait | 只有Debug, Clone | `#[derive(Debug, Clone, Copy)]` 全部Copy |
| 值渲染 | render函数内联 | `render_value_line()` 独立函数 |
| radio渲染 | render函数内联 | `render_radio()` 独立函数 |
| 镜像操作 | match内联 | 5个独立函数(cycle/set_prev/set_next/toggle/set) |
| 反向导航 | 无 | BackTab(Shift+Tab)支持 |
| Toggle方向键 | 无 | Left=OFF, Right=ON |
| 密码掩码上限 | `.min(20)` | `.min(24)` |
| buffer访问 | 直接索引`[idx]` | `get_mut(idx)` 安全访问 |
| 安全限界 | 无 | `focused_index.min(FIELDS.len()-1)` + cursor越界修正 |
| 字段计数 | 无 | 底栏"字段 X/Y" |
| trim处理 | 无 | apply_config_form全字段`.trim()` |
| 密码空检查 | `.is_empty()` | `.trim().is_empty()` |