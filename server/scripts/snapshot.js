// Online, consistent SQLite snapshot for upgrades. Includes credentials; keep
// this local recovery copy private. Portable UI exports remain encrypted.
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
    const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
    const directory = path.join(root, 'upgrade-snapshots');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `before-update-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    const db = new DatabaseSync(path.join(root, 'centsible.sqlite'), { readOnly: true });
    try {
        // Reserve with restrictive permissions before SQLite writes data.
        await fs.writeFile(filename, '', { mode: 0o600, flag: 'wx' });
        await backup(db, filename);
        console.log(filename);
    } finally { db.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
