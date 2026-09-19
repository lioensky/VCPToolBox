#!/usr/bin/env node

const MAX_SLEEP_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function getArgument(args, ...names) {
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined) {
            return args[name];
        }
    }

    const normalizedNames = names.map(name => name.toLowerCase());
    for (const [key, value] of Object.entries(args)) {
        if (normalizedNames.includes(key.toLowerCase()) && value !== undefined) {
            return value;
        }
    }

    return undefined;
}

function parseSleepDuration(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('睡觉时间必须是有限数字。');
        return Math.round(value * 1000);
    }

    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('缺少必需参数：睡觉时间。');
    }

    const input = value.trim().toLowerCase();

    if (/^\d+(?:\.\d+)?$/.test(input)) {
        return Math.round(Number(input) * 1000);
    }

    const unitMatch = input.match(/^(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒|m|min|分钟|h|hr|小时)$/i);
    if (unitMatch) {
        const amount = Number(unitMatch[1]);
        const unit = unitMatch[2].toLowerCase();
        const multiplier = {
            ms: 1,
            毫秒: 1,
            s: 1000,
            秒: 1000,
            m: 60 * 1000,
            min: 60 * 1000,
            分钟: 60 * 1000,
            h: 60 * 60 * 1000,
            hr: 60 * 60 * 1000,
            小时: 60 * 60 * 1000
        }[unit];
        return Math.round(amount * multiplier);
    }

    const compoundMatch = input.match(/^(?:(\d+(?:\.\d+)?)\s*(?:小时|h|hr))?\s*(?:(\d+(?:\.\d+)?)\s*(?:分钟|min|m))?\s*(?:(\d+(?:\.\d+)?)\s*(?:秒|s))?$/i);
    if (compoundMatch && compoundMatch.slice(1).some(valuePart => valuePart !== undefined)) {
        const hours = Number(compoundMatch[1] || 0);
        const minutes = Number(compoundMatch[2] || 0);
        const seconds = Number(compoundMatch[3] || 0);
        return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }

    throw new Error('无法识别睡觉时间。请使用秒数或 30s、10m、2h、1小时30分钟 等格式。');
}

function resolveTimezone() {
    const timezone = String(process.env.DEFAULT_TIMEZONE || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(new Date());
        return timezone;
    } catch (_) {
        return DEFAULT_TIMEZONE;
    }
}

function formatWakeTime(date, timezone) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'longOffset'
    }).formatToParts(date);

    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const offset = values.timeZoneName || timezone;
    return {
        date: `${values.year}-${values.month}-${values.day}`,
        time: `${values.hour}:${values.minute}:${values.second}`,
        offset
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sendResponse(response) {
    process.stdout.write(JSON.stringify(response));
}

async function main(args) {
    const durationValue = getArgument(
        args,
        '睡觉时间',
        'sleepTime',
        'duration',
        'durationSeconds',
        'seconds'
    );
    const tipsValue = getArgument(
        args,
        '睡觉tips',
        '睡觉提示',
        'tips',
        'tip',
        'message'
    );

    const durationMs = parseSleepDuration(durationValue);
    if (durationMs <= 0) {
        throw new Error('睡觉时间必须大于 0。');
    }
    if (durationMs > MAX_SLEEP_MS) {
        throw new Error('单次睡觉时间不能超过 12 小时。');
    }

    const tips = tipsValue === undefined || tipsValue === null
        ? ''
        : String(tipsValue).trim();

    const timezone = resolveTimezone();
    const startedAt = new Date();

    await sleep(durationMs);

    const wokeAt = new Date();
    const localWakeTime = formatWakeTime(wokeAt, timezone);
    const tipsMessage = tips ? `睡前留下的小纸条：${tips}\n` : '';
    const message = `休息结束了。\n${tipsMessage}现在是 ${localWakeTime.date} ${localWakeTime.time}（${timezone}，${localWakeTime.offset}）。`;

    sendResponse({
        status: 'success',
        result: {
            content: [
                {
                    type: 'text',
                    text: message
                }
            ],
            details: {
                requestedDurationMs: durationMs,
                actualDurationMs: wokeAt.getTime() - startedAt.getTime(),
                tips,
                timezone,
                startedAt: startedAt.toISOString(),
                wokeAt: wokeAt.toISOString(),
                localWakeTime: `${localWakeTime.date} ${localWakeTime.time}`,
                utcOffset: localWakeTime.offset
            }
        }
    });
}

let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    inputData += chunk;
});
process.stdin.on('end', async () => {
    try {
        if (!inputData.trim()) {
            throw new Error('未从 stdin 接收到调用参数。');
        }
        const args = JSON.parse(inputData);
        await main(args);
    } catch (error) {
        sendResponse({
            status: 'error',
            error: `VCPSleep 插件错误：${error.message}`
        });
        process.exitCode = 1;
    }
});