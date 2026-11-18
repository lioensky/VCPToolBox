const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const SCHEDULE_FILE = path.join(__dirname, '..', '..', 'Plugin', 'ScheduleManager', 'schedules.json');

    router.get('/schedules', async (req, res) => {
        try {
            let schedules = [];
            try {
                const content = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(content);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            res.json(schedules);
        } catch (error) {
            console.error('[AdminAPI] Error getting schedules:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    router.post('/schedules', async (req, res) => {
        try {
            const { time, content } = req.body;
            if (!time || !content) return res.status(400).json({ error: 'Required fields missing' });
            let schedules = [];
            try {
                const fileContent = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(fileContent);
            } catch (e) { if (e.code !== 'ENOENT') throw e; }
            const newSchedule = { id: Date.now().toString(), time, content };
            schedules.push(newSchedule);
            schedules.sort((a, b) => new Date(a.time) - new Date(b.time));
            await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
            res.json({ status: 'success', schedule: newSchedule });
        } catch (error) {
            res.status(500).json({ error: 'Failed' });
        }
    });

    router.put('/schedules/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { time, content } = req.body;
            if (!time || !content) return res.status(400).json({ error: 'Required fields missing' });

            let schedules = [];
            try {
                const fileContent = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(fileContent);
            } catch (e) { if (e.code !== 'ENOENT') throw e; }

            const scheduleIndex = schedules.findIndex(s => s.id === id);
            if (scheduleIndex === -1) {
                return res.status(404).json({ error: 'Schedule not found' });
            }

            schedules[scheduleIndex] = {
                ...schedules[scheduleIndex],
                time,
                content
            };
            schedules.sort((a, b) => new Date(a.time) - new Date(b.time));

            await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
            res.json({ status: 'success', schedule: schedules.find(s => s.id === id) });
        } catch (error) {
            console.error('[AdminAPI] Error updating schedule:', error);
            res.status(500).json({ error: 'Failed' });
        }
    });

    router.delete('/schedules/:id', async (req, res) => {
        try {
            const { id } = req.params;
            let schedules = [];
            try {
                const fileContent = await fs.readFile(SCHEDULE_FILE, 'utf-8');
                schedules = JSON.parse(fileContent);
            } catch (e) { if (e.code !== 'ENOENT') throw e; }
            const initialLength = schedules.length;
            schedules = schedules.filter(s => s.id !== id);
            if (schedules.length === initialLength) {
                return res.status(404).json({ error: 'Schedule not found' });
            }
            await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
            res.json({ status: 'success' });
        } catch (error) {
            res.status(500).json({ error: 'Failed' });
        }
    });

    return router;
};
