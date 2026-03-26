# CapturePreprocessor (捕获预处理器)

`CapturePreprocessor` 是一个 VCPToolBox 消息预处理插件。它通过监控系统提示词 (System Prompt) 中的特定占位符，动态地将实时的视觉上下文注入到对话流中。

## 🌟 核心特性：分布式捕获

不同于传统的本地截图插件，`CapturePreprocessor` 采用 **分布式架构**：
- **远程调用**：它通过 VCP Server 的工具调度系统，透明地调用连接到服务器的分布式节点（如用户的个人电脑）上的 `ScreenPilot` 工具。
- **视觉增强**：自动检测占位符，并在模型接收消息前，将捕获到的图片作为多模态内容注入到当前用户消息中。
- **按需触发**：仅在系统提示词中存在占位符时执行，不增加额外负担。

## 📝 语法指南

您可以将以下占位符放置在 AI Agent 的 **系统提示词 (System Prompt)** 中：

### 1. 屏幕截图 (Screen Shot)
- `{{VCPScreenShot}}`：捕获全屏图像（原始分辨率）。
- `{{VCPScreenShot:窗口标题}}`：截取指定标题的窗口（支持部分匹配）。

### 2. 轻量化截图 (Screen Shot Mini) —— **推荐使用**
为了节省 Token 消耗，支持 `Mini` 语法。该模式会通过 `ffmpeg` 将图片宽高各缩小 50%（例如 4K 变 2K），理论上减少 4 倍的 Token 占用：
- `{{VCPScreenShotMini}}`：全屏缩略图。
- `{{VCPScreenShotMini:窗口标题}}`：指定窗口的缩略图。

### 3. 摄像头捕获 (Camera Capture)
- `{{VCPCameraCapture}}`：捕获索引为 0 的摄像头。
- `{{VCPCameraCapture(N)}}`：捕获索引为 N 的摄像头。
  > *注：目前分布式版本的摄像头捕获功能暂未在服务端完全上线。*

## ⚙️ 配置参数

插件配置文件位于 `Plugin/CapturePreprocessor/config.env`：

- **`MONITOR_TIMEOUT_MS`**: 截图任务的超时时间（毫秒），默认为 `30000`。

## 🔧 工作流程

1. **扫描**：检测系统提示词中的占位符。
2. **调度**：向 VCP Server 发送 `TOOL_REQUEST`，寻找在线的 `ScreenPilot` 节点。
3. **后处理**：如果是 `Mini` 语法，插件会在本地使用 `ffmpeg` 进行高效缩放，并优化内存回收。
4. **注入**：将处理后的图片注入到最后一条用户消息中。
5. **清理**：从系统提示词中移除占位符，保持对话上下文整洁。

---
*VCPToolBox - 让 AI 能够跨设备“看见”您的工作流。*
