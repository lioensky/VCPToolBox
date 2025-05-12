# WeatherReporter 插件 (天气预报员)

这是一个 `static` 类型的插件，其主要目的是定期获取指定城市的实时天气信息，并将这些信息提供给系统，以便在处理用户请求时通过系统提示词中的占位符注入。

## 功能

*   **自动获取天气**: 定期（默认为每天凌晨 4 点）自动执行脚本以获取最新的天气信息。
*   **多阶段处理**:
    1.  使用 Tavily API 搜索指定城市的原始天气预报数据。
    2.  将原始数据与预设的提示模板结合，调用配置的大语言模型 (LLM) 对天气信息进行总结和格式化。
*   **缓存**: 将最终处理好的天气信息文本存储在本地文件 ([`weather_cache.txt`](Plugin/WeatherReporter/weather_cache.txt)) 中。
*   **容错**: 如果实时获取天气信息失败，插件会尝试使用上一次成功获取的缓存数据。
*   **系统集成**: 将获取到的天气信息（或错误提示）更新到系统提示词的 `{{VCPWeatherInfo}}` 占位符中，供 AI 在生成响应时参考。

## 工作方式

1.  **定时触发**: 根据 [`plugin-manifest.json`](Plugin/WeatherReporter/plugin-manifest.json) 中 `refreshIntervalCron` 定义的时间（例如 `"0 4 * * *"`），插件管理器自动执行 `node weather-reporter.js` 命令。
2.  **执行脚本 ([`weather-reporter.js`](Plugin/WeatherReporter/weather-reporter.js))**:
    *   加载位于**项目根目录** `config.env` 文件中的配置（API URL、API Key、模型名称、提示模板、城市、Tavily Key 等）。
    *   调用 Tavily API 获取原始天气数据。
    *   调用配置的 LLM API，让其根据 `WeatherPrompt` 模板和 Tavily 数据生成总结性的天气信息。
    *   从 LLM 响应中提取 `[WeatherInfo:...]` 标记内的文本。
    *   将提取到的信息写入缓存文件 [`weather_cache.txt`](Plugin/WeatherReporter/weather_cache.txt)。
    *   将成功获取的信息（或在失败时尝试读取的缓存信息，或最终的错误信息）打印到标准输出。
3.  **更新占位符**: 插件管理器读取脚本的标准输出，并用该内容更新系统提示词中的 `{{VCPWeatherInfo}}` 占位符的值。

## 配置

此插件需要以下配置项，通常设置在**项目根目录**的 `config.env` 文件中：

*   `API_URL`: (必需) 用于天气信息总结的 LLM API 端点 URL。
*   `API_Key`: (必需) 用于 LLM API 的认证密钥。
*   `WeatherModel`: (必需) 用于天气总结的 LLM 模型名称。
*   `WeatherPrompt`: (必需) 用于指导 LLM 总结天气的提示模板。模板中可以使用以下变量：
    *   `{{Date}}`: 当前日期 (上海时区)。
    *   `{{VarCity}}`: 下面配置的目标城市。
    *   `{{TavilySearchResult}}`: 从 Tavily API 获取的原始天气搜索结果字符串（或错误信息）。
    *   **重要**: 提示应指导模型输出包含 `[WeatherInfo:...]` 标记的文本，插件会提取此标记内的内容。
*   `VarCity`: (必需) 需要获取天气预报的目标城市名称。
*   `TavilyKey`: (必需) 用于调用 Tavily API 获取原始天气数据的 API 密钥。
*   `WeatherModelMaxTokens`: (可选) 限制 LLM 输出的最大 token 数。

## 依赖

*   **Node.js**: 需要 Node.js 运行环境。
*   **npm 包**:
    *   `dotenv`: 用于加载 `.env` 配置文件。
    *   `node-fetch` (v3+): 用于进行 API 调用 (通过动态 `import()` 使用)。
    (可以通过 `npm install dotenv node-fetch` 安装)

## 缓存

*   **文件**: [`Plugin/WeatherReporter/weather_cache.txt`](Plugin/WeatherReporter/weather_cache.txt)
*   **内容**: 存储最后一次成功从 LLM 获取并提取的 `[WeatherInfo:...]` 中的天气文本。
*   **用途**: 在实时 API 调用失败时提供备用数据。

## 集成与使用

*   此插件设计为后台自动运行，用户或 AI 通常不直接与其交互。
*   AI 可以通过读取系统提示词中由 `{{VCPWeatherInfo}}` 占位符提供的最新天气信息来了解当前天气状况。