# RegexPostProcessor - 正则表达式后处理器插件

## 概述

RegexPostProcessor是一个VCP消息后处理插件，用于在AI响应返回给客户端之前，对响应内容进行正则表达式替换处理。该插件支持流式和非流式两种处理模式，可以实现各种文本处理需求。

## 功能特性

- **正则表达式替换**：支持使用正则表达式对AI响应内容进行灵活的文本替换
- **流式处理**：支持对流式响应进行实时处理
- **非流式处理**：支持对完整响应进行批量处理
- **多规则支持**：可以同时配置多个正则表达式规则
- **动态配置**：支持运行时动态更新正则表达式规则
- **安全处理**：包含错误处理机制，确保插件异常不影响主服务

## 安装与配置

### 1. 插件文件结构

```
Plugin/RegexPostProcessor/
├── plugin-manifest.json      # 插件清单文件
├── regex-post-processor.js   # 主插件脚本
├── regex-rules.json          # 正则表达式规则配置文件
├── test-plugin.js           # 测试脚本
├── config.env.example       # 配置示例
└── README.md                # 使用说明
```

### 2. 配置参数

在VCP主配置文件`config.env`中添加以下配置：

```env
# 正则表达式规则文件路径（相对于插件目录）
RulesFilePath=regex-rules.json

# 是否自动重新加载规则文件
AutoReloadRules=false

# 自动重新加载检查间隔（毫秒）
ReloadInterval=5000

# 是否启用流式处理模式
EnableStreaming=true

# 流式处理时的chunk缓冲区大小
ChunkBufferSize=1000

# 流式处理时的处理间隔（毫秒）
ProcessInterval=500
```

### 3. 规则文件配置

正则表达式规则现在存储在`regex-rules.json`文件中，格式如下：

```json
{
  "rules": [
    {
      "pattern": "我",
      "replacement": "偶",
      "flags": "g",
      "description": "将'我'替换为'偶'",
      "enabled": true
    },
    {
      "pattern": "AI",
      "replacement": "人工智能",
      "flags": "gi",
      "description": "将AI替换为人工智能",
      "enabled": true
    },
    {
      "pattern": "\\bVCP\\b",
      "replacement": "Variable & Command Protocol",
      "flags": "g",
      "description": "将VCP缩写展开为全称",
      "enabled": true
    }
  ],
  "version": "1.0.0",
  "description": "RegexPostProcessor插件的正则表达式规则配置",
  "lastUpdated": "2025-01-28T08:00:00.000Z"
}
```

**规则字段说明：**
- `pattern`: 正则表达式模式（必需）
- `replacement`: 替换内容（必需）
- `flags`: 正则表达式标志，常用值：
  - `g`: 全局匹配
  - `i`: 忽略大小写
  - `m`: 多行模式
  - `s`: 让 `.` 匹配换行符
  - `u`: Unicode模式
  - `y`: 粘性匹配
- `description`: 规则描述，便于管理
- `enabled`: 是否启用该规则，默认为 `true`

**注意事项：**
- 规则按配置顺序执行
- 禁用的规则（`enabled: false`）不会被应用
- 正则表达式中的特殊字符需要正确转义
- 插件会在启动时自动加载规则文件

### 3. 正则表达式规则格式

```json
{
  "rules": [
    {
      "pattern": "正则表达式",
      "replacement": "替换内容",
      "flags": "gimsuy",
      "description": "规则描述",
      "enabled": true
    }
  ]
}
```

**参数说明：**
- `pattern`: 正则表达式模式（必需）
- `replacement`: 替换内容（必需）
- `flags`: 正则表达式标志，可选值：g（全局）、i（忽略大小写）、m（多行）、s（dotAll）、u（unicode）、y（sticky）
- `description`: 规则描述，便于管理
- `enabled`: 是否启用该规则，默认为true

## 使用示例

### 基础示例

```json
{
  "rules": [
    {
      "pattern": "我",
      "replacement": "偶",
      "flags": "g",
      "description": "将'我'替换为'偶'"
    }
  ]
}
```

### 高级示例

```json
{
  "rules": [
    {
      "pattern": "\\bVCP\\b",
      "replacement": "Variable & Command Protocol",
      "flags": "gi",
      "description": "将VCP缩写展开为全称"
    },
    {
      "pattern": "(\\d{4})-(\\d{2})-(\\d{2})",
      "replacement": "$3/$2/$1",
      "flags": "g",
      "description": "将YYYY-MM-DD格式转换为DD/MM/YYYY"
    },
    {
      "pattern": "(?<!\\S)(AI|人工智能)(?!\\S)",
      "replacement": "🤖$1🤖",
      "flags": "g",
      "description": "为AI相关词汇添加表情符号"
    }
  ]
}
```

## 工作原理

### 非流式模式
1. 等待AI生成完整响应
2. 将完整响应传递给插件
3. 应用所有正则表达式规则
4. 返回处理后的响应

### 流式模式
1. 接收AI响应的chunk数据
2. 将chunk累积到缓冲区
3. 当缓冲区达到一定大小时进行处理
4. 应用正则表达式规则
5. 继续处理后续chunk

## 开发接口

### processResponse方法

```javascript
async processResponse(content, config, isStreaming = false, chunkBuffer = null)
```

**参数：**
- `content`: 要处理的内容（字符串）
- `config`: 插件配置对象
- `isStreaming`: 是否为流式处理模式
- `chunkBuffer`: 流式处理的chunk缓冲区

**返回值：**
- 处理后的内容字符串

### updateRules方法

```javascript
async updateRules(newRules)
```

**参数：**
- `newRules`: 新的正则表达式规则配置，格式：
```javascript
{
  rules: [
    {
      pattern: "正则表达式",
      replacement: "替换内容",
      flags: "g",
      description: "规则描述",
      enabled: true
    }
  ]
}
```

**返回值：**
- `{ success: true, ruleCount: number }` 或 `{ success: false, error: string }`

### reloadRules方法

```javascript
async reloadRules()
```

**功能：**
- 从规则文件重新加载正则表达式规则

**返回值：**
- `{ success: true, ruleCount: number }` 或 `{ success: false, error: string }`

### getStatus方法

```javascript
getStatus()
```

**返回值：**
- 插件状态对象：
```javascript
{
  initialized: true,      // 是否已初始化
  ruleCount: 5,          // 规则总数
  enabledRules: 5,       // 启用的规则数
  chunkBufferSize: 0,    // chunk缓冲区大小
  lastProcessTime: 0     // 最后处理时间
}
```

## 动态规则管理

插件支持运行时动态更新正则表达式规则，无需重启VCP服务。

### 更新规则

可以通过VCP的工具调用API动态更新规则：

```bash
curl -X POST http://localhost:5890/v1/human/tool \
-H "Authorization: Bearer your_server_key_here" \
-H "Content-Type: text/plain" \
-d '<<<[TOOL_REQUEST]>>>
tool_name:「始」RegexPostProcessor「末」,
rules_json:「始」{"rules":[{"pattern":"新规则","replacement":"新替换","flags":"g","description":"新规则描述"}]}「末」
<<<[END_TOOL_REQUEST]>>>'
```

### 重新加载规则

如果规则文件被外部程序修改，可以重新加载规则：

```bash
curl -X POST http://localhost:5890/v1/human/tool \
-H "Authorization: Bearer your_server_key_here" \
-H "Content-Type: text/plain" \
-d '<<<[TOOL_REQUEST]>>>
tool_name:「始」RegexPostProcessor「末」,
action:「始」reload「末」
<<<[END_TOOL_REQUEST]>>>'
```

### 规则验证

更新规则时，插件会自动验证正则表达式的有效性，无效的规则会被拒绝并返回错误信息。

## 注意事项

1. **性能考虑**：复杂的正则表达式可能影响处理性能，建议在生产环境中进行测试
2. **规则冲突**：多个规则可能产生冲突，执行顺序为配置中的顺序
3. **转义字符**：在JSON配置中需要正确转义正则表达式中的特殊字符
4. **错误处理**：插件包含完善的错误处理机制，确保异常情况下的稳定性

## 故障排除

### 常见问题

1. **正则表达式无效**
   - 检查pattern字段中的转义字符
   - 验证flags参数是否正确

2. **替换不生效**
   - 确认规则已启用（enabled: true）
   - 检查正则表达式是否正确匹配目标文本

3. **性能问题**
   - 减少复杂的正则表达式规则
   - 调整ChunkBufferSize参数

### 调试模式

在VCP主配置文件中启用调试模式：

```env
DebugMode=true
```

这将提供详细的处理日志，帮助诊断问题。

## 更新日志

### v1.1.0
- **重大改进**：移除硬编码的正则规则
- **新增**：JSON文件格式的规则存储（regex-rules.json）
- **新增**：规则文件自动加载和重新加载功能
- **新增**：规则验证机制，无效规则自动过滤
- **新增**：reloadRules API接口
- **改进**：updateRules方法现在会保存规则到文件
- **改进**：更好的错误处理和日志记录

### v1.0.0
- 初始版本发布
- 支持基本的正则表达式替换
- 支持流式和非流式处理模式
- 提供动态规则更新接口