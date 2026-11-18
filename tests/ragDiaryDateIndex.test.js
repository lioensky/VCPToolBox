'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

const TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';

function host(rows) {
    const instance = Object.create(rag);
    let calls = 0;
    instance.vectorDBManager = {
        async getDiaryDateIndex() {
            calls += 1;
            return rows.map(row => ({ ...row }));
        }
    };
    return { instance, calls: () => calls };
}

test('diary date index keeps the day start of every date in the configured timezone', async () => {
    const dates = [
        '2025-01-01', '2025-03-09', '2025-03-30', '2025-11-02',
        '2024-02-29', '2025-02-30', '2025-12-31', '2025-03-09'
    ];
    const rows = dates.map((date, index) => ({ relativePath: `Diary/${index}.txt`, date }));
    const { instance } = host(rows);

    for (let round = 0; round < 2; round += 1) {
        const metas = await instance._getDiaryDateIndexCached('Diary', { diaryDateIndex: new Map() });
        assert.equal(metas.length, rows.length);
        for (const meta of metas) {
            assert.ok(meta.diaryDate instanceof Date);
            assert.equal(
                meta.diaryDate.getTime(),
                dayjs.tz(meta.date, TIMEZONE).startOf('day').toDate().getTime(),
                meta.date
            );
        }
        for (let index = 1; index < metas.length; index += 1) {
            assert.ok(new Date(metas[index - 1].date) >= new Date(metas[index].date));
        }
        const sameDay = metas.filter(meta => meta.date === '2025-03-09');
        assert.equal(sameDay.length, 2);
        assert.notEqual(sameDay[0].diaryDate, sameDay[1].diaryDate);
        sameDay[0].diaryDate.setFullYear(1999);
    }
});

test('time range filtering still selects by day start', async () => {
    const rows = ['2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04']
        .map(date => ({ relativePath: `Diary/${date}.txt`, date }));
    const { instance, calls } = host(rows);
    const requestCache = { diaryDateIndex: new Map() };
    const range = {
        start: dayjs.tz('2025-05-02', TIMEZONE).startOf('day').toDate(),
        end: dayjs.tz('2025-05-03', TIMEZONE).startOf('day').toDate()
    };
    const paths = await instance._getTimeRangeFilePaths('Diary', range, requestCache);
    assert.deepEqual(paths.sort(), ['Diary/2025-05-02.txt', 'Diary/2025-05-03.txt']);
    await instance._getTimeRangeFilePaths('Diary', range, requestCache);
    assert.equal(calls(), 1);
});
