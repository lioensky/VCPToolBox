[根目录](../../../CLAUDE.md) > [Plugin](../) > **WeatherReporter**

# WeatherReporter 插件

## 面包屑导航
[根目录](../../../CLAUDE.md) > [Plugin](../) > **WeatherReporter**

## 模块职责

WeatherReporter（天气预报员）是一个静态插件，用于提供实时的天气信息，并将其集成到系统提示词的 `{{VCPWeatherInfo}}` 占位符中。它会定期获取天气数据并缓存，确保AI在回复时能够引用当前的天气情况。

## 入口与启动

- **入口文件**: `weather-reporter.js`
- **启动命令**: `node weather-reporter.js`
- **插件类型**: 静态插件
- **通信协议**: stdio
- **刷新间隔**: 每8小时执行一次 (Cron: `0 */8 * * *`)

## 对外接口

### 系统提示词占位符
- **{{VCPWeatherInfo}}**: 当前的实时天气信息
  - 此占位符会被自动注入到系统提示词中，为AI提供上下文相关的天气信息

## 关键依赖与配置

### 配置文件
- **主配置**: `config.env.example` (需要复制为`config.env`并填写实际值)
- **插件清单**: `plugin-manifest.json`

### 必需配置项
```env
VarCity=城市名称 (例如: Beijing)
WeatherKey=和风天气API密钥
WeatherUrl=和风天气API地址 (例如: devapi.qweather.com)
```

### 可选配置项
```json
{
  "forecastDays": 7,           // 获取未来天气预报的天数 (范围: 1-30)
  "hourlyForecastInterval": 2,  // 24小时天气预报的显示间隔（小时）
  "hourlyForecastCount": 12     // 24小时天气预报总共显示的条目数
}
```

### 外部服务依赖
- **和风天气API**: 用于获取天气数据
  - 注册地址: https://console.qweather.com/

## 数据模型

### 缓存文件
- `city_cache.txt`: 城市信息缓存
- `weather_cache.txt`: 天气数据缓存
- `weather_cache.json`: JSON格式的天气数据缓存

### 天气数据结构
天气数据包含以下信息：
- 当前天气状况（温度、湿度、风力等）
- 未来几天的天气预报
- 24小时天气预报（可选）

## 测试与质量

### 测试文件
目前未发现专门的测试文件，建议添加：
- `test_weather_reporter.js` - 天气获取功能测试

### 质量工具
- 暂无发现代码质量工具配置

## 常见问题 (FAQ)

1. **如何获取和风天气API密钥？**
   - 访问 https://console.qweather.com/ 注册账号并获取API密钥

2. **插件多久更新一次天气数据？**
   - 默认每8小时自动更新一次，可通过修改plugin-manifest.json中的refreshIntervalCron调整

3. **天气数据不准确怎么办？**
   - 检查VarCity配置是否正确
   - 确认WeatherKey和WeatherUrl配置有效
   - 查看服务器日志获取错误信息

4. **如何更改预报天数？**
   - 修改config.env中的forecastDays配置项

## 相关文件清单

```
Plugin/WeatherReporter/
├── weather-reporter.js        # 主入口文件
├── plugin-manifest.json      # 插件清单
├── config.env.example        # 配置文件模板
├── city_cache.txt            # 城市信息缓存
├── weather_cache.txt         # 天气数据缓存
└── weather_cache.json        # JSON格式天气缓存
```

## 变更记录 (Changelog)

### 2025-09-30 20:07:41 - AI上下文初始化
- 创建WeatherReporter插件文档
- 添加导航面包屑
- 完善插件功能和配置说明