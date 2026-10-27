'use strict';

// Minimal extensions used by README and tests/slots.test.cjs. Register them from your own plugin with
// pluginManager.getServiceModule('VTrade').register(...) or pass the same objects to register() below.

// 1. A market source: reads CSV files (date,open,high,low,close,volume; prices in yuan, volume in shares)
//    from the administrator's directory. Configure it in the sources file with "kind": "example-csv".
const csvSource = {
    description: '示例：读取管理员目录下的 CSV 日线（元、股），不复权。',
    validate(config) {
        if (!Array.isArray(config.securities) || !config.securities.every(s => /^[A-Za-z0-9._-]+\.csv$/.test(s.file || ''))) {
            throw new Error('example-csv needs securities: [{ symbol, name, file: "X.csv" }]');
        }
    },
    async load({ name, config, readFile }) {
        const cents = text => Math.round(Number(text) * 100);
        const securities = [];
        for (const item of config.securities) {
            const [, ...lines] = (await readFile(item.file)).toString('utf8').trim().split(/\r?\n/);
            securities.push({ symbol: item.symbol, name: item.name, bars: lines.map(line => {
                const [date, open, high, low, close, volume] = line.split(',');
                return { date, openCents: cents(open), highCents: cents(high), lowCents: cents(low),
                    closeCents: cents(close), volume: Number(volume) };
            }) });
        }
        return { schemaVersion: 1, source: { kind: 'example-csv', name, adjustment: 'none', currency: 'CNY',
            timezone: 'Asia/Shanghai', volumeUnit: 'shares' }, securities };
    },
};

// 2. A signal: close above the highest high of the previous N days (a textbook channel breakout).
//    bars already stop at the simulation date, so the signal cannot see the future.
const breakout = {
    type: 'signal',
    description: '示例：收盘价突破前 N 日最高价记 buy。教科书示例，不是选股建议。',
    parameters: { days: '回看天数，默认 20' },
    compute({ bars, options }) {
        const days = options.days ?? 20, signals = [];
        for (let i = days; i < bars.length; i++) {
            const high = Math.max(...bars.slice(i - days, i).map(b => b.highCents));
            if (bars[i].closeCents > high) signals.push({ date: bars[i].date, action: 'buy', note: `突破前 ${days} 日最高价` });
        }
        return { signals };
    },
};

function register({ register: add }) {
    const disposers = [add('market', 'example-csv', csvSource), add('analysis', 'example-breakout', breakout)];
    return () => disposers.forEach(dispose => dispose());
}
module.exports = { csvSource, breakout, register };
