const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const SERVER_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js');
const BACKUP_SCHEMA_PLAIN = 'centsible-backup-v3';
const BACKUP_SCHEMA_ENCRYPTED = 'centsible-backup-v3-encrypted';
const BACKUP_CIPHER = 'aes-256-gcm';
const BACKUP_PREVIEW_AAD_MODE = 'preview-v1';

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => {
            const address = socket.address();
            socket.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

async function waitForServer(baseUrl, child, logs) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming ready.\nSTDOUT:\n${logs.stdout}\nSTDERR:\n${logs.stderr}`);
        }
        try {
            const response = await fetch(`${baseUrl}/settings`, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return;
        } catch (_) { }
        await delay(250);
    }
    throw new Error(`Server did not become ready.\nSTDOUT:\n${logs.stdout}\nSTDERR:\n${logs.stderr}`);
}

async function stopServerProcess(child) {
    if (child.exitCode !== null) return;
    child.kill('SIGINT');
    const exitPromise = once(child, 'exit').catch(() => []);
    const timeoutReached = await Promise.race([
        exitPromise.then(() => false),
        delay(5000).then(() => true)
    ]);
    if (timeoutReached && child.exitCode === null) {
        child.kill('SIGKILL');
        await exitPromise;
    }
}

async function startServer(t, options = {}) {
    const port = options.port || await getFreePort();
    const projectRoot = options.projectRoot || null;
    const dataDir = options.dataDir || (projectRoot
        ? path.join(projectRoot, 'data')
        : await fs.mkdtemp(path.join(os.tmpdir(), 'centsible-regression-')));
    const cleanupDataDir = options.cleanupDataDir !== false;
    const autoStop = options.autoStop !== false;
    await fs.mkdir(dataDir, { recursive: true });

    const childEnv = {
        ...process.env,
        PORT: String(port),
        CENTSIBLE_DISABLE_STARTUP_NETWORK: '1',
        CENTSIBLE_DISABLE_SCHEDULED_JOBS: '1',
        ...options.env
    };
    if (projectRoot) {
        childEnv.CENTSIBLE_PROJECT_ROOT = projectRoot;
    }
    if (!options.omitDataDirEnv) {
        childEnv.DATA_DIR = dataDir;
    } else {
        delete childEnv.DATA_DIR;
    }

    const logs = { stdout: '', stderr: '' };
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: SERVER_DIR,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
        logs.stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        logs.stderr += chunk.toString();
    });

    const baseUrl = `http://127.0.0.1:${port}/api`;
    try { await waitForServer(baseUrl, child, logs); } catch (error) { child.kill('SIGKILL'); throw error; }

    const server = {
        port,
        dataDir,
        baseUrl,
        logs,
        async request(apiPath, init = {}) {
            const response = await fetch(`${baseUrl}${apiPath}`, { ...init, signal: AbortSignal.timeout(10000) }).catch(error => { throw new Error(`${init.method || 'GET'} ${apiPath}: ${error.message}\n${logs.stderr}`); });
            const text = await response.text();
            let json = null;
            if (text) {
                try {
                    json = JSON.parse(text);
                } catch (_) {
                    json = text;
                }
            }
            return {
                status: response.status,
                ok: response.ok,
                json,
                text
            };
        },
        async get(apiPath) {
            return this.request(apiPath);
        },
        async post(apiPath, body) {
            return this.request(apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        },
        async patch(apiPath, body) {
            return this.request(apiPath, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        },
        async stop() {
            await stopServerProcess(child);
            if (cleanupDataDir) {
                await fs.rm(dataDir, { recursive: true, force: true });
            }
        }
    };

    if (autoStop) {
        t.after(async () => {
            await server.stop();
        });
    }

    return server;
}

function summarizeItemsSnapshot(items) {
    const normalizedItems = Array.isArray(items) ? items : [];
    return {
        itemCount: normalizedItems.length,
        purchasedCount: normalizedItems.filter(item => Boolean(item && item.purchased)).length,
        listCount: new Set(normalizedItems.map(item => String((item && item.listId) || 'default'))).size || 1,
        rangeStart: null,
        rangeEnd: null
    };
}

async function deriveBackupKey(password, saltBase64) {
    const saltBuffer = Buffer.from(String(saltBase64 || '').trim(), 'base64');
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, saltBuffer, 32, (error, key) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(key);
        });
    });
}

async function encryptBackupSnapshot(snapshot, password) {
    const salt = crypto.randomBytes(16).toString('base64');
    const iv = crypto.randomBytes(12);
    const preview = {
        ...summarizeItemsSnapshot(snapshot.items),
        auditCount: Array.isArray(snapshot.audit) ? snapshot.audit.length : 0,
        diagnosticsCount: Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics.length : 0,
        includesHistory: Array.isArray(snapshot.items)
            ? snapshot.items.some(item => Array.isArray(item && item.history) && item.history.length > 0)
            : false,
        includesWebhookSettings: Boolean(
            snapshot
            && snapshot.settings
            && (snapshot.settings.discordWebhook || snapshot.settings.telegramWebhook || snapshot.settings.telegramChatId)
        )
    };
    const keyBuffer = await deriveBackupKey(password, salt);
    const aad = Buffer.from(JSON.stringify(preview), 'utf8');
    const cipher = crypto.createCipheriv(BACKUP_CIPHER, keyBuffer, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(snapshot), 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return {
        schema: BACKUP_SCHEMA_ENCRYPTED,
        createdAt: snapshot.createdAt,
        encrypted: true,
        preview,
        encryption: {
            algorithm: BACKUP_CIPHER,
            kdf: 'scrypt',
            aad: BACKUP_PREVIEW_AAD_MODE,
            salt,
            iv: iv.toString('base64'),
            tag: tag.toString('base64')
        },
        ciphertext: ciphertext.toString('base64')
    };
}

async function buildBackupSnapshotTemplate(server, items) {
    const settingsResponse = await server.get('/settings');
    assert.equal(settingsResponse.status, 200);
    const settings = settingsResponse.json;
    return {
        schema: BACKUP_SCHEMA_PLAIN,
        createdAt: new Date().toISOString(),
        items,
        settings: {
            discordWebhook: '',
            telegramWebhook: '',
            telegramChatId: '',
            lists: settings.lists,
            alertRules: settings.alertRules,
            checkIntervalMs: settings.checkIntervalMs,
            checkIntervalPreset: settings.checkIntervalPreset
        },
        diagnostics: [],
        audit: []
    };
}

async function getCurrentRevision(server) {
    const itemsResponse = await server.get('/items');
    assert.equal(itemsResponse.status, 200);
    return Number(itemsResponse.json.revision || 0);
}

test('imports encrypted backups into a fresh install without requiring current backup configuration', async (t) => {
    const source = await startServer(t);
    const target = await startServer(t);

    const sourceSettings = await source.get('/settings');
    assert.equal(sourceSettings.status, 200);
    const saveSettings = await source.post('/settings', {
        revision: sourceSettings.json.revision,
        backupPassword: 'phase3pass123'
    });
    assert.equal(saveSettings.status, 200);

    const createItem = await source.post('/items/create', {
        revision: await getCurrentRevision(source),
        item: {
            name: 'Phase 3 Source Item',
            url: 'https://example.com/source-item',
            listId: 'default'
        }
    });
    assert.equal(createItem.status, 200);

    const exported = await source.post('/backups/export', {});
    assert.equal(exported.status, 200);
    assert.equal(exported.json.backup.encrypted, true);

    const imported = await target.post('/backups/import', {
        backup: exported.json.backup,
        password: 'phase3pass123'
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));

    const itemsResponse = await target.get('/items');
    assert.equal(itemsResponse.status, 200);
    assert(itemsResponse.json.items.some(item => item.name === 'Phase 3 Source Item'));

    const settingsResponse = await target.get('/settings');
    assert.equal(settingsResponse.status, 200);
    assert.equal(settingsResponse.json.backupPasswordConfigured, false);
});

test('restores from a server backup file and creates an encrypted safety backup for existing state', async (t) => {
    const source = await startServer(t);
    const target = await startServer(t);

    const sourceSettings = await source.get('/settings');
    assert.equal(sourceSettings.status, 200);
    assert.equal((await source.post('/settings', {
        revision: sourceSettings.json.revision,
        backupPassword: 'restorepass123'
    })).status, 200);
    assert.equal((await source.post('/items/create', {
        revision: await getCurrentRevision(source),
        item: {
            name: 'Restore Source Item',
            url: 'https://example.com/restore-source',
            listId: 'default'
        }
    })).status, 200);

    const exported = await source.post('/backups/export', {});
    assert.equal(exported.status, 200);

    assert.equal((await target.post('/items/create', {
        revision: await getCurrentRevision(target),
        item: {
            name: 'Existing Local Item',
            url: 'https://example.com/existing-local',
            listId: 'default'
        }
    })).status, 200);

    const backupDir = path.join(target.dataDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(
        path.join(backupDir, 'fixture-backup.json'),
        JSON.stringify(exported.json.backup, null, 2),
        'utf8'
    );

    const restored = await target.post('/backups/restore', {
        filename: 'fixture-backup.json',
        password: 'restorepass123'
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));

    const itemsResponse = await target.get('/items');
    assert.equal(itemsResponse.status, 200);
    assert(itemsResponse.json.items.some(item => item.name === 'Restore Source Item'));
    assert(!itemsResponse.json.items.some(item => item.name === 'Existing Local Item'));

    const backupFiles = await fs.readdir(backupDir);
    const safetyBackups = backupFiles.filter(name => name.startsWith('manual-pre-restore-') && name.endsWith('.json'));
    assert(safetyBackups.length >= 1);

    const safetyBackupPayload = JSON.parse(await fs.readFile(path.join(backupDir, safetyBackups[0]), 'utf8'));
    assert.equal(safetyBackupPayload.encrypted, true);
});

test('rejects unsupported plaintext backups and encrypted backups with duplicate tracked URLs', async (t) => {
    const server = await startServer(t);

    const plainSnapshot = await buildBackupSnapshotTemplate(server, []);
    const plainImport = await server.post('/backups/import', {
        backup: plainSnapshot,
        password: 'ignored'
    });
    assert.equal(plainImport.status, 400);
    assert.match(String(plainImport.json.error || ''), /Only encrypted backups are supported/i);

    const duplicateSnapshot = await buildBackupSnapshotTemplate(server, [{
        id: 'duplicate-a',
        name: 'Duplicate A',
        url: 'https://example.com/product?utm_source=one',
        listId: 'default',
        history: []
    }, {
        id: 'duplicate-b',
        name: 'Duplicate B',
        url: 'https://example.com/product?utm_source=two',
        listId: 'default',
        history: []
    }]);
    const encryptedDuplicateBackup = await encryptBackupSnapshot(duplicateSnapshot, 'duplicatepass123');
    const duplicateImport = await server.post('/backups/import', {
        backup: encryptedDuplicateBackup,
        password: 'duplicatepass123'
    });
    assert.equal(duplicateImport.status, 400);
    assert.match(String(duplicateImport.json.error || ''), /Duplicate tracked url/i);
});

test('rejects stale item revisions and duplicate canonical URLs without mutating saved state', async (t) => {
    const server = await startServer(t);

    const created = await server.post('/items/create', {
        revision: await getCurrentRevision(server),
        item: {
            name: 'Tracked Item',
            url: 'https://example.com/product?utm_source=first',
            listId: 'default'
        }
    });
    assert.equal(created.status, 200);
    const currentRevision = created.json.revision;
    const createdId = created.json.item.id;

    const duplicateCreate = await server.post('/items/create', {
        revision: currentRevision,
        item: {
            name: 'Tracked Item Duplicate',
            url: 'https://example.com/product?utm_source=second',
            listId: 'default'
        }
    });
    assert.equal(duplicateCreate.status, 400);
    assert.match(String(duplicateCreate.json.error || ''), /Duplicate tracked url|already tracked/i);

    const stalePatch = await server.patch(`/items/${createdId}`, {
        revision: 0,
        name: 'Stale Rename',
        url: 'https://example.com/product?utm_source=first'
    });
    assert.equal(stalePatch.status, 409);
    assert(Array.isArray(stalePatch.json.items));

    const itemsResponse = await server.get('/items');
    assert.equal(itemsResponse.status, 200);
    const currentItem = itemsResponse.json.items.find(item => item.id === createdId);
    assert(currentItem);
    assert.equal(currentItem.name, 'Tracked Item');
    assert.equal(itemsResponse.json.items.length, 1);
});

test('rejects stale settings, list, and alert-rule revisions without overwriting current config', async (t) => {
    const server = await startServer(t);

    const initialSettings = await server.get('/settings');
    assert.equal(initialSettings.status, 200);
    const initialRevision = initialSettings.json.revision;

    const firstSettingsSave = await server.post('/settings', {
        revision: initialRevision,
        checkIntervalMs: 30 * 60 * 1000,
        checkIntervalPreset: '30m'
    });
    assert.equal(firstSettingsSave.status, 200);

    const staleSettingsSave = await server.post('/settings', {
        revision: initialRevision,
        checkIntervalMs: 60 * 60 * 1000,
        checkIntervalPreset: '1h'
    });
    assert.equal(staleSettingsSave.status, 409);

    const reloadedSettings = await server.get('/settings');
    assert.equal(reloadedSettings.status, 200);
    assert.equal(reloadedSettings.json.checkIntervalMs, 30 * 60 * 1000);

    const listCreate = await server.post('/lists', {
        revision: reloadedSettings.json.revision,
        name: 'Pens'
    });
    assert.equal(listCreate.status, 200);
    const createdListId = listCreate.json.list.id;
    const staleListRevision = reloadedSettings.json.revision;

    const staleListRename = await server.patch(`/lists/${createdListId}`, {
        revision: staleListRevision,
        name: 'Pens Renamed'
    });
    assert.equal(staleListRename.status, 409);

    const listsResponse = await server.get('/lists');
    assert.equal(listsResponse.status, 200);
    assert(listsResponse.json.lists.some(list => list.id === createdListId && list.name === 'Pens'));

    const alertRulesResponse = await server.get('/alert-rules');
    assert.equal(alertRulesResponse.status, 200);
    const alertRevision = alertRulesResponse.json.revision;

    const firstAlertSave = await server.post('/alert-rules', {
        revision: alertRevision,
        staleHours: 5
    });
    assert.equal(firstAlertSave.status, 200);

    const staleAlertSave = await server.post('/alert-rules', {
        revision: alertRevision,
        staleHours: 12
    });
    assert.equal(staleAlertSave.status, 409);

    const finalAlertRules = await server.get('/alert-rules');
    assert.equal(finalAlertRules.status, 200);
    assert.equal(finalAlertRules.json.alertRules.staleHours, 5);
});

test('items payload exposes current settings revision after list changes', async (t) => {
    const server = await startServer(t);

    const initialItems = await server.get('/items');
    assert.equal(initialItems.status, 200);
    const initialSettingsRevision = Number(initialItems.json.settingsRevision);
    assert(Number.isFinite(initialSettingsRevision));

    const settingsResponse = await server.get('/settings');
    assert.equal(settingsResponse.status, 200);
    assert.equal(initialSettingsRevision, Number(settingsResponse.json.revision));

    const createdList = await server.post('/lists', {
        revision: settingsResponse.json.revision,
        name: 'Revision Sync List'
    });
    assert.equal(createdList.status, 200);

    const itemsAfterListCreate = await server.get('/items');
    assert.equal(itemsAfterListCreate.status, 200);
    assert.equal(Number(itemsAfterListCreate.json.settingsRevision), Number(createdList.json.revision));
    assert.notEqual(Number(itemsAfterListCreate.json.settingsRevision), initialSettingsRevision);
});

test('items and lists payloads expose a list-state token that changes for list metadata and item-count changes', async (t) => {
    const server = await startServer(t);

    const initialItems = await server.get('/items');
    assert.equal(initialItems.status, 200);
    const initialLists = await server.get('/lists');
    assert.equal(initialLists.status, 200);
    assert.equal(String(initialItems.json.listsStateToken || ''), String(initialLists.json.listsStateToken || ''));
    const initialToken = String(initialItems.json.listsStateToken || '');
    assert(initialToken);

    const createdItem = await server.post('/items/create', {
        revision: await getCurrentRevision(server),
        item: {
            name: 'List Token Item',
            url: 'https://example.com/list-token-item',
            listId: 'default'
        }
    });
    assert.equal(createdItem.status, 200);

    const itemsAfterCreate = await server.get('/items');
    assert.equal(itemsAfterCreate.status, 200);
    const afterCreateToken = String(itemsAfterCreate.json.listsStateToken || '');
    assert(afterCreateToken);
    assert.notEqual(afterCreateToken, initialToken);

    const settingsResponse = await server.get('/settings');
    assert.equal(settingsResponse.status, 200);
    const createdList = await server.post('/lists', {
        revision: settingsResponse.json.revision,
        name: 'List Token Group'
    });
    assert.equal(createdList.status, 200);

    const listsAfterListCreate = await server.get('/lists');
    assert.equal(listsAfterListCreate.status, 200);
    const afterListCreateToken = String(listsAfterListCreate.json.listsStateToken || '');
    assert(afterListCreateToken);
    assert.notEqual(afterListCreateToken, afterCreateToken);
});

test('SQLite state survives a full process restart', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centsible-restart-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const first = await startServer(t, { dataDir, cleanupDataDir: false, autoStop: false });
    const created = await first.post('/items/create', { revision: await getCurrentRevision(first), item: {
        name: 'Persistent Product', url: 'https://example.com/product', currentPrice: 100, currency: 'USD'
    } });
    assert.equal(created.status, 200);
    await first.stop();
    const second = await startServer(t, { dataDir, cleanupDataDir: false });
    const result = await second.get('/items');
    assert.equal(result.json.items[0].name, 'Persistent Product');
    assert.equal(result.json.items[0].currentPrice, 100);
});

test('import invalidates an in-flight background check before it can rewrite restored state', async (t) => {
    const server = await startServer(t, {
        env: {
            CENTSIBLE_TEST_FETCH_HTML: '<html><body><span>$20.00</span></body></html>',
            CENTSIBLE_TEST_FETCH_DELAY_MS: '600'
        }
    });

    const created = await server.post('/items/create', {
        revision: await getCurrentRevision(server),
        item: {
            name: 'Live Item',
            url: 'https://example.com/live-item',
            listId: 'default',
            currentPrice: 10,
            originalPrice: 10,
            currency: 'USD',
            history: [{ price: 10, date: new Date().toISOString() }]
        }
    });
    assert.equal(created.status, 200);
    const itemId = created.json.item.id;

    const snapshot = await buildBackupSnapshotTemplate(server, [{
        id: itemId,
        name: 'Restored Item',
        url: 'https://example.com/live-item',
        listId: 'default',
        currentPrice: 5,
        originalPrice: 5,
        currency: 'USD',
        history: [{ price: 5, date: new Date().toISOString() }]
    }]);
    const encryptedBackup = await encryptBackupSnapshot(snapshot, 'restorepass123');

    const triggered = await server.post('/check-now', {});
    assert.equal(triggered.status, 200);
    await delay(150);

    const imported = await server.post('/backups/import', {
        backup: encryptedBackup,
        password: 'restorepass123'
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));

    await delay(900);

    const itemsResponse = await server.get('/items');
    assert.equal(itemsResponse.status, 200);
    const restoredItem = itemsResponse.json.items.find(item => item.id === itemId);
    assert(restoredItem);
    assert.equal(restoredItem.name, 'Restored Item');
    assert.equal(restoredItem.currentPrice, 5);
});

test('item patch is serialized with background check persistence', async (t) => {
    const server = await startServer(t, {
        env: {
            CENTSIBLE_TEST_FETCH_HTML: '<html><head><meta itemprop="priceCurrency" content="USD"><meta itemprop="price" content="15.00"></head></html>',
            CENTSIBLE_TEST_FETCH_DELAY_MS: '1200',
            CENTSIBLE_TEST_PATCH_DELAY_MS: '1500'
        }
    });

    const created = await server.post('/items/create', {
        revision: await getCurrentRevision(server),
        item: {
            name: 'Patch Target',
            url: 'https://example.com/patch-target',
            listId: 'default',
            currentPrice: 10,
            originalPrice: 10,
            currency: 'USD',
            history: [{ price: 10, date: new Date().toISOString() }]
        }
    });
    assert.equal(created.status, 200);
    const itemId = created.json.item.id;
    const revision = created.json.revision;

    const triggered = await server.post('/check-now', {});
    assert.equal(triggered.status, 200);
    await delay(50);

    const patched = await server.patch(`/items/${itemId}`, {
        revision,
        name: 'Patch Renamed',
        url: 'https://example.com/patch-target'
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));

    await delay(1400);

    const itemsResponse = await server.get('/items');
    assert.equal(itemsResponse.status, 200);
    const patchedItem = itemsResponse.json.items.find(item => item.id === itemId);
    assert(patchedItem);
    assert.equal(patchedItem.name, 'Patch Renamed');
    assert.equal(patchedItem.currentPrice, 15);
    assert.equal(patchedItem.lastCheckStatus, 'ok');
});

test('restore/import requires the current local backup password before protecting existing state', async (t) => {
    const sharedDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centsible-regression-shared-'));
    let firstServer = null;
    let secondServer = null;
    try {
        firstServer = await startServer(t, {
            dataDir: sharedDataDir,
            cleanupDataDir: false,
            autoStop: false
        });

        const settingsResponse = await firstServer.get('/settings');
        assert.equal(settingsResponse.status, 200);
        const saveSettings = await firstServer.post('/settings', {
            revision: settingsResponse.json.revision,
            backupPassword: 'localpass123'
        });
        assert.equal(saveSettings.status, 200);

        const createItem = await firstServer.post('/items/create', {
            revision: await getCurrentRevision(firstServer),
            item: {
                name: 'Existing Local Item',
                url: 'https://example.com/existing-local',
                listId: 'default'
            }
        });
        assert.equal(createItem.status, 200);

        await firstServer.stop();
        firstServer = null;

        secondServer = await startServer(t, {
            dataDir: sharedDataDir,
            cleanupDataDir: false,
            autoStop: false
        });

        const snapshot = await buildBackupSnapshotTemplate(secondServer, [{
            id: 'incoming-item',
            name: 'Incoming Item',
            url: 'https://example.com/incoming-item',
            listId: 'default',
            history: []
        }]);
        const encryptedBackup = await encryptBackupSnapshot(snapshot, 'incomingpass123');

        const imported = await secondServer.post('/backups/import', {
            backup: encryptedBackup,
            password: 'incomingpass123'
        });
        assert.equal(imported.status, 400);
        assert.match(String(imported.json.error || ''), /current backup password/i);

        const itemsResponse = await secondServer.get('/items');
        assert.equal(itemsResponse.status, 200);
        assert(itemsResponse.json.items.some(item => item.name === 'Existing Local Item'));
    } finally {
        if (secondServer) await secondServer.stop();
        if (firstServer) await firstServer.stop();
        await fs.rm(sharedDataDir, { recursive: true, force: true });
    }
});

test('backup listing marks corrupt files as non-restorable', async (t) => {
    const server = await startServer(t);
    const backupDir = path.join(server.dataDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'prices-corrupt.json'), '{not valid json', 'utf8');

    const backupsResponse = await server.get('/backups');
    assert.equal(backupsResponse.status, 200);
    const corruptBackup = backupsResponse.json.find(entry => entry.name === 'prices-corrupt.json');
    assert(corruptBackup);
    assert.equal(Boolean(corruptBackup.preview.corrupt), true);
    assert.equal(Boolean(corruptBackup.preview.unsupported), true);
});

test('manual checks persist alerts atomically and retry delivery after a restart', async (t) => {
    const http = require('node:http');
    let attempts = 0;
    const receiver = http.createServer((req, res) => {
        attempts++;
        req.resume();
        if (attempts === 1) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
            res.end(JSON.stringify({ retry_after: 1 }));
        } else { res.writeHead(204); res.end(); }
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => receiver.close(resolve)));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centsible-delivery-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const env = {
        DISCORD_WEBHOOK: `http://127.0.0.1:${receiver.address().port}/webhook`,
        TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
        CENTSIBLE_TEST_FETCH_HTML: '<meta itemprop="priceCurrency" content="USD"><meta itemprop="price" content="80">'
    };
    const first = await startServer(t, { dataDir, cleanupDataDir: false, env });
    const settings = await first.get('/settings');
    assert.equal((await first.post('/settings', { revision: settings.json.revision,
        alertRules: { priceDropEnabled: true, targetHitEnabled: false, allTimeLowEnabled: false, priceDrop24hEnabled: false }
    })).status, 200);
    const created = await first.post('/items/create', { revision: await getCurrentRevision(first), item: {
        name: 'Delivery fixture', url: 'https://example.com/product', currentPrice: 100, currency: 'USD',
        history: [{ price: 100, date: new Date().toISOString() }]
    } });
    assert.equal(created.status, 200);
    const checked = await first.post(`/items/${created.json.item.id}/check-result`, {
        revision: created.json.revision, expectedUrl: created.json.item.url, expectedSelector: null,
        extraction: { price: 80, currency: 'USD', confidence: 95, availability: { status: 'in_stock', confidence: 90 } }
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.json.item.currentPrice, 80);
    assert.equal((await first.get('/health')).json.pendingNotifications, 1);
    assert.equal(attempts, 0);
    await first.stop();
    const activeEnv = { ...env, CENTSIBLE_DISABLE_SCHEDULED_JOBS: '0' };
    const second = await startServer(t, { dataDir, cleanupDataDir: false, env: activeEnv });
    for (let i = 0; i < 30 && (await second.get('/health')).json.failedNotifications !== 1; i++) await delay(100);
    assert.equal((await second.get('/health')).json.failedNotifications, 1);
    await second.stop();
    await delay(1100);
    const third = await startServer(t, { dataDir, cleanupDataDir: false, env: activeEnv });
    for (let i = 0; i < 30 && (await third.get('/health')).json.pendingNotifications; i++) await delay(100);
    const health = (await third.get('/health')).json;
    assert.equal(health.pendingNotifications, 0);
    assert.equal(attempts, 2);
    assert.equal(health.deliveries[0].channels.discord.attempts, 2);
    assert(health.deliveries[0].channels.discord.deliveredAt);
    assert.equal((await third.get('/items')).json.items[0].currentPrice, 80);
});

test('rejected extraction leaves price/history untouched and manual refresh uses the shared rules', async t => {
    const server = await startServer(t);
    const created = await server.post('/items/create', { revision: await getCurrentRevision(server), item: {
        name: 'Trusted price', url: 'https://example.com/trusted', currentPrice: 1299, currency: 'EUR',
        history: [{ price: 1299, date: new Date().toISOString() }]
    } });
    const result = await server.post(`/items/${created.json.item.id}/check-result`, {
        revision: created.json.revision, expectedUrl: created.json.item.url,
        extraction: { price: 1.29, currency: 'EUR', confidence: 95 }
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.item.currentPrice, 1299);
    assert.equal(result.json.item.history.length, 1);
    assert.equal(result.json.item.lastCheckStatus, 'fail');
    assert.equal((await server.get('/diagnostics')).json.entries[0].ok, false);
    assert.equal((await server.get('/health')).json.failingItems, 1);
});

test('frontend individual refresh and health view work in Chromium', async t => {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    try { await fs.access(executablePath); } catch { t.skip('Chromium not installed'); return; }
    const server = await startServer(t, { env: { CENTSIBLE_TEST_FETCH_HTML: '<title>Fixture</title><meta itemprop="priceCurrency" content="USD"><meta itemprop="price" content="80.00">' } });
    const created = await server.post('/items/create', { revision: await getCurrentRevision(server), item: {
        name: 'UI fixture', url: 'https://93.184.216.34/product', currentPrice: 100, currency: 'USD'
    } });
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.baseUrl.replace('/api', ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.app && app.items.length === 1);
    await page.evaluate(async id => { await app.refreshItem(id); await app.renderHealthPanel(); }, created.json.item.id);
    assert.equal((await server.get('/items')).json.items[0].currentPrice, 80);
    assert.match(await page.$eval('#healthSummary', el => el.textContent), /queued alerts/);
    await page.evaluate(id => {
        app.showDoctorModal(id);
        app.setPriceOptions('doctor', {currencyOverride:'USD',priceLocale:'en-US'});
    }, created.json.item.id);
    await page.evaluate(() => app.updateDoctorSelector());
    const configured = (await server.get('/items')).json.items[0];
    assert.equal(configured.currencyOverride, 'USD');
    assert.equal(configured.priceLocale, 'en-US');
    await page.evaluate(async id => app.refreshItem(id), created.json.item.id);
    assert.equal((await server.get('/items')).json.items[0].lastCheckStatus, 'ok');
    await page.evaluate(id => app.showDoctorModal(id), created.json.item.id);
    await page.$eval('#doctorCurrencyOverride', el => el.closest('details').open = true);
    await delay(400);
    await page.screenshot({ path: path.join(os.tmpdir(), 'centsible-currency-review.png'), fullPage: true });
    await page.evaluate(() => app.closeDoctorModal());
    assert.deepEqual(errors, []);
    await page.evaluate(() => app.switchView('audit'));
    await page.screenshot({ path: path.join(os.tmpdir(), 'centsible-health-review.png'), fullPage: true });
});

test('currency settings survive restart and blocked checks preserve trusted history', async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'centsible-currency-'));
    t.after(() => fs.rm(dataDir,{recursive:true,force:true}));
    const server = await startServer(t,{dataDir,cleanupDataDir:false});
    const created = await server.post('/items/create',{revision:await getCurrentRevision(server),item:{
        name:'Lira fixture',url:'https://example.com/lira',currency:'TRY',currencyOverride:'TRY',priceLocale:'tr-TR',currentPrice:1299,
        history:[{price:1299,date:new Date().toISOString()}]
    }});
    assert.equal(created.status,200);
    const id = created.json.item.id;
    const changed = await fetch(`${server.baseUrl}/items/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:created.json.revision,currencyOverride:'EUR'})});
    assert.equal(changed.status,400);
    const stale = await server.post(`/items/${id}/check-result`,{revision:created.json.revision,expectedUrl:created.json.item.url,extraction:{price:100,currency:'TRY',confidence:95}});
    assert.equal(stale.status,409);
    const blocked = await server.post(`/items/${id}/check-result`,{revision:created.json.revision,expectedUrl:created.json.item.url,expectedCurrencyOverride:'TRY',expectedPriceLocale:'tr-TR',error:'Website requires human verification',errorCode:'challenge'});
    assert.equal(blocked.status,200);
    assert.equal(blocked.json.item.currentPrice,1299);
    assert.equal(blocked.json.item.history.length,1);
    assert.equal(blocked.json.item.lastCheckErrorCode,'challenge');
    assert.equal((await server.get('/health')).json.pendingNotifications,0);
    await server.stop();
    const restarted = await startServer(t,{dataDir,cleanupDataDir:false});
    const saved = (await restarted.get('/items')).json.items[0];
    assert.equal(saved.currencyOverride,'TRY');
    assert.equal(saved.priceLocale,'tr-TR');
    assert.equal(saved.currentPrice,1299);
});
