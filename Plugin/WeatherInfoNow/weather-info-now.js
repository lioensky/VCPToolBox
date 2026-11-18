const fs = require('fs').promises;
const path = require('path');
const { getFreshWeather } = require('../WeatherReporter/weather-data');

const WEATHER_REPORTER_JSON_CACHE = path.join(__dirname, '../WeatherReporter/weather_cache.json');

async function main() {
    try {
        const data = await fs.readFile(WEATHER_REPORTER_JSON_CACHE, 'utf-8');
        const weatherData = getFreshWeather(JSON.parse(data));

        if (!weatherData || !weatherData.hourly || weatherData.hourly.length === 0) {
            process.stdout.write('[实时天气信息暂不可用]');
            return;
        }

        // 寻找与当前时间最接近的小时预报
        const currentTime = new Date();
        let now = weatherData.now || weatherData.hourly[0];
        let minDiff = weatherData.now ? Math.abs(currentTime - new Date(weatherData.now.obsTime)) : Infinity;

        for (const hour of weatherData.hourly) {
            const fxTime = new Date(hour.fxTime);
            const diff = Math.abs(currentTime - fxTime);
            if (diff < minDiff) {
                minDiff = diff;
                now = hour;
            }
        }

        const air = weatherData.airQuality;
        
        let output = `【当前天气】${now.text}，温度 ${now.temp}℃`;
        
        if (now.windDir && now.windScale) {
            output += `，${now.windDir}${now.windScale}级`;
        }
        
        if (air && air.category) {
            output += `，空气质量：${air.category}(${air.aqi})`;
        }

        if (weatherData.warning && weatherData.warning.length > 0) {
            let warningDetail = '\n【天气预警详情】';
            weatherData.warning.forEach(w => {
                warningDetail += `\n- ${w.title}: ${w.text}`;
            });
            output += warningDetail;
        }

        output += `\n数据更新时间: ${new Date(weatherData.sourceUpdatedAt || weatherData.lastUpdate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        process.stdout.write(output);
    } catch (error) {
        if (error.code === 'ENOENT') {
            process.stdout.write('[等待 WeatherReporter 插件生成数据...]');
        } else {
            process.stdout.write(`[获取实时天气简报失败: ${error.message}]`);
        }
    }
}

main();