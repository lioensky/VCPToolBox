# VCP Plugin Markdown 渲染标准指南

本文档记录了 VCP 插件向大模型输出文本结果的最佳实践格式。随着应用深入，我们发现纯 JSON 输出会导致模型混淆、过多的 Token 消耗以及阅读障碍。

因此，所有生成非结构化数据的插件，应当尽可能将其结果使用 Markdown 进行包裹和预格式化。

## 标准核心包裹层 (Data Structure)

VCP 主系统在处理多模态和文字输出时，期待以下核心数据结构：

```json
{
  "status": "success",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "你的 Markdown 格式化输出字符串"
      }
    ]
  }
}
```

> **注意！** 必须使用 `[{ type: 'text', text: '<string>' }]` 数组结构包裹你的字符串内容。如果直接将字符串赋予 `{ content: "..." }`，在经过多层 JSON 序列化传输时，大模型接收到的很有可能仍是一段带出大量 `\n`、`\r` 与 `\"` 的生硬字符串，从而无法正常触发对话侧的 Markdown 渲染。

## 场景案例

### 1. 终端执行结果 (例如：PowerShellExecutor)

对于脚本或命令行输出，应使用带语言高亮的 Markdown Block，辅以说明性标题：

```javascript
const outputText = `**PowerShell 执行结果**\n\`\`\`powershell\n${rawStdout}\n\`\`\``;

const finalResult = {
  status: 'success',
  result: {
    content: [
      { type: 'text', text: outputText }
    ]
  }
};
console.log(JSON.stringify(finalResult));
```

### 2. 文件详细信息 (例如：FileOperator -> getFileInfo)

对于键值对强关联的属性信息，使用 Markdown List (无序列表) 展现：

```javascript
const markdownList = `**文件信息**: \`${fileData.name}\`
- **路径**: \`${fileData.path}\`
- **目录**: \`${fileData.directory}\`
- **类型**: ${fileData.type === 'directory' ? '📁 目录' : '📄 文件'}
- **大小**: ${fileData.sizeFormatted} (${fileData.size} Bytes)
- **修改时间**: ${new Date(fileData.lastModified).toLocaleString()}`;
```

### 3. 多项列表/内容索引 (例如：FileOperator -> listDirectory)

对于长条目的平铺，强烈建议使用 Markdown Table，以便大模型建立空间与表格认知：

```javascript
let markdownTable = `| 名称 | 类型 | 大小 | 修改时间 | 隐藏 |\n|---|---|---|---|---|\n`;
for (const item of directoryItems) {
  const typeStr = item.type === 'directory' ? '📁' : '📄';
  const sizeStr = item.sizeFormatted || '-';
  const timeStr = new Date(item.lastModified).toLocaleString();
  const hiddenStr = item.isHidden ? '是' : '否';
  markdownTable += `| ${typeStr} **${item.name}** | ${item.type} | ${sizeStr} | ${timeStr} | ${hiddenStr} |\n`;
}
// 追加到内容
const outputText = `Directory listing of \`${dirPath}\`\n\n` + markdownTable;
```

### 4. 出现警告和拦截 (例如：被禁止的鉴权动作)

如果在命令执行前后产生了前置警告、提示、或其他非致命性阻断，可以使用 GitHub 风格的 Alert Banner (引用块加标签) 包裹它放在结果的最顶部：

```javascript
let finalContentText = resultOutput;
if (notice) {
    finalContentText = `> [!WARNING]\n> ${notice}\n\n` + finalContentText;
}

const finalResult = {
    status: 'success',
    result: {
        content: [
            { type: 'text', text: finalContentText }
        ]
    }
};
```

## 为什么要这么做？

1. **Token 节省**：纯 Markdown 表格、列表相较于充满 `": "` 和 `},{` 控制字符的 JSON，大幅稀释了垃圾符号。
2. **逻辑穿透力**：绝大多数先进的 LLM 均在海量 Markdown 数据集上接受指令微调。阅读代码高亮区和 Markdown 表格对它们来说简直像呼吸一样自然，可以显著降低长文理解过程中的“注意力崩塌”问题。
3. **消除转义困扰**：利用 `type: 'text'` 这个统一管道传输 Markdown 源文本，避免了二次 JSON 嵌套导致换行符变成字面意义上的 `\n`。
