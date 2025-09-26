const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const config = require('./config'); // 引入配置文件

class DatabaseManager {
    constructor() {
        this.db = null;
    }

    async init() {
        this.db = await open({
            filename: config.DB_FILE, // 使用配置
            driver: sqlite3.Database
        });

        console.log('[DatabaseManager] Connected to SQLite database.');

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                members TEXT,
                roles TEXT,
                goal TEXT,
                mode TEXT,
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS chat_history (
                id TEXT PRIMARY KEY,
                group_id TEXT,
                from_agent TEXT,
                content TEXT,
                to_agent TEXT,
                is_tool_response INTEGER,
                timestamp TEXT,
                FOREIGN KEY(group_id) REFERENCES groups(id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                group_id TEXT,
                description TEXT,
                status TEXT,
                result TEXT,
                created_at TEXT,
                FOREIGN KEY(group_id) REFERENCES groups(id)
            );
        `);
        console.log('[DatabaseManager] Tables ensured.');
    }

    async close() {
        if (this.db) {
            await this.db.close();
            console.log('[DatabaseManager] Database connection closed.');
        }
    }

    async createGroup({ id, name, members, roles, goal, mode, created_at }) {
        const membersJson = JSON.stringify(members);
        const rolesJson = JSON.stringify(roles);
        const sql = `INSERT INTO groups (id, name, members, roles, goal, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        return this.db.run(sql, id, name, membersJson, rolesJson, goal, mode, created_at);
    }

    async getGroup(groupId) {
        const row = await this.db.get('SELECT * FROM groups WHERE id = ?', groupId);
        if (!row) return null;
        return {
            ...row,
            members: JSON.parse(row.members),
            roles: JSON.parse(row.roles)
        };
    }
    
    async getAllGroups() {
        const rows = await this.db.all('SELECT * FROM groups');
        return rows.map(row => ({
            ...row,
            members: JSON.parse(row.members),
            roles: JSON.parse(row.roles)
        }));
    }

    async logMessage({ id, group_id, from_agent, content, to_agent, is_tool_response, timestamp }) {
        const sql = `INSERT INTO chat_history (id, group_id, from_agent, content, to_agent, is_tool_response, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        return this.db.run(sql, id, group_id, from_agent, content, to_agent, is_tool_response ? 1 : 0, timestamp);
    }

    async getHistory(groupId, limit = 50) {
        const sql = `SELECT * FROM chat_history WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?`;
        const rows = await this.db.all(sql, groupId, limit);
        return rows.reverse(); // To maintain chronological order
    }

    // ... 其他 Task 相关的 CRUD 方法 ...
}

module.exports = DatabaseManager;