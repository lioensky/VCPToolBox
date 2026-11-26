# VCP 后端原生 Function Calling 链路

## 范围与执行权

- `POST /v1/chat/completions` 支持客户端提供 OpenAI `tools`、`tool_choice`，也可向支持它的上游传 `parallel_tool_calls`。它允许同一轮产生多个调用，不保证上游会发多个，也不规定执行并发度。
- 原生旁路是客户端执行契约：调用定义由客户端提供，模型输出由 VCP 返回，客户端执行并提交结果。VCP 不会仅凭原生函数名派发同名插件。旧 VCP 文本工具仍沿用自身的执行和回执链。
- 同轮返回已确认的原生调用时，不再执行该轮正文里的旧 VCP 工具块。未确认的原生碎片不会阻止现有畸形恢复或合格的 VCP 文本工具尾部接管。
- 本接口没有自动注册 VCP 插件的能力；原生 JSON 参数中的 `ink`、`archery`、`timely_contact`、`JEV` 不具备 VCP 全局语义。`/v1/human/tool` 是另一个文本直调入口，不是原生 FC 回执端点。

## 第三方前端测试

1. 配置 OpenAI 兼容连接，发送标准的 `tools` 定义（例如两个客户端自带的只读函数）。分别测 `stream: false` 和 `stream: true`。仅支持显示调用的客户端可以测到第 3 步，完整闭环需要可执行工具的客户端。
2. 非流式读取 `choices[i].message.tool_calls[]`；每条含 `id`、`type: "function"`、`function.name` 和 JSON 字符串形式的 `function.arguments`。
3. 流式读取 `choices[i].delta.tool_calls[]`，按 `choice.index`、调用 `index` 合并分片。不同调用的参数分片可能交错；以 `id` 关联执行结果，不按工具名关联。不要因单个片段能解析成 JSON 就执行。VCP 会继续流出正文，原生分片在上游成功结束后提交；标准调用的 `finish_reason` 为 `tool_calls`，随后结束本次 SSE。
4. 客户端执行后，下一请求的 `messages[]` 在原始助手调用消息之后为每个 ID 追加一条工具消息。不是把整个批次塞进单条 `tool` 消息，也不是再发一个 `user` 块。例如：

   ```json
   [
     {"role":"assistant","content":null,"tool_calls":[
       {"id":"call_a","type":"function","function":{"name":"lookup_a","arguments":"{}"}},
       {"id":"call_b","type":"function","function":{"name":"lookup_b","arguments":"{}"}}
     ]},
     {"role":"tool","tool_call_id":"call_a","content":"A result"},
     {"role":"tool","tool_call_id":"call_b","content":"B result"}
   ]
   ```

## 无 MCP 调试：`VCP_FC_DEBUG`

在后端 `config.env` 设置 `VCP_FC_DEBUG=true` 并重启后端。默认关闭。仅当请求没有 `tools`、`tool_choice`，也没有旧版 `functions` 或 `function_call` 时，后端才补入一个 `vcptools` 函数和 `tool_choice: "auto"`。显式空数组或 `none` 不覆盖。

`vcptools` 接受开放 JSON 对象，每次调用一个请求，可在一轮调用多次。服务端只认领本次由自己注入的声明；调用需经过现有 VCP 执行、审批和分布式派发，不要求客户端注册 MCP。客户端自带的函数（包括同名函数）仍按标准透传，不由 VCP 认领。建议以已启用的只读 VCP 插件测试；`auto` 不保证模型一定调用。

托管调用与文本调用共享同一 ToolLoop 和前端回执：流式输出原有摘要、执行记录 ID 和按配置可见的详情，不向客户端发待执行的 `tool_calls` 或中间 `[DONE]`。完整回执写出后仍经过既有暂挂闸门；解除暂挂才派发续轮，硬中止不派发。唯一区别在模型侧：文本入口用原有 `user` 载荷，托管原生入口保留 `assistant.tool_calls`，每个原始 ID 回填一条 `role: "tool"`。JEV 子结果归回父 ID；纯静默射箭不单独触发续轮。

### 可选：向客户端转发托管 FC

在服务端 `config.env` 设置 `VCP_FC_FORWARD_TO_CLIENT=true` 后重启（默认 `false`）。对托管 Chat Completions 流全局生效，无需客户端声明能力；后端校验整批后、回执之前，把原始调用 ID、函数名和参数放进 `choices[0].delta.tool_calls`。该帧的 `finish_reason` 为 `null`，不插入中间 `[DONE]`。后端仍执行并回填真实结果，不改变客户端声明工具的标准透传路径，也不改变非流式行为。

同一部署上的客户端必须遵守托管执行权：收到这些帧只展示或存档，不得自行重复执行。若接入会自动执行收到的 FC 的通用客户端，保持此全局开关关闭。

## 畸形恢复与协议桥

- 不再按 Hydrogen 模型名清除工具声明、历史调用和响应调用。`NativeToolIsolationModels` 已退役。
- 流式仍处理显式 `MALFORMED_FUNCTION_CALL`；实际出站模型为 Hydrogen、且没有正文、推理、原生调用证据或载荷错误时，保留对空 `content_filter` 的兼容恢复。原生分片只在整轮确认后提交，不因客户端偶然收到了合法 JSON 前缀而提前提交。
- 现有 `POST /v1/responses` 通过 Chat Completions 协议桥转换 `function_call` 和 `function_call_output`。返回值用 `call_id` 配对，注意不要把输出项自身的 `id` 与 `call_id` 混用。

## 图片型工具回执

`POST /v1/chat/completions` 接受以下 **VCP 输入扩展**。调用消息与全部 `tool` 消息连续提交，每个 `tool_call_id` 恰好一次：

```json
{"role":"tool","tool_call_id":"call_a","content":[
  {"type":"text","text":"Image generated"},
  {"type":"image_url","image_url":{"url":"https://example.com/result.png","detail":"low"}}
]}
```

VCP 出站时保留该 `tool` 消息和原 ID，只把其 `content` 投影成文本；同批回执之后追加一条临时多模态 `user` 消息，里面按来源调用 ID 标注图片。它不进入持久聊天历史，也不加角色分割线。工具回执中的文字标记按字面保留，不作为角色指令执行。如果供应商不是 VCP，请勿假设上述 Chat 输入扩展受支持。

`POST /v1/responses` 则使用标准结构，不需要客户端手动附加 `user`：

```json
{"type":"function_call_output","call_id":"call_a","output":[
  {"type":"input_text","text":"Image generated"},
  {"type":"input_image","image_url":"https://example.com/result.png","detail":"low"}
]}
```

Responses 对外保留标准回执格式；当前内部上游还是 Chat Completions，因此同样进行出站投影。支持显式 HTTP(S) URL 和 `data:image/...;base64,...`，例如 Doubao `showbase64` 的图片块；不会把 JSON 字符串、HTML 或 Markdown 中的链接当图。当前投影不解析 `file_id`、不主动下载图片，也不保证纯文本模型能够消费图片；验证时请选择支持视觉的上游。

## 后续 VChat / VCP 托管适配

- 主聊天气泡现有的 VCP 工具回执与原生模型续轮消息是不同数据；不为了显示把 `role: "tool"` 改成 `user`，也不把回执重复回灌。
- 当前托管和客户端声明互斥，不会混合执行权。客户端回执不应再次回填已由后端托管的调用。
- 前端状态和回执应按调用 ID 关联。同一 JEV 父调用若展开多个插件调用，展示可有子项，模型协议仍按原始父调用 ID 闭合。VChat 主气泡改造不在本阶段。