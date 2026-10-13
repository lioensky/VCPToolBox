const fs = require('fs').promises;
const path = require('path');

const SCHEDULE_FILE = path.join(__dirname, 'schedules.json');

async function readSchedules() {
    try {
        const data = await fs.readFile(SCHEDULE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeSchedules(schedules) {
    await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

async function handleRequest(request) {
    const { command } = request;
    let schedules = await readSchedules();

    switch (command) {
        case 'AddSchedule':
            // 时间格式校验 (简单校验 YYYY-MM-DD HH:mm 或类似格式)
            if (!request.time || !/^\d{4}-\d{1,2}-\d{1,2}/.test(request.time)) {
                return { status: 'error', error: `无效的时间格式: ${request.time}。请使用 YYYY-MM-DD HH:mm 格式。` };
            }

            const newSchedule = {
                id: Date.now().toString(),
                time: request.time,
                content: request.content || request.text || request.title || request.event
            };
            schedules.push(newSchedule);
            
            // 自动排序：按时间升序排列
            schedules.sort((a, b) => new Date(a.time) - new Date(b.time));
            
            await writeSchedules(schedules);
            return { status: 'success', result: `日程已添加。ID: ${newSchedule.id}` };

        case 'DeleteSchedule':
            const initialLength = schedules.length;
            schedules = schedules.filter(s => s.id !== request.id);
            if (schedules.length === initialLength) {
                return { status: 'error', error: `未找到 ID 为 ${request.id} 的日程。` };
            }
            await writeSchedules(schedules);
            return { status: 'success', result: `日程 ${request.id} 已删除。` };

        case 'ListSchedules':
            if (schedules.length === 0) {
                return { status: 'success', result: '当前没有日程。' };
            }
            const list = schedules.map(s => `[${s.id}] ${s.time}: ${s.content}`).join('\n');
            return { status: 'success', result: `当前日程列表：\n${list}` };

        default:
            return { status: 'error', error: `未知命令: ${command}` };
    }
}

async function main() {
    try {
        let inputData = '';
        process.stdin.on('data', (chunk) => {
            inputData += chunk;
        });

        process.stdin.on('end', async () => {
            try {
                if (!inputData.trim()) {
                    console.log(JSON.stringify({ status: 'error', error: '无输入数据' }));
                    process.exit(0);
                }
                const request = JSON.parse(inputData);
                const response = await handleRequest(request);
                console.log(JSON.stringify(response));
            } catch (e) {
                console.log(JSON.stringify({ status: 'error', error: `解析输入失败: ${e.message}` }));
            }
            process.exit(0);
        });
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: error.message }));
        process.exit(1);
    }
}

main();