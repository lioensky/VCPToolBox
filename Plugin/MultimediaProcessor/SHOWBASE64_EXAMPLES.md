# {{ShowBase64::path}} 使用示例与测试指南

## ⚠️ 重要行为说明

### `{{ShowBase64}}` vs `{{ShowBase64::path}}` 的关键区别

| 占位符 | 作用范围 | ImageProcessor 行为 |
|--------|---------|-------------------|
| `{{ShowBase64}}` | **全局效果** | 禁用所有多模态文件的预处理（包括用户上传的图片） |
| `{{ShowBase64::path}}` | **选择性效果** | 仅对指定路径的文件跳过预处理，用户上传的图片仍会被翻译 |

**实际应用场景：**
- 使用 `{{ShowBase64::@hornet}}`：系统提示词中的表情包直接发送，用户上传的图片会被 ImageProcessor 翻译成文本
- 使用 `{{ShowBase64}}`：所有多模态内容（包括用户上传）都直接发送给 LLM，不经过任何翻译

## 快速开始

### 1. 配置路径别名

编辑 `Plugin/MultimediaProcessor/path-aliases.json`：

```json
{
  "images": "/Users/username/Pictures",
  "@hornet": "/Users/username/Pictures/Hornet表情包",
  "videos": "/Users/username/Videos",
  "downloads": "/Users/username/Downloads",
  "project": "/path/to/project/assets"
}
```

### 2. 基本使用示例

#### 示例 1：发送单个图片
```
系统提示词：
你是一个可爱的 AI 助手。{{ShowBase64::images/avatar.jpg}}
这是你的头像，你可以在对话中引用它。
```

#### 示例 2：发送表情包集合
```
系统提示词：
你可以使用以下表情包：{{ShowBase64::@hornet}}
这些表情包的视觉内容已经发送给你，你可以在回复中自然地提到它们。
```

#### 示例 3：发送项目截图文件夹
```
系统提示词：
请分析以下 UI 设计：{{ShowBase64::project/ui-designs}}
所有设计稿的原始图片已发送，请基于视觉内容提供专业反馈。
```

## 高级使用场景

### 场景 1：表情包管理系统

**目录结构：**
```
/Pictures/
  └── Hornet表情包/
      ├── 爱你.png
      ├── 比心心.png
      ├── 害羞捂脸.png
      ├── .multimodalignore
      └── ... (更多表情包)
```

**`.multimodalignore` 内容：**
```gitignore
# 排除草稿和备份
*_draft.*
*_backup.*
Thumbs.db
.DS_Store
```

**系统提示词：**
```
你是 Hornet，一个活泼可爱的 AI 角色。

可用表情包：{{ShowBase64::@hornet}}

在对话中，你可以：
1. 根据情绪自然地提到表情包（如"我现在很开心～(比心心)"）
2. 不需要描述表情包的具体内容，因为我已经能看到它们
3. 表情包名称会出现在文件名中，你可以根据文件名判断适合的场景
```

### 场景 2：项目文档与截图

**目录结构：**
```
/project/
  ├── screenshots/
  │   ├── login.png
  │   ├── dashboard.png
  │   └── settings.png
  └── designs/
      ├── final_design.fig
      └── mockup.png
```

**系统提示词：**
```
项目分析任务：

当前实现截图：{{ShowBase64::project/screenshots}}
设计稿：{{ShowBase64::project/designs/mockup.png}}

请对比设计稿和实际实现，指出差异并提供优化建议。
所有图片的原始内容已发送，请直接基于视觉内容进行分析。
```

### 场景 3：多路径组合

```
系统提示词：
你是一个专业的 UI/UX 分析师。

参考资料：
1. 竞品分析：{{ShowBase64::downloads/competitors}}
2. 我们的设计稿：{{ShowBase64::project/current-design.png}}
3. 用户反馈截图：{{ShowBase64::project/feedback}}

请综合分析以上所有视觉材料，提供改进建议。
```

## 文件过滤最佳实践

### 使用 .multimodalignore

**场景：处理包含大量文件的文件夹**

```gitignore
# .multimodalignore

# 只处理最终版本
!final_*.png
*.png

# 排除所有测试文件
*test*
*demo*

# 排除大型视频（如果只想处理图片）
*.mp4
*.avi
*.mov

# 排除系统文件
Thumbs.db
.DS_Store
desktop.ini
```

## 性能优化建议

### 1. 文件数量控制
- ✅ 推荐：每次发送 1-10 个文件
- ⚠️ 注意：超过 20 个文件可能导致上下文过大
- 💡 技巧：使用 `.showbase64ignore` 精确控制发送的文件

### 2. 文件大小优化
```
理想文件大小：
- 图片：< 5MB（推荐 < 2MB）
- 视频：< 10MB（或使用视频缩略图）
- 音频：< 5MB
```

### 3. 路径组织
```
推荐的路径别名结构：
{
  "@ui": "/project/ui",           // 短别名，常用路径
  "@emoji": "/assets/emojis",     // 明确的用途
  "temp": "/downloads/temp",      // 临时文件
  "archive": "/backup/2024"       // 归档文件
}
```

## 常见问题排查

### 问题 1：占位符未被处理

**症状：** 系统提示词中的 `{{ShowBase64::path}}` 原样显示

**排查步骤：**
1. 检查路径是否正确（绝对路径或已配置的别名）
2. 确认文件/文件夹是否存在
3. 查看控制台是否有错误日志（需开启 `DebugMode=true`）
4. 确认文件格式是否在支持列表中

### 问题 2：文件夹为空

**症状：** `[ShowBase64已处理:0个文件]`

**可能原因：**
1. 文件夹内没有支持的媒体格式
2. 所有文件都被 `.showbase64ignore` 排除
3. 路径解析错误

**解决方法：**
```bash
# 1. 检查文件夹内容
ls -la /your/path

# 2. 查看是否有 ignore 文件
cat /your/path/.showbase64ignore

# 3. 开启 Debug 模式查看详细日志
# 在 config.env 中设置：DebugMode=true
```

### 问题 3：路径别名不工作

**症状：** 提示路径不存在

**排查步骤：**
1. 确认 `path-aliases.json` 文件存在于 `Plugin/MultimediaProcessor/` 目录
2. 检查 JSON 格式是否正确（使用 JSON 验证器）
3. 确认别名路径使用的是绝对路径
4. 重启服务器以重新加载配置

## 与其他功能的配合

### 与 {{OverBase64::...}} 配合使用

```
系统提示词：
# 直接发送表情包图片（LLM 原生理解）
可用表情包：{{ShowBase64::@hornet}}

# 同时获取项目截图的文本描述（用于存档和搜索）
项目截图分析：{{OverBase64::technical::project/screenshots}}

这样你既能"看到"表情包，又能获得截图的详细文本描述。
```

### 与 VCPTavern 配合使用

```
系统提示词：
{{VCPTavern::character_preset}}

# 角色专属表情包
{{ShowBase64::@character_emojis}}

# 动态注入的背景信息
{{VCPTavern::scene_context}}
```

## 测试清单

使用以下清单测试 `{{ShowBase64::path}}` 功能：

- [ ] 单个文件（绝对路径）
- [ ] 单个文件（路径别名）
- [ ] 文件夹（所有文件）
- [ ] 文件夹（带 .showbase64ignore）
- [ ] 深层路径（别名 + 子目录）
- [ ] 多个占位符同时使用
- [ ] 不同媒体格式（图片、音频、视频）
- [ ] 路径不存在的错误处理
- [ ] 空文件夹的处理
- [ ] **关键测试**：使用 `{{ShowBase64::path}}` 时，用户上传的图片是否仍被 ImageProcessor 处理
- [ ] **关键测试**：同时使用 `{{ShowBase64}}` 和 `{{ShowBase64::path}}` 的行为

## 调试技巧

### 开启详细日志

在 `config.env` 中：
```env
DebugMode=true
```

查看日志输出：
```
[ShowBase64] 文件夹 /path/to/folder 包含 5 个媒体文件
[ShowBase64] 成功处理 5 个文件，来自路径: @hornet
[Server] 注入 5 个 ShowBase64::path 文件到消息中
```

### 使用 writeDebugLog

检查 `DebugLog/` 目录下的日志文件：
- `LogInput-*.txt` - 原始请求
- `LogOutputAfterProcessing-*.txt` - 处理后的消息（包含注入的 Base64 数据）

## 最佳实践总结

1. **路径别名命名**：使用有意义的短名称，如 `@emoji`, `@ui`, `@avatar`
2. **文件组织**：将相关文件放在同一文件夹，使用 `.showbase64ignore` 精确控制
3. **性能考虑**：控制每次发送的文件数量和大小
4. **错误处理**：开启 Debug 模式排查问题
5. **文档注释**：在系统提示词中说明已发送的内容，帮助 LLM 理解上下文
6. **格式统一**：同一批次尽量使用相同格式的文件（都是图片或都是音频）
7. **缓存清理**：路径别名缓存 1 分钟，修改配置后无需重启即可生效
8. **⭐ 混合使用策略**：
   - 使用 `{{ShowBase64::path}}` 发送固定素材（表情包、UI 模板等）
   - 让用户上传的图片通过 ImageProcessor 获得文本描述
   - 这样 LLM 既能"看到"固定素材，又能理解用户上传的内容
9. **选择合适的占位符**：
   - 需要所有内容直接发送 → 使用 `{{ShowBase64}}`
   - 只需要特定文件直接发送 → 使用 `{{ShowBase64::path}}`
   - 需要文本描述 → 使用 `{{OverBase64::preset::path}}`