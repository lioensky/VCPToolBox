# BilibiliFetch 插件说明

该插件用于从Bilibili视频链接中提取字幕内容。

## 功能

- 根据Bilibili视频URL或BVID提取字幕。
- 支持通过环境变量配置用户Cookie以访问需要登录的内容。
- 支持选择特定的字幕语言。

## 配置

### 环境变量

在项目根目录的 `config.env` 文件中，你需要配置以下变量：

- **`BILIBILI_COOKIE`** (必需): 你的Bilibili网站登录Cookie。对于某些需要登录才能观看或获取完整内容的视频是必需的。
  - **示例**: `BILIBILI_COOKIE="SESSDATA=xxxx;..."`

## AI 调用参数

当AI调用此工具时，可以传入以下参数：

1.  **`url`** (必需)
    - **描述**: Bilibili视频的URL。
    - **示例**: `https://www.bilibili.com/video/BV1PoMDzdEga`

2.  **`lang`** (可选)
    - **描述**: 指定要获取的字幕语言代码。
    - **常见值**: `ai-zh` (中文), `ai-en` (英文)。
    - **默认行为**: 如果不提供此参数，插件将默认尝试获取**中文字幕**。如果中文不存在，则选择第一个可用的字幕。

### 如何查找可用的语言代码？

当你使用此插件处理一个视频时，服务器的后台日志会打印出类似下面的一行信息，其中包含了该视频所有可用的语言代码：

```
INFO - Available subtitle languages: ['ai-en', 'ai-zh']
```

AI可以根据这个列表来决定使用哪个语言代码。

### AI 调用示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」BilibiliFetch「末」,
url:「始」https://www.bilibili.com/video/BV1PoMDzdEga「末」,
lang:「始」ai-en「末」
<<<[END_TOOL_REQUEST]>>>
```