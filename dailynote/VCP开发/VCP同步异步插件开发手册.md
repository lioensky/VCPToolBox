# VCP 同步插件开发手册

欢迎来到 VCP 同步插件开发的世界！本手册将指导你完成从构思到实现一个功能完备的同步插件的全过程。

## 1. 什么是VCP同步插件

VCP (Virtual Cherry-Var Protocol) 同步插件是一种外部可执行程序或脚本，它被主服务（[`server.js`](server.js)）按需调用以执行特定任务。它被称为“同步”是因为主服务会启动插件进程，向其发送数据，然后等待其执行完成并返回结果，整个过程是阻塞式的。

**核心交互机制:**

1.  **启动 (Spawn)**: 当AI需要调用某个工具时，[`Plugin.js`](Plugin.js) 中的插件管理器会根据 [`plugin-manifest.json`](Plugin/FileOperator/plugin-manifest.json) 的配置，启动一个对应的子进程。
2.  **输入 (stdin)**: 主服务将AI请求的参数（一个JSON字符串）通过标准输入（`stdin`）传递给插件进程。
3.  **执行 (Execute)**: 插件进程读取 `stdin` 的数据，执行其核心逻辑。这可能包括计算、调用外部API、文件操作等。
4.  **输出 (stdout)**: 插件执行完毕后，必须将其结果（一个特定格式的JSON字符串）打印到标准输出（`stdout`）。
5.  **终止 (Exit)**: 主服务读取到 `stdout` 的结果后，插件进程便完成了它的使命，可以正常退出。

**技术选型:**
你可以使用任何能够处理标准输入输出的编程语言或脚本来编写插件，例如：
*   **Python**: 如 [`SciCalculator`](Plugin/SciCalculator) 插件。
*   **Node.js**: 如 [`DMXDoubaoGen`](Plugin/DMXDoubaoGen) 和 [`FileOperator`](Plugin/FileOperator) 插件。
*   **Go, Rust, C++, C#** 等编译型语言。

---

## 2. 如何构建 `plugin-manifest.json` 和 `config.env`

这两个文件是插件的“身份证”和“配置单”，它们定义了插件的行为、能力和所需配置。

### 2.1 `plugin-manifest.json` 详解

这是插件的核心描述文件，主服务通过它来了解并加载你的插件。让我们从一个最简单的“回声”插件（EchoPlugin）的 `plugin-manifest.json` 示例开始。

**结构示例: `EchoPlugin/plugin-manifest.json`**

```json
{
  "manifestVersion": "1.0.0",
  "name": "EchoPlugin",
  "version": "1.0.0",
  "displayName": "回声插件",
  "description": "一个简单的插件，它会原样返回你发送给它的任何文本。",
  "author": "Your Name",
  "pluginType": "synchronous",
  "entryPoint": {
    "type": "python",
    "command": "python echo.py"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 5000
  },
  "configSchema": {
    "ECHO_PREFIX": {
      "type": "string",
      "description": "在返回的文本前添加的前缀。",
      "default": "Echo: "
    }
  },
  "capabilities": {
    "invocationCommands": [
      {
        "commandIdentifier": "EchoText",
        "description": "调用此工具将一段文本原样返回。\n参数:\n- text (字符串, 必需): 需要返回的文本内容。\n调用格式:\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」EchoPlugin「末」,\ntext:「始」你好，世界！「末」\n<<<[END_TOOL_REQUEST]>>>",
        "example": "<<<[TOOL_REQUEST]>>>\ntool_name:「始」EchoPlugin「末」,\ntext:「始」这是一个测试。「末」\n<<<[END_TOOL_REQUEST]>>>"
      }
    ]
  }
}
```

**关键字段解析:**

*   `"name"`: **(必需)** 插件的唯一英文标识符。AI在发起工具调用时，`tool_name`字段的值就来源于此。例如：`"EchoPlugin"`, `"SciCalculator"`。
*   `"name"`用途: 在主服务器中，当检测到Agent的系统提示词中包含`{{VCPToolname}}`占位符（例如name是SciCalculator，则占位符为{{VCPSciCalculator}}）时，会将invocationCommands中的description字段推送给Agent作为系统提示词的一部分。通过此类方法实现只需要编辑Agent系统提示词中的占位符list就能实现对Agent的插件功能热插拔。
*   `"displayName"`: **(必需)** 插件的显示名称，用于在UI中展示。
*   `"pluginType"`: **(必需)** 对于同步插件，此值必须是 `"synchronous"`。
*   `"entryPoint"`: **(必需)** 定义了插件的入口。
    *   `"type"`: 脚本类型，如 `"python"` 或 `"nodejs"`。
    *   `"command"`: 启动插件的完整命令。例如：`"python echo.py"`, [`"node DoubaoGen.js"`](Plugin/DMXDoubaoGen/plugin-manifest.json:11)。
*   `"communication"`: **(必需)**
    *   `"protocol"`: 对于同步插件，此值必须是 `"stdio"`。
    *   `"timeout"`: （可选）插件执行的超时时间（毫秒）。
*   `"configSchema"`: （可选）定义插件需要的配置项及其类型，这些配置项由 `config.env` 提供。在上面的例子中，我们定义了一个 `ECHO_PREFIX`，允许用户在 `config.env` 中自定义回声的前缀。
*   `"capabilities.invocationCommands"`: **(必需)** 这是最重要的部分，它定义了AI可以如何调用你的插件。它是一个数组，可以包含一个或多个命令对象。

    **`description` 字段的重要性:**
    此字段的内容至关重要，因为它会组合成一个占位符（如 `{{VCPEchoPlugin}}`），并被插入到AI的系统提示词（System Prompt）中。AI完全依赖此处的描述来理解你的工具能做什么、如何调用、参数是什么。因此，一个清晰、准确、详尽的 `description` 是插件能否被AI成功调用的关键。[`Plugin.js`](Plugin.js) 中的 [`buildVCPDescription()`](Plugin.js:402) 函数负责处理这个逻辑。

    **情况一：单个指令的插件**
    如果你的插件只提供一个核心功能，`invocationCommands` 数组中就只有一个对象。
    *   **示例**: [`SciCalculator/plugin-manifest.json`](Plugin/SciCalculator/plugin-manifest.json:19)
        它详细描述了计算器的所有功能、函数和调用格式，AI会根据这份“说明书”来构建数学表达式。

    **情况二：多个指令的插件**
    如果你的插件提供多种不同的操作，`invocationCommands` 数组中可以有多个对象，每个对象代表一个指令。
    *   **示例**: [`FileOperator/plugin-manifest.json`](Plugin/FileOperator/plugin-manifest.json:43)
        它为 `ReadFile`, `WriteFile`, `ListDirectory` 等每个功能都定义了一个独立的命令对象。每个对象都有自己的 `command` 字段和 `description`。当AI调用时，它会指定要执行的 `command`，你的插件脚本需要根据这个 `command` 值来执行相应的操作。

### 2.2 `config.env` 配置文件

这是一个简单的文本文件，用于存放敏感信息（如API密钥）或可配置的参数，避免硬编码在代码中。

*   **位置**: 放在插件的根目录下，例如 [`Plugin/DMXDoubaoGen/config.env`](Plugin/DMXDoubaoGen/config.env)。
*   **格式**: 纯文本，每行一个键值对，格式为 `KEY=VALUE`。
*   **加载**: [`Plugin.js`](Plugin.js) 在启动插件进程时，会自动读取这个文件，并将其中的键值对设置为该进程的环境变量。你的插件代码可以通过 `process.env.KEY` (Node.js) 或 `os.environ['KEY']` (Python) 来获取这些值。
*   **示例**:
    ```env
    # DMXDoubaoGen/config.env
    VOLCENGINE_API_KEY=sk-yourkey
    ```
    在 [`DoubaoGen.js`](Plugin/DMXDoubaoGen/DoubaoGen.js:10) 中，通过 `process.env.VOLCENGINE_API_KEY` 来获取它。

---

## 3. 如何构建插件本体

插件本体是执行核心逻辑的脚本文件。无论使用何种语言，其核心模式都是一致的。

**核心模式：**

1.  **读取标准输入（stdin）**: 获取来自主服务的JSON字符串参数。
2.  **解析JSON**: 将输入字符串解析为程序可用的对象。
3.  **执行逻辑**: 根据参数执行核心功能。
4.  **构建响应JSON**: 创建一个包含 `status` 和 `result`/`error` 字段的对象。
5.  **打印到标准输出（stdout）**: 将响应对象序列化为JSON字符串并打印。

### 3.1 返回纯文本信息

这是最简单的插件类型，其结果是纯文本字符串。

*   **适用场景**: 计算器、查询、简单的文本处理等。
*   **示例**: [`SciCalculator/calculator.py`](Plugin/SciCalculator/calculator.py)
    该插件的 `main` 函数展示了完整的流程：
    ```python
    # calculator.py 简化逻辑
    import sys
    import json

    def main():
        # 1. 读取 stdin
        expression_input = sys.stdin.readline().strip()
        
        # 2 & 3. 执行逻辑
        result_str = evaluate(expression_input) # evaluate是核心计算函数
        
        # 4. 构建响应
        output = {"status": "success", "result": result_str}
        
        # 5. 打印到 stdout
        print(json.dumps(output), file=sys.stdout)
        sys.exit(0)

    if __name__ == "__main__":
        main()
    ```
    它的 `result` 字段就是一个字符串，例如 `"###计算结果：2.718###，请将结果转告用户###`。

### 3.2 返回“多模态结构化”信息

当插件需要返回图片、音频或其他复杂结构的数据时，需要使用多模态结构。

*   **适用场景**: 图像生成、文件读取（返回图片内容）、音频处理等。
*   **核心结构**: `result` 字段是一个对象，其 `content` 属性是一个数组，数组中的每个元素都是一个带 `type` 的对象。
*   **示例**: [`DMXDoubaoGen/DoubaoGen.js`](Plugin/DMXDoubaoGen/DoubaoGen.js)
    该插件生成图片后，返回一个包含文本描述和图片数据的结构：
    ```javascript
    // DoubaoGen.js 简化逻辑
    const result = {
        content: [
            {
                type: 'text',
                text: `图片已成功生成！\n- 提示词: ${args.prompt}...`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/png;base64,${base64Image}` // 使用Data URI嵌入图片
                }
            }
        ],
        // ...其他细节
    };

    // 最终打印到 stdout
    console.log(JSON.stringify({ status: "success", result: result }));
    ```
    前端或其他服务可以解析这个结构，将文本和图片分别渲染出来。

### 3.3 AI 友好型返回格式：用 content 数组规避转义地狱（推荐）

> **设计理念**：把插件的 `result` 字段构造成一个**模拟 OpenAI user message content 数组**的结构，让 AI 像"接收一段用户输入"那样自然消化插件输出，而不是面对一坨被反复转义的 JSON 字符串。

#### 3.3.1 为什么需要这种格式

传统的纯字符串 `result` 在以下场景会出现严重问题：

1.  **转义噩梦**：当返回内容包含 Markdown、URL、代码块、引号、换行时，序列化为 JSON 字符串后会产生 `\\n`、`\\"`、`\\\\` 等多重转义，AI 在阅读时容易把这些字符当作字面量处理，导致渲染异常或链接断裂。
2.  **多模态混排困难**：纯文本无法承载图片、音频等二进制资源，强行 base64 内联到字符串中既破坏可读性又污染上下文。
3.  **来源边界模糊**：纯字符串返回会被 AI 当作"工具的旁白"，与用户消息边界混淆；而 content 数组结构天然带有"这是一段独立的多模态内容"的语义提示。

#### 3.3.2 核心结构（OpenAI 风格 content 数组）

将 `result` 设计为一个对象，其 `content` 字段是一个数组，每个元素都是一个带 `type` 字段的对象，**完全模仿 OpenAI Vision API 中 user message 的 content 数组格式**：

```javascript
{
    "status": "success",
    "result": {
        "content": [
            { "type": "text", "text": "这里是给 AI 看的纯文本说明，可以包含 Markdown、URL、换行，无需任何转义。" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } },
            { "type": "text", "text": "这里可以继续追加文本片段，与图片混排。" }
        ]
    }
}
```

**关键支持的 type 类型**：

| type | 字段结构 | 用途 |
|------|---------|------|
| `text` | `{ type: 'text', text: '...' }` | 文本片段，支持 Markdown/URL/换行原文 |
| `image_url` | `{ type: 'image_url', image_url: { url: '...' } }` | 图片，支持 https URL 或 `data:image/...;base64,...` Data URI |

#### 3.3.3 核心技巧：用 `type: 'text'` 包裹文本"冒充" user content

**这是该格式最精妙的地方**：即使你只想返回纯文本，也可以把文本切成若干个 `{ type: 'text', text: '...' }` 元素塞进 `content` 数组。这样做的收益：

*   **绕过 JSON 字符串的多层转义**：文本内容作为 JSON 对象的字段值存在，主服务在解析时会自动还原所有转义字符，AI 拿到的是干净的原文。
*   **让 AI 把它当成"用户输入"读**：因为结构与 OpenAI user content 数组完全一致，AI 模型对此结构有天然的"内容感知"，不容易把工具返回当作"系统旁白"草草略过。
*   **天然支持后续扩展**：如果未来要插入图片或其它多模态资源，直接在数组里追加元素即可，无需改造调用方。

**对比示例**：

❌ **传统做法（容易出问题）**：
```javascript
const longMarkdown = `## 检索报告\n\n详见 [链接](https://example.com/path?a=1&b="2")\n\n\`\`\`json\n{"key": "value"}\n\`\`\``;
console.log(JSON.stringify({ status: "success", result: longMarkdown }));
// 实际输出：{"status":"success","result":"## 检索报告\\n\\n详见 [链接](https://example.com/path?a=1&b=\\"2\\")\\n\\n```json\\n{\\"key\\": \\"value\\"}\\n```"}
// AI 读到的是带 \\n、\\" 的转义字符串，渲染体验差
```

✅ **推荐做法（AI 友好）**：
```javascript
const longMarkdown = `## 检索报告\n\n详见 [链接](https://example.com/path?a=1&b="2")\n\n\`\`\`json\n{"key": "value"}\n\`\`\``;
console.log(JSON.stringify({
    status: "success",
    result: {
        content: [
            { type: 'text', text: longMarkdown }
        ]
    }
}));
// AI 拿到的 text 字段会被正确解析为原文 Markdown，链接、代码块、引号都完好
```

#### 3.3.4 实战示例 1：纯文本检索结果（VSearch 风格）

参考 [`Plugin/VSearch/VSearch.js`](Plugin/VSearch/VSearch.js)，搜索类插件返回的报告往往包含大量 URL、Markdown 标题、引用源，使用 content 数组可避免长文本被转义破坏：

```javascript
// VSearch.js 中的真实实现：先抽出工厂函数，再统一应用到所有搜索模式
const buildAiFriendlyResult = (reportText) => ({
    content: [
        { type: 'text', text: reportText }
    ]
});

const finalReport = `## VSearch 检索报告 [模式: Grounding]\n\n**研究主题**: ${SearchTopic}\n\n${allResults.join('')}`;

sendResponse({
    status: "success",
    result: buildAiFriendlyResult(finalReport)
});
```

> 提示：VSearch 的 4 个搜索模式（Grok / Tavily / KimiSearch / Grounding）都已统一改造为 content 数组格式，复杂 Markdown 报告中的 URL、引用源、代码块均能完好送达 AI。

#### 3.3.5 实战示例 2：文本 + 图片混排（DoubaoGen 风格）

参考 [`Plugin/DMXDoubaoGen/DoubaoGen.js`](Plugin/DMXDoubaoGen/DoubaoGen.js:466) 的实现，图像生成插件用 content 数组同时返回文本说明 + 图片 base64：

```javascript
// 来自 DoubaoGen.js 的真实实现
const content = [
    {
        type: 'text',
        text: `图片已成功生成！\n- 提示词: ${args.prompt}\n- 分辨率: ${size}\n- Seed: ${finalSeed}\n- 可访问URL: ${accessibleImageUrl}\n请将生成好的图片转发给用户哦。`
    }
];

// 可选：根据参数决定是否内联 base64 图片（节省 token）
if (showBase64) {
    content.push({
        type: 'image_url',
        image_url: {
            url: `data:${imageMimeType};base64,${base64Image}`
        }
    });
}

const result = {
    content: content,
    details: { /* 额外的结构化元数据，可选 */
        fileName: generatedFileName,
        prompt: args.prompt,
        resolution: size,
        seed: finalSeed,
        imageUrl: accessibleImageUrl
    }
};

console.log(JSON.stringify({ status: "success", result: result }));
```

**值得借鉴的设计点**：

1.  **`text` 段写得像"自然语言交付"**：包含具体参数、URL、给 AI 的行动建议（"请将生成好的图片转发给用户哦"），让模型自然衔接到下一句回复。
2.  **`image_url` 段可选**：通过 `showbase64` 开关让用户决定是否内联 base64（base64 图片会消耗大量 token，默认关闭可降低成本）。
3.  **`details` 旁路字段**：在 `content` 之外另设 `details` 对象，承载结构化元数据（文件名、seed、URL），供前端或日志系统使用，不污染 AI 的视觉上下文。

#### 3.3.6 重要概念：将生成内容转化为内网 URL（imageUrl / fileUrl）

当插件生成了图片、PDF、Markdown、音频、视频或其他文件时，**不要只返回本地磁盘路径**，也不要默认把大文件全部塞进 Base64。推荐做法是：

1.  将生成结果保存到 VCP 的公开资源目录：
    *   图片类资源保存到 `PROJECT_BASE_PATH/image/<插件子目录>/...`
    *   普通文件类资源保存到 `PROJECT_BASE_PATH/file/<插件子目录>/...`
2.  通过 [`ImageFileServer`](Plugin/ImageFileServer/image-file-server.js:433) 暴露的安全路由，把本地文件路径转换为带访问密钥的内网 URL：
    *   图片 URL：`{VarHttpUrl}:{SERVER_PORT}/pw={IMAGESERVER_IMAGE_KEY}/images/<相对路径>`
    *   文件 URL：`{VarHttpUrl}:{SERVER_PORT}/pw={IMAGESERVER_FILE_KEY}/files/<相对路径>`
3.  在 `result.content` 的 `text` 段里明确给出可访问 URL，并在 `details` 中额外保留 `imageUrl` / `fileUrl`、`serverPath`、`fileName` 等结构化字段。

> 这里的"内网 URL"是指由 VCP 自身的 Image/File Server 提供的受控访问地址，不是外部 API 临时 URL，也不是 `file://` 本地路径。这样前端、OpenWebUI 脚本、其他 Agent 或后续工具都能稳定访问生成内容。

**ImageFileServer 路由规则**

[`Plugin/ImageFileServer/image-file-server.js`](Plugin/ImageFileServer/image-file-server.js:473) 会将以下目录暴露为带密钥访问的静态资源服务：

| 资源类型 | 本地根目录 | URL 路径 | 鉴权环境变量 | 插件侧注入变量 |
|----------|------------|----------|--------------|----------------|
| 图片 | `PROJECT_BASE_PATH/image` | `/pw=<Image_Key>/images/...` | `Image_Key` | `IMAGESERVER_IMAGE_KEY` |
| 文件 | `PROJECT_BASE_PATH/file` | `/pw=<File_Key>/files/...` | `File_Key` | `IMAGESERVER_FILE_KEY` |

插件通常不直接读取 `Image_Key` / `File_Key`，而是读取由 [`Plugin.js`](Plugin.js:1221) 注入到插件进程环境变量中的 `IMAGESERVER_IMAGE_KEY` / `IMAGESERVER_FILE_KEY`。主机、端口和项目根目录则来自 `VarHttpUrl`、`SERVER_PORT`、`PROJECT_BASE_PATH`。

**图像生成插件示例（imageUrl）**

参考 [`Plugin/DMXDoubaoGen/DoubaoGen.js`](Plugin/DMXDoubaoGen/DoubaoGen.js:434) 的核心流程：先把外部 API 返回的图片下载或解码为 Buffer，写入 `image/doubaogen`，再拼出可访问的 `imageUrl`。

```javascript
const generatedFileName = `${uuidv4()}.${imageExtension}`;
const imageDir = path.join(PROJECT_BASE_PATH, 'image', 'doubaogen');
const localImagePath = path.join(imageDir, generatedFileName);

await fs.mkdir(imageDir, { recursive: true });
await fs.writeFile(localImagePath, imageBuffer);

const relativePathForUrl = path.join('doubaogen', generatedFileName).replace(/\\/g, '/');
const imageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativePathForUrl}`;

const result = {
    content: [
        {
            type: 'text',
            text: `图片已成功生成！\n- 可访问URL: ${imageUrl}\n请将生成好的图片转发给用户哦。`
        }
    ],
    details: {
        serverPath: `image/doubaogen/${generatedFileName}`,
        fileName: generatedFileName,
        imageUrl
    }
};

console.log(JSON.stringify({ status: 'success', result }));
```

**普通文件生成插件示例（fileUrl）**

如果插件生成的是 PDF、Markdown、CSV、视频等普通文件，应写入 `PROJECT_BASE_PATH/file/<插件子目录>`，并使用 `/files/` 路由和 `IMAGESERVER_FILE_KEY`：

```javascript
const generatedFileName = `${crypto.randomUUID()}.pdf`;
const fileDir = path.join(PROJECT_BASE_PATH, 'file', 'reporter');
const localFilePath = path.join(fileDir, generatedFileName);

await fs.mkdir(fileDir, { recursive: true });
await fs.writeFile(localFilePath, pdfBuffer);

const relativePathForUrl = path.join('reporter', generatedFileName).replace(/\\/g, '/');
const fileUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_FILE_KEY}/files/${relativePathForUrl}`;

const result = {
    content: [
        {
            type: 'text',
            text: `报告已生成：${fileUrl}`
        }
    ],
    details: {
        serverPath: `file/reporter/${generatedFileName}`,
        fileName: generatedFileName,
        fileUrl
    }
};
```

**从内容中的 `file://` 转换为 URL**

有些插件不是自己生成二进制文件，而是接收或生成 Markdown 内容，其中包含本地 `file://` 链接。这种情况下可参考 [`DailyNote`](Plugin/DailyNote/dailynote.js:327) 的做法：

*   `![alt](file://...)`：读取本地图片，复制到 `PROJECT_BASE_PATH/image/dailynote`，替换为 `![alt](http://.../images/dailynote/...)`。
*   `[text](file://...)`：读取本地普通文件，复制到 `PROJECT_BASE_PATH/file/dailynote`，替换为 `[text](http://.../files/dailynote/...)`。

这种转换让最终保存的 Markdown / 日记内容不再依赖本机绝对路径，而是通过 VCP 内网 URL 可被前端或其他客户端访问。

**实践建议**

*   **生成物优先返回 URL，Base64 只作为可选项**：图片可像 [`DoubaoGen.js`](Plugin/DMXDoubaoGen/DoubaoGen.js:473) 一样通过 `showbase64` 参数控制是否额外返回 Data URI。
*   **URL 放在 `content.text`，元数据放在 `details`**：AI 能直接看到链接，程序也能稳定读取 `details.imageUrl` / `details.fileUrl`。
*   **按资源类型选择目录和路由**：图片走 `image/...` + `/images/...`；普通文件走 `file/...` + `/files/...`。
*   **不要暴露裸本地路径给用户**：`H:\...`、`/home/...`、`file://...` 对远端客户端通常不可访问，也可能泄露服务器目录结构。
*   **注意文件类型白名单**：[`ImageFileServer`](Plugin/ImageFileServer/image-file-server.js:12) 对图片和普通文件都有扩展名白名单；新增文件类型时要确认服务端允许访问。
*   **注意访问密钥**：URL 中的 `/pw=...` 是访问控制的一部分，日志和公开回复中应按业务场景谨慎暴露。

#### 3.3.7 实施建议

*   **新插件优先采用 content 数组格式**，即使只返回纯文本。
*   **存量插件**：当返回内容超过约 500 字符、包含 Markdown/URL/代码块、或涉及多模态时，建议改造为 content 数组格式。
*   **保持向后兼容**：`result` 字段同时支持字符串和对象两种形态，主服务会自动识别并适配下游消费者，**无需担心改造破坏现有调用链**。
*   **不要过度切片**：单个 `text` 段可以包含很长的 Markdown，没必要为每段话都拆一个数组元素，按"语义边界 + 模态切换"自然分段即可。

### 3.4 处理多个指令

对于像 [`FileOperator`](Plugin/FileOperator) 这样的多功能插件，你需要在代码中实现一个分发逻辑。

*   **实现方式**:
    1.  从 `stdin` 解析出的JSON对象中，读取 `command` 字段的值。
    2.  使用 `switch` 语句或 `if-else` 结构，根据 `command` 的值调用不同的处理函数。
*   **示例**: [`FileOperator/FileOperator.js`](Plugin/FileOperator/FileOperator.js:786)
    ```javascript
    // FileOperator.js 简化逻辑
    async function processRequest(request) {
      const { command, ...parameters } = request; // 分离出 command 和其他参数
      const action = command;

      switch (action) {
        case 'ReadFile':
          return await readFile(parameters.filePath, parameters.encoding);
        case 'WriteFile':
          return await writeFile(parameters.filePath, parameters.content, parameters.encoding);
        case 'ListDirectory':
          return await listDirectory(parameters.directoryPath, parameters.showHidden);
        // ... 其他 case
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    }
    ```

---

## 4. 技术细节

### 4.1 VCP的AI调用语法

AI通过一种特殊的文本格式来发起工具调用请求。

```
<<<[TOOL_REQUEST]>>>
maid:「始」Agent的署名「末」, // 重要字段，以进行任务追踪了解工具由谁发起
tool_name:「始」工具名「末」, // 必要字段，以了解你要调用什么工具
arg:「始」工具参数「末」, // 具体视不同工具需求而定
timely_contact:「始」(可选) 设置一个未来时间点定时调用工具，格式为 YYYY-MM-DD-HH:mm (例如 2025-07-05-14:00)。如果提供此字段，工具调用将被安排在指定时间调用。「末」
<<<[END_TOOL_REQUEST]>>>
```

**重点**: 作为插件开发者，你 **不需要** 解析这个块。[`server.js`](server.js) 会为你完成解析，并只将干净的参数（例如 `tool_name` 对应的 `arg`）作为JSON对象通过 `stdin` 发送给你的插件。

### 4.2 构建串行调用的语法

为了提高效率，AI可以一次性请求执行多个连续的操作。这被称为“批量”或“串行”调用。插件开发者可以通过在插件中实现特定的逻辑来支持这种调用方式。

**对AI的调用格式约定:**

当AI需要发起批量调用时，它需要构造一个特殊的JSON对象，其中每个指令和其参数都通过数字后缀来区分。

*   **格式**: 将每个指令命名为 `commandX`，其对应的参数也加上相同的数字后缀 `X`，例如 `filePathX`, `contentX`。`X` 从1开始递增。

*   **示例**: 假设AI需要先列出 `/home/user/docs` 目录的内容，然后读取该目录下的 `report.txt` 文件。AI应该构造如下的完整 `TOOL_REQUEST` 块：

    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」FileOperator「末」,
    command1:「始」ListDirectory「末」,
    directoryPath1:「始」/home/user/docs「末」,
    command2:「始」ReadFile「末」,
    filePath2:「始」/home/user/docs/report.txt「末」
    <<<[END_TOOL_REQUEST]>>>
    ```

    主服务 (`server.js`) 会解析这个请求，并将以下JSON对象发送到 `FileOperator` 插件的 `stdin`：
    ```json
    {
      "command1": "ListDirectory",
      "directoryPath1": "/home/user/docs",
      "command2": "ReadFile",
      "filePath2": "/home/user/docs/report.txt"
    }
    ```

**对插件开发者的提示:**

*   你的插件脚本需要能够解析这种带数字后缀的JSON格式。
*   [`FileOperator.js`](Plugin/FileOperator/FileOperator.js:855) 是一个很好的参考实现。它通过检查请求中是否存在 `command1`, `command2` 等键来识别批量请求，然后循环处理每个指令，并最终返回一个包含所有操作结果的汇总报告。
*   在你的 `plugin-manifest.json` 的 `description` 中，应明确告知AI你的插件支持这种批量调用方式，并提供一个简单的示例。

### 4.3 构建鲁棒的参数识别

为了让AI更容易、更灵活地使用你的插件，建议在插件内部处理参数的同义词和大小写问题。

*   **场景**: AI可能用 `size` 或 `resolution` 来表示图片分辨率，也可能用 `Prompt` 或 `prompt`。
*   **实现**: 在你的代码中，检查多个可能的参数名。

    **Node.js 示例:**
    ```javascript
    function handleImageRequest(args) {
        // 处理同义词
        const resolution = args.resolution || args.size;
        // 处理大小写
        const prompt = args.prompt || args.Prompt;

        if (!resolution || !prompt) {
            throw new Error("必须提供 prompt 和 resolution/size 参数。");
        }
        // ...后续逻辑
    }
    ```

    **Python 示例:**
    ```python
    def handle_image_request(args):
        # .get(key, default) 是一个安全的方式
        # .lower() 用于处理大小写
        args_lower = {k.lower(): v for k, v in args.items()}
        
        resolution = args_lower.get('resolution') or args_lower.get('size')
        prompt = args_lower.get('prompt')

        if not resolution or not prompt:
            raise ValueError("必须提供 prompt 和 resolution/size 参数。")
        # ...后续逻辑
    ```
通过在插件内部增加这种兼容性处理，可以大大提高AI调用插件的成功率和用户体验。

### 4.4 分布式文件 URL：插件无需关心跨节点取文件

在当前版本中，分布式文件处理已经由插件管理器透明接管。插件收到参数前，主服务会预先扫描本地插件调用参数中的 `file://` URL，并通过 [`FileFetcherServer.resolveFileUrl()`](FileFetcherServer.js:1) 自动把远程文件拉取并转换为可用的数据形式。对应逻辑位于 [`PluginManager.processToolCall()`](Plugin.js:909)。

因此，插件开发者不再需要实现旧版“超栈追踪”协议，也不需要：

*   捕获 `ENOENT` 后返回 `FILE_NOT_FOUND_LOCALLY`。
*   让插件主动请求 `FileFetcherServer`。
*   为 `internal_request_file` 编写额外响应逻辑。
*   针对多个 `file://` URL 自行编排跨节点拉取流程。

**插件侧只需要做两件事：**

1.  **按普通入参处理文件字段**：如果你的插件声明接收 `image_url`、`file_url`、`audio_url` 等字段，直接读取最终收到的参数即可。远程 `file://` 的解析与替换已经在插件执行前完成。
2.  **正确处理 Base64 / Data URI**：如果参数中包含 `data:image/...;base64,...`、`data:audio/...;base64,...` 或纯 Base64 字符串，插件需要自行识别、提取 MIME 类型与纯 Base64 数据，并按业务需求解码或上传。

> 注意：分布式工具本身（即 `plugin.isDistributed` 的云端/远端插件）不会由主服务器预拉取其 `file://` 参数，而是透传给分布式端处理；这里的“透明预处理”主要面向由当前主服务直接执行的本地插件。

#### 4.4.1 推荐实践：兼容 Data URI 与纯 Base64

很多上游链路为了保留 MIME 类型，会把图片、音频或文件内容包装为 Data URI：

```text
data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...
```

但也有场景只传递纯 Base64：

```text
iVBORw0KGgoAAAANSUhEUg...
```

插件应同时兼容这两种格式。下面是一个通用 Node.js 解析示例：

```javascript
function parseBase64Payload(input, fallbackMimeType = 'application/octet-stream') {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('Base64 输入不能为空。');
    }

    const trimmed = input.trim();
    const dataUriMatch = trimmed.match(/^data:([^;,]+);base64,(.*)$/s);

    if (dataUriMatch) {
        return {
            mimeType: dataUriMatch[1],
            base64: dataUriMatch[2],
            buffer: Buffer.from(dataUriMatch[2], 'base64')
        };
    }

    return {
        mimeType: fallbackMimeType,
        base64: trimmed,
        buffer: Buffer.from(trimmed, 'base64')
    };
}
```

使用时只需要对最终收到的参数做解析：

```javascript
const imageInput = args.image_base64 || args.image_url || args.file_base64;
const imageData = parseBase64Payload(imageInput, 'image/png');

// imageData.buffer 可直接写入文件或上传到外部 API
// imageData.mimeType 可用于构造请求头或多模态消息
```

#### 4.4.2 插件开发建议

*   **不要再实现旧版 `FILE_NOT_FOUND_LOCALLY` 流程**：这会让插件行为与当前插件管理器的透明预处理重复，甚至造成错误处理路径混乱。
*   **不要假设收到的一定是本地路径**：你的插件可能收到普通 URL、Data URI、纯 Base64 或经过服务端转换后的可访问地址，应按插件自身能力声明并做清晰校验。
*   **在 `description` 中明确入参格式**：如果插件支持 Base64，请写清楚是否支持 Data URI、纯 Base64、URL，以及推荐优先级。
*   **大文件谨慎内联**：Base64 会显著放大体积并消耗上下文/token；如已有可访问 URL，优先返回 URL，把 Base64 作为必要时的兼容选项。

### 4.5 VCP Auth 验证码机制：管理员权限指令

VCP Auth 验证码机制允许插件开发者为特定的指令添加一层安全验证，确保只有拥有正确验证码的用户才能执行敏感操作。这对于需要管理员权限或高风险操作的插件（如系统命令执行、文件删除等）至关重要。

#### 4.5.1 启用管理员权限 (Manifest 配置)

要在插件级别启用 VCP Auth 验证码机制，你需要在 `plugin-manifest.json` 的根级别添加 `requiresAdmin` 字段并设置为 `true`。

```json
{
  "manifestVersion": "1.0.0",
  "name": "AdminPlugin",
  // ... 其他字段
  "pluginType": "synchronous",
  "requiresAdmin": true, // 关键：启用管理员权限验证
  // ...
}
```

当 `requiresAdmin` 为 `true` 时，主服务 (`Plugin.js`) 会自动执行以下操作：
1.  从安全存储中获取并解密当前的 VCP Auth 验证码。
2.  将解密后的验证码注入到插件进程的环境变量 `DECRYPTED_AUTH_CODE` 中。

#### 4.5.2 AI 调用规范 (InvocationCommands)

如果你的插件启用了管理员权限，你必须在 `invocationCommands` 的 `description` 中明确告知 AI 必须提供一个名为 `requireAdmin` 的参数，其值为用户提供的验证码。

**示例 (参考 `PowerShellExecutor`):**

```json
"invocationCommands": [
  {
    "commandIdentifier": "AdminCommand",
    "description": "执行需要管理员权限的命令。\n参数:\n- command (字符串, 必需): 要执行的命令。\n- requireAdmin (字符串, 必需): 6位数的验证码，用于执行需要管理员权限的任务。\n调用格式:\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」AdminPlugin「末」,\ncommand:「始」system-shutdown-command「末」,\nrequireAdmin:「始」123456「末」\n<<<[END_TOOL_REQUEST]>>>"
  }
]
```

#### 4.5.3 插件内部验证逻辑 (核心实现)

插件脚本必须从输入参数中读取用户提供的验证码（例如 `args.requireAdmin`），并将其与环境变量 `DECRYPTED_AUTH_CODE` 进行比对。

**Node.js 验证范例 (参考 `PowerShellExecutor.js`):**

```javascript
// 假设 args 是从 stdin 解析出的 JSON 对象
const requireAdmin = args.requireAdmin;

if (requireAdmin) {
    const realCode = process.env.DECRYPTED_AUTH_CODE;

    if (!realCode) {
        // 如果主服务未能注入验证码，通常是配置问题
        throw new Error('无法获取管理员验证码。请确保主服务器配置正确。');
    }

    if (String(requireAdmin) !== realCode) {
        // 验证失败，抛出错误
        throw new Error('管理员验证码错误。');
    }
    // 验证成功，继续执行管理员命令
}
```

**Python 验证范例:**

```python
import os
import json

def validate_admin_auth(args):
    require_admin = args.get('requireAdmin')
    
    if require_admin:
        real_code = os.environ.get('DECRYPTED_AUTH_CODE')
        
        if not real_code:
            raise ValueError('无法获取管理员验证码。请确保主服务器配置正确。')
        
        if str(require_admin) != real_code:
            raise ValueError('管理员验证码错误。')
        
        print("管理员权限验证成功。")
        return True
    return False
```

通过在插件内部实现这一验证步骤，即使 AI 尝试调用管理员指令，如果没有提供正确的验证码，插件也会立即失败并返回错误信息，从而保障系统的安全。

---

## 5. VCP 异步插件开发

当一个任务需要很长时间才能完成时（例如视频生成、长时间的数据分析），同步插件模型不再适用，因为它会阻塞主服务，直到任务完成。为了解决这个问题，VCP引入了异步插件模型。

### 5.1 什么是异步插件

异步插件将一个长耗时任务分解为两个阶段：

1.  **任务提交（同步阶段）**: 插件被调用后，它会立即启动后台任务，并马上向主服务返回一个“任务已提交”的回执。这个回执中包含一个唯一的任务ID和一个特殊的占位符。主服务收到后，会立刻将这个占位符返回给AI，AI再呈现给用户。这个过程非常快，不会阻塞。
2.  **结果回调（异步阶段）**: 插件的后台任务（例如，一个独立的线程）会持续工作或轮询状态。当任务最终完成（成功或失败）时，它会通过一个HTTP请求，将最终结果“回调”给主服务器上的一个特定API端点。

主服务器收到回调后，会将结果保存下来，并通过WebSocket通知前端。更重要的是，当AI在后续的对话中再次看到之前收到的那个占位符时，主服务器会自动将其替换为已保存的最终结果。

**以 [`VideoGenerator`](Plugin/VideoGenerator) 为例的生命周期：**

1.  **AI 调用**: AI 发起一个视频生成请求。
2.  **插件执行**: [`Plugin.js`](Plugin.js) 启动 `video_handler.py` 进程。
3.  **立即返回**: `video_handler.py` 向外部API提交了生成任务，然后立刻向 `stdout` 打印一个JSON，其中包含任务ID和一个占位符，例如 `{{VCP_ASYNC_RESULT::Wan2.1VideoGen::some-request-id}}`。
4.  **后台轮询**: `video_handler.py` 进程**没有退出**，而是启动一个后台线程，该线程开始轮询视频生成的状态。
5.  **结果回调**: 几分钟后，后台线程发现视频已生成。它立刻向主服务器的 `/plugin-callback/Wan2.1VideoGen/some-request-id` 地址发送一个 `POST` 请求，请求体中包含了视频的URL和状态。
6.  **服务器处理**: [`server.js`](server.js) 上的回调路由接收到这个请求，将结果保存到 `VCPAsyncResults` 目录下的一个JSON文件中，并发送WebSocket通知。
7.  **占位符替换**: 在未来的对话中，系统提示词里的 `{{VCP_ASYNC_RESULT::...}}` 会被自动替换成已保存的视频URL和相关信息。

### 5.2 如何构建 `plugin-manifest.json`

异步插件的清单文件在同步插件的基础上增加了几个关键配置。

**`VideoGenerator/plugin-manifest.json` 示例解析:**

```json
{
  "name": "Wan2.1VideoGen",
  "displayName": "视频生成器 (Wan2.1)",
  "pluginType": "asynchronous", // 关键点1: 类型必须是 "asynchronous"
  "entryPoint": {
    "command": "python video_handler.py"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 1800000 // 建议设置一个较长的超时时间
  },
  "capabilities": {
    "invocationCommands": [
      {
        "command": "submit",
        "description": "提交一个新的视频生成任务...这是一个动态上下文占位符...请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::Wan2.1VideoGen::{req_id_submit}}}}}" // 关键点2: 必须指导AI返回占位符
      },
      {
        "command": "query",
        "description": "查询指定 request_id 的视频生成任务状态..." // 提供一个手动查询状态的命令作为备用
      }
    ]
  },
  "webSocketPush": { // 关键点3: （可选）配置WebSocket推送
    "enabled": true,
    "messageType": "video_generation_status",
    "usePluginResultAsMessage": true,
    "targetClientType": "VCPLog"
  }
}
```

**关键字段解析:**

*   `"pluginType"`: **(必需)** 必须设置为 `"asynchronous"`。这是 [`Plugin.js`](Plugin.js) 区分两种插件模式的唯一标识。
*   `"description"` (在 `submit` 命令中): **(极其重要)** 你必须在描述中明确告知AI：
    1.  这是一个耗时操作。
    2.  调用成功后，它会收到一个**动态上下文占位符**。
    3.  AI**必须**将这个占位符**原文**返回给用户，格式为 `{{VCP_ASYNC_RESULT::YourPluginName::{任务ID}}}`。
*   `"webSocketPush"`: (可选) 如果配置了此项，当插件通过回调API返回最终结果时，[`server.js`](server.js) 会自动向指定类型的客户端发送一个WebSocket消息，用于实时通知。

### 5.3 如何构建插件本体

异步插件的脚本核心是实现“两阶段执行”模式。

**核心模式：**

1.  **阶段一 (同步)**:
    *   从 `stdin` 读取输入参数。
    *   启动后台任务（例如，在Python中创建一个 `threading.Thread`）。
    *   **立即**向 `stdout` 打印一个JSON对象，其 `result` 字段包含要返回给AI的占位符字符串。
    *   **不要退出进程！**
2.  **阶段二 (异步)**:
    *   后台任务开始执行（例如，轮询API状态）。
    *   任务完成后，获取最终结果。
    *   从环境变量中读取 `CALLBACK_BASE_URL` 和 `PLUGIN_NAME_FOR_CALLBACK`。
    *   向 `f"{CALLBACK_BASE_URL}/{PLUGIN_NAME_FOR_CALLBACK}/{任务ID}"` 发起一个 `POST` HTTP请求，请求体为包含最终结果的JSON。
    *   回调发送成功后，后台任务结束，整个插件进程可以安全退出。

**示例: `video_handler.py` 关键逻辑**

1.  **主函数 `main()` (同步部分)**
    ```python
    # video_handler.py -> main()
    def main():
        # ... 读取和解析 stdin ...
        if command == "submit":
            # ... 参数校验 ...
            
            # 调用API提交函数，这个函数会启动后台线程
            req_id_submit = submit_video_request_api(
                api_key, t2v_model, prompt, ...,
                callback_base_url=os.getenv("CALLBACK_BASE_URL"), 
                plugin_name_for_callback=os.getenv("PLUGIN_NAME_FOR_CALLBACK")
            )
            
            # 构造包含占位符的结果字符串
            result_string_for_ai = (
                f"文生视频任务 (ID: {req_id_submit}) 已成功提交。\n"
                f"这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n"
                f"请在你的回复中包含以下占位符原文：{{{{VCP_ASYNC_RESULT::Wan2.1VideoGen::{req_id_submit}}}}}"
            )
            
            # 立即打印初始响应到 stdout
            print_json_output(status="success", result=result_string_for_ai)
            # 此后，主线程结束，但后台线程仍在运行
    ```

2.  **提交函数 `submit_video_request_api()` (启动后台)**
    ```python
    # video_handler.py -> submit_video_request_api()
    def submit_video_request_api(...):
        # ... 调用外部API，获取 request_id ...
        
        if callback_base_url and plugin_name_for_callback:
            # 创建一个后台线程来执行轮询和回调
            polling_thread = threading.Thread(target=poll_and_callback, args=(
                api_key, request_id, callback_base_url, plugin_name_for_callback, ...
            ))
            # 必须是非守护线程（默认即是），这样主进程会等待它执行完毕
            polling_thread.start()
            log_event("info", f"[{request_id}] Background polling thread started.")
        
        return request_id
    ```

3.  **回调函数 `poll_and_callback()` (异步部分)**
    ```python
    # video_handler.py -> poll_and_callback()
    def poll_and_callback(api_key, request_id, callback_base_url, plugin_name, ...):
        # ... 循环轮询任务状态 ...
        
        # 当获取到最终状态 ("Succeed" or "Failed")
        if current_status in ["Succeed", "Failed"]:
            log_event("info", f"[{request_id}] Final status '{current_status}' received. Attempting callback.")
            
            # 构造回调URL
            callback_url = f"{callback_base_url}/{plugin_name}/{request_id}"
            
            # 准备回调数据
            callback_payload = {
                "requestId": request_id,
                "status": current_status,
                # ... 其他结果数据，如 videoUrl, reason, message ...
            }

            try:
                # 发送POST请求到主服务器
                callback_response = requests.post(callback_url, json=callback_payload, timeout=30)
                callback_response.raise_for_status()
                log_event("success", f"[{request_id}] Callback to {callback_url} successful.")
            except requests.exceptions.RequestException as cb_e:
                log_event("error", f"[{request_id}] Callback to {callback_url} failed.")
            
            return # 任务完成，线程退出
    ```

通过遵循这个模式，你可以创建强大的异步插件来处理任何耗时的任务，同时保持主服务的响应性和流畅的用户体验。
