# VCP ToolBox 插件生态系统总结报告

## 概述

VCP (Variable & Command Protocol) ToolBox 目前拥有 **47个插件**（46个活跃插件 + 1个待激活插件），构建了一个功能丰富的AI增强插件生态系统。这些插件按照功能类型和执行模式进行分类，涵盖了图像生成、内容搜索、数据管理、娱乐工具、系统监控等多个领域。

## 插件分类统计

### 按插件类型分类
- **同步插件 (Synchronous)**: 29个 - 提供即时响应的工具调用
- **静态插件 (Static)**: 8个 - 定期运行并提供动态数据
- **服务插件 (Service)**: 4个 - 注册HTTP服务端点
- **混合服务插件 (Hybrid Service)**: 2个 - 结合预处理和服务功能
- **消息预处理插件 (Message Preprocessor)**: 1个 - 处理用户输入
- **异步插件 (Asynchronous)**: 1个 - 长时间异步处理
- **待激活插件**: 2个 - 需要配置启用

### 按功能领域分类
- **图像生成工具**: 7个
- **搜索引擎工具**: 7个  
- **日记管理系统**: 6个
- **文件系统工具**: 5个
- **研究学术工具**: 3个
- **浏览器控制工具**: 2个
- **通信推送工具**: 3个
- **娱乐占卜工具**: 2个
- **计算工具**: 2个
- **系统监控工具**: 3个
- **协作管理工具**: 1个
- **其他专用工具**: 5个

---

## 详细插件清单

### 🎨 图像生成工具类 (7个)

#### 1. **ComfyUIGen** - ComfyUI 图像生成器
- **版本**: 0.3.0 | **类型**: 同步插件
- **功能**: 通过 ComfyUI API 生成高质量图像，支持 LoRA 模型管理
- **特色**: 77+ LoRA模型选择、质量增强词、工作流模板支持
- **调用命令**: `ComfyUIGenerateImage`
- **作者**: niuniu

#### 2. **DoubaoGen** - Doubao 风格图片生成器  
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 通过火山方舟 API 使用 Doubao Seedream 3.0 模型生成图片
- **调用命令**: `DoubaoGenerateImage`
- **作者**: B3000Kcn

#### 3. **FluxGen** - FLUX.1图像生成器
- **版本**: 0.1.0 | **类型**: 同步插件  
- **功能**: 通过SiliconFlow API使用FLUX.1-schnell模型生成图片
- **调用命令**: `FluxGenerateImage`
- **作者**: UserProvided & Roo

#### 4. **GeminiImageGen** - Gemini图像生成器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 使用Google Gemini Flash Preview进行图像生成和编辑
- **调用命令**: `GeminiGenerateImage`, `GeminiEditImage`
- **作者**: Kilo Code

#### 5. **NanoBananaGenOR** - 多功能图像处理器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 通过OpenRouter调用Gemini 2.5 Flash进行图像操作
- **调用命令**: `NanoBananaGenerateImage`, `NanoBananaEditImage`, `NanoBananaComposeImage`
- **特色**: 支持生成、编辑、合成多张图片
- **作者**: Kilo Code

#### 6. **NovelAIGen** - NovelAI图像生成器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 使用NovelAI API生成高质量动漫风格图片
- **调用命令**: `NovelAIGenerateImage`
- **作者**: VCP-Assistant

#### 7. **ArtistMatcher** - 画师匹配查询器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 匹配SDXL模型内部的画师Tag，提供拟合度建议
- **调用命令**: `FindArtist`, `GetRandomArtistString`
- **作者**: Kilo Code

---

### 🔍 搜索引擎工具类 (7个)

#### 8. **FlashDeepSearch** - 多维度深度研究插件
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 围绕主题进行关键词扩展和综合搜索
- **调用命令**: `StartResearch`
- **作者**: VCP

#### 9. **GoogleSearch** - Google搜索引擎
- **版本**: 2.0.0 | **类型**: 同步插件
- **功能**: 使用Google Custom Search API进行搜索
- **调用命令**: `GoogleSearch`
- **作者**: Kilo Code

#### 10. **IMAPSearch** - 邮件全文搜索
- **版本**: 1.1.0 | **类型**: 同步插件
- **功能**: 在本地邮件索引中进行全文搜索
- **调用命令**: `IMAPSearch`
- **特色**: 分页支持、结果数量限制
- **作者**: B3000Kcn

#### 11. **KarakeepSearch** - Karakeep书签搜索
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 在Karakeep中全文搜索书签
- **调用命令**: `SearchBookmarks`
- **作者**: Kilo Code

#### 12. **SerpSearch** - 多引擎搜索服务
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 使用SerpApi提供多种搜索引擎服务
- **调用命令**: `bing_search`, `duckduckgo_search`, `google_scholar_search`
- **支持引擎**: Bing、DuckDuckGo、Google Scholar

#### 13. **TavilySearch** - 高级网络搜索
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 使用Tavily API进行高级网络搜索
- **调用命令**: `TavilySearch`
- **特色**: 时间范围、主题筛选
- **作者**: Roo

#### 14. **UrlFetch** - 网页内容获取器
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 访问指定URL的网页内容
- **调用命令**: `UrlFetch`
- **特色**: 文本模式和截图模式
- **作者**: Lionsky

---

### 📝 日记管理系统类 (6个)

#### 15. **DailyNoteGet** - 日记内容获取器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 定期读取所有角色的日记内容
- **占位符**: `{{AllCharacterDiariesData}}`
- **刷新间隔**: 每5分钟
- **作者**: System

#### 16. **DailyNoteWrite** - 日记写入器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 将日记数据写入对应的日记文件
- **作者**: System

#### 17. **DailyNoteEditor** - 日记内容编辑器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 编辑日记文件中的特定内容
- **调用命令**: `EditDailyNote`
- **安全特性**: 15字符最小匹配要求
- **作者**: Roo

#### 18. **DailyNoteManager** - 日记整理器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 智能分析、信息融合、内容精简日记
- **调用命令**: `DailyNoteManager`
- **特色**: 智能融合、格式化输出

#### 19. **RAGDiaryPlugin** - RAG日记检索插件
- **版本**: 1.0.0 | **类型**: 混合服务插件
- **功能**: 通过向量检索动态注入日记内容到系统提示词
- **作者**: Ryan & Gemini

#### 20. **AgentMessage** - 代理消息推送插件
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: AI通过WebSocket向用户前端发送格式化消息
- **调用命令**: `AgentMessage`
- **特色**: WebSocket实时推送
- **作者**: Roo

---

### 📁 文件系统工具类 (5个)

#### 21. **FileServer** - 文件服务器
- **版本**: 1.0.0 | **类型**: 服务插件
- **功能**: 提供受密码保护的静态文件服务
- **服务**: `ProtectedFileHosting`
- **作者**: Kilo Code

#### 22. **FileListGenerator** - 文件列表生成器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 生成'file'目录下的文件和文件夹列表
- **占位符**: `{{VCPFileServer}}`
- **刷新间隔**: 每5分钟
- **作者**: Kilo Code

#### 23. **FileTreeGenerator** - 文件树生成器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 扫描指定目录的文件夹结构
- **占位符**: `{{VCPFilestructureInfo}}`
- **刷新间隔**: 每5分钟

#### 24. **ImageServer** - 图像服务器
- **版本**: 1.0.0 | **类型**: 服务插件
- **功能**: 提供受密码保护的静态图片和文件服务
- **服务**: `ProtectedImageHosting`, `ProtectedFileHosting`
- **作者**: SystemMigration

#### 25. **EmojiListGenerator** - 表情包列表生成器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 扫描image/目录下的表情包文件夹并生成列表
- **作者**: System

---

### 🎓 研究学术工具类 (3个)

#### 26. **ArxivDailyPapers** - Arxiv每日论文
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 从Arxiv API获取每日研究论文
- **占位符**: `{{ArxivDailyPapersData}}`
- **刷新间隔**: 每30分钟
- **作者**: Gemini

#### 27. **CrossRefDailyPapers** - CrossRef每日论文
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 从CrossRef API获取每日研究论文
- **占位符**: `{{CrossRefDailyPapersData}}`
- **刷新间隔**: 每30分钟
- **作者**: Gemini

#### 28. **BilibiliFetch** - Bilibili内容获取插件
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 根据Bilibili URL获取视频或直播信息
- **调用命令**: `BilibiliFetch`
- **作者**: Roo

---

### 🌐 浏览器控制工具类 (2个)

#### 29. **ChromeControl** - Chrome浏览器控制器
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 向Chrome浏览器发送操作指令（点击、输入）
- **调用命令**: `type`, `click`, `open_url`

#### 30. **ChromeObserver** - Chrome浏览器观察者
- **版本**: 1.0.0 | **类型**: 服务插件
- **功能**: 实时观察Chrome当前页面内容
- **占位符**: `{{VCPChromePageInfo}}`
- **特色**: WebSocket连接浏览器扩展

---

### 📡 通信推送工具类 (3个)

#### 31. **SynapsePusher** - Synapse推送器
- **版本**: 1.0.0 | **类型**: 服务插件
- **功能**: 将VCP工具调用日志推送到Synapse (Matrix)房间

#### 32. **VCPLog** - VCP日志记录器
- **版本**: 1.0.0 | **类型**: 服务插件
- **功能**: 通过WebSocket推送VCP调用信息并记录日志

#### 33. **IMAPIndex** - IMAP邮件索引器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 通过IMAP拉取邮件并生成本地索引
- **占位符**: `{{IMAPIndex}}`
- **刷新间隔**: 每30分钟
- **特色**: 支持HTTP(S)代理，白名单过滤
- **作者**: B3000Kcn

---

### 🎲 娱乐占卜工具类 (2个)

#### 34. **Randomness** - 多功能随机事件生成器
- **版本**: 5.2.0 | **类型**: 同步插件
- **功能**: 随机事件生成，包括掷骰子、塔罗牌、符文等
- **调用命令**: `createDeck`, `drawFromDeck`, `rollDice`, `drawTarot`, `castRunes`等
- **特色**: 有状态牌堆管理、TRPG掷骰
- **作者**: VincentHDLee & Gemini

#### 35. **TarotDivination** - 塔罗占卜系统
- **版本**: 2.0.0 | **类型**: 同步插件
- **功能**: 融合天文与内在起源的塔罗占卜
- **调用命令**: `draw_single_card`, `draw_three_card_spread`, `draw_celtic_cross`, `get_celestial_data`
- **特色**: 起源系统（日、月、星）影响占卜结果
- **作者**: Kilo Code

---

### 🧮 计算工具类 (2个)

#### 36. **SciCalculator** - 科学计算器
- **版本**: 1.1.1 | **类型**: 同步插件
- **功能**: 支持复杂数学表达式的科学计算器
- **调用命令**: `SciCalculatorRequest`
- **特色**: 统计函数、微积分、误差传递
- **作者**: UserProvided (Adapted by Roo)

#### 37. **MCPO** - MCP工具桥接插件
- **版本**: 1.0.0 | **类型**: 同步插件
- **功能**: 自动发现和调用MCP工具
- **调用命令**: `list_tools`, `call_tool`, `get_tool_info`, `manage_server`等
- **特色**: 多种MCP服务器类型，热重载
- **作者**: VCP Team

---

### 📊 系统监控工具类 (3个)

#### 38. **FRPSInfoProvider** - FRPS信息提供器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 从FRPS服务器获取代理设备信息
- **占位符**: `{{FRPSAllProxyInfo}}`
- **刷新间隔**: 每10秒
- **作者**: B3000Kcn

#### 39. **MCPOMonitor** - MCPO服务监控器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 监控MCPO服务器状态和MCP工具信息
- **占位符**: `{{MCPOServiceStatus}}`
- **刷新间隔**: 每10秒
- **作者**: VCP Team

#### 40. **WeatherReporter** - 天气信息报告器
- **版本**: 1.0.0 | **类型**: 静态插件
- **功能**: 提供实时天气信息
- **占位符**: `{{VCPWeatherInfo}}`
- **刷新间隔**: 每8小时
- **作者**: System

---

### 🤝 协作管理工具类 (1个)

#### 46. **AgentAssistant** - 多代理协作插件
- **版本**: 2.0.0 | **类型**: 同步插件 (待激活)
- **功能**: 允许主AI或用户调用专门配置的代理执行各种任务
- **调用命令**: `InvokeAgent`
- **特色**: 支持即时和定时通信，每个代理独立系统提示词和配置
- **状态**: 需要配置启用 (plugin-manifest.json.example)
- **作者**: Your Name Here

---

### 🎵 其他专用工具类 (5个)

#### 41. **SunoGen** - Suno音乐生成器
- **版本**: 0.1.0 | **类型**: 同步插件
- **功能**: 使用Suno API生成原创歌曲
- **调用命令**: `generate_song`
- **特色**: 支持歌词、风格、续写

#### 42. **VideoGenerator** - 视频生成器
- **版本**: 0.1.0 | **类型**: 异步插件
- **功能**: 使用Wan2.1 API进行文本到视频或图像到视频生成
- **调用命令**: `submit`, `query`
- **特色**: 长时间异步处理，WebSocket推送状态

#### 43. **ImageProcessor** - 多模态图像处理器
- **版本**: 1.1.0 | **类型**: 消息预处理插件
- **功能**: 处理用户消息中的多模态数据（图像、音频、视频）
- **特色**: 调用多模态模型提取信息并管理缓存
- **作者**: System

#### 44. **VCPTavern** - 可视化上下文注入插件
- **版本**: 0.1.0 | **类型**: 混合服务插件
- **功能**: 类似SillyTavern的可视化上下文注入
- **作者**: Kilo Code

#### 45. **DailyHot** - 每日热榜
- **版本**: 2.0.0 | **类型**: 静态插件
- **功能**: 周期性获取主流平台的今日热榜信息
- **占位符**: `{{VCPDailyHot}}`
- **刷新间隔**: 每4小时
- **特色**: 综合微博、知乎、B站等平台热榜
- **作者**: Kilo Code & Roo

---

## 待激活插件 (2个)

### 🏥 1PanelInfoProvider - 1Panel信息提供器 
- **状态**: 需要配置启用 (plugin-manifest.json.block)
- **功能**: 提供1Panel服务器的仪表板和系统信息

### 🤝 AgentAssistant - 多代理协作插件
- **版本**: 2.0.0 | **状态**: 需要配置启用 (plugin-manifest.json.example)
- **功能**: 多代理协作系统，支持专门配置的代理和定时通信

---

## 技术架构总结

### 支持的编程语言
- **JavaScript/Node.js**: 32个插件
- **Python**: 10个插件  
- **混合**: 3个插件

### 通信协议
- **标准输入输出 (stdio)**: 41个插件
- **直接通信 (direct)**: 4个插件

### 数据提供方式
- **工具调用**: 28个插件提供主动调用功能
- **占位符**: 17个插件提供被动数据注入
- **服务端点**: 9个插件注册HTTP服务
- **消息预处理**: 1个插件处理用户输入

---

## 生态系统特点

1. **功能覆盖面广**: 从基础工具到高级AI服务，涵盖日常使用的各个方面
2. **技术栈多样**: 支持多种编程语言和通信协议
3. **实时性强**: 多个插件支持WebSocket实时推送
4. **可扩展性好**: 标准化的插件架构支持快速开发新功能
5. **智能集成**: 深度集成AI能力，提供智能化的用户体验

这个插件生态系统为VCP ToolBox提供了强大的功能扩展能力，使其能够适应各种复杂的AI应用场景和用户需求。

---

**生成时间**: 2025-08-28  
**插件总数**: 47个（45个活跃 + 2个待激活）  
**报告版本**: 1.1