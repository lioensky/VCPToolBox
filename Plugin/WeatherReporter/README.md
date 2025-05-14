# WeatherReporter 插件 (天气预报员)

这是一个 `static` 类型的插件，其主要目的是定期获取指定城市的实时天气信息，并将这些信息提供给系统，以便在处理用户请求时通过系统提示词中的占位符注入。

## 功能

- 使用和风天气 API 获取实时天气和未来 7 日天气预报。
- 将获取到的天气信息缓存到 `weather_cache.txt` 文件中。
- 通过 `{{VCPWeatherInfo}}` 占位符在系统提示词中提供天气信息。

## 配置

请在主项目的 `config.env` 文件中配置以下变量：

- `VarCity`: 需要获取天气的城市名称。
- `WeatherKey`: 您的和风天气 API Key。
- `WeatherUrl`: 和风天气 API 的请求域名 (例如: `mu4ewr6k8g.re.qweatherapi.com`)。

## 更新频率

插件配置为每 2 小时自动更新一次天气信息。

## 缓存

天气信息会被缓存到 `weather_cache.txt` 文件中，以便在 API 请求失败时提供旧数据。
