const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// One process owns the database. All multi-record changes use synchronous SQLite
// transactions; no asynchronous work or external delivery happens inside them.
class Store {
    constructor(root) {
        fs.mkdirSync(root, { recursive: true });
        const filename = path.join(root, 'centsible.sqlite');
        const fd = fs.openSync(filename, 'a', 0o600); fs.closeSync(fd);
        this.db = new DatabaseSync(filename, { timeout: 5000 });
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw new Error('Database was created by a newer Centsible version. Restore a matching backup before downgrading.');
        this.db.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, position INTEGER NOT NULL, value TEXT NOT NULL) STRICT;
            PRAGMA user_version=1;`);
        const check = this.db.prepare('PRAGMA quick_check').get();
        if (Object.values(check)[0] !== 'ok') throw new Error('Database integrity check failed. Restore a backup.');
    }
    get(key, fallback = null) {
        if (key === 'items') return this.db.prepare('SELECT value FROM items ORDER BY position').all().map(row => JSON.parse(row.value));
        const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : fallback;
    }
    set(key, value) {
        if (key === 'items') {
            const ids = new Set(value.map(item => item.id));
            for (const row of this.db.prepare('SELECT id FROM items').all()) {
                if (!ids.has(row.id)) this.db.prepare('DELETE FROM items WHERE id=?').run(row.id);
            }
            const put = this.db.prepare(`INSERT INTO items VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE
                SET position=excluded.position, value=excluded.value
                WHERE position != excluded.position OR value != excluded.value`);
            value.forEach((item, index) => put.run(item.id, index, JSON.stringify(item)));
        } else {
            this.db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
                .run(key, JSON.stringify(value));
        }
    }
    updateItem(item) {
        const result = this.db.prepare('UPDATE items SET value=? WHERE id=?').run(JSON.stringify(item), item.id);
        if (result.changes !== 1) throw new Error('Item no longer exists');
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    write(key, value) { return this.transaction(() => this.set(key, value)); }
    close() { this.db.close(); }
}
module.exports = { Store };
