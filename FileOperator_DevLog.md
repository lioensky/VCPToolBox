# FileOperator 插件开发日志：标准返回结构与 JSON 处理指南

## 1. 标准返回结构 (VCP Protocol v2)

为了支持多模态输出（串语法）和更结构化的工具反馈，插件的返回结构已统一。

### 1.1 内部返回格式 (Internal Response)
插件内部函数应返回如下结构的 `Object`：

```javascript
{
  success: true, // 或 false
  data: {
    message: "操作成功描述", // 简短的成功消息
    content: [ // 串语法数组，用于模型直接阅读
      { type: "text", text: "已读取文件 'example.js' (1.2 KB)。" },
      { type: "text", text: "console.log('hello');" }
    ],
    validation: [], // 可选：代码验证结果数组
    items: [], // 可选：目录列表项
    results: [], // 可选：搜索结果项
    _specialAction: "action_name", // 可选：触发前端特殊动作
    payload: {} // 可选：特殊动作的负载数据
  }
}
```

### 1.2 VCP 协议转换格式 (VCP Protocol Format)
`convertToVCPFormat` 函数负责将内部格式转换为 VCP 协议标准格式：

```javascript
{
  "status": "success",
  "result": {
    "content": [ ... ], // 统一的串语法数组
    "details": { ... }  // 原始的结构化数据，供程序逻辑使用
  },
  "_specialAction": "...", // 如果存在
  "payload": { ... }       // 如果存在
}
```

---

## 2. 如何处理 JSON 返回方法

在处理如 `ListDirectory`、`FileInfo`、`SearchFiles` 等返回大量结构化数据的操作时，应遵循以下原则：

### 2.1 文本摘要与 JSON 详情并存
为了让模型既能快速理解结果，又能获取完整数据，`content` 数组应包含：
1.  **文本摘要**：一条描述性的 `text` 消息。
2.  **JSON 字符串**：使用 `JSON.stringify(data, null, 2)` 格式化的数据，作为 `text` 类型放入数组。

**示例代码：**
```javascript
const message = `Directory listing of ${dirPath} (${result.length} items)`;
return {
  success: true,
  data: {
    items: result,
    message: message,
    content: [
      { type: 'text', text: message },
      { type: 'text', text: JSON.stringify(result, null, 2) }
    ]
  }
};
```

### 2.2 自动转换逻辑
`convertToVCPFormat` 具备自动降级处理能力。如果 `data.content` 为空，它会尝试根据 `data.items` 或 `data.results` 自动生成 `content` 数组，确保模型始终能看到有意义的输出。

### 2.3 批量请求中的聚合
在 `processBatchRequest` 中，多个操作的 `content` 数组会被平铺（flatten）并合并。
*   **读取类操作**：其 `content` 直接推入聚合数组。
*   **写入类操作**：其 `message` 会被收集到 `summaryMessages` 中，最后统一生成一个摘要 `text` 块放在数组最前面。

---

## 3. 串语法 (Multimodal) 支持

插件现在支持返回图片、音频和视频。

*   **图片**：`{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`
*   **音视频**：同样使用 `image_url` 类型，VCP 前端会根据 Base64 的 MIME 类型自动识别并渲染对应的播放器。

---

## 4. 代码验证集成

所有修改文件的操作（`WriteFile`, `EditFile`, `ApplyDiff`）都应调用 `runValidationAndAttachResults`。
这会将验证结果放入 `data.validation` 字段，并在 `convertToVCPFormat` 中自动转换为可读的文本块附加在返回末尾，而不会破坏原始的成功消息。