# DoubaoGen - 火山引擎图像生成器

## 简介

DoubaoGen 是一个基于火山引擎 API 的 VCP 图像生成插件，支持文生图、图生图、多图融合、组图生成以及动态模型发现。

### 主要特性

- **文生图**：通过文字描述生成高质量图像
- **图生图**：基于参考图片生成新图像，支持风格转换
- **多图融合**：融合 2-10 张图片创造全新场景
- **组图生成**：一次生成最多 15 张连续图片
- **动态模型发现**：查询火山方舟可用模型，由 AI 自主选择最佳模型
- **智能密钥池**：支持多 API 密钥顺序轮询，自动错误处理与降级
- **双格式返回**：支持 URL 和 Base64 两种返回格式
- **零外部依赖**：仅使用 Node.js 原生模块，无需 npm install

## 系统要求

- Node.js v18.0.0 或更高版本

## 安装配置

### 1. 获取 API 密钥

访问 [火山引擎控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) 获取 API 密钥。

> **提示**：火山方舟中的模型需要先激活才能使用。

### 2. 配置插件

复制 `config.env.example` 为 `config.env`，填入你的 API 密钥：

```env
# 单个 API 密钥
VOLCENGINE_API_KEY=your_api_key_here

# 多个 API 密钥（推荐，配额用完自动切换）
VOLCENGINE_API_KEY=key1,key2,key3
```

### 3. 配置选项

```env
# 默认模型ID（可通过 list_models 命令动态查询）
# SEEDREAM_MODEL_ID=doubao-seedream-5-0-260128

# 是否默认添加水印（true/false）
DEFAULT_WATERMARK=false

# 默认返回格式（url 或 b64_json）
# url: 返回图片链接（24小时有效）
# b64_json: 返回Base64编码（多模态AI可直接查看图片）
DEFAULT_RESPONSE_FORMAT=b64_json

# 调试模式（true/false）
DebugMode=false
```

## 使用方法

### 查询可用模型

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」list_models「末」
<<<[END_TOOL_REQUEST]>>>
```

### 文生图

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」generate「末」,
prompt:「始」A majestic cat warrior in futuristic armor, cyberpunk style.「末」,
resolution:「始」1024x1024「末」
<<<[END_TOOL_REQUEST]>>>
```

### 指定模型生成

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」generate「末」,
model:「始」doubao-seedream-5-0-260128「末」,
prompt:「始」未来城市夜景「末」,
resolution:「始」1280x720「末」
<<<[END_TOOL_REQUEST]>>>
```

### 图生图

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」edit「末」,
prompt:「始」将这张照片变成油画风格「末」,
image:「始」https://example.com/photo.jpg「末」
<<<[END_TOOL_REQUEST]>>>
```

### 多图融合

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」compose「末」,
prompt:「始」融合这些元素创造梦幻场景「末」,
image:「始」["url1", "url2", "url3"]「末」
<<<[END_TOOL_REQUEST]>>>
```

### 组图生成

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」group「末」,
prompt:「始」猫咪的一天：早上起床、吃饭、玩耍、睡觉「末」,
max_images:「始」4「末」
<<<[END_TOOL_REQUEST]>>>
```

## 参数说明

### 基础参数

| 参数 | 必需 | 说明 | 默认值 |
|------|------|------|--------|
| `command` | 是 | 指令类型 | `generate` |
| `prompt` | 是 | 图像描述 | - |
| `model` | 否 | 模型ID（可通过 list_models 查询） | 配置文件中的默认值 |
| `resolution` | 否 | 图片分辨率 | `1024x1024` |
| `watermark` | 否 | 是否添加水印 | `false` |

### 命令类型

| 命令 | 别名 | 说明 |
|------|------|------|
| `generate` | `text2image` / `t2i` | 文生图 |
| `edit` | `image2image` / `i2i` | 图生图 |
| `compose` | `merge` / `fusion` | 多图融合 |
| `group` | `sequential` / `series` | 组图生成 |
| `list_models` | `models` | 查询可用模型 |

### 推荐分辨率

| 比例 | 分辨率 | 用途 |
|------|--------|------|
| 1:1 | `1024x1024` | 正方形图片（默认） |
| 4:3 | `1152x864` | 横向照片 |
| 3:4 | `864x1152` | 竖向照片 |
| 16:9 | `1280x720` | 宽屏横幅 |
| 9:16 | `720x1280` | 手机壁纸 |
| 1:1 (高清) | `2048x2048` | 高清正方形 |
| 16:9 (高清) | `2560x1440` | 高清宽屏 |
| 预设 | `1K` / `2K` / `4K` | 预设尺寸 |

### 高级参数

| 参数 | 适用命令 | 说明 | 范围 |
|------|----------|------|------|
| `seed` | generate, edit | 随机种子（-1 为随机） | -1 ~ 2147483647 |
| `guidance_scale` | generate | 提示词相关性 | 1 ~ 10 |
| `image` | edit, compose | 参考图片（URL/Base64/file://） | - |
| `max_images` | group | 组图数量 | 1 ~ 15 |

## 技术特性

### 智能 API 密钥池

插件内置密钥池管理系统：

1. **顺序轮询**：按顺序使用密钥，确保负载均衡
2. **状态持久化**：密钥状态保存在 `.doubao_api_cache.json`
3. **智能错误处理**：错误达到阈值（3次）自动禁用密钥
4. **自动恢复**：所有密钥失效时自动重置并重试
5. **配额切换**：429 限流时自动切换其他密钥重试

### 动态模型发现

通过 `list_models` 命令查询火山方舟 `/api/v3/models` 接口：

- 自动过滤出图像生成相关模型
- 查询结果缓存 24 小时，减少 API 调用
- 支持 `refresh: true` 参数强制刷新缓存
- AI 可根据任务需求自主选择最佳模型

### 返回格式

#### URL 格式（`DEFAULT_RESPONSE_FORMAT=url`）
- 返回火山引擎的图片 URL（24小时有效）
- 图片自动保存到本地，提供永久访问链接
- 适合节省传输数据量

#### Base64 格式（`DEFAULT_RESPONSE_FORMAT=b64_json`）
- 返回 Base64 编码的图片数据
- **多模态 AI 可以直接"看到"图片内容**
- 适合需要 AI 分析图片的场景

### 图片自动保存

所有生成的图片都会自动保存到本地：

- **保存路径**：`VCPToolBox/image/doubaogen/`
- **文件命名**：UUID 唯一文件名
- **永久有效**：即使 API 返回的 URL 过期，本地图片仍然可用

### 安全特性

- **路径遍历防护**：所有文件写入操作均验证路径在安全范围内
- **HTML 转义**：防止 prompt 中的特殊字符导致注入
- **输出安全**：使用 `process.stdout.write` + callback 确保数据完整刷出

## 注意事项

1. **模型激活**：火山方舟中的模型需要先在控制台激活才能使用
2. **URL 有效期**：API 返回的图片 URL 将在 24 小时后失效，但本地保存的图片永久有效
3. **提示词建议**：建议使用英文提示词以获得最佳效果
4. **图片要求**（图生图/多图融合）：
   - 格式：JPEG、PNG
   - 大小：≤10MB
   - 尺寸：宽高 > 14px，总像素 ≤ 6000×6000px

## 故障排除

### 常见问题

1. **未配置 API 密钥**
   - 检查 `config.env` 文件是否正确配置
   - 多个密钥用英文逗号分隔

2. **API 配额用完**
   - 配置多个 API 密钥实现自动切换
   - 查看 `.doubao_api_cache.json` 了解密钥状态

3. **模型未找到**
   - 使用 `list_models` 命令查看当前可用模型
   - 确认模型已在火山方舟控制台激活

4. **分辨率错误**
   - 使用推荐的分辨率值，或留空使用默认值

## 相关链接

- [火山引擎官方文档](https://www.volcengine.com/docs/82379/1541523)
- [获取 API 密钥](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)
- [模型列表](https://www.volcengine.com/docs/82379/1330310)

## 文件结构

```
DoubaoGen/
├── DoubaoGen.js            # 主程序（零外部依赖）
├── config.env              # 配置文件（需创建）
├── config.env.example      # 配置示例
├── plugin-manifest.json    # 插件清单
├── package.json            # 包信息
├── README.md               # 说明文档
└── .doubao_api_cache.json  # 密钥状态与模型缓存（自动生成）

生成的图片保存在：
VCPToolBox/
└── image/
    └── doubaogen/
        ├── uuid1.png
        ├── uuid2.jpg
        └── ...
```

## 更新日志

### v2.0.0
- 完全重写，从 SeedreamGen 引入多项能力
- 新增图生图、多图融合、组图生成功能
- 新增动态模型发现（list_models），AI 可自主选择模型
- 新增智能 API 密钥池（多 key 轮询、自动降级与恢复）
- 新增 Base64 返回格式，多模态 AI 可直接查看生成图片
- 移除 axios/uuid 外部依赖，改用 Node.js 原生模块
- 修复 Windows 路径分隔符导致图片 URL 无法访问的 bug
- 修复 stdout 输出竞态导致父进程收到截断数据的 bug
- 新增路径遍历防护、HTML 转义等安全特性

### v0.1.0
- 初始版本，仅支持文生图

---

作为 VCPToolBox 插件使用时，根据 VCP 变量命名规则，应在系统提示词中添加：`{{VCPDoubaoGen}}`。
