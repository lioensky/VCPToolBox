
# ShowBase64+ 占位符使用示例

## 概述

`{{ShowBase64+::~}}` 占位符是 `{{ShowBase64::path}}` 和 `{{OverBase64::~}}` 的完美结合，它能够：

1. **获取多模态描述**：使用指定的预设调用多模态 API 获取文件的文本描述
2. **直接发送原始文件**：同时将原始的 Base64 编码文件直接发送给 LLM

这意味着 LLM 既能看到文本描述，又能看到原始的多模态内容，获得最完整的信息。

## 语法格式

```
{{ShowBase64+::预设名称::路径}}                    // 默认使用缓存
{{ShowBase64+::预设1;预设2::路径}}                 // 默认使用缓存
{{ShowBase64+::预设名称::路径::cache}}             // 明确使用缓存（与默认行为相同）
{{ShowBase64+::预设1;预设2::路径::no_cache}}       // 禁用缓存，强制重新分析
```

### 参数说明

- **预设名称**：在 `presets.json` 中定义的预设，用于指定如何分析多模态内容
  - 支持多个预设，用分号 `;` 分隔
  - 每个预设会生成一份独立的描述
  
- **路径**：文件或文件夹的路径
  - 支持绝对路径
  - 支持相对路径（相对于项目根目录）
  - 支持路径别名（在 `path-aliases.json` 中定义）
  - 如果是文件夹，会处理文件夹内所有符合格式的媒体文件

- **缓存控制**（可选）：
  - **默认行为**：使用缓存（节省 API 成本和响应时间）
  - **`::cache`**：明确使用缓存，与默认行为相同（可省略）
  - **`::no_cache`**：禁用缓存，强制重新调用 API 获取最新描述

## 使用示例

### 1. 基础用法 - 单个文件 + 单个预设（默认缓存）

**系统提示词：**
```
你是一个图像分析助手。

{{ShowBase64+::detailed::/users/screenshots/diagram.png}}

请根据上述图像的分析结果和原始图像，为用户提供详细的解释。
```

**效果：**
- **默认使用缓存**：相同图片+预设组合会直接使用缓存描述
- 文本中会插入 `detailed` 预设对图像的描述
- 同时原始图像的 Base64 数据会被注入到最后一条用户消息中
- LLM 既能看到文本描述，又能看到原始图像

---

### 2. 多预设分析 - 不同角度理解同一文件

**系统提示词：**
```
你是一个多模态内容分析专家。

{{ShowBase64+::technical;artistic::/users/photos/architecture.jpg}}

请综合技术分析和艺术分析的结果，结合原始图像，给出全面的评价。
```

**效果：**
- **自动使用缓存**：两个预设的描述都会被缓存
- 生成两份描述：
  - `[technical]`: 技术角度的分析（构图、光线、技术参数等）
  - `[artistic]`: 艺术角度的分析（美学、情感、意境等）
- 原始图像也会被直接发送

---

### 3. 使用路径别名

**path-aliases.json 配置：**
```json
{
  "@screenshots": "/users/john/screenshots",
  "@photos": "/users/john/photos"
}
```

**系统提示词：**
```
{{ShowBase64+::default::@screenshots/error-log.png}}

请帮我分析这个错误截图。
```

**说明：**
- 使用路径别名 `@screenshots`
- 默认启用缓存，相同截图不会重复分析

---

### 4. 处理文件夹 - 批量分析

**系统提示词：**
```
你需要分析一批医学影像。

{{ShowBase64+::medical;summary::/data/xray-images/patient001/}}

请综合所有影像的分析结果和原始图像，给出诊断建议。
```

**效果：**
- **批量缓存**：文件夹内所有文件的描述都会被缓存
- 处理文件夹内所有支持的图像文件
- 每个文件都会生成 `medical` 和 `summary` 两份描述
- 所有原始图像都会被注入到消息中
- 支持 `.showbase64plusignore` 文件排除特定文件

**如需强制重新分析：**
```
{{ShowBase64+::medical;summary::/data/xray-images/patient001/::no_cache}}
```

---

### 5. 结合其他占位符使用

**系统提示词：**
```
你是 {{agent:assistant}} 助手。

当前任务：分析用户提供的设计稿

{{ShowBase64+::design;usability::@workspace/designs/}}

请基于以上分析和原始图像，提供改进建议。

可用工具：{{VCPAllTools}}
```

**效果：**
- Agent 变量会先展开
- ShowBase64+ 自动使用缓存处理设计稿文件夹
- 其他系统变量正常替换
- 所有功能协同工作

**如需在迭代开发中强制更新分析：**
```
{{ShowBase64+::design;usability::@workspace/designs/::no_cache}}
```

---

### 6. 视频和音频文件

**系统提示词：**
```
{{ShowBase64+::transcript;sentiment::/media/interview.mp4}}

请根据视频的转录内容和情感分析，以及原始视频，总结访谈要点。
```

**支持的格式：**
- 图像：`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tiff`
- 视频：`.mp4`, `.mov`, `.avi`
- 音频：`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`

---

## 高级用法

### 1. 智能缓存控制

`{{ShowBase64+}}` 默认启用缓存，与 `{{OverBase64}}` 行为一致：

**默认行为**（自动使用缓存）：
```
{{ShowBase64+::detailed::/path/to/image.jpg}}
```
- 相同文件 + 相同预设的组合直接使用缓存
- 节省 API 成本，提高响应速度
- 适合大多数场景

**明确使用缓存**（可选，与默认相同）：
```
{{ShowBase64+::detailed::/path/to/image.jpg::cache}}
```
- 与默认行为完全相同
- 可用于代码可读性

**禁用缓存**（强制重新分析）：
```
{{ShowBase64+::detailed::/path/to/image.jpg::no_cache}}
```
- 每次都调用 API 获取最新描述
- 适合开发调试、需要最新分析的场景
- 适合内容会变化但路径不变的情况

**缓存机制**：
- 基于文件内容的 MD5 哈希 + 预设名称
- 文件内容改变后哈希不同，会自动重新生成描述
- 缓存存储在 `multimedia_cache.json` 中
- 包含完整的元数据、预设配置、访问统计

### 2. 使用 .showbase64plusignore

在文件夹内创建 `.showbase64plusignore` 文件来排除特定文件：

```gitignore
# 排除临时文件
*.tmp
*_temp.*

# 排除特定文件
debug_*.png
test_*.jpg

# 排除子文件夹
backup/
```

### 3. 自定义预设

在 `presets.json` 中定义自己的预设：

```json
{
  "medical": {
    "displayName": "医学影像分析",
    "prompt": "作为医学影像专家，请详细分析这张影像，包括：1) 可见的解剖结构 2) 异常发现 3) 可能的诊断方向",
    "model": "gpt-4o",
    "maxTokens": 2000,
    "temperature": 0.3
  },
  "code_review": {
    "displayName": "代码截图审查",
    "prompt": "请审查这段代码截图，关注：1) 代码质量 2) 潜在bug 3) 性能问题 4) 最佳实践建议",
    "maxTokens": 1500
  }
}
```

---

## 与其他占位符的对比

| 占位符 | 文本描述 | 原始文件 | 默认缓存 | 缓存控制 | 使用场景 |
|--------|---------|---------|---------|---------|---------|
| `{{ShowBase64}}` | ❌ | ✅ 所有 | ❌ | 无 | 禁用图像翻译，直接发送所有多模态内容 |
| `{{ShowBase64::path}}` | ❌ | ✅ 指定 | ❌ | 无 | 只发送指定路径的文件，其他文件正常处理 |
| `{{OverBase64::~}}` | ✅ | ❌ | ✅ | `::no_cache` | 只需要文本描述，不发送原始文件 |
| `{{ShowBase64+::~}}` | ✅ | ✅ 指定 | ✅ | `::no_cache` | **完整体验**：既有描述又有原始文件 |

---

## 注意事项

### 1. 性能考虑

- **API 调用**：每个文件的每个预设都会调用一次多模态 API
  - **默认使用缓存**避免重复调用，节省成本
  - 缓存命中时直接返回，无 API 成本
  - 只有使用 `::no_cache` 才会强制重新调用
- **文件大小**：原始文件会被完整发送，注意 Base64 编码后的大小
- **并发限制**：通过 `MultiModalModelAsynchronousLimit` 配置控制并发数

**缓存策略建议**：
- **生产环境**：使用默认缓存（或明确 `::cache`），节省成本
- **开发调试**：使用 `::no_cache`，确保获取最新分析
- **固定素材**：使用默认缓存（如表情包、UI 模板）
- **动态内容**：根据更新频率决定是否使用 `::no_cache`

### 2. 与 ImageProcessor 的关系

- `{{ShowBase64+}}` **不影响** ImageProcessor 的行为
- 用户在聊天中发送的图片仍然会被 ImageProcessor 处理（除非使用了 `{{ShowBase64}}`）
- `{{ShowBase64+}}` 只处理占位符中指定的文件

### 3. 文件格式白名单

只有在 `SupportedMediaFormats` 配置中列出的格式才会被处理：

```env
SupportedMediaFormats=.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.mp4,.mov,.avi,.mp3,.wav,.ogg,.flac,.m4a
```

### 4. 错误处理

如果处理失败，占位符会被替换为错误信息：

```
[ShowBase64+错误: 文件不存在]
[ShowBase64+错误: API 调用失败]
```

---

## 实际应用场景

### 1. 医疗诊断辅助（默认缓存）

```
{{ShowBase64+::medical;radiology::/patients/P12345/ct-scans/}}

请基于影像分析报告和原始 CT 影像，提供初步诊断意见。
```

### 2. 设计评审（强制实时分析）

```
{{ShowBase64+::design;accessibility::@figma/project-wireframes/::no_cache}}

请评审这些设计稿的可用性和无障碍性，给出改进建议。
```

### 3. 代码审查（默认缓存）

```
{{ShowBase64+::code_review::@screenshots/pull-request/}}

请审查这些代码截图，指出潜在问题。
```

### 4. 教育辅导（强制实时分析）

```
{{ShowBase64+::educational;step_by_step::@homework/math-problem.jpg::no_cache}}

请详细讲解这道题目的解题思路。
```

### 5. 内容审核（默认缓存）

```
{{ShowBase64+::content_moderation;safety::/uploads/user-content/}}

请检查这些用户上传的内容是否符合社区准则。
```

---

## 调试技巧

### 1. 启用调试模式

在 `config.env` 中设置：
```env
DebugMode=true
```

### 2. 查看处理日志

调试模式下会输出详细信息：
- 占位符识别
- 文件路径解析
- API 调用状态
- 缓存命中情况

### 3. 检查缓存

查看 `multimedia_cache.json` 了解缓存状态：
```json
{
  "abc123def456": {
    "hash": "abc123def456",
    "mimeType": "image/jpeg",
    "paths": [...],
    "descriptions": {
      "detailed": {
        "description": "...",
        "accessCount": 5,
        "lastAccessTime": "..."
      }
    }
  