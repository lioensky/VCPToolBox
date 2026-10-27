# WeatherReporter 天气预报员

定期获取天气、空气质量和预报，通过 `{{VCPWeatherInfo}}` 注入提示词，并提供管理面板使用的天气缓存。

## 数据源与配置

配置可放在根目录或插件目录的 `config.env` 中。插件目录配置由插件管理器优先传入。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `VarCity` | 必填 | 查询城市，例如 `惠城`、`北京`；已有城市缓存中的 `Huicheng` 会转换成 `惠城` |
| `WeatherProvider` | `auto` | `auto`、`uapi` 或 `qweather` |
| `WeatherKey` | 和风天气需要 | 和风天气 API Key |
| `WeatherUrl` | 和风天气需要 | 和风控制台“设置”中的账号专属 API Host，例如 `xxxxxxxx.xy.qweatherapi.com` |
| `forecastDays` | `7` | 预报展示天数；UAPI 最多 7 天，和风天气最多 15 天 |
| `hourlyForecastInterval` | `2` | 逐小时预报展示间隔，单位小时 |
| `hourlyForecastCount` | `12` | 逐小时预报最多展示条数 |

`auto` 优先使用已配置的和风天气专属 Host，失败后尝试 UAPI。缺少和风配置或仍使用 `devapi.qweather.com` 等旧公共域名时，直接使用 UAPI。`uapi` 固定使用免 Key 接口；`qweather` 固定使用和风天气，配置错误时会输出修正提示。

### UAPI

接口：`https://uapis.cn/api/v1/misc/weather`。每次刷新使用一条请求，参数为 `city`、`extended=true`、`forecast=true`、`hourly=true`、`lang=zh`。截至 2026-10-27，本机实测无需 Key，惠城可返回实时天气、空气质量、7 日及逐小时预报。服务可用性、调用限制和字段以提供方当前规则为准。

响应会转换为现有的 `now`、`hourly`、`daily`、`warning` 等字段，供现有消费者读取。记录来源、查询城市、获取时间 `lastUpdate` 和观测时间 `sourceUpdatedAt`。服务返回的无时区时间按北京时间解析。

提供方返回 `alerts` 时转换为预警列表；省略该字段时保留“预警信息未知”状态。月相与太阳角度在和风天气成功返回时展示。

## 刷新与缓存

默认每小时刷新一次。每个 HTTP 请求通过 `AbortSignal` 限制为 10 秒，和风天气的独立数据请求并行执行。

- `city_cache.txt`：城市 ID、经纬度和名称缓存。
- `weather_cache.json`：统一数据缓存。检查获取时间、观测时间、预报有效时段及预警有效期。
- `weather_cache.txt`：便于阅读的天气报告；失败回退从 JSON 重新生成。

缓存有效期为 3 小时。回退时每个折叠层级都会标明来源、时间和刷新失败状态。过期、缺失有效时间、城市或指定数据源不匹配时，输出天气暂不可用状态，替换提示词中的上一份天气。

预警会过滤已结束、取消、解除、尚未开始或时间无效的条目。缺少结束时间的预警最多保留到发布后 24 小时。实时简报和管理面板接口使用同一套有效期规则；管理接口遇到过期数据返回 HTTP 503。

## 验证

```powershell
node --test Plugin/WeatherReporter/weather-reporter.test.js
node Plugin/WeatherReporter/weather-reporter.js
```

运行主程序会刷新两个天气缓存文件。排查时先备份需要保留的旧缓存。
