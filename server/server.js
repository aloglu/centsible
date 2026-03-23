const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const notifier = require('node-notifier'); // Notifications

require('dotenv').config({ path: path.join(__dirname, '../.env') });

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = process.env.CENTSIBLE_PROJECT_ROOT
    ? path.resolve(process.env.CENTSIBLE_PROJECT_ROOT)
    : path.join(__dirname, '../');
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, 'data');
const DATA_ROOT = process.env.DATA_DIR
    ? path.resolve(PROJECT_ROOT, process.env.DATA_DIR)
    : DEFAULT_DATA_ROOT;
const DATA_FILE = path.join(DATA_ROOT, 'prices.json');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const DIAGNOSTICS_FILE = path.join(DATA_ROOT, 'diagnostics.json');
const AUDIT_FILE = path.join(DATA_ROOT, 'audit.json');
const BACKUP_DIR = path.join(DATA_ROOT, 'backups');
const TRANSACTION_JOURNAL_FILE = path.join(DATA_ROOT, '.state-transaction.json');
const LEGACY_TRANSACTION_JOURNAL_FILE = path.join(PROJECT_ROOT, '.state-transaction.json');
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BACKUP_PASSWORD_MIN_LENGTH = 8;
const BACKUP_SCHEMA_PLAIN = 'centsible-backup-v3';
const BACKUP_SCHEMA_ENCRYPTED = 'centsible-backup-v3-encrypted';
const BACKUP_CIPHER = 'aes-256-gcm';
const BACKUP_PREVIEW_AAD_MODE = 'preview-v1';
const BACKUP_PASSWORD_ENV = String(process.env.BACKUP_PASSWORD || '').trim();
const DISABLE_STARTUP_NETWORK = process.env.CENTSIBLE_DISABLE_STARTUP_NETWORK === '1';
const DISABLE_SCHEDULED_JOBS = process.env.CENTSIBLE_DISABLE_SCHEDULED_JOBS === '1';
const DISCORD_PROXY_BASE = (process.env.DISCORD_PROXY_BASE || '').trim();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => normalizeOrigin(origin))
    .filter(Boolean);
const hasExplicitCorsAllowlist = allowedOrigins.length > 0;
const FETCH_ALLOWED_HOSTS = (process.env.FETCH_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
const TEST_FETCH_DELAY_MS = Math.max(0, Number(process.env.CENTSIBLE_TEST_FETCH_DELAY_MS || 0) || 0);
const TEST_PATCH_DELAY_MS = Math.max(0, Number(process.env.CENTSIBLE_TEST_PATCH_DELAY_MS || 0) || 0);
const TEST_FAKE_FETCH_HTML = typeof process.env.CENTSIBLE_TEST_FETCH_HTML === 'string'
    ? process.env.CENTSIBLE_TEST_FETCH_HTML
    : '';

function normalizeOrigin(origin) {
    if (!origin) return '';
    try {
        return new URL(origin).origin.toLowerCase();
    } catch (_) {
        return String(origin).trim().replace(/\/+$/, '').toLowerCase();
    }
}

function shouldMigrateLegacyProjectRootData() {
    return path.resolve(DATA_ROOT) === path.resolve(DEFAULT_DATA_ROOT)
        && path.resolve(DATA_ROOT) !== path.resolve(PROJECT_ROOT);
}

async function shouldCopyLegacyFile(legacyPath, targetPath) {
    if (!fs.existsSync(legacyPath)) return false;
    if (!fs.existsSync(targetPath)) return true;
    const [legacyStat, targetStat] = await Promise.all([
        fsPromises.stat(legacyPath),
        fsPromises.stat(targetPath)
    ]);
    return legacyStat.mtimeMs > targetStat.mtimeMs;
}

async function migrateLegacyProjectRootData() {
    if (!shouldMigrateLegacyProjectRootData()) return;

    const fileMappings = [
        { legacyPath: path.join(PROJECT_ROOT, 'prices.json'), targetPath: DATA_FILE },
        { legacyPath: path.join(PROJECT_ROOT, 'settings.json'), targetPath: SETTINGS_FILE },
        { legacyPath: path.join(PROJECT_ROOT, 'diagnostics.json'), targetPath: DIAGNOSTICS_FILE },
        { legacyPath: path.join(PROJECT_ROOT, 'audit.json'), targetPath: AUDIT_FILE }
    ];

    await recoverPendingJsonFileTransaction(LEGACY_TRANSACTION_JOURNAL_FILE);
    await fsPromises.mkdir(DATA_ROOT, { recursive: true });

    for (const mapping of fileMappings) {
        if (!(await shouldCopyLegacyFile(mapping.legacyPath, mapping.targetPath))) continue;
        await fsPromises.mkdir(path.dirname(mapping.targetPath), { recursive: true });
        await fsPromises.copyFile(mapping.legacyPath, mapping.targetPath);
    }

    const legacyBackupDir = path.join(PROJECT_ROOT, 'backups');
    if (!fs.existsSync(legacyBackupDir)) return;

    await fsPromises.mkdir(BACKUP_DIR, { recursive: true });
    const legacyBackups = await fsPromises.readdir(legacyBackupDir, { withFileTypes: true });
    for (const entry of legacyBackups) {
        if (!entry.isFile()) continue;
        const legacyPath = path.join(legacyBackupDir, entry.name);
        const targetPath = path.join(BACKUP_DIR, entry.name);
        if (!(await shouldCopyLegacyFile(legacyPath, targetPath))) continue;
        await fsPromises.copyFile(legacyPath, targetPath);
    }
}

function resolveBrowserExecutablePath() {
    // Prefer explicit env override, then common Linux install paths.
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (_) { }
    }
    return undefined;
}

// Currencies support (relative to USD base, populated by live refresh)
let exchangeRates = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    TRY: 33.0,
    JPY: 150.0,
    CAD: 1.35,
    AUD: 1.5,
    CHF: 0.88,
    CNY: 7.2
};

const SUPPORTED_CURRENCIES = new Set([
    'USD', 'EUR', 'GBP', 'TRY', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY',
    'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON'
]);

// State
let items = [];
let itemsRevision = 0;
let settingsRevision = 0;
let stateMutationQueue = Promise.resolve();
let lastCheckTime = null;
let isChecking = false;
let checkingItemId = null;
let backgroundCheckRunCounter = 0;
let activeBackgroundCheckToken = 0;
let browserInstance = null; // Single persistent browser
let checkIntervalHandle = null;
let diagnostics = [];
let auditLog = [];
const DEFAULT_LISTS = [{ id: 'default', name: 'Default' }];
const DEFAULT_ALERT_RULES = {
    targetHitEnabled: true,
    priceDropEnabled: true,
    priceDrop24hEnabled: true,
    priceDrop24hPercent: 5,
    allTimeLowEnabled: true,
    lowConfidenceEnabled: true,
    lowConfidenceThreshold: 55,
    staleEnabled: true,
    staleHours: 12,
    notifyCooldownMinutes: 240
};
const alertCooldownByKey = new Map();
let settings = {
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    telegramWebhook: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    lists: [...DEFAULT_LISTS],
    alertRules: { ...DEFAULT_ALERT_RULES },
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    checkIntervalPreset: '1h',
    backupEncryption: null
};
let backupSession = {
    keyBuffer: null,
    salt: null,
    unlockedAt: null
};

// --- Settings Management ---
function createBackupKeyVerifier(keyBuffer, saltBase64) {
    const saltBuffer = Buffer.from(String(saltBase64 || '').trim(), 'base64');
    if (!saltBuffer.length) throw new Error('Backup salt is missing');
    return crypto
        .createHash('sha256')
        .update('centsible-backup-verifier', 'utf8')
        .update(saltBuffer)
        .update(Buffer.from(keyBuffer))
        .digest('base64');
}

function normalizeBackupEncryptionConfig(config) {
    if (!config || typeof config !== 'object') return null;
    const salt = String(config.salt || '').trim();
    const verifier = String(config.verifier || '').trim();
    const legacyKey = String(config.key || '').trim();
    if (!salt) return null;
    if (!verifier && !legacyKey) return null;
    const normalized = {
        salt,
        verifier,
        updatedAt: config.updatedAt || null
    };
    if (!normalized.verifier && legacyKey) {
        try {
            const legacyKeyBuffer = Buffer.from(legacyKey, 'base64');
            if (legacyKeyBuffer.length !== 32) return null;
            normalized.verifier = createBackupKeyVerifier(legacyKeyBuffer, salt);
            normalized.legacyKey = legacyKey;
        } catch (_) {
            return null;
        }
    }
    if (!normalized.verifier) return null;
    return normalized;
}

function getPersistentBackupEncryptionConfig(config) {
    const normalized = normalizeBackupEncryptionConfig(config);
    if (!normalized) return null;
    return {
        salt: normalized.salt,
        verifier: normalized.verifier,
        updatedAt: normalized.updatedAt || null
    };
}

function normalizeOptionalString(value, fallback = '') {
    if (value == null) return fallback;
    const normalized = String(value).trim();
    return normalized || fallback;
}

function normalizeOptionalStringOrNull(value) {
    const normalized = normalizeOptionalString(value, '');
    return normalized || null;
}

function normalizeFiniteNumberOrNull(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeClampedNumber(value, min, max, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
}

function normalizeIsoDateStringOrNull(value) {
    const normalized = normalizeOptionalString(value, '');
    if (!normalized) return null;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function normalizeListEntries(rawLists) {
    const sourceLists = Array.isArray(rawLists) ? rawLists : [];
    const seenIds = new Set();
    const seenNames = new Set();
    const normalized = [];

    const getUniqueListId = (baseId) => {
        let nextId = normalizeOptionalString(baseId, '');
        if (!nextId) {
            nextId = !seenIds.has('default') && normalized.length === 0
                ? 'default'
                : `list_${normalized.length + 1}`;
        }
        if (!seenIds.has(nextId)) return nextId;
        let suffix = 2;
        while (seenIds.has(`${nextId}_${suffix}`)) {
            suffix += 1;
        }
        return `${nextId}_${suffix}`;
    };

    const getUniqueListName = (baseName, id) => {
        let nextName = normalizeOptionalString(baseName, id === 'default' ? 'Default' : `List ${normalized.length + 1}`);
        const lower = nextName.toLowerCase();
        if (!seenNames.has(lower)) return nextName;
        let suffix = 2;
        while (seenNames.has(`${nextName} (${suffix})`.toLowerCase())) {
            suffix += 1;
        }
        return `${nextName} (${suffix})`;
    };

    sourceLists.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const id = getUniqueListId(entry.id);
        const name = getUniqueListName(entry.name, id);
        seenIds.add(id);
        seenNames.add(name.toLowerCase());
        normalized.push({ id, name });
    });

    if (!normalized.length) {
        return [...DEFAULT_LISTS];
    }
    if (!normalized.some(list => list.id === 'default')) {
        normalized.unshift({ id: 'default', name: 'Default' });
    }
    return normalized;
}

function normalizeHistoryEntries(rawHistory) {
    if (!Array.isArray(rawHistory)) return [];
    return rawHistory
        .filter(entry => entry && typeof entry === 'object')
        .map((entry) => {
            const price = normalizeFiniteNumberOrNull(entry.price);
            const date = normalizeIsoDateStringOrNull(entry.date);
            if (!Number.isFinite(price) || !date) return null;
            return { price, date };
        })
        .filter(Boolean);
}

function normalizeDiagnosticsEntries(rawEntries) {
    const sourceEntries = Array.isArray(rawEntries) ? rawEntries : [];
    return sourceEntries
        .filter(entry => entry && typeof entry === 'object')
        .slice(0, 2000)
        .map((entry) => {
            const stockStatus = normalizeOptionalString(entry.stockStatus, 'unknown').toLowerCase();
            return {
                time: normalizeIsoDateStringOrNull(entry.time) || new Date().toISOString(),
                itemId: normalizeOptionalStringOrNull(entry.itemId),
                itemName: normalizeOptionalStringOrNull(entry.itemName),
                url: normalizeOptionalStringOrNull(entry.url),
                listId: normalizeOptionalString(entry.listId, 'default'),
                ok: Boolean(entry.ok),
                price: normalizeFiniteNumberOrNull(entry.price),
                currency: normalizeOptionalStringOrNull(entry.currency)?.toUpperCase() || null,
                confidence: normalizeClampedNumber(entry.confidence, 0, 100, 0),
                source: normalizeOptionalStringOrNull(entry.source),
                selectorUsed: normalizeOptionalStringOrNull(entry.selectorUsed),
                stockStatus: ['unknown', 'in_stock', 'out_of_stock'].includes(stockStatus) ? stockStatus : 'unknown',
                outOfStock: Boolean(entry.outOfStock),
                stockReason: normalizeOptionalString(entry.stockReason, ''),
                error: normalizeOptionalStringOrNull(entry.error)
            };
        });
}

function normalizeAuditEntries(rawEntries) {
    const sourceEntries = Array.isArray(rawEntries) ? rawEntries : [];
    return sourceEntries
        .filter(entry => entry && typeof entry === 'object')
        .slice(0, 5000)
        .map((entry) => ({
            time: normalizeIsoDateStringOrNull(entry.time) || new Date().toISOString(),
            action: normalizeOptionalString(entry.action, 'unknown'),
            source: normalizeOptionalString(entry.source, 'system'),
            details: entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
                ? cloneJsonState(entry.details)
                : {}
        }));
}

function normalizeSettingsShape(sourceSettings = {}) {
    const normalized = { ...(sourceSettings || {}) };
    normalized.lists = normalizeListEntries(normalized.lists);
    normalized.alertRules = { ...DEFAULT_ALERT_RULES, ...(normalized.alertRules || {}) };
    normalized.checkIntervalMs = sanitizeCheckIntervalMs(normalized.checkIntervalMs);
    normalized.checkIntervalPreset = String(normalized.checkIntervalPreset || 'custom');
    normalized.backupEncryption = normalizeBackupEncryptionConfig(normalized.backupEncryption);
    return normalized;
}

function applyEnvironmentSettings(sourceSettings = settings) {
    sourceSettings.discordWebhook = process.env.DISCORD_WEBHOOK || sourceSettings.discordWebhook;
    sourceSettings.telegramWebhook = process.env.TELEGRAM_BOT_TOKEN || sourceSettings.telegramWebhook;
    sourceSettings.telegramChatId = process.env.TELEGRAM_CHAT_ID || sourceSettings.telegramChatId;
    return sourceSettings;
}

function cloneJsonState(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
}

function bumpItemsRevision() {
    const now = Date.now();
    itemsRevision = now > itemsRevision ? now : itemsRevision + 1;
    return itemsRevision;
}

function bumpSettingsRevision() {
    const now = Date.now();
    settingsRevision = now > settingsRevision ? now : settingsRevision + 1;
    return settingsRevision;
}

function createTempFilePath(targetPath, label = 'tmp') {
    const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${label}-${token}`);
}

async function replaceFileAtomic(sourcePath, targetPath) {
    try {
        await fsPromises.rename(sourcePath, targetPath);
    } catch (error) {
        if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
            await fsPromises.rm(targetPath, { force: true });
            await fsPromises.rename(sourcePath, targetPath);
            return;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, value) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = createTempFilePath(filePath, 'write');
    try {
        await fsPromises.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
        await replaceFileAtomic(tempPath, filePath);
    } finally {
        await fsPromises.rm(tempPath, { force: true }).catch(() => { });
    }
}

async function cleanupJsonTransactionArtifacts(journal, journalPath = TRANSACTION_JOURNAL_FILE) {
    const entries = Array.isArray(journal && journal.entries) ? journal.entries : [];
    for (const entry of entries) {
        if (entry && entry.tempPath) {
            await fsPromises.rm(entry.tempPath, { force: true }).catch(() => { });
        }
        if (entry && entry.backupPath) {
            await fsPromises.rm(entry.backupPath, { force: true }).catch(() => { });
        }
    }
    await fsPromises.rm(journalPath, { force: true }).catch(() => { });
}

async function rollbackJsonFileTransaction(journal, journalPath = TRANSACTION_JOURNAL_FILE) {
    const entries = Array.isArray(journal && journal.entries) ? journal.entries : [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (!entry || !entry.targetPath) continue;
        if (entry.hadOriginal && entry.backupPath) {
            try {
                await fsPromises.access(entry.backupPath);
                await replaceFileAtomic(entry.backupPath, entry.targetPath);
            } catch (_) { }
        } else {
            await fsPromises.rm(entry.targetPath, { force: true }).catch(() => { });
        }
        if (entry.tempPath) {
            await fsPromises.rm(entry.tempPath, { force: true }).catch(() => { });
        }
    }
    await cleanupJsonTransactionArtifacts(journal, journalPath);
}

async function recoverPendingJsonFileTransaction(journalPath = TRANSACTION_JOURNAL_FILE) {
    if (!fs.existsSync(journalPath)) return;

    let journal = null;
    try {
        journal = JSON.parse(await fsPromises.readFile(journalPath, 'utf8'));
    } catch (error) {
        throw new Error(`[Transaction] Recovery failed: could not read journal (${error.message})`);
    }

    if (!journal || !Array.isArray(journal.entries)) {
        throw new Error('[Transaction] Recovery failed: journal is invalid');
    }

    console.warn('[Transaction] Incomplete state write detected. Rolling back pending file transaction.');
    await rollbackJsonFileTransaction(journal, journalPath);
}

async function runJsonFileTransaction(entries) {
    const journal = {
        createdAt: new Date().toISOString(),
        entries: []
    };

    try {
        for (const entry of entries) {
            const tempPath = createTempFilePath(entry.targetPath, 'next');
            const backupPath = createTempFilePath(entry.targetPath, 'backup');
            const hadOriginal = fs.existsSync(entry.targetPath);

            await fsPromises.mkdir(path.dirname(entry.targetPath), { recursive: true });
            await fsPromises.writeFile(tempPath, JSON.stringify(entry.nextValue, null, 2), 'utf8');
            if (hadOriginal) {
                await fsPromises.copyFile(entry.targetPath, backupPath);
            }

            journal.entries.push({
                label: entry.label || path.basename(entry.targetPath),
                targetPath: entry.targetPath,
                tempPath,
                backupPath,
                hadOriginal
            });
        }

        await writeJsonFile(TRANSACTION_JOURNAL_FILE, journal);

        for (const entry of journal.entries) {
            await replaceFileAtomic(entry.tempPath, entry.targetPath);
        }

        await cleanupJsonTransactionArtifacts(journal);
    } catch (error) {
        await rollbackJsonFileTransaction(journal).catch((rollbackError) => {
            console.error('[Transaction] Rollback failed:', rollbackError.message);
        });
        throw error;
    }
}

async function loadSettings() {
    try {
        let fileSettings = {};
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = await fsPromises.readFile(SETTINGS_FILE, 'utf8');
            fileSettings = JSON.parse(data);
        }
        const nextSettings = applyEnvironmentSettings(normalizeSettingsShape({
            ...settings,
            ...fileSettings
        }));
        const needsBackupMigration = Boolean(nextSettings.backupEncryption && nextSettings.backupEncryption.legacyKey);
        settings = nextSettings;
        bumpSettingsRevision();
        clearBackupEncryptionSession();
        if (needsBackupMigration) {
            settings.backupEncryption = getPersistentBackupEncryptionConfig(nextSettings.backupEncryption);
            await saveSettings();
        }
    } catch (e) {
        console.error('[Settings] Load failed:', e.message);
    }
}

async function saveSettings(nextSettings = settings) {
    try {
        await writeJsonFile(SETTINGS_FILE, getPersistentSettingsSnapshot(nextSettings));
    } catch (e) {
        console.error('[Settings] Save failed:', e.message);
        throw e;
    }
}

function getPersistentSettingsSnapshot(sourceSettings = settings) {
    const persistentSettings = normalizeSettingsShape(sourceSettings);
    if (process.env.DISCORD_WEBHOOK) persistentSettings.discordWebhook = '';
    if (process.env.TELEGRAM_BOT_TOKEN) persistentSettings.telegramWebhook = '';
    if (process.env.TELEGRAM_CHAT_ID) persistentSettings.telegramChatId = '';
    persistentSettings.backupEncryption = getPersistentBackupEncryptionConfig(persistentSettings.backupEncryption);
    delete persistentSettings.backupPasswordConfigured;
    delete persistentSettings.backupPasswordUpdatedAt;
    delete persistentSettings.backupSessionUnlocked;
    delete persistentSettings.discordWebhookConfigured;
    delete persistentSettings.telegramWebhookConfigured;
    delete persistentSettings.telegramChatIdConfigured;
    return persistentSettings;
}

function getBackupSettingsSnapshot(sourceSettings = settings) {
    // Backups should be fully restorable, including currently effective webhook settings.
    const backupSettings = { ...(sourceSettings || {}) };
    delete backupSettings.backupEncryption;
    delete backupSettings.backupPasswordConfigured;
    delete backupSettings.backupPasswordUpdatedAt;
    return backupSettings;
}

function getPublicSettingsSnapshot(sourceSettings = settings) {
    const publicSettings = { ...(sourceSettings || {}) };
    const backupEncryption = normalizeBackupEncryptionConfig(publicSettings.backupEncryption);
    delete publicSettings.backupEncryption;
    delete publicSettings.discordWebhook;
    delete publicSettings.telegramWebhook;
    delete publicSettings.telegramChatId;
    publicSettings.discordWebhook = '';
    publicSettings.telegramWebhook = '';
    publicSettings.telegramChatId = '';
    publicSettings.discordWebhookConfigured = Boolean(sourceSettings && sourceSettings.discordWebhook);
    publicSettings.telegramWebhookConfigured = Boolean(sourceSettings && sourceSettings.telegramWebhook);
    publicSettings.telegramChatIdConfigured = Boolean(sourceSettings && sourceSettings.telegramChatId);
    publicSettings.backupPasswordConfigured = Boolean(backupEncryption);
    publicSettings.backupPasswordUpdatedAt = backupEncryption ? backupEncryption.updatedAt || null : null;
    publicSettings.backupSessionUnlocked = hasUnlockedBackupEncryptionSession(sourceSettings);
    publicSettings.revision = settingsRevision;
    return publicSettings;
}

function getListsSnapshot() {
    const lists = Array.isArray(settings.lists) && settings.lists.length ? settings.lists : [...DEFAULT_LISTS];
    const counts = items.reduce((acc, item) => {
        const key = item.listId || 'default';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return lists.map(list => ({ ...list, itemCount: counts[list.id] || 0 }));
}

function getListsStateToken() {
    const lists = getListsSnapshot();
    const countsSignature = lists
        .map(list => `${String(list.id || '')}:${Number(list.itemCount || 0)}`)
        .join('|');
    return `${settingsRevision}:${countsSignature}`;
}

function getSettingsConflictPayload(message = 'Settings changed in another tab. Reload and try again.') {
    return {
        error: message,
        revision: settingsRevision,
        listsStateToken: getListsStateToken(),
        settings: getPublicSettingsSnapshot(settings),
        lists: getListsSnapshot(),
        alertRules: getAlertRules(),
        itemsRevision
    };
}

function clearBackupEncryptionSession() {
    backupSession = {
        keyBuffer: null,
        salt: null,
        unlockedAt: null
    };
}

function setBackupEncryptionSession(keyBuffer, saltBase64) {
    backupSession = {
        keyBuffer: Buffer.from(keyBuffer),
        salt: String(saltBase64 || '').trim(),
        unlockedAt: new Date().toISOString()
    };
}

function sanitizeCheckIntervalMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_CHECK_INTERVAL_MS;
    return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(MAX_CHECK_INTERVAL_MS, Math.round(numeric)));
}

function scheduleBackgroundChecks() {
    // Re-arm timer with latest interval (called on startup and interval updates).
    const intervalMs = sanitizeCheckIntervalMs(settings.checkIntervalMs);
    settings.checkIntervalMs = intervalMs;
    if (checkIntervalHandle) clearInterval(checkIntervalHandle);
    checkIntervalHandle = setInterval(checkPrices, intervalMs);
    return intervalMs;
}

async function loadDiagnostics() {
    try {
        if (!fs.existsSync(DIAGNOSTICS_FILE)) {
            diagnostics = [];
            return;
        }
        const data = await fsPromises.readFile(DIAGNOSTICS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        diagnostics = normalizeDiagnosticsEntries(parsed);
    } catch (e) {
        console.error('[Diagnostics] Load failed:', e.message);
        diagnostics = [];
    }
}

async function saveDiagnostics(nextDiagnostics = diagnostics) {
    try {
        await writeJsonFile(DIAGNOSTICS_FILE, normalizeDiagnosticsEntries(nextDiagnostics));
    } catch (e) {
        console.error('[Diagnostics] Save failed:', e.message);
        throw e;
    }
}

async function addDiagnostic(entry) {
    return runStateMutation(async () => {
        const nextDiagnostics = [{
            time: new Date().toISOString(),
            ...entry
        }, ...diagnostics].slice(0, 2000);
        await saveDiagnostics(nextDiagnostics);
        diagnostics = nextDiagnostics;
        return nextDiagnostics;
    });
}

async function loadAuditLog() {
    try {
        if (!fs.existsSync(AUDIT_FILE)) {
            auditLog = [];
            return;
        }
        const data = await fsPromises.readFile(AUDIT_FILE, 'utf8');
        const parsed = JSON.parse(data);
        auditLog = normalizeAuditEntries(parsed);
    } catch (e) {
        console.error('[Audit] Load failed:', e.message);
        auditLog = [];
    }
}

async function saveAuditLog(nextAuditLog = auditLog) {
    try {
        await writeJsonFile(AUDIT_FILE, normalizeAuditEntries(nextAuditLog));
    } catch (e) {
        console.error('[Audit] Save failed:', e.message);
        throw e;
    }
}

async function addAuditEntry(action, details = {}, source = 'system') {
    return runStateMutation(async () => {
        const nextAuditLog = [{
            time: new Date().toISOString(),
            action: String(action || 'unknown'),
            source: String(source || 'system'),
            details: details && typeof details === 'object' ? details : {}
        }, ...auditLog].slice(0, 5000);
        await saveAuditLog(nextAuditLog);
        auditLog = nextAuditLog;
        return nextAuditLog;
    });
}

// --- Backup Logic ---
function hasBackupEncryptionConfigured(sourceSettings = settings) {
    return Boolean(normalizeBackupEncryptionConfig(sourceSettings.backupEncryption));
}

function getBackupEncryptionConfig(sourceSettings = settings) {
    const config = normalizeBackupEncryptionConfig(sourceSettings.backupEncryption);
    if (!config) throw new Error('Backup password is not configured');
    return config;
}

function backupVerifiersMatch(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'utf8');
    const rightBuffer = Buffer.from(String(right || ''), 'utf8');
    if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasUnlockedBackupEncryptionSession(sourceSettings = settings) {
    const config = normalizeBackupEncryptionConfig(sourceSettings.backupEncryption);
    return Boolean(
        config
        && backupSession.keyBuffer
        && Buffer.isBuffer(backupSession.keyBuffer)
        && backupSession.keyBuffer.length === 32
        && backupSession.salt === config.salt
    );
}

function getActiveBackupEncryptionKeyBuffer(sourceSettings = settings) {
    if (!hasBackupEncryptionConfigured(sourceSettings)) {
        throw new Error('Backup password is not configured');
    }
    if (!hasUnlockedBackupEncryptionSession(sourceSettings)) {
        throw new Error('Backup password must be re-entered after restart before encrypted backup actions can run');
    }
    return Buffer.from(backupSession.keyBuffer);
}

function createBackupEncryptionStateFromPassword(password) {
    const normalizedPassword = String(password || '').trim();
    if (normalizedPassword.length < BACKUP_PASSWORD_MIN_LENGTH) {
        throw new Error(`Backup password must be at least ${BACKUP_PASSWORD_MIN_LENGTH} characters`);
    }
    const saltBuffer = crypto.randomBytes(16);
    const salt = saltBuffer.toString('base64');
    const keyBuffer = crypto.scryptSync(normalizedPassword, saltBuffer, 32);
    return {
        config: {
            salt,
            verifier: createBackupKeyVerifier(keyBuffer, salt),
            updatedAt: new Date().toISOString()
        },
        keyBuffer
    };
}

async function validateBackupPasswordWithoutSession(password, sourceSettings = settings) {
    const config = getBackupEncryptionConfig(sourceSettings);
    const keyBuffer = await deriveBackupKeyFromPassword(password, config.salt);
    const verifier = createBackupKeyVerifier(keyBuffer, config.salt);
    if (!backupVerifiersMatch(verifier, config.verifier)) {
        throw new Error('Backup password is incorrect');
    }
    return { config, keyBuffer };
}

async function deriveBackupKeyFromPassword(password, saltBase64) {
    const normalizedPassword = String(password || '').trim();
    if (!normalizedPassword) throw new Error('Backup password is required');
    const saltBuffer = Buffer.from(String(saltBase64 || '').trim(), 'base64');
    if (!saltBuffer.length) throw new Error('Backup salt is missing');
    return await new Promise((resolve, reject) => {
        crypto.scrypt(normalizedPassword, saltBuffer, 32, (err, keyBuffer) => {
            if (err) reject(err);
            else resolve(keyBuffer);
        });
    });
}

async function unlockBackupEncryptionSession(password, sourceSettings = settings) {
    const { config, keyBuffer } = await validateBackupPasswordWithoutSession(password, sourceSettings);
    setBackupEncryptionSession(keyBuffer, config.salt);
    return { config, keyBuffer };
}

async function ensureBackupEncryptionSessionUnlocked(sourceSettings = settings) {
    if (!hasBackupEncryptionConfigured(sourceSettings)) return false;
    if (hasUnlockedBackupEncryptionSession(sourceSettings)) return true;
    if (!BACKUP_PASSWORD_ENV) return false;
    try {
        await unlockBackupEncryptionSession(BACKUP_PASSWORD_ENV, sourceSettings);
        console.log('[Backup] Session unlocked from BACKUP_PASSWORD environment variable.');
        return true;
    } catch (e) {
        clearBackupEncryptionSession();
        console.warn(`[Backup] Failed to unlock from BACKUP_PASSWORD: ${e.message}`);
        return false;
    }
}

function buildBackupSnapshot() {
    return normalizeBackupSnapshot({
        schema: BACKUP_SCHEMA_PLAIN,
        createdAt: new Date().toISOString(),
        items: cloneJsonState(Array.isArray(items) ? items : []),
        settings: getBackupSettingsSnapshot(settings),
        diagnostics: cloneJsonState(Array.isArray(diagnostics) ? diagnostics : []),
        audit: cloneJsonState(Array.isArray(auditLog) ? auditLog : [])
    }, {
        repairIds: false,
        allowDuplicateCanonicalUrls: false
    });
}

function buildDefaultBackupSettingsState() {
    return applyEnvironmentSettings(normalizeSettingsShape({
        discordWebhook: '',
        telegramWebhook: '',
        telegramChatId: '',
        lists: [...DEFAULT_LISTS],
        alertRules: { ...DEFAULT_ALERT_RULES },
        checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
        checkIntervalPreset: '1h',
        backupEncryption: null
    }));
}

function isMeaningfulBackupSnapshot(snapshot) {
    const normalizedSnapshot = normalizeBackupSnapshot(snapshot, {
        repairIds: false,
        allowDuplicateCanonicalUrls: false
    });
    const defaultSettingsSnapshot = getBackupSettingsSnapshot(buildDefaultBackupSettingsState());
    return Boolean(
        normalizedSnapshot.items.length
        || normalizedSnapshot.diagnostics.length
        || normalizedSnapshot.audit.length
        || JSON.stringify(normalizedSnapshot.settings) !== JSON.stringify(defaultSettingsSnapshot)
    );
}

async function ensureBackupDirectory() {
    try {
        await fsPromises.access(BACKUP_DIR);
    } catch {
        await fsPromises.mkdir(BACKUP_DIR, { recursive: true });
    }
}

async function getConfiguredBackupWriteContext(sourceSettings = settings) {
    if (!hasBackupEncryptionConfigured(sourceSettings)) {
        return {
            available: false,
            reason: 'Configure a backup password before backups can be written.'
        };
    }
    if (!(await ensureBackupEncryptionSessionUnlocked(sourceSettings))) {
        return {
            available: false,
            reason: 'Re-enter the backup password after restart before backups can be written.'
        };
    }
    return {
        available: true,
        mode: 'configured',
        keyBuffer: getActiveBackupEncryptionKeyBuffer(sourceSettings),
        salt: getBackupEncryptionConfig(sourceSettings).salt
    };
}

async function createEphemeralBackupWriteContext(password) {
    const normalizedPassword = String(password || '').trim();
    if (!normalizedPassword) {
        throw new Error('Backup password is required');
    }
    const salt = crypto.randomBytes(16).toString('base64');
    return {
        available: true,
        mode: 'ephemeral',
        keyBuffer: await deriveBackupKeyFromPassword(normalizedPassword, salt),
        salt
    };
}

async function getSafetyBackupWriteContext(password = '', sourceSettings = settings) {
    const normalizedPassword = String(password || '').trim();
    if (!hasBackupEncryptionConfigured(sourceSettings)) {
        if (!normalizedPassword) {
            return {
                available: false,
                reason: 'Backup password is required to create a safety backup.'
            };
        }
        return createEphemeralBackupWriteContext(normalizedPassword);
    }

    if (await ensureBackupEncryptionSessionUnlocked(sourceSettings)) {
        return getConfiguredBackupWriteContext(sourceSettings);
    }

    if (!normalizedPassword) {
        return {
            available: false,
            reason: 'Re-enter the current backup password in Settings before restore/import so Centsible can protect the existing state.'
        };
    }

    try {
        const { config, keyBuffer } = await validateBackupPasswordWithoutSession(normalizedPassword, sourceSettings);
        return {
            available: true,
            mode: 'provided-current-password',
            keyBuffer,
            salt: config.salt
        };
    } catch (error) {
        return {
            available: false,
            reason: 'The current backup password must be unlocked in Settings before restore/import so Centsible can protect the existing state.'
        };
    }
}

async function writeEncryptedBackupFile(filename, snapshot, writeContext) {
    if (!writeContext || !writeContext.keyBuffer || !writeContext.salt) {
        throw new Error('Backup write context is incomplete');
    }
    await ensureBackupDirectory();
    const backupPath = path.join(BACKUP_DIR, filename);
    const normalizedSnapshot = normalizeBackupSnapshot(snapshot, {
        repairIds: false,
        allowDuplicateCanonicalUrls: false
    });
    const envelope = buildEncryptedBackupEnvelope(
        normalizedSnapshot,
        writeContext.keyBuffer,
        writeContext.salt
    );
    await writeJsonFile(backupPath, envelope);
    console.log(`[Backup] Saved encrypted backup to: ${backupPath}`);
    cleanOldBackups().catch(() => { });
    return {
        success: true,
        filename,
        preview: envelope.preview,
        mode: writeContext.mode || 'configured'
    };
}

async function performBackup() {
    return writeNamedBackup(`prices-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

async function writeNamedBackup(filename) {
    const writeContext = await getConfiguredBackupWriteContext();
    if (!writeContext.available) {
        console.warn(`[Backup] Skipped: ${writeContext.reason}`);
        return {
            success: false,
            skipped: true,
            reason: writeContext.reason
        };
    }
    try {
        return await writeEncryptedBackupFile(filename, buildBackupSnapshot(), writeContext);
    } catch (e) {
        console.error('[Backup] Failed:', e.message);
        return { success: false, error: e.message };
    }
}

async function createSafetyBackup(password = '') {
    const currentSnapshot = buildBackupSnapshot();
    if (!isMeaningfulBackupSnapshot(currentSnapshot)) {
        return {
            success: true,
            skipped: true,
            reason: 'No current app state requires a safety backup.'
        };
    }

    const writeContext = await getSafetyBackupWriteContext(password);
    if (!writeContext.available) {
        return {
            success: false,
            skipped: true,
            reason: writeContext.reason || 'Cannot continue without a safety backup.'
        };
    }

    let result;
    try {
        result = await writeEncryptedBackupFile(`manual-pre-restore-${Date.now()}.json`, currentSnapshot, writeContext);
    } catch (e) {
        result = { success: false, error: e.message };
    }
    if (!result.success && !result.skipped) {
        console.warn('[Backup] Safety backup failed:', result.error || 'unknown error');
    }
    return result;
}

function buildEncryptedBackupEnvelope(snapshot, keyBuffer, saltBase64) {
    const iv = crypto.randomBytes(12);
    const preview = summarizeBackupSnapshot(snapshot);
    const previewAad = Buffer.from(JSON.stringify(preview), 'utf8');
    const cipher = crypto.createCipheriv(BACKUP_CIPHER, keyBuffer, iv);
    cipher.setAAD(previewAad);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(snapshot), 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return {
        schema: BACKUP_SCHEMA_ENCRYPTED,
        createdAt: snapshot.createdAt || new Date().toISOString(),
        encrypted: true,
        preview,
        encryption: {
            algorithm: BACKUP_CIPHER,
            kdf: 'scrypt',
            aad: BACKUP_PREVIEW_AAD_MODE,
            salt: String(saltBase64 || '').trim(),
            iv: iv.toString('base64'),
            tag: tag.toString('base64')
        },
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptEncryptedBackupEnvelopeWithKey(envelope, keyBuffer) {
    const encryption = envelope && envelope.encryption ? envelope.encryption : {};
    if (!encryption.iv || !encryption.tag || !envelope.ciphertext) {
        throw new Error('Backup payload is incomplete');
    }
    if (String(encryption.algorithm || BACKUP_CIPHER) !== BACKUP_CIPHER) {
        throw new Error('Unsupported backup cipher');
    }
    if (encryption.kdf && String(encryption.kdf) !== 'scrypt') {
        throw new Error('Unsupported backup key derivation');
    }

    const decipher = crypto.createDecipheriv(
        BACKUP_CIPHER,
        keyBuffer,
        Buffer.from(encryption.iv, 'base64')
    );
    if (encryption.aad === BACKUP_PREVIEW_AAD_MODE) {
        const preview = envelope && envelope.preview && typeof envelope.preview === 'object'
            ? envelope.preview
            : {};
        decipher.setAAD(Buffer.from(JSON.stringify(preview), 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(encryption.tag, 'base64'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
    ]).toString('utf8');

    return JSON.parse(plaintext);
}

async function decryptEncryptedBackupEnvelope(envelope, password) {
    const keyBuffer = await deriveBackupKeyFromPassword(password, envelope && envelope.encryption && envelope.encryption.salt);
    return decryptEncryptedBackupEnvelopeWithKey(envelope, keyBuffer);
}

function isEncryptedBackupEnvelope(value) {
    return Boolean(
        value
        && typeof value === 'object'
        && value.encrypted === true
        && value.encryption
        && value.ciphertext
    );
}

async function reencryptExistingBackups(nextEncryptionConfig, nextKeyBuffer, previousKeyBuffer = null) {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = (await fsPromises.readdir(BACKUP_DIR)).filter(f => f.endsWith('.json'));

    for (const file of files) {
        const fullPath = path.join(BACKUP_DIR, file);
        let parsed;
        try {
            parsed = JSON.parse(await fsPromises.readFile(fullPath, 'utf8'));
        } catch (e) {
            if (e && e.message === 'Current backup password must be entered before it can be changed') {
                throw e;
            }
            continue;
        }

        let snapshot = null;
        try {
            if (isEncryptedBackupEnvelope(parsed)) {
                if (parsed.encryption && parsed.encryption.salt === nextEncryptionConfig.salt) continue;
                if (!previousKeyBuffer) {
                    throw new Error('Current backup password must be entered before it can be changed');
                }
                snapshot = decryptEncryptedBackupEnvelopeWithKey(parsed, previousKeyBuffer);
            } else {
                snapshot = (await parseBackupPayload(parsed)).snapshot;
            }
        } catch {
            continue;
        }

        if (!snapshot) continue;
        const envelope = buildEncryptedBackupEnvelope(snapshot, nextKeyBuffer, nextEncryptionConfig.salt);
        await writeJsonFile(fullPath, envelope);
    }
}

async function cleanOldBackups() {
    try {
        const files = await fsPromises.readdir(BACKUP_DIR);
        const backupFiles = files.filter(f => f.endsWith('.json'));

        const groups = {
            daily: backupFiles.filter(f => f.startsWith('prices-')),
            preRestore: backupFiles.filter(f => f.startsWith('manual-pre-restore-'))
        };

        const maxByGroup = { daily: 30, preRestore: 20 };

        for (const group of Object.keys(groups)) {
            const candidates = await Promise.all(groups[group].map(async f => ({
                file: f,
                fullPath: path.join(BACKUP_DIR, f),
                mtime: (await fsPromises.stat(path.join(BACKUP_DIR, f))).mtime
            })));
            candidates.sort((a, b) => a.mtime - b.mtime);
            const max = maxByGroup[group] || 20;
            const toDelete = candidates.slice(0, Math.max(0, candidates.length - max));
            for (const x of toDelete) {
                await fsPromises.unlink(x.fullPath);
            }
            if (toDelete.length) {
                console.log(`[Backup] Cleaned ${toDelete.length} old ${group} backups.`);
            }
        }
    } catch (e) {
        console.error('[Backup] Cleanup failed:', e.message);
    }
}

function summarizeItemsSnapshot(rawItems) {
    const arr = Array.isArray(rawItems) ? rawItems : [];
    const itemCount = arr.length;
    const purchasedCount = arr.filter(item => Boolean(item && item.purchased)).length;
    let minDate = null;
    let maxDate = null;
    const listSet = new Set();

    for (const item of arr) {
        if (item && item.listId) listSet.add(String(item.listId));
        if (item && item.lastChecked) {
            const d = new Date(item.lastChecked);
            if (!Number.isNaN(d.getTime())) {
                if (!minDate || d < minDate) minDate = d;
                if (!maxDate || d > maxDate) maxDate = d;
            }
        }
    }

    return {
        itemCount,
        purchasedCount,
        listCount: listSet.size || 1,
        rangeStart: minDate ? minDate.toISOString() : null,
        rangeEnd: maxDate ? maxDate.toISOString() : null
    };
}

function summarizeBackupSnapshot(snapshot) {
    const summary = summarizeItemsSnapshot(snapshot && snapshot.items);
    const settingsLists = snapshot && snapshot.settings && Array.isArray(snapshot.settings.lists)
        ? snapshot.settings.lists
        : null;
    if (settingsLists && settingsLists.length) {
        summary.listCount = settingsLists.length;
    }
    summary.auditCount = Array.isArray(snapshot && snapshot.audit) ? snapshot.audit.length : 0;
    summary.diagnosticsCount = Array.isArray(snapshot && snapshot.diagnostics) ? snapshot.diagnostics.length : 0;
    summary.includesHistory = Array.isArray(snapshot && snapshot.items)
        ? snapshot.items.some(item => Array.isArray(item && item.history) && item.history.length > 0)
        : false;
    summary.includesWebhookSettings = Boolean(
        snapshot
        && snapshot.settings
        && (snapshot.settings.discordWebhook || snapshot.settings.telegramWebhook || snapshot.settings.telegramChatId)
    );
    return summary;
}

async function parseBackupPayload(parsed, password = '') {
    if (Array.isArray(parsed)) {
        throw new Error('Only encrypted backups are supported');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Unsupported backup format');
    }

    if (isEncryptedBackupEnvelope(parsed)) {
        const snapshot = normalizeBackupSnapshot(
            await decryptEncryptedBackupEnvelope(parsed, password),
            {
                repairIds: false,
                allowDuplicateCanonicalUrls: false
            }
        );
        return {
            snapshot,
            encrypted: true,
            preview: summarizeBackupSnapshot(snapshot)
        };
    }

    throw new Error('Only encrypted backups are supported');
}

async function readBackupSummary(filename) {
    const backupPath = path.join(BACKUP_DIR, filename);
    const raw = await fsPromises.readFile(backupPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (isEncryptedBackupEnvelope(parsed)) {
        return {
            ...(parsed.preview || {}),
            encrypted: true
        };
    }
    if (Array.isArray(parsed)) {
        return {
            ...summarizeItemsSnapshot(parsed),
            auditCount: 0,
            diagnosticsCount: 0,
            encrypted: false,
            legacy: true,
            unsupported: true
        };
    }
    if (parsed && typeof parsed === 'object') {
        return {
            ...summarizeBackupSnapshot(parsed),
            encrypted: false,
            unsupported: true
        };
    }
    throw new Error('Unsupported backup format');
}

async function restoreBackupSnapshot(snapshot) {
    const normalizedSnapshot = normalizeBackupSnapshot(snapshot, {
        repairIds: false,
        allowDuplicateCanonicalUrls: false
    });
    const restoredSettings = normalizedSnapshot.settings;
    const mergedSettings = normalizeSettingsShape({
        ...settings,
        ...restoredSettings,
        backupEncryption: settings.backupEncryption
    });
    const nextSettings = applyEnvironmentSettings(cloneJsonState(mergedSettings));
    const nextItems = normalizedSnapshot.items;
    const nextDiagnostics = normalizedSnapshot.diagnostics;
    const nextAudit = normalizedSnapshot.audit;
    const transactionEntries = [{
        label: 'items',
        targetPath: DATA_FILE,
        nextValue: nextItems
    }, {
        label: 'settings',
        targetPath: SETTINGS_FILE,
        nextValue: getPersistentSettingsSnapshot(nextSettings)
    }, {
        label: 'diagnostics',
        targetPath: DIAGNOSTICS_FILE,
        nextValue: nextDiagnostics
    }, {
        label: 'audit',
        targetPath: AUDIT_FILE,
        nextValue: nextAudit
    }];

    await runJsonFileTransaction(transactionEntries);

    items = nextItems;
    bumpItemsRevision();
    settings = nextSettings;
    bumpSettingsRevision();
    diagnostics = nextDiagnostics;
    auditLog = nextAudit;
    clearBackupEncryptionSession();
    scheduleBackgroundChecks();
}

async function prepareIncomingBackupSnapshot(backupInput, password = '') {
    const parsed = typeof backupInput === 'string' ? JSON.parse(backupInput) : backupInput;
    return parseBackupPayload(parsed, password);
}

async function executeBackupRestore(backupInput, password = '') {
    const { snapshot } = await prepareIncomingBackupSnapshot(backupInput, password);
    invalidateActiveBackgroundCheck('restore/import');
    await ensureSafetyBackupReady(password);
    await restoreBackupSnapshot(snapshot);
    return snapshot;
}

function validateBackupSnapshot(snapshot) {
    if (!isPlainObject(snapshot)) {
        throw new Error('Unsupported backup format');
    }
    if (snapshot.schema !== BACKUP_SCHEMA_PLAIN) {
        throw new Error('Unsupported backup schema');
    }
    if (!Array.isArray(snapshot.items)) {
        throw new Error('Backup is missing items array');
    }
    if (!isPlainObject(snapshot.settings)) {
        throw new Error('Backup is missing settings payload');
    }
    if (!Array.isArray(snapshot.diagnostics)) {
        throw new Error('Backup diagnostics payload is invalid');
    }
    if (!Array.isArray(snapshot.audit)) {
        throw new Error('Backup audit payload is invalid');
    }
}

function normalizeBackupSnapshot(snapshot, options = {}) {
    validateBackupSnapshot(snapshot);
    const normalizedSettings = getBackupSettingsSnapshot(normalizeSettingsShape(cloneJsonState(snapshot.settings)));
    const effectiveLists = Array.isArray(normalizedSettings.lists) ? normalizedSettings.lists : [...DEFAULT_LISTS];
    const validListIds = new Set(effectiveLists.map(list => list.id));
    const fallbackListId = (effectiveLists[0] && effectiveLists[0].id) || 'default';
    const normalizedItems = normalizeIncomingItems(snapshot.items, fallbackListId, {
        repairIds: Boolean(options.repairIds),
        validListIds,
        allowDuplicateCanonicalUrls: Boolean(options.allowDuplicateCanonicalUrls)
    }).items;
    return {
        schema: BACKUP_SCHEMA_PLAIN,
        createdAt: normalizeIsoDateStringOrNull(snapshot.createdAt) || new Date().toISOString(),
        items: normalizedItems,
        settings: normalizedSettings,
        diagnostics: normalizeDiagnosticsEntries(snapshot.diagnostics),
        audit: normalizeAuditEntries(snapshot.audit)
    };
}

async function ensureSafetyBackupReady(password = '') {
    const result = await createSafetyBackup(password);
    if (!result.success) {
        throw new Error(result.reason || result.error || 'Cannot continue without a safety backup.');
    }
    return result;
}
// --------------------

function resolveSecretSettingValue(currentValue, nextValue, clearRequested = false) {
    if (clearRequested) return '';
    const normalized = typeof nextValue === 'string' ? nextValue.trim() : '';
    if (normalized) return normalized;
    return currentValue || '';
}

function sendFrontendFile(res, filename) {
    res.sendFile(path.join(__dirname, '../', filename));
}

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        // Allow same-origin/non-browser requests; optionally enforce explicit allowlist.
        const normalizedOrigin = normalizeOrigin(origin);
        if (!origin || !hasExplicitCorsAllowlist || allowedOrigins.includes(normalizedOrigin)) {
            callback(null, true);
            return;
        }
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error('CORS blocked for this origin'));
    }
}));
app.use(express.json({ limit: '20mb' }));
app.get(['/style.css', '/script.js', '/index.html'], (req, res) => {
    sendFrontendFile(res, path.basename(req.path));
});

app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
});

app.get('/', (_req, res) => {
    sendFrontendFile(res, 'index.html');
});

// User Agents for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

// Helper Functions
function isLegacyDemoItem(item) {
    // Filters old seeded demo rows so production data stays clean.
    if (!item) return false;
    const id = String(item.id || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    const url = String(item.url || '').toLowerCase();
    return (
        id === 'demo1' ||
        id === 'demo2' ||
        id === 'demo3' ||
        name.includes('sony wh-1000xm5 wireless headphones') ||
        name.includes('macbook air m2 15-inch') ||
        name.includes('logitech mx master 3s') ||
        url.includes('/demo1') ||
        url.includes('/demo2') ||
        url.includes('/demo3')
    );
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTrackedUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl || '').trim());
        u.hash = '';
        const drop = new Set([
            'fbclid', 'gclid', 'msclkid', '_ga', '_gl', 'mc_cid', 'mc_eid',
            '_pos', '_sid', '_ss', 'ref', 'ref_'
        ]);
        Array.from(u.searchParams.keys()).forEach((key) => {
            const normalizedKey = String(key || '').toLowerCase();
            if (normalizedKey.startsWith('utm_') || normalizedKey.startsWith('pf_rd_') || normalizedKey.startsWith('pd_rd_') || drop.has(normalizedKey)) {
                u.searchParams.delete(key);
            }
        });
        return u.toString().replace(/\/+$/, '');
    } catch {
        return String(rawUrl || '').trim();
    }
}

function generateItemId() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `item_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function generateUniqueItemId(seenIds) {
    let nextId = generateItemId();
    while (seenIds.has(nextId)) {
        nextId = generateItemId();
    }
    return nextId;
}

function normalizeIncomingItems(rawItems, fallbackListId, options = {}) {
    const repairIds = Boolean(options.repairIds);
    const allowDuplicateCanonicalUrls = Boolean(options.allowDuplicateCanonicalUrls);
    const dropDuplicateCanonicalUrls = Boolean(options.dropDuplicateCanonicalUrls);
    const validListIds = options.validListIds instanceof Set ? options.validListIds : null;
    if (!Array.isArray(rawItems)) {
        throw new Error('Invalid data format');
    }

    const seenIds = new Set();
    const seenCanonicalUrls = new Map();
    let changed = false;
    const items = rawItems.map((item, index) => {
        if (!isPlainObject(item)) {
            throw new Error(`Invalid item at index ${index}`);
        }

        let normalizedId = String(item.id || '').trim();
        if (!normalizedId) {
            if (!repairIds) {
                throw new Error(`Missing item id at index ${index}`);
            }
            normalizedId = generateUniqueItemId(seenIds);
            changed = true;
        }
        if (seenIds.has(normalizedId)) {
            if (!repairIds) {
                throw new Error(`Duplicate item id: ${normalizedId}`);
            }
            normalizedId = generateUniqueItemId(seenIds);
            changed = true;
        }
        seenIds.add(normalizedId);

        const normalizedName = typeof item.name === 'string' ? item.name.trim() : String(item.name || '').trim();
        if (!normalizedName) {
            throw new Error(`Missing item name at index ${index}`);
        }
        const normalizedUrl = typeof item.url === 'string' ? item.url.trim() : String(item.url || '').trim();
        if (!normalizedUrl) {
            throw new Error(`Missing item url at index ${index}`);
        }
        try {
            const parsedUrl = new URL(normalizedUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                throw new Error(`Invalid item url at index ${index}`);
            }
        } catch (error) {
            if (String(error.message || '').startsWith('Invalid item url at index')) {
                throw error;
            }
            throw new Error(`Invalid item url at index ${index}`);
        }
        const canonicalUrl = normalizeTrackedUrl(normalizedUrl);
        if (canonicalUrl) {
            const duplicateAt = seenCanonicalUrls.get(canonicalUrl);
            if (duplicateAt != null) {
                if (dropDuplicateCanonicalUrls) {
                    changed = true;
                    return null;
                }
                if (!allowDuplicateCanonicalUrls) {
                    throw new Error(`Duplicate tracked url: ${canonicalUrl}`);
                }
            }
            if (duplicateAt == null) {
                seenCanonicalUrls.set(canonicalUrl, index);
            }
        }

        let nextListId = normalizeOptionalString(item.listId, fallbackListId);
        if (validListIds && !validListIds.has(nextListId)) {
            nextListId = fallbackListId;
        }

        const normalizedHistory = normalizeHistoryEntries(item.history);
        const normalizedItem = {
            ...item,
            id: normalizedId,
            name: normalizedName,
            url: normalizedUrl,
            canonicalUrl,
            listId: nextListId,
            selector: normalizeOptionalStringOrNull(item.selector),
            currency: normalizeOptionalStringOrNull(item.currency)?.toUpperCase() || null,
            currentPrice: normalizeFiniteNumberOrNull(item.currentPrice),
            originalPrice: normalizeFiniteNumberOrNull(item.originalPrice),
            targetPrice: normalizeFiniteNumberOrNull(item.targetPrice),
            lastSeenPrice: normalizeFiniteNumberOrNull(item.lastSeenPrice),
            extractionConfidence: normalizeClampedNumber(item.extractionConfidence, 0, 100, 0),
            history: normalizedHistory,
            purchased: Boolean(item.purchased),
            purchasedAt: Boolean(item.purchased) ? normalizeIsoDateStringOrNull(item.purchasedAt) : null,
            lastChecked: normalizeIsoDateStringOrNull(item.lastChecked),
            lastCheckAttempt: normalizeIsoDateStringOrNull(item.lastCheckAttempt),
            lastCheckStatus: ['ok', 'fail'].includes(normalizeOptionalString(item.lastCheckStatus, '').toLowerCase())
                ? normalizeOptionalString(item.lastCheckStatus, '').toLowerCase()
                : '',
            lastCheckError: normalizeOptionalString(item.lastCheckError, ''),
            stockStatus: ['unknown', 'in_stock', 'out_of_stock'].includes(normalizeOptionalString(item.stockStatus, 'unknown').toLowerCase())
                ? normalizeOptionalString(item.stockStatus, 'unknown').toLowerCase()
                : 'unknown',
            stockConfidence: normalizeClampedNumber(item.stockConfidence, 0, 100, 0),
            stockReason: normalizeOptionalString(item.stockReason, ''),
            stockSource: normalizeOptionalStringOrNull(item.stockSource),
            stockChangedAt: normalizeIsoDateStringOrNull(item.stockChangedAt),
            stockTransition: ['out_of_stock', 'back_in_stock'].includes(normalizeOptionalString(item.stockTransition, '').toLowerCase())
                ? normalizeOptionalString(item.stockTransition, '').toLowerCase()
                : null
        };
        if (JSON.stringify(normalizedItem) !== JSON.stringify(item)) changed = true;
        return normalizedItem;
    }).filter(Boolean);
    return { items, changed };
}

async function loadData() {
    try {
        const data = await fsPromises.readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const fallbackListId = (settings.lists && settings.lists[0] && settings.lists[0].id) || 'default';
        const validListIds = new Set((settings.lists || DEFAULT_LISTS).map(list => list.id));
        const { items: normalizedItems, changed } = normalizeIncomingItems(Array.isArray(parsed) ? parsed : [], fallbackListId, {
            repairIds: true,
            validListIds,
            allowDuplicateCanonicalUrls: false,
            dropDuplicateCanonicalUrls: true
        });
        items = normalizedItems.filter(item => !isLegacyDemoItem(item));
        if (changed || items.length !== normalizedItems.length) {
            await saveData(items, { allowDuplicateCanonicalUrls: false });
        }
        bumpItemsRevision();
        console.log(`Loaded ${items.length} items from disk.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No data file found, starting with empty list.');
            items = [];
            bumpItemsRevision();
        } else {
            console.error('Failed to load data:', error.message);
        }
    }
}

async function saveData(nextItems = items, options = {}) {
    try {
        const normalized = normalizeItemsForPersistence(nextItems, options);
        await writeJsonFile(DATA_FILE, normalized);
        return normalized;
    } catch (error) {
        console.error('Failed to save data:', error.message);
        throw error;
    }
}

function normalizeItemsForPersistence(nextItems, options = {}) {
    const fallbackListId = (settings.lists && settings.lists[0] && settings.lists[0].id) || 'default';
    const validListIds = new Set((settings.lists || DEFAULT_LISTS).map(list => list.id));
    return normalizeIncomingItems(Array.isArray(nextItems) ? nextItems : [], fallbackListId, {
        repairIds: false,
        validListIds,
        allowDuplicateCanonicalUrls: Boolean(options.allowDuplicateCanonicalUrls)
    }).items;
}

function getItemsConflictPayload(message = 'Items changed in another tab or background check. Reload and try again.') {
    return {
        error: message,
        items,
        revision: itemsRevision,
        settingsRevision,
        listsStateToken: getListsStateToken()
    };
}

function createApiError(status, message, payload = null) {
    const error = new Error(message);
    error.status = status;
    error.payload = payload;
    return error;
}

async function delayMs(ms) {
    const timeout = Math.max(0, Number(ms) || 0);
    if (!timeout) return;
    await new Promise(resolve => setTimeout(resolve, timeout));
}

async function runStateMutation(task) {
    const run = async () => task();
    const pending = stateMutationQueue.then(run, run);
    stateMutationQueue = pending.catch(() => { });
    return pending;
}

async function runItemsMutation(task) {
    return runStateMutation(task);
}

function assertItemsRevision(requestedRevision, message = 'Items changed in another tab or background check. Reload and try again.') {
    if (!Number.isFinite(requestedRevision) || requestedRevision !== itemsRevision) {
        throw createApiError(409, message, getItemsConflictPayload(message));
    }
}

function assertSettingsRevision(requestedRevision, message = 'Settings changed in another tab. Reload and try again.') {
    if (!Number.isFinite(requestedRevision) || requestedRevision !== settingsRevision) {
        throw createApiError(409, message, getSettingsConflictPayload(message));
    }
}

function getItemsSuccessPayload(extra = {}) {
    return {
        success: true,
        items,
        revision: itemsRevision,
        settingsRevision,
        listsStateToken: getListsStateToken(),
        ...extra
    };
}

async function persistItemsState(nextItems, options = {}) {
    const normalizedItems = await saveData(nextItems, options);
    items = normalizedItems;
    bumpItemsRevision();
    return normalizedItems;
}

async function replaceItemState(itemId, nextItem, options = {}) {
    const index = items.findIndex(item => item.id === itemId);
    if (index === -1) {
        throw createApiError(404, 'Item not found');
    }
    const nextItems = items.slice();
    nextItems[index] = nextItem;
    const normalizedItems = await persistItemsState(nextItems, options);
    return normalizedItems.find(item => item.id === itemId) || null;
}

function normalizeSelectorValue(value) {
    return normalizeOptionalStringOrNull(value);
}

function itemSourceChanged(currentItem, expectedUrl, expectedSelector) {
    const normalizedExpectedUrl = normalizeOptionalString(expectedUrl, currentItem.url);
    const normalizedExpectedSelector = normalizeSelectorValue(expectedSelector);
    return currentItem.url !== normalizedExpectedUrl
        || normalizeSelectorValue(currentItem.selector) !== normalizedExpectedSelector;
}

function buildSuccessfulCheckItem(currentItem, extraction, nowIso = new Date().toISOString()) {
    const availability = extraction && typeof extraction === 'object'
        ? (extraction.availability || { status: 'unknown', confidence: 0, reason: '', source: null })
        : { status: 'unknown', confidence: 0, reason: '', source: null };
    const nextItem = cloneJsonState(currentItem);
    const price = extraction && extraction.price !== null && extraction.price !== undefined
        ? Number(extraction.price)
        : null;
    const previousStockStatus = String(currentItem.stockStatus || 'unknown');
    const stockStatus = availability.status || (price !== null ? 'in_stock' : 'unknown');
    const isOutOfStock = stockStatus === 'out_of_stock';

    if (price === null && !isOutOfStock) {
        throw new Error('Could not find price');
    }

    if (!isOutOfStock && price !== null) {
        nextItem.currentPrice = price;
    }
    if (extraction && extraction.currency) nextItem.currency = extraction.currency;
    if (extraction && extraction.selectorUsed && !nextItem.selector) nextItem.selector = extraction.selectorUsed;
    nextItem.extractionConfidence = extraction && extraction.confidence ? extraction.confidence : (nextItem.extractionConfidence || 0);
    nextItem.stockStatus = stockStatus;
    nextItem.stockConfidence = Number(availability.confidence || 0);
    nextItem.stockReason = availability.reason || '';
    nextItem.stockSource = availability.source || null;
    if (previousStockStatus !== 'out_of_stock' && stockStatus === 'out_of_stock') {
        nextItem.stockChangedAt = nowIso;
        nextItem.stockTransition = 'out_of_stock';
    } else if (previousStockStatus === 'out_of_stock' && stockStatus === 'in_stock') {
        nextItem.stockChangedAt = nowIso;
        nextItem.stockTransition = 'back_in_stock';
    } else {
        nextItem.stockTransition = null;
    }
    nextItem.lastChecked = nowIso;
    nextItem.lastCheckAttempt = nowIso;
    nextItem.lastCheckStatus = 'ok';
    nextItem.lastCheckError = '';
    nextItem.currency = nextItem.currency || 'USD';
    if (Number.isFinite(price)) {
        nextItem.lastSeenPrice = Number(price);
        nextItem.priceInUSD = convertToUSD(price, nextItem.currency);
    }

    if (!isOutOfStock && price !== null) {
        const history = Array.isArray(nextItem.history) ? nextItem.history : [];
        nextItem.history = history;
        const last = history[history.length - 1];
        if (!last || last.price !== price || (Date.now() - new Date(last.date).getTime() > 86400000)) {
            history.push({
                date: nowIso,
                price
            });
        }
    }

    return {
        nextItem,
        price,
        previousStockStatus,
        stockStatus,
        isOutOfStock
    };
}

function buildFailedCheckItem(currentItem, errorMessage, nowIso = new Date().toISOString()) {
    return {
        ...cloneJsonState(currentItem),
        lastCheckAttempt: nowIso,
        lastCheckStatus: 'fail',
        lastCheckError: normalizeOptionalString(errorMessage, 'Check failed')
    };
}

function getItemValidationStatus(errorMessage = '') {
    return errorMessage && (
        errorMessage.startsWith('Invalid data format')
        || errorMessage.startsWith('Invalid item at index')
        || errorMessage.startsWith('Missing item id')
        || errorMessage.startsWith('Missing item name')
        || errorMessage.startsWith('Missing item url')
        || errorMessage.startsWith('Invalid item url')
        || errorMessage.startsWith('Duplicate item id')
        || errorMessage.startsWith('Duplicate tracked url')
    )
        ? 400
        : 500;
}

const BASE_PRICE_SELECTORS = [
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
    'meta[property="product:price:amount"]',
    'meta[name="twitter:data1"]',
    '[itemprop="price"]',
    '[data-test-id*="price"]',
    '[data-testid*="price"]',
    '[class*="price"]',
    '[id*="price"]',
    '.price',
    '.product-price',
    '.new-price',
    '.current-price',
    '.discount_price',
    '.indirimli_fiyat',
    '.satis_fiyati',
    '.a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice'
];

const SITE_ADAPTERS = [
    {
        match: /amazon\./i,
        selectors: [
            '#corePrice_feature_div .a-price .a-offscreen',
            '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
            '#corePriceDisplay_mobile_feature_div .a-price .a-offscreen',
            '#apex_desktop .a-price .a-offscreen',
            '#apex_mobile .a-price .a-offscreen',
            '#price_inside_buybox',
            '#priceblock_saleprice',
            '#priceblock_ourprice',
            'input#twister-plus-price-data-price'
        ]
    },
    {
        match: /trendyol\.com/i,
        selectors: ['.prc-dsc', '.prc-slg', '[class*="prc"]', '[data-test-id*="price"]']
    },
    {
        match: /hepsiburada\.com/i,
        selectors: ['[data-test-id="price-current-price"]', '[id*="offering-price"]', '[class*="price"]']
    },
    {
        match: /n11\.com/i,
        selectors: ['.newPrice ins', '.newPrice', '[class*="price"]']
    },
    {
        match: /boyner\.com\.tr/i,
        selectors: ['.m-productPrice__salePrice', '[class*="salePrice"]', '[class*="price"]']
    }
];

function getDomainHints(targetUrl = '') {
    try {
        const host = new URL(targetUrl).hostname.toLowerCase();
        if (host.endsWith('.tr') || /trendyol|hepsiburada|n11|boyner|amazon\.com\.tr/.test(host)) {
            return { preferredCurrency: 'TRY', selectors: getSiteSelectors(host) };
        }
        if (/amazon\.de|\.de$/.test(host)) return { preferredCurrency: 'EUR', selectors: getSiteSelectors(host) };
        if (/amazon\.co\.uk|\.co\.uk$/.test(host)) return { preferredCurrency: 'GBP', selectors: getSiteSelectors(host) };
        if (/amazon\.jp|\.jp$/.test(host)) return { preferredCurrency: 'JPY', selectors: getSiteSelectors(host) };
        if (/amazon\.ca|\.ca$/.test(host)) return { preferredCurrency: 'CAD', selectors: getSiteSelectors(host) };
        if (/amazon\.com\.au|\.com\.au$/.test(host)) return { preferredCurrency: 'AUD', selectors: getSiteSelectors(host) };
        if (/amazon\.com|\.com$/.test(host)) return { preferredCurrency: 'USD', selectors: getSiteSelectors(host) };
        return { preferredCurrency: 'USD', selectors: getSiteSelectors(host) };
    } catch {
        return { preferredCurrency: 'USD', selectors: [] };
    }
}

function getSiteSelectors(hostname) {
    const adapter = SITE_ADAPTERS.find(a => a.match.test(hostname));
    return adapter ? adapter.selectors : [];
}

function isAmazonTarget(targetUrl = '') {
    try {
        return /amazon\./i.test(new URL(targetUrl).hostname);
    } catch {
        return /amazon\./i.test(String(targetUrl || ''));
    }
}

function detectCurrencyFromText(text, fallback = 'USD') {
    const t = String(text || '').toUpperCase();
    if (/(\u20BA|(^|[^A-Z])TRY([^A-Z]|$)|(^|[^A-Z])TL([^A-Z]|$))/i.test(t)) return 'TRY';
    if (/(\u20AC|(^|[^A-Z])EUR([^A-Z]|$))/i.test(t)) return 'EUR';
    if (/(\u00A3|(^|[^A-Z])GBP([^A-Z]|$))/i.test(t)) return 'GBP';
    if (/(^|[^A-Z])JPY([^A-Z]|$)|\u00A5/.test(t)) return 'JPY';
    if (/(^|[^A-Z])CAD([^A-Z]|$)/.test(t)) return 'CAD';
    if (/(^|[^A-Z])AUD([^A-Z]|$)/.test(t)) return 'AUD';
    if (/(^|[^A-Z])CHF([^A-Z]|$)/.test(t)) return 'CHF';
    if (/(^|[^A-Z])CNY([^A-Z]|$)|\u00A5/.test(t)) return 'CNY';
    if (/(\$|(^|[^A-Z])USD([^A-Z]|$))/i.test(t)) return 'USD';
    return fallback;
}

const OUT_OF_STOCK_TERMS = [
    'out of stock', 'out-of-stock', 'sold out', 'currently unavailable', 'temporarily unavailable',
    'not available', 'unavailable', 'not in stock', 'currently out of stock',
    'backorder', 'back order', 'preorder', 'pre-order', 'notify me',
    'email me when available', 'coming soon',
    'stokta yok', 'stok yok', 'stokta bulunmuyor', 'stokta bulunmamakta', 'stokta bulunmamaktadir',
    'mevcut degil', 'su anda mevcut degil', 'su an mevcut degil', 'gecici olarak stokta yok',
    'simdilik mevcut degil', 'urun mevcut degil', 'tukendi', 'satista degil', 'satista yok',
    'stoga gelince haber ver', 'haber ver',
    'agotado', 'sin stock', 'no disponible',
    'rupture de stock', 'epuise', 'indisponible',
    'ausverkauft', 'nicht verfugbar', 'nicht auf lager',
    'esgotado', 'sem estoque',
    'esaurito', 'non disponibile',
    'niet op voorraad', 'uitverkocht',
    'brak w magazynie', 'niedostepny',
    'net v nalichii', 'rasprodano'
];

const IN_STOCK_TERMS = [
    'in stock', 'available now', 'ready to ship', 'ships today', 'buy now', 'add to cart',
    'sepete ekle', 'hemen al', 'stokta', 'mevcut', 'satin al',
    'en stock', 'disponible',
    'auf lager', 'verfugbar',
    'disponivel', 'em estoque',
    'disponibile',
    'op voorraad',
    'dostepny', 'w magazynie',
    'v nalichii'
];

function normalizeAvailabilityText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();
}

const NORMALIZED_OUT_OF_STOCK_TERMS = OUT_OF_STOCK_TERMS.map(normalizeAvailabilityText).filter(Boolean);
const NORMALIZED_IN_STOCK_TERMS = IN_STOCK_TERMS.map(normalizeAvailabilityText).filter(Boolean);

function scoreAvailabilityText(rawText) {
    const text = normalizeAvailabilityText(rawText);
    if (!text) return null;

    let outScore = 0;
    let inScore = 0;
    let outReason = '';
    let inReason = '';

    for (const term of NORMALIZED_OUT_OF_STOCK_TERMS) {
        if (text.includes(term)) {
            const score = term.length > 10 ? 70 : 60;
            if (score > outScore) {
                outScore = score;
                outReason = term;
            }
        }
    }

    for (const term of NORMALIZED_IN_STOCK_TERMS) {
        if (text.includes(term)) {
            const score = term.length > 10 ? 62 : 54;
            if (score > inScore) {
                inScore = score;
                inReason = term;
            }
        }
    }

    if (!outScore && !inScore) return null;
    return { outScore, inScore, outReason, inReason };
}

function detectShopifyAvailabilityFromRawHtml(htmlString) {
    const raw = String(htmlString || '');
    if (!raw) return null;

    const isShopifyLike = /(myshopify\.com|Shopify\.shop|\/cdn\/shop\/|shopify-digital-wallet)/i.test(raw);
    if (!isShopifyLike) return null;

    // Common Shopify product data surfaces used by many themes/apps.
    const hasBisOutOfStock = /_BISConfig\.product\s*=\s*\{[\s\S]{0,120000}?"available"\s*:\s*false/i.test(raw)
        || /_BISConfig\.product\.variants\[[0-9]+\]\['oos'\]\s*=\s*true/i.test(raw);
    const hasSchemaOutOfStock = /"availability"\s*:\s*"https?:\/\/schema\.org\/OutOfStock"/i.test(raw);
    const hasBisInStock = /_BISConfig\.product\s*=\s*\{[\s\S]{0,120000}?"available"\s*:\s*true/i.test(raw);
    const hasSchemaInStock = /"availability"\s*:\s*"https?:\/\/schema\.org\/InStock"/i.test(raw);

    if (hasBisOutOfStock || hasSchemaOutOfStock) {
        return {
            status: 'out_of_stock',
            confidence: 96,
            reason: hasBisOutOfStock ? 'shopify product json available=false' : 'shopify schema outofstock',
            source: hasBisOutOfStock ? 'shopify-product-json' : 'shopify-schema'
        };
    }
    if (hasBisInStock || hasSchemaInStock) {
        return {
            status: 'in_stock',
            confidence: 91,
            reason: hasBisInStock ? 'shopify product json available=true' : 'shopify schema instock',
            source: hasBisInStock ? 'shopify-product-json' : 'shopify-schema'
        };
    }
    return null;
}

function detectAvailability($, htmlString, targetUrl = '') {
    let bestOut = { score: 0, reason: '', source: '' };
    let bestIn = { score: 0, reason: '', source: '' };
    let hasEnabledPurchaseAction = false;
    let hasDisabledPurchaseAction = false;
    let hasBuyingOptionsAction = false;
    let hasAmazonBuyingOptionsStructure = false;
    let hasAmazonUnqualifiedBuyBox = false;
    let requiresVariantSelection = false;
    let hasVariantSelectors = false;
    let structuredOut = null;
    let structuredIn = null;
    const isAmazon = isAmazonTarget(targetUrl);
    const withSignals = (result) => ({
        ...result,
        signals: {
            isAmazon,
            hasEnabledPurchaseAction,
            hasDisabledPurchaseAction,
            hasBuyingOptionsAction,
            hasAmazonBuyingOptionsStructure,
            hasAmazonUnqualifiedBuyBox,
            requiresVariantSelection,
            hasVariantSelectors,
            bestInScore: bestIn.score,
            bestOutScore: bestOut.score
        }
    });

    const isLikelyHidden = (el) => {
        const node = $(el);
        const style = normalizeAvailabilityText(node.attr('style'));
        const classes = normalizeAvailabilityText(node.attr('class'));
        const hiddenAttr = node.attr('hidden') !== undefined || normalizeAvailabilityText(node.attr('aria-hidden')) === 'true';
        if (hiddenAttr) return true;
        if (style && /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/.test(style)) return true;
        if (classes && /(^|\s)(hidden|d-none|sr-only|visually-hidden)(\s|$)/.test(classes)) return true;
        return false;
    };

    const setStructured = (status, confidence, reason, source) => {
        if (status === 'out_of_stock') {
            if (!structuredOut || confidence > structuredOut.confidence) {
                structuredOut = { status, confidence, reason, source };
            }
        } else if (status === 'in_stock') {
            if (!structuredIn || confidence > structuredIn.confidence) {
                structuredIn = { status, confidence, reason, source };
            }
        }
    };

    const classifyStructuredToken = (rawValue) => {
        const v = normalizeAvailabilityText(rawValue);
        if (!v) return null;
        if (/(outofstock|out_of_stock|soldout|sold_out|discontinued|unavailable|currentlyunavailable|temporarilyunavailable|notinstock|preorder|pre-order|backorder|back-order)/.test(v)) {
            return { status: 'out_of_stock', confidence: 94, reason: v.slice(0, 120) };
        }
        if (/(instock|in_stock|limitedavailability|availablefororder)/.test(v)) {
            return { status: 'in_stock', confidence: 90, reason: v.slice(0, 120) };
        }
        return null;
    };

    const considerSignal = (text, baseScore, source) => {
        const scored = scoreAvailabilityText(text);
        if (!scored) return;
        const outScore = Math.min(100, scored.outScore ? scored.outScore + baseScore : 0);
        const inScore = Math.min(100, scored.inScore ? scored.inScore + baseScore : 0);
        if (outScore > bestOut.score) {
            bestOut = { score: outScore, reason: scored.outReason || String(text || '').slice(0, 80), source };
        }
        if (inScore > bestIn.score) {
            bestIn = { score: inScore, reason: scored.inReason || String(text || '').slice(0, 80), source };
        }
    };

    const availabilityMeta = [
        $('meta[itemprop="availability"]').attr('content'),
        $('link[itemprop="availability"]').attr('href'),
        $('meta[property="product:availability"]').attr('content')
    ].filter(Boolean);
    availabilityMeta.forEach((v) => {
        considerSignal(v, 20, 'meta-availability');
        const cls = classifyStructuredToken(v);
        if (cls) setStructured(cls.status, cls.confidence, cls.reason, 'meta-availability');
    });

    $('script[type*="ld+json"]').slice(0, 25).each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }
        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) {
                stack.push(...node);
                continue;
            }
            for (const key of ['availability', 'offerAvailability']) {
                if (!node[key]) continue;
                const value = String(node[key]);
                considerSignal(value, 22, 'jsonld-availability');
                const cls = classifyStructuredToken(value);
                if (cls) setStructured(cls.status, cls.confidence, cls.reason, 'jsonld-availability');
            }
            for (const childKey of Object.keys(node)) {
                if (node[childKey] && typeof node[childKey] === 'object') stack.push(node[childKey]);
            }
        }
    });

    const shopifyRawAvailability = detectShopifyAvailabilityFromRawHtml(htmlString);
    if (shopifyRawAvailability) {
        setStructured(
            shopifyRawAvailability.status,
            Number(shopifyRawAvailability.confidence || 0),
            shopifyRawAvailability.reason,
            shopifyRawAvailability.source
        );
    }

    const stockSelectors = [
        '#availability',
        '#availability span',
        '#availabilityInsideBuyBox_feature_div',
        '#availabilityInsideBuyBox_feature_div span',
        '#outOfStock',
        '#outOfStock span',
        '#availabilityMessage_feature_div',
        '#availabilityMessage_feature_div span',
        '[itemprop="availability"]',
        '[class*="stock"]',
        '[id*="stock"]',
        '[class*="availability"]',
        '[id*="availability"]',
        '[data-stock]',
        '[data-availability]',
        '[data-test-id*="stock"]',
        '[data-testid*="stock"]',
        '[data-test-id*="availability"]',
        '[data-testid*="availability"]'
    ];
    stockSelectors.forEach((sel) => {
        $(sel).slice(0, 20).each((_, el) => {
            if (isLikelyHidden(el)) return;
            const text = $(el).attr('content') || $(el).attr('aria-label') || $(el).text();
            const compact = normalizeAvailabilityText(text);
            if (!compact || compact.length > 500) return;
            considerSignal(compact, 18, `selector:${sel}`);
        });
    });

    if (isAmazon) {
        hasAmazonUnqualifiedBuyBox = $('#unqualifiedBuyBox, #unqualifiedBuyBox_feature_div').length > 0;
        if (hasAmazonUnqualifiedBuyBox) {
            hasBuyingOptionsAction = true;
            if (bestOut.score < 88) {
                bestOut = { score: 88, reason: 'unqualified buy box', source: 'amazon-unqualified-buybox' };
            }
        }

        hasAmazonBuyingOptionsStructure = $([
            '#buybox-see-all-buying-choices',
            '[data-action="show-all-offers-display"]',
            '#all-offers-display',
            '#aod-has-oas-offers',
            'a[href*="/gp/offer-listing/"]',
            'a[href*="ref=dp_olp"]'
        ].join(',')).length > 0;
        if (hasAmazonBuyingOptionsStructure) {
            hasBuyingOptionsAction = true;
            if (bestOut.score < 72) {
                bestOut = { score: 72, reason: 'amazon buying options structure', source: 'amazon-buying-options-structure' };
            }
        }

        $('#buybox a, #desktop_buybox a, #availability_feature_div a').slice(0, 80).each((_, el) => {
            if (isLikelyHidden(el)) return;
            const t = normalizeAvailabilityText($(el).attr('aria-label') || $(el).text());
            if (!t) return;
            if (/(see all buying options|all buying options|buying options|satin alma seceneklerini gor|satın alma seceneklerini gor|satın alma seçeneklerini gör)/.test(t)) {
                hasBuyingOptionsAction = true;
                if (bestOut.score < 74) {
                    bestOut = { score: 74, reason: t, source: 'amazon-buying-options-link' };
                }
            }
        });
    }

    $('button, input[type="submit"], [role="button"], a[role="button"]').slice(0, 160).each((_, el) => {
        if (isLikelyHidden(el)) return;
        const node = $(el);
        const text = node.attr('aria-label') || node.attr('value') || node.text() || '';
        const normalizedText = normalizeAvailabilityText(text);
        const attrBlob = normalizeAvailabilityText([
            node.attr('id'),
            node.attr('name'),
            node.attr('class'),
            node.attr('data-testid'),
            node.attr('data-test-id')
        ].filter(Boolean).join(' '));
        const isDisabled = node.is(':disabled')
            || node.attr('disabled') !== undefined
            || normalizeAvailabilityText(node.attr('aria-disabled')) === 'true';

        const hasKeyboardShortcutHint = /(shift|alt|option|ctrl|cmd|command)\b/.test(normalizedText);
        const looksLikeShortcutPurchaseLabel = /(add to cart|buy now|sepete ekle|hemen al|satin al|satın al)/.test(normalizedText) && hasKeyboardShortcutHint;
        if (!(isAmazon && looksLikeShortcutPurchaseLabel)) {
            considerSignal(normalizedText, isDisabled ? 12 : 6, 'button');
        }

        const actionBlob = `${normalizedText} ${attrBlob}`;
        const isBuyingOptionsAction = /(see all buying options|all buying options|buying options|satin alma seceneklerini gor|satın alma seceneklerini gor|satın alma seçeneklerini gör)/.test(normalizedText);
        const isPurchaseAction = /(add to cart|buy now|checkout|sepete ekle|hemen al|satin al|satın al|addtocart|buynow|buy-now)/.test(actionBlob)
            && !(isAmazon && looksLikeShortcutPurchaseLabel);
        const isNotifyAction = /(notify me|email me|haber ver|gelince haber ver)/.test(normalizedText);
        const isVariantSelectionPrompt = /(select size|choose size|select option|choose option|select variant|choose variant|beden sec|beden seç|numara sec|numara seç|varyant sec|varyant seç|renk sec|renk seç|lütfen sec|lutfen sec)/.test(normalizedText);

        if (isVariantSelectionPrompt) {
            requiresVariantSelection = true;
        }

        if (isBuyingOptionsAction) {
            hasBuyingOptionsAction = true;
        }
        if (isBuyingOptionsAction && !hasEnabledPurchaseAction && bestOut.score < 68) {
            bestOut = { score: 68, reason: normalizedText || 'buying options only', source: 'buying-options' };
        }
        if (isPurchaseAction && !isDisabled && !isBuyingOptionsAction) {
            hasEnabledPurchaseAction = true;
            if (bestIn.score < 78) {
                bestIn = { score: 78, reason: normalizedText || attrBlob || 'purchase-action', source: 'purchase-action' };
            }
        }
        if (isPurchaseAction && isDisabled && !isBuyingOptionsAction) {
            hasDisabledPurchaseAction = true;
            if (bestOut.score < 80) {
                bestOut = { score: 80, reason: normalizedText || 'disabled purchase action', source: 'purchase-action-disabled' };
            }
        }
        if (isNotifyAction) {
            if (bestOut.score < 74) {
                bestOut = { score: 74, reason: normalizedText || 'notify action', source: 'notify-action' };
            }
        }
    });

    // Detect presence of configurable variants (size/color/model) in a generic way.
    $('select').slice(0, 20).each((_, el) => {
        if (isLikelyHidden(el)) return;
        const node = $(el);
        const optionCount = node.find('option').length;
        const attrs = normalizeAvailabilityText([
            node.attr('name'),
            node.attr('id'),
            node.attr('class'),
            node.attr('aria-label')
        ].filter(Boolean).join(' '));
        if (optionCount > 1 || /(size|beden|numara|renk|color|variant|varyant|secenek|secenekler|option)/.test(attrs)) {
            hasVariantSelectors = true;
        }
    });

    if (!requiresVariantSelection) {
        const shortBody = normalizeAvailabilityText($('body').text()).slice(0, 12000);
        if (/(select size|choose size|select option|choose option|select variant|choose variant|beden sec|beden seç|numara sec|numara seç|varyant sec|varyant seç|renk sec|renk seç|once beden sec|önce beden seç)/.test(shortBody)) {
            requiresVariantSelection = true;
        }
    }

    // Some stores require size/variant selection before carting; this is not out-of-stock by itself.
    if (requiresVariantSelection) {
        if (bestOut.score < 92) {
            bestOut.score = Math.min(bestOut.score, 70);
        }
        if (bestIn.score < 72 && (hasEnabledPurchaseAction || $('select').length > 0)) {
            bestIn = { score: 72, reason: 'variant selection required', source: 'variant-selection' };
        }
    }

    // Variant selectors + disabled cart button usually means "choose an option first", not "out of stock".
    if ((requiresVariantSelection || hasVariantSelectors) && hasDisabledPurchaseAction && !hasEnabledPurchaseAction) {
        const outIsStrongStructured = structuredOut && structuredOut.confidence >= 94;
        if (!outIsStrongStructured && bestOut.score < 92) {
            return withSignals({
                status: 'in_stock',
                confidence: Math.max(bestIn.score, 72),
                reason: bestIn.reason || 'Variant selection required before purchase',
                source: bestIn.source || 'variant-selection'
            });
        }
    }

    if (structuredOut && (!structuredIn || structuredOut.confidence >= structuredIn.confidence + 2)) {
        return withSignals(structuredOut);
    }
    if (structuredIn && !structuredOut) {
        return withSignals(structuredIn);
    }

    if (hasEnabledPurchaseAction && !hasDisabledPurchaseAction && bestOut.score < 88) {
        return withSignals({
            status: 'in_stock',
            confidence: Math.max(bestIn.score, 74),
            reason: bestIn.reason || 'Purchase action available',
            source: bestIn.source || 'purchase-action'
        });
    }

    if (bestOut.score >= 82 && bestOut.score >= bestIn.score + 10) {
        return withSignals({
            status: 'out_of_stock',
            confidence: bestOut.score,
            reason: bestOut.reason || 'Out-of-stock signal detected',
            source: bestOut.source || null
        });
    }
    if (bestIn.score >= 72 && bestIn.score >= bestOut.score + 6) {
        return withSignals({
            status: 'in_stock',
            confidence: bestIn.score,
            reason: bestIn.reason || 'In-stock signal detected',
            source: bestIn.source || null
        });
    }
    if (hasDisabledPurchaseAction && bestOut.score >= 74) {
        return withSignals({
            status: 'out_of_stock',
            confidence: bestOut.score,
            reason: bestOut.reason || 'Disabled purchase action detected',
            source: bestOut.source || 'purchase-action-disabled'
        });
    }

    if (isAmazon && !hasEnabledPurchaseAction) {
        const amazonAvailabilityText = normalizeAvailabilityText([
            $('#availability').text(),
            $('#availability_feature_div').text(),
            $('#availabilityInsideBuyBox_feature_div').text(),
            $('#outOfStock').text(),
            $('#availabilityMessage_feature_div').text(),
            $('meta[name="description"]').attr('content'),
            $('title').text()
        ].filter(Boolean).join(' '));
        if (/(currently unavailable|temporarily unavailable|temporarily out of stock|currently out of stock|out of stock|not available|stokta yok|stokta bulunmuyor|su anda mevcut degil|gecici olarak stokta yok|urun mevcut degil|mevcut degil)/.test(amazonAvailabilityText)) {
            return withSignals({
                status: 'out_of_stock',
                confidence: Math.max(bestOut.score, 90),
                reason: amazonAvailabilityText.slice(0, 180) || 'Amazon availability indicates out of stock',
                source: 'amazon-availability'
            });
        }
    }

    // Amazon pages can expose "buying options" even when first-party stock is unavailable.
    // If there is no reliable on-page price and only buying-options actions are present,
    // classify as out_of_stock for primary offer tracking.
    if (isAmazon && hasBuyingOptionsAction && !hasEnabledPurchaseAction && bestIn.score < 78) {
        return withSignals({
            status: 'out_of_stock',
            confidence: Math.max(bestOut.score, 84),
            reason: bestOut.reason || 'Buying options shown without a direct purchasable offer/price',
            source: bestOut.source || 'buying-options'
        });
    }

    return withSignals({
        status: 'unknown',
        confidence: Math.max(bestIn.score, bestOut.score, 0),
        reason: '',
        source: null
    });
}

function normalizePriceString(rawNum, currencyHint = 'USD') {
    let s = String(rawNum || '').trim().replace(/\s/g, '');
    if (!s) return null;
    const turkishLike = currencyHint === 'TRY';

    if (s.includes('.') && s.includes(',')) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastComma > lastDot) {
            s = s.replace(/\./g, '').replace(',', '.');
        } else {
            s = s.replace(/,/g, '');
        }
    } else if (s.includes(',')) {
        if (turkishLike || /,[0-9]{2}$/.test(s)) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    } else if (s.includes('.')) {
        const parts = s.split('.');
        if (turkishLike && parts[parts.length - 1].length === 3) s = s.replace(/\./g, '');
    }

    const n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    return n;
}

function extractNumericCandidates(text) {
    if (!text) return [];
    const re = /([0-9]{1,3}(?:[.,\s][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]+(?:[.,][0-9]{1,2})?)/g;
    return Array.from(String(text).matchAll(re)).map(m => m[1]).slice(0, 6);
}

function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function buildCandidate(text, selector, source, preferredCurrency, scoreBase = 0) {
    const rawText = String(text || '').trim();
    if (!rawText) return null;
    if (rawText.length > 220) return null;

    const currency = detectCurrencyFromText(rawText, preferredCurrency);
    const rawNumbers = extractNumericCandidates(rawText);
    if (!rawNumbers.length) return null;
    const hasExplicitCurrency = /(\u20BA|\u20AC|\u00A3|\$|\bTRY\b|\bUSD\b|\bEUR\b|\bGBP\b|\bJPY\b|\bCAD\b|\bAUD\b|\bCHF\b|\bCNY\b|\bTL\b)/i.test(rawText);
    if (rawNumbers.length > 2 && !hasExplicitCurrency) return null;
    if (source === 'text' && !hasExplicitCurrency && !/(price|fiyat|sale|deal|discount|ourprice)/i.test(rawText)) return null;

    const price = normalizePriceString(rawNumbers[0], currency);
    if (!Number.isFinite(price) || price <= 0) return null;

    let score = scoreBase;
    const lc = rawText.toLowerCase();
    if (/(price|fiyat|sale|deal|current|ourprice|discount)/.test(lc)) score += 25;
    if (/(shipping|delivery|kargo|installment|taksit|monthly|month|save)/.test(lc)) score -= 25;
    if (/(availability|website|url|vat|date|mm\/dd\/yyyy)/.test(lc)) score -= 40;
    if (/(width|height|margin|padding|font|button|registry|spacing)/.test(lc)) score -= 45;
    if (selector && /(price|fiyat|ourprice|deal|sale|discount)/i.test(selector)) score += 18;
    if (selector && /(old|strike|cross|was|list|compare)/i.test(selector)) score -= 20;
    if (selector && /(\[class\*="price"\]|\[id\*="price"\])/.test(selector)) score -= 20;
    if (preferredCurrency && currency !== preferredCurrency && source !== 'json-ld') score -= 12;
    if (price < 2 && source !== 'json-ld') score -= 50;
    if (SUPPORTED_CURRENCIES.has(currency)) score += 8;
    if (price > 0 && price < 2000000) score += 5;

    return {
        price,
        currency,
        selector: selector || '',
        source,
        score,
        snippet: rawText.replace(/\s+/g, ' ').slice(0, 140)
    };
}

function extractFromRawPatterns(htmlString, preferredCurrency, targetUrl = '') {
    const candidates = [];
    const html = String(htmlString || '');
    if (!html) return candidates;

    const pushRaw = (rawPrice, rawCurrency, score, source, selector = '') => {
        const currency = rawCurrency && SUPPORTED_CURRENCIES.has(String(rawCurrency).toUpperCase())
            ? String(rawCurrency).toUpperCase()
            : preferredCurrency;
        const price = normalizePriceString(String(rawPrice), currency);
        if (!Number.isFinite(price) || price <= 0) return;
        candidates.push({
            price,
            currency,
            selector,
            source,
            score,
            snippet: `${rawPrice} ${currency}`
        });
    };

    const rePriceAmount = /"priceAmount"\s*:\s*"([^"]+)"/gi;
    for (const m of html.matchAll(rePriceAmount)) {
        pushRaw(m[1], preferredCurrency, 88, 'raw-json');
    }

    const reOffer = /"price"\s*:\s*"([^"]+)"[^}]{0,200}?"priceCurrency"\s*:\s*"([A-Z]{3})"/gi;
    for (const m of html.matchAll(reOffer)) {
        pushRaw(m[1], m[2], 90, 'raw-json');
    }

    return candidates;
}

function extractFromJsonLd($, preferredCurrency) {
    const candidates = [];
    $('script[type*="ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }

        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;

            if (Array.isArray(node)) {
                stack.push(...node);
                continue;
            }

            if (node.offers) {
                const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
                for (const offer of offers) {
                    if (!offer || typeof offer !== 'object') continue;
                    const priceValue = offer.price ?? offer.lowPrice ?? offer.highPrice;
                    const currency = (offer.priceCurrency || preferredCurrency || 'USD').toString().toUpperCase();
                    const price = normalizePriceString(String(priceValue ?? ''), currency);
                    if (Number.isFinite(price) && price > 0) {
                        candidates.push({
                            price,
                            currency: SUPPORTED_CURRENCIES.has(currency) ? currency : preferredCurrency,
                            selector: 'script[type="application/ld+json"]',
                            source: 'json-ld',
                            score: 95,
                            snippet: `${priceValue} ${currency}`
                        });
                    }
                }
            }

            for (const key of Object.keys(node)) {
                if (node[key] && typeof node[key] === 'object') stack.push(node[key]);
            }
        }
    });
    return candidates;
}

function collectSelectorCandidates($, selectors, preferredCurrency, source, scoreBase) {
    const candidates = [];
    for (const sel of selectors) {
        let elements;
        try {
            elements = $(sel);
        } catch {
            continue;
        }
        if (!elements || !elements.length) continue;
        elements.slice(0, 5).each((_, el) => {
            const text = $(el).attr('content')
                || $(el).attr('data-price')
                || $(el).attr('aria-label')
                || $(el).text();
            const candidate = buildCandidate(text, sel, source, preferredCurrency, scoreBase);
            if (candidate) candidates.push(candidate);
        });
    }
    return candidates;
}

function rankCandidates(candidates) {
    const dedup = new Map();
    for (const c of candidates) {
        const key = `${c.selector}|${c.price}|${c.currency}`;
        const existing = dedup.get(key);
        if (!existing || c.score > existing.score) dedup.set(key, c);
    }
    return Array.from(dedup.values()).sort((a, b) => b.score - a.score);
}

function parseHtml(htmlString, customSelector = null, targetUrl = '') {
    const $ = cheerio.load(htmlString);
    const { preferredCurrency, selectors: siteSelectors } = getDomainHints(targetUrl);
    const isAmazon = isAmazonTarget(targetUrl);
    const candidates = [];
    const availability = detectAvailability($, htmlString, targetUrl);

    candidates.push(...extractFromJsonLd($, preferredCurrency));
    if (!isAmazon) {
        candidates.push(...extractFromRawPatterns(htmlString, preferredCurrency, targetUrl));
    }

    if (customSelector) {
        const customSelectors = [
            customSelector,
            `#${customSelector}`,
            `.${customSelector}`,
            `[data-test-id="${customSelector}"]`,
            `[data-testid="${customSelector}"]`
        ];
        candidates.push(...collectSelectorCandidates($, customSelectors, preferredCurrency, 'custom', 88));
    }

    const selectors = isAmazon
        ? [...new Set([
            ...siteSelectors,
            'meta[property="og:price:amount"]',
            'meta[itemprop="price"]',
            'meta[property="product:price:amount"]'
        ])]
        : [...new Set([...siteSelectors, ...BASE_PRICE_SELECTORS])];
    candidates.push(...collectSelectorCandidates($, selectors, preferredCurrency, 'selector', 60));

    if (!isAmazon) {
        const priceLikeTexts = [];
        $('body *').slice(0, 1200).each((_, el) => {
            const txt = $(el).text();
            if (!txt) return;
            const compact = txt.replace(/\s+/g, ' ').trim();
            if (!compact || compact.length < 2 || compact.length > 140) return;
            if (/(price|fiyat|discount|sale|deal|ourprice|\u20ba|\u20ac|\u00a3|\$|TRY|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY)/i.test(compact)) {
                priceLikeTexts.push(compact);
            }
        });
        for (const txt of priceLikeTexts.slice(0, 120)) {
            const c = buildCandidate(txt, '', 'text', preferredCurrency, 30);
            if (c) candidates.push(c);
        }
    }

    const amazonScopedCandidates = isAmazon
        ? candidates.filter((c) => {
            const sel = String(c.selector || '').toLowerCase();
            if (c.source === 'custom') return true;
            if (sel.includes('#coreprice') || sel.includes('#priceblock_') || sel.includes('#price_inside_buybox') || sel.includes('#apex_') || sel.includes('twister-plus-price-data-price')) return true;
            if (sel.includes('meta[itemprop="price"]') || sel.includes('meta[property="og:price:amount"]') || sel.includes('meta[property="product:price:amount"]')) return true;
            return false;
        }).filter((c) => c.currency === preferredCurrency)
        : candidates;

    const ranked = rankCandidates(amazonScopedCandidates);
    const best = ranked[0] || null;
    const suggestions = ranked.slice(0, 5).map(c => ({
        selector: c.selector || '(text candidate)',
        snippet: c.snippet,
        score: c.score,
        price: c.price,
        currency: c.currency
    }));

    const shouldSuppressAmazonOutOfStockPrice = isAmazon
        && availability.status === 'out_of_stock'
        && Number(availability.confidence || 0) >= 80;

    const noPriceConfidence = (() => {
        const stockConf = Number(availability && availability.confidence);
        if (Number.isFinite(stockConf) && stockConf > 0 && availability && availability.status === 'out_of_stock') {
            return stockConf;
        }
        return 0;
    })();

    if (!best || shouldSuppressAmazonOutOfStockPrice) {
        return {
            price: null,
            currency: preferredCurrency,
            confidence: normalizeConfidence(noPriceConfidence),
            selectorUsed: null,
            source: null,
            suggestions,
            availability,
            debug: {
                isAmazon,
                candidateCount: candidates.length,
                rankedCount: ranked.length,
                suppressedPriceBecauseOutOfStock: shouldSuppressAmazonOutOfStockPrice,
                availabilitySignals: availability && availability.signals ? availability.signals : null
            }
        };
    }

    return {
        price: best.price,
        currency: best.currency || preferredCurrency,
        confidence: normalizeConfidence(best.score),
        selectorUsed: best.selector || null,
        source: best.source || null,
        suggestions,
        availability,
        debug: {
            isAmazon,
            candidateCount: candidates.length,
            rankedCount: ranked.length,
            suppressedPriceBecauseOutOfStock: false,
            availabilitySignals: availability && availability.signals ? availability.signals : null
        }
    };
}

function extractTitleFromHtml(htmlString) {
    const $ = cheerio.load(htmlString);
    const candidates = [
        $('meta[property="og:title"]').attr('content'),
        $('meta[name="twitter:title"]').attr('content'),
        $('h1').first().text(),
        $('title').first().text()
    ].map(v => String(v || '').trim()).filter(Boolean);
    if (!candidates.length) return null;
    return candidates[0].replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function refreshExchangeRates() {
    try {
        // External feed is best-effort; failures keep prior cached rates.
        const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 15000 });
        const rates = res.data && res.data.rates ? res.data.rates : null;
        if (!rates || typeof rates !== 'object') return;

        const nextRates = { ...exchangeRates };
        for (const code of SUPPORTED_CURRENCIES) {
            if (rates[code] && Number.isFinite(Number(rates[code])) && Number(rates[code]) > 0) {
                nextRates[code] = Number(rates[code]);
            }
        }
        nextRates.USD = 1;
        exchangeRates = nextRates;
    } catch (e) {
        console.warn('[FX] Could not refresh rates, using last known values:', e.message);
    }
}

function convertToUSD(amount, currency) {
    const c = String(currency || 'USD').toUpperCase();
    const rate = exchangeRates[c];
    if (!Number.isFinite(amount)) return null;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return amount;
    return amount / rate;
}

// Helper: Get or Init Browser
async function getBrowser() {
    if (browserInstance) {
        if (!browserInstance.isConnected()) {
            console.log('Browser disconnected, restarting...');
            await browserInstance.close().catch(() => { });
            browserInstance = null;
        } else {
            return browserInstance;
        }
    }

    console.log('Launching new Puppeteer instance...');
    const executablePath = resolveBrowserExecutablePath();
    if (process.env.PUPPETEER_EXECUTABLE_PATH && !executablePath) {
        console.warn(`[Browser] Configured PUPPETEER_EXECUTABLE_PATH not found: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }
    if (executablePath) {
        console.log(`[Browser] Using executable: ${executablePath}`);
    } else {
        console.log('[Browser] Using Puppeteer default browser resolution.');
    }
    browserInstance = await puppeteer.launch({
        headless: "new",
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(executablePath ? { executablePath } : {}),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080'
        ]
    });
    return browserInstance;
}

// Helper: Fetch with Puppeteer (Reusing Browser)
async function fetchWithPuppeteer(url) {
    let page = null;
    try {
        if (TEST_FETCH_DELAY_MS) {
            await delayMs(TEST_FETCH_DELAY_MS);
        }
        if (TEST_FAKE_FETCH_HTML) {
            return TEST_FAKE_FETCH_HTML;
        }

        const browser = await getBrowser();
        page = await browser.newPage();

        // Randomize Viewport
        await page.setViewport({ width: 1920, height: 1080 });

        // Set User Agent
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        await page.setUserAgent(userAgent);

        // Optimize: Block images/fonts/media
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Navigate
        // Using domcontentloaded is faster than 'networkidle0' but might miss late JS 
        // We add a small sleep to be safe.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Wait a bit for JS frameworks (React/Vue hydration)
        await new Promise(r => setTimeout(r, 2000));

        const html = await page.content();
        return html;

    } catch (e) {
        // If browser crashes, reset instance
        if (e.message.includes('Session closed') || e.message.includes('not opened')) {
            if (browserInstance) await browserInstance.close().catch(() => { });
            browserInstance = null;
        }
        throw new Error(`Puppeteer fetch failed: ${e.message}`);
    } finally {
        if (page) await page.close(); // Only close the page, keep browser open
    }
}

// --- Notifications & Webhooks ---
async function notifyAll(title, message, overrideSettings = null) {
    const effective = overrideSettings && typeof overrideSettings === 'object'
        ? { ...settings, ...overrideSettings }
        : settings;
    const result = {
        local: { attempted: true, success: true, error: null, channel: 'Local' },
        discord: { attempted: false, success: false, error: null, channel: 'Discord' },
        telegram: { attempted: false, success: false, error: null, channel: 'Telegram' }
    };

    // 1. Local Notification
    try {
        notifier.notify({
            title: title,
            message: message,
            sound: true,
            wait: true
        });
    } catch (e) {
        result.local.success = false;
        result.local.error = e.message;
        console.error('[Local Notification] Failed:', e.message);
    }

    // 2. Discord Webhook
    if (effective.discordWebhook) {
        result.discord.attempted = true;
        try {
            const discordUrl = buildDiscordWebhookUrl(effective.discordWebhook);
            await axios.post(discordUrl, {
                content: `**${title}**\n${message}`
            });
            result.discord.success = true;
        } catch (e) {
            result.discord.error = e.response
                ? `${e.response.status} ${JSON.stringify(e.response.data)}`
                : e.message;
            if (e.response) {
                console.error('[Discord Webhook] Failed:', e.response.status, JSON.stringify(e.response.data));
            } else {
                console.error('[Discord Webhook] Failed:', e.message);
            }
        }
    }

    // 3. Telegram Webhook (Simple bot implementation)
    if (effective.telegramWebhook && effective.telegramChatId) {
        result.telegram.attempted = true;
        try {
            const url = `https://api.telegram.org/bot${effective.telegramWebhook}/sendMessage`;
            await axios.post(url, {
                chat_id: effective.telegramChatId,
                text: `*${title}*\n${message}`,
                parse_mode: 'Markdown'
            });
            result.telegram.success = true;
        } catch (e) {
            result.telegram.error = e.response
                ? `${e.response.status} ${JSON.stringify(e.response.data)}`
                : e.message;
            console.error('[Telegram Webhook] Failed:', e.message);
        }
    }

    return result;
}

function summarizeTestNotificationResult(result) {
    const remoteResults = [result.discord, result.telegram].filter(channel => channel.attempted);
    if (!remoteResults.length) {
        return {
            ok: false,
            status: 400,
            message: 'No Discord webhook or Telegram destination is configured for the test.'
        };
    }

    const succeeded = remoteResults.filter(channel => channel.success);
    const failed = remoteResults.filter(channel => !channel.success);

    if (failed.length) {
        const sentText = succeeded.length
            ? `Sent via ${succeeded.map(channel => channel.channel).join(' and ')}. `
            : '';
        const failedText = failed
            .map(channel => `${channel.channel} failed: ${channel.error || 'Unknown error'}`)
            .join(' | ');
        return {
            ok: false,
            status: 502,
            message: `${sentText}${failedText}`.trim()
        };
    }

    return {
        ok: true,
        status: 200,
        message: `Test notification sent via ${succeeded.map(channel => channel.channel).join(' and ')}.`
    };
}

function getAlertRules() {
    return { ...DEFAULT_ALERT_RULES, ...(settings.alertRules || {}) };
}

function shouldSendAlert(alertKey, cooldownMinutes) {
    // Cooldown is tracked per alert key (e.g., "drop:itemId") to prevent notification spam.
    const now = Date.now();
    const key = String(alertKey || '');
    const cooldownMs = Math.max(1, Number(cooldownMinutes || DEFAULT_ALERT_RULES.notifyCooldownMinutes)) * 60 * 1000;
    const last = alertCooldownByKey.get(key) || 0;
    if ((now - last) < cooldownMs) return false;
    alertCooldownByKey.set(key, now);
    return true;
}

function findPriceNear24h(history, nowTs) {
    const points = Array.isArray(history) ? history : [];
    if (!points.length) return null;
    const targetTs = nowTs - (24 * 60 * 60 * 1000);
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const p of points) {
        const ts = new Date(p.date).getTime();
        if (!Number.isFinite(ts) || !Number.isFinite(Number(p.price))) continue;
        const delta = Math.abs(ts - targetTs);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = p;
        }
    }
    return best;
}

function buildDiscordWebhookUrl(rawWebhookUrl) {
    const webhookUrl = (rawWebhookUrl || '').trim();
    if (!webhookUrl || !DISCORD_PROXY_BASE) return webhookUrl;

    try {
        const parsed = new URL(webhookUrl);
        const match = parsed.pathname.match(/^\/api\/webhooks\/([^/]+)\/([^/]+)$/);
        if (!match) return webhookUrl;

        const webhookId = match[1];
        const webhookToken = match[2];
        const base = DISCORD_PROXY_BASE.replace(/\/+$/, '');
        return `${base}/webhooks/${webhookId}/${webhookToken}`;
    } catch {
        return webhookUrl;
    }
}

function createBackgroundCheckRunToken() {
    const token = ++backgroundCheckRunCounter;
    activeBackgroundCheckToken = token;
    return token;
}

function isBackgroundCheckRunActive(token) {
    return Boolean(token) && activeBackgroundCheckToken === token;
}

function invalidateActiveBackgroundCheck(reason = 'state restore') {
    if (!isChecking) return false;
    activeBackgroundCheckToken = ++backgroundCheckRunCounter;
    checkingItemId = null;
    console.warn(`[Background Check] Active run invalidated: ${reason}.`);
    return true;
}

// Background Task: Check Prices
async function checkPrices() {
    if (isChecking) return;
    isChecking = true;
    const runToken = createBackgroundCheckRunToken();
    console.log(`[${new Date().toLocaleTimeString()}] Starting background check...`);

    let updatedCount = 0;
    const rules = getAlertRules();
    try {
        const candidateIds = items.filter(item => !Boolean(item.purchased)).map(item => item.id);

        for (const itemId of candidateIds) {
            if (!isBackgroundCheckRunActive(runToken)) {
                console.warn('[Background Check] Stopping invalidated run before next item.');
                break;
            }
            const snapshotItem = items.find(item => item.id === itemId);
            if (!snapshotItem || Boolean(snapshotItem.purchased)) continue;

            checkingItemId = itemId;
            const fetchUrl = snapshotItem.url;
            const fetchSelector = normalizeSelectorValue(snapshotItem.selector);
            const nowIso = new Date().toISOString();
            const nowTs = Date.now();

            try {
                const html = await fetchWithPuppeteer(fetchUrl);
                const extraction = parseHtml(html, fetchSelector, fetchUrl);
                const persisted = await runItemsMutation(async () => {
                    if (!isBackgroundCheckRunActive(runToken)) {
                        return { skipped: true, reason: 'check-invalidated' };
                    }
                    const currentItem = items.find(item => item.id === itemId);
                    if (!currentItem || Boolean(currentItem.purchased)) {
                        return { skipped: true, reason: 'item-missing' };
                    }
                    if (itemSourceChanged(currentItem, fetchUrl, fetchSelector)) {
                        return { skipped: true, reason: 'source-changed' };
                    }

                    const result = buildSuccessfulCheckItem(currentItem, extraction, nowIso);
                    const currentPrice = result.price;
                    const oldPrice = Number(currentItem.currentPrice);

                    if (!result.isOutOfStock && currentPrice !== currentItem.currentPrice) {
                        if (rules.priceDropEnabled && Number.isFinite(oldPrice) && currentPrice < oldPrice) {
                            const dropAmount = (oldPrice - currentPrice).toFixed(2);
                            if (shouldSendAlert(`drop:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                                console.log(`[Price Drop] ${currentItem.name} dropped by ${dropAmount}!`);
                                notifyAll('Price Drop Alert', `${currentItem.name} is now ${currentPrice} (Was ${oldPrice})`);
                            }
                        }

                        if (rules.targetHitEnabled && currentItem.targetPrice && currentPrice <= currentItem.targetPrice && oldPrice > currentItem.targetPrice) {
                            if (shouldSendAlert(`target:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                                console.log(`[Target Hit] ${currentItem.name} hit target of ${currentItem.targetPrice}!`);
                                notifyAll('Target Price Hit', `${currentItem.name} is now ${currentPrice}, meeting your target of ${currentItem.targetPrice}!`);
                            }
                        }

                        if (rules.priceDrop24hEnabled && Array.isArray(currentItem.history) && currentItem.history.length > 1) {
                            const reference = findPriceNear24h(currentItem.history, nowTs);
                            if (reference && Number(reference.price) > 0) {
                                const pctDrop = ((Number(reference.price) - Number(currentPrice)) / Number(reference.price)) * 100;
                                if (pctDrop >= Number(rules.priceDrop24hPercent || 0) && currentPrice < oldPrice) {
                                    if (shouldSendAlert(`drop24h:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                                        notifyAll('24h Drop Alert', `${currentItem.name} dropped ${pctDrop.toFixed(2)}% in ~24h (now ${currentPrice}).`);
                                    }
                                }
                            }
                        }

                        if (rules.allTimeLowEnabled) {
                            const historyPrices = Array.isArray(currentItem.history)
                                ? currentItem.history.map(h => Number(h.price)).filter(Number.isFinite)
                                : [];
                            const minBefore = Math.min(...historyPrices, Number.isFinite(oldPrice) ? oldPrice : Number.POSITIVE_INFINITY);
                            if (currentPrice < minBefore) {
                                if (shouldSendAlert(`atl:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                                    notifyAll('All-Time Low', `${currentItem.name} reached a new all-time low at ${currentPrice}.`);
                                }
                            }
                        }
                    }

                    if (result.previousStockStatus !== 'out_of_stock' && result.isOutOfStock) {
                        if (shouldSendAlert(`oos-transition:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                            notifyAll('Out of Stock', `${currentItem.name} appears to be out of stock.`);
                        }
                    } else if (result.previousStockStatus === 'out_of_stock' && result.stockStatus === 'in_stock') {
                        if (shouldSendAlert(`back-in-stock:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                            notifyAll('Back in Stock', `${currentItem.name} appears to be back in stock.`);
                        }
                    }

                    if (
                        rules.lowConfidenceEnabled
                        && Number(result.nextItem.extractionConfidence || 0) > 0
                        && Number(result.nextItem.extractionConfidence) < Number(rules.lowConfidenceThreshold || 0)
                    ) {
                        if (shouldSendAlert(`lowconf:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                            notifyAll('Low Extraction Confidence', `${currentItem.name} confidence is ${Math.round(result.nextItem.extractionConfidence)}.`);
                        }
                    }

                    const savedItem = await replaceItemState(itemId, result.nextItem, { allowDuplicateCanonicalUrls: false });
                    return {
                        skipped: false,
                        savedItem,
                        price: currentPrice,
                        isOutOfStock: result.isOutOfStock,
                        extraction
                    };
                });

                if (persisted.skipped) {
                    if (persisted.reason === 'check-invalidated') {
                        console.warn('[Background Check] Discarded stale result after run invalidation.');
                        break;
                    }
                    continue;
                }

                updatedCount += 1;
                await addDiagnostic({
                    itemId: persisted.savedItem.id,
                    itemName: persisted.savedItem.name,
                    url: persisted.savedItem.url,
                    listId: persisted.savedItem.listId || 'default',
                    ok: true,
                    price: persisted.price,
                    currency: persisted.savedItem.currency,
                    confidence: persisted.extraction.confidence || 0,
                    source: persisted.extraction.source || null,
                    selectorUsed: persisted.extraction.selectorUsed || null,
                    stockStatus: persisted.savedItem.stockStatus,
                    outOfStock: persisted.isOutOfStock,
                    stockReason: persisted.savedItem.stockReason || '',
                    error: null
                }).catch((e) => {
                    console.error('[Diagnostics] Failed to append entry:', e.message);
                });
            } catch (error) {
                console.error(`Failed to check ${snapshotItem.name}: ${error.message}`);
                const persistedFailure = await runItemsMutation(async () => {
                    if (!isBackgroundCheckRunActive(runToken)) {
                        return { skipped: true, reason: 'check-invalidated' };
                    }
                    const currentItem = items.find(item => item.id === itemId);
                    if (!currentItem || Boolean(currentItem.purchased)) {
                        return { skipped: true, reason: 'item-missing' };
                    }
                    if (itemSourceChanged(currentItem, fetchUrl, fetchSelector)) {
                        return { skipped: true, reason: 'source-changed' };
                    }

                    if (rules.staleEnabled) {
                        const last = currentItem.lastChecked ? new Date(currentItem.lastChecked).getTime() : 0;
                        const staleMs = Number(rules.staleHours || 0) * 60 * 60 * 1000;
                        if (!last || (nowTs - last) > staleMs) {
                            if (shouldSendAlert(`stale:${currentItem.id}`, rules.notifyCooldownMinutes)) {
                                notifyAll('Stale Price Item', `${currentItem.name} has not had a successful check for over ${rules.staleHours}h.`);
                            }
                        }
                    }

                    const savedItem = await replaceItemState(
                        itemId,
                        buildFailedCheckItem(currentItem, error.message, nowIso),
                        { allowDuplicateCanonicalUrls: false }
                    );
                    return {
                        skipped: false,
                        savedItem
                    };
                });

                if (persistedFailure.skipped && persistedFailure.reason === 'check-invalidated') {
                    console.warn('[Background Check] Discarded stale failure result after run invalidation.');
                    break;
                }
                if (!persistedFailure.skipped) {
                    await addDiagnostic({
                        itemId: persistedFailure.savedItem.id,
                        itemName: persistedFailure.savedItem.name,
                        url: persistedFailure.savedItem.url,
                        listId: persistedFailure.savedItem.listId || 'default',
                        ok: false,
                        price: null,
                        currency: persistedFailure.savedItem.currency || null,
                        confidence: 0,
                        source: null,
                        selectorUsed: persistedFailure.savedItem.selector || null,
                        stockStatus: persistedFailure.savedItem.stockStatus || 'unknown',
                        outOfStock: false,
                        stockReason: persistedFailure.savedItem.stockReason || '',
                        error: error.message
                    }).catch((e) => {
                        console.error('[Diagnostics] Failed to append entry:', e.message);
                    });
                }
            }
            // Small pacing delay helps avoid bursty scraping patterns.
            if (!isBackgroundCheckRunActive(runToken)) {
                console.warn('[Background Check] Run invalidated after item processing.');
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        lastCheckTime = new Date();
        console.log(`[${new Date().toLocaleTimeString()}] Background check complete. Updated ${updatedCount} items.`);
    } catch (e) {
        console.error(`[Background Check] Failed: ${e.message}`);
    } finally {
        if (activeBackgroundCheckToken === runToken) {
            activeBackgroundCheckToken = 0;
        }
        checkingItemId = null;
        isChecking = false;
    }
}

// API Endpoints

// Get Items & Status
app.get('/api/items', (req, res) => {
    try {
        res.json({
            items: items,
            revision: itemsRevision,
            settingsRevision,
            listsStateToken: getListsStateToken(),
            status: {
                active: true,
                lastCheck: lastCheckTime,
                isChecking: isChecking,
                checkingItemId: checkingItemId || null
            }
        });
    } catch (e) {
        console.error('Error in /api/items:', e);
        res.status(500).json({ error: e.message });
    }
});

// Update Items (Add/Delete/Rename from UI)
app.post('/api/items', async (req, res) => {
    try {
        const body = isPlainObject(req.body) ? req.body : null;
        const rawItems = body ? body.items : req.body;
        const requestedRevision = Number(body && body.revision);
        const normalizedItems = await runItemsMutation(async () => {
            assertItemsRevision(requestedRevision);
            return persistItemsState(rawItems, { allowDuplicateCanonicalUrls: false });
        });
        res.json({ success: true, count: normalizedItems.length, items: normalizedItems, revision: itemsRevision });
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Invalid data format' });
    }
});

app.post('/api/items/create', async (req, res) => {
    try {
        const body = isPlainObject(req.body) ? req.body : {};
        const rawItem = isPlainObject(body.item) ? body.item : null;
        if (!rawItem) {
            return res.status(400).json({ error: 'Item payload is required' });
        }
        const normalizedItems = await runItemsMutation(async () => {
            assertItemsRevision(Number(body.revision));
            const seenIds = new Set(items.map(item => item.id));
            const nextItem = {
                ...rawItem,
                id: generateUniqueItemId(seenIds)
            };
            const savedItems = await persistItemsState([...items, nextItem], { allowDuplicateCanonicalUrls: false });
            return {
                savedItems,
                createdId: nextItem.id
            };
        });
        const createdItem = normalizedItems.savedItems.find(item => item.id === normalizedItems.createdId)
            || normalizedItems.savedItems[normalizedItems.savedItems.length - 1]
            || null;
        res.json(getItemsSuccessPayload({ item: createdItem }));
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to create item' });
    }
});

app.delete('/api/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await runItemsMutation(async () => {
            assertItemsRevision(Number(req.query.revision));
            if (!items.some(item => item.id === id)) {
                throw createApiError(404, 'Item not found');
            }
            await persistItemsState(items.filter(item => item.id !== id), { allowDuplicateCanonicalUrls: false });
        });
        res.json(getItemsSuccessPayload({ deletedId: id }));
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to delete item' });
    }
});

app.post('/api/items/:id/move', async (req, res) => {
    try {
        const { id } = req.params;
        const body = isPlainObject(req.body) ? req.body : {};
        const targetListId = normalizeOptionalString(body.listId, '');
        if (!targetListId) {
            return res.status(400).json({ error: 'List id is required' });
        }
        if (!(settings.lists || DEFAULT_LISTS).some(list => list.id === targetListId)) {
            return res.status(400).json({ error: 'List not found' });
        }
        const savedItem = await runItemsMutation(async () => {
            assertItemsRevision(Number(body.revision));
            const currentItem = items.find(item => item.id === id);
            if (!currentItem) {
                throw createApiError(404, 'Item not found');
            }
            return replaceItemState(id, { ...currentItem, listId: targetListId }, { allowDuplicateCanonicalUrls: false });
        });
        res.json(getItemsSuccessPayload({ item: savedItem }));
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to move item' });
    }
});

app.post('/api/items/:id/purchase', async (req, res) => {
    try {
        const { id } = req.params;
        const body = isPlainObject(req.body) ? req.body : {};
        const nextPurchased = Boolean(body.purchased);
        const savedItem = await runItemsMutation(async () => {
            assertItemsRevision(Number(body.revision));
            const currentItem = items.find(item => item.id === id);
            if (!currentItem) {
                throw createApiError(404, 'Item not found');
            }
            return replaceItemState(id, {
                ...currentItem,
                purchased: nextPurchased,
                purchasedAt: nextPurchased
                    ? (normalizeIsoDateStringOrNull(body.purchasedAt) || new Date().toISOString())
                    : null
            }, { allowDuplicateCanonicalUrls: false });
        });
        res.json(getItemsSuccessPayload({ item: savedItem }));
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to update purchased status' });
    }
});

app.post('/api/items/:id/check-result', async (req, res) => {
    try {
        const { id } = req.params;
        const body = isPlainObject(req.body) ? req.body : {};
        const savedItem = await runItemsMutation(async () => {
            assertItemsRevision(Number(body.revision));
            const currentItem = items.find(item => item.id === id);
            if (!currentItem) {
                throw createApiError(404, 'Item not found');
            }
            if (Boolean(currentItem.purchased)) {
                throw createApiError(400, 'Purchased items are excluded from refresh checks');
            }
            if (itemSourceChanged(currentItem, body.expectedUrl, body.expectedSelector)) {
                const message = 'Item changed during refresh. Reload and try again.';
                throw createApiError(409, message, getItemsConflictPayload(message));
            }

            if (body.error) {
                return replaceItemState(
                    id,
                    buildFailedCheckItem(currentItem, body.error, new Date().toISOString()),
                    { allowDuplicateCanonicalUrls: false }
                );
            }
            const extraction = isPlainObject(body.extraction) ? body.extraction : {};
            const { nextItem } = buildSuccessfulCheckItem(currentItem, extraction, new Date().toISOString());
            return replaceItemState(id, nextItem, { allowDuplicateCanonicalUrls: false });
        });

        res.json(getItemsSuccessPayload({ item: savedItem }));
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to persist check result' });
    }
});

// Manual Trigger
app.post('/api/check-now', (req, res) => {
    if (isChecking) return res.status(429).json({ error: 'Already checking' });
    checkPrices(); // Run async without awaiting
    res.json({ success: true, message: 'Background check started' });
});

// Test Notification
app.post('/api/test-notification', async (req, res) => {
    const body = req.body || {};
    const type = body.type;
    const testSettings = body.settings && typeof body.settings === 'object'
        ? {
            discordWebhook: String(body.settings.discordWebhook || '').trim() || settings.discordWebhook || '',
            telegramWebhook: String(body.settings.telegramWebhook || '').trim() || settings.telegramWebhook || '',
            telegramChatId: String(body.settings.telegramChatId || '').trim() || settings.telegramChatId || ''
        }
        : null;
    const result = type === 'target'
        ? await notifyAll('Test: Target Hit', 'This is a test notification for a target price hit.', testSettings)
        : await notifyAll('Test: Price Drop', 'This is a test notification for a generic price drop.', testSettings);
    const summary = summarizeTestNotificationResult(result);
    if (!summary.ok) {
        return res.status(summary.status).json({ error: summary.message, deliveries: result });
    }
    res.json({ success: true, message: summary.message, deliveries: result });
});

// Settings Endpoints
app.get('/api/settings', (req, res) => {
    res.json(getPublicSettingsSnapshot(settings));
});

app.post('/api/settings', async (req, res) => {
    try {
        const payload = await runStateMutation(async () => {
            const previousSettingsSnapshot = cloneJsonState(settings);
            const previousBackupSession = {
                keyBuffer: backupSession.keyBuffer ? Buffer.from(backupSession.keyBuffer) : null,
                salt: backupSession.salt,
                unlockedAt: backupSession.unlockedAt
            };
            let backupReencryptRollback = null;
            let settingsPersisted = false;
            let intervalRescheduled = false;
            try {
                const previousInterval = sanitizeCheckIntervalMs(settings.checkIntervalMs);
                const previousEncryption = normalizeBackupEncryptionConfig(settings.backupEncryption);
                const incoming = { ...(req.body || {}) };
                assertSettingsRevision(Number(incoming.revision));
                delete incoming.revision;
                const backupPassword = typeof incoming.backupPassword === 'string' ? incoming.backupPassword.trim() : '';
                const clearDiscordWebhook = Boolean(incoming.clearDiscordWebhook);
                const clearTelegramWebhook = Boolean(incoming.clearTelegramWebhook);
                const clearTelegramChatId = Boolean(incoming.clearTelegramChatId);

                delete incoming.backupPassword;
                delete incoming.backupPasswordConfigured;
                delete incoming.backupPasswordUpdatedAt;
                delete incoming.backupSessionUnlocked;
                delete incoming.discordWebhookConfigured;
                delete incoming.telegramWebhookConfigured;
                delete incoming.telegramChatIdConfigured;
                delete incoming.clearDiscordWebhook;
                delete incoming.clearTelegramWebhook;
                delete incoming.clearTelegramChatId;

                const incomingDiscordWebhook = typeof incoming.discordWebhook === 'string' ? incoming.discordWebhook : null;
                const incomingTelegramWebhook = typeof incoming.telegramWebhook === 'string' ? incoming.telegramWebhook : null;
                const incomingTelegramChatId = typeof incoming.telegramChatId === 'string' ? incoming.telegramChatId : null;

                delete incoming.discordWebhook;
                delete incoming.telegramWebhook;
                delete incoming.telegramChatId;

                const nextSettings = normalizeSettingsShape({
                    ...settings,
                    ...incoming,
                    discordWebhook: resolveSecretSettingValue(settings.discordWebhook, incomingDiscordWebhook, clearDiscordWebhook),
                    telegramWebhook: resolveSecretSettingValue(settings.telegramWebhook, incomingTelegramWebhook, clearTelegramWebhook),
                    telegramChatId: resolveSecretSettingValue(settings.telegramChatId, incomingTelegramChatId, clearTelegramChatId),
                    backupEncryption: previousEncryption ? getPersistentBackupEncryptionConfig(previousEncryption) : null
                });
                let backupPasswordUpdated = false;
                let nextBackupSession = null;

                if (backupPassword) {
                    if (!previousEncryption) {
                        const nextState = createBackupEncryptionStateFromPassword(backupPassword);
                        nextSettings.backupEncryption = nextState.config;
                        nextBackupSession = {
                            keyBuffer: nextState.keyBuffer,
                            salt: nextState.config.salt
                        };
                        backupPasswordUpdated = true;
                    } else if (!hasUnlockedBackupEncryptionSession(settings)) {
                        const unlocked = await validateBackupPasswordWithoutSession(backupPassword, settings);
                        nextBackupSession = {
                            keyBuffer: unlocked.keyBuffer,
                            salt: unlocked.config.salt
                        };
                    } else {
                        const currentConfig = getBackupEncryptionConfig(settings);
                        const currentKeyBuffer = getActiveBackupEncryptionKeyBuffer(settings);
                        const { keyBuffer: candidateKeyBuffer } = await validateBackupPasswordWithoutSession(backupPassword, settings);
                        const candidateVerifier = createBackupKeyVerifier(candidateKeyBuffer, currentConfig.salt);
                        if (backupVerifiersMatch(candidateVerifier, currentConfig.verifier)) {
                            nextBackupSession = {
                                keyBuffer: candidateKeyBuffer,
                                salt: currentConfig.salt
                            };
                        } else {
                            const nextState = createBackupEncryptionStateFromPassword(backupPassword);
                            await reencryptExistingBackups(nextState.config, nextState.keyBuffer, currentKeyBuffer);
                            nextSettings.backupEncryption = nextState.config;
                            nextBackupSession = {
                                keyBuffer: nextState.keyBuffer,
                                salt: nextState.config.salt
                            };
                            backupReencryptRollback = {
                                previousConfig: currentConfig,
                                previousKeyBuffer: currentKeyBuffer,
                                nextKeyBuffer: nextState.keyBuffer
                            };
                            backupPasswordUpdated = true;
                        }
                    }
                }

                const nextRuntimeSettings = applyEnvironmentSettings(nextSettings);
                await saveSettings(nextRuntimeSettings);
                settingsPersisted = true;
                settings = nextRuntimeSettings;
                bumpSettingsRevision();

                if (nextBackupSession) {
                    setBackupEncryptionSession(nextBackupSession.keyBuffer, nextBackupSession.salt);
                }

                if (settings.checkIntervalMs !== previousInterval) {
                    scheduleBackgroundChecks();
                    intervalRescheduled = true;
                    console.log(`[Scheduler] Background check interval updated to ${Math.round(settings.checkIntervalMs / 60000)} minutes.`);
                }

                if (backupPassword) {
                    const backupResult = await performBackup();
                    if (!backupResult.success) {
                        throw new Error(backupResult.error || backupResult.reason || 'Failed to create encrypted backup');
                    }
                }

                return {
                    success: true,
                    revision: settingsRevision,
                    checkIntervalMs: settings.checkIntervalMs,
                    backupPasswordConfigured: hasBackupEncryptionConfigured(),
                    backupPasswordUpdatedAt: settings.backupEncryption ? settings.backupEncryption.updatedAt || null : null,
                    backupSessionUnlocked: hasUnlockedBackupEncryptionSession(),
                    discordWebhookConfigured: Boolean(settings.discordWebhook),
                    telegramWebhookConfigured: Boolean(settings.telegramWebhook),
                    telegramChatIdConfigured: Boolean(settings.telegramChatId),
                    backupPasswordUpdated
                };
            } catch (e) {
                if (backupReencryptRollback) {
                    try {
                        await reencryptExistingBackups(
                            backupReencryptRollback.previousConfig,
                            backupReencryptRollback.previousKeyBuffer,
                            backupReencryptRollback.nextKeyBuffer
                        );
                    } catch (rollbackError) {
                        console.error('[Backup] Failed to roll back backup re-encryption:', rollbackError.message);
                    }
                }
                if (settingsPersisted) {
                    try {
                        await saveSettings(previousSettingsSnapshot);
                    } catch (rollbackError) {
                        console.error('[Settings] Failed to roll back settings save:', rollbackError.message);
                    }
                }
                settings = previousSettingsSnapshot;
                bumpSettingsRevision();
                if (previousBackupSession.keyBuffer) {
                    backupSession = {
                        keyBuffer: Buffer.from(previousBackupSession.keyBuffer),
                        salt: previousBackupSession.salt,
                        unlockedAt: previousBackupSession.unlockedAt
                    };
                } else {
                    clearBackupEncryptionSession();
                }
                if (intervalRescheduled) {
                    scheduleBackgroundChecks();
                }
                throw e;
            }
        });
        res.json(payload);
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(400).json({ error: e.message || 'Failed to save settings' });
    }
});

app.get('/api/lists', (req, res) => {
    res.json({
        lists: getListsSnapshot(),
        revision: settingsRevision,
        listsStateToken: getListsStateToken()
    });
});

app.post('/api/lists', async (req, res) => {
    try {
        const result = await runStateMutation(async () => {
            const body = req.body || {};
            assertSettingsRevision(Number(body.revision));
            const name = String(body.name || '').trim();
            if (!name) throw createApiError(400, 'List name is required');
            const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
            if (lists.some(l => String(l.name).toLowerCase() === name.toLowerCase())) {
                throw createApiError(400, 'List already exists');
            }
            const id = `list_${Date.now()}`;
            const nextLists = [...lists, { id, name }];
            const nextSettings = normalizeSettingsShape({ ...settings, lists: nextLists });
            await saveSettings(nextSettings);
            settings = nextSettings;
            bumpSettingsRevision();
            return { success: true, list: { id, name }, lists: getListsSnapshot(), revision: settingsRevision };
        });
        res.json(result);
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(500).json({ error: e.message || 'Failed to create list' });
    }
});

app.patch('/api/lists/:id', async (req, res) => {
    try {
        const result = await runStateMutation(async () => {
            const { id } = req.params;
            const body = req.body || {};
            assertSettingsRevision(Number(body.revision));
            const name = String(body.name || '').trim();
            if (!name) throw createApiError(400, 'List name is required');
            const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
            const idx = lists.findIndex(l => l.id === id);
            if (idx === -1) throw createApiError(404, 'List not found');
            if (lists.some((l, listIndex) => listIndex !== idx && String(l.name).toLowerCase() === name.toLowerCase())) {
                throw createApiError(400, 'List already exists');
            }
            const nextLists = lists.map((list, listIndex) => listIndex === idx ? { ...list, name } : list);
            const nextSettings = normalizeSettingsShape({ ...settings, lists: nextLists });
            await saveSettings(nextSettings);
            settings = nextSettings;
            bumpSettingsRevision();
            return { success: true, lists: getListsSnapshot(), revision: settingsRevision };
        });
        res.json(result);
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(500).json({ error: e.message || 'Failed to rename list' });
    }
});

app.post('/api/lists/:id/delete', async (req, res) => {
    try {
        const result = await runStateMutation(async () => {
            const { id } = req.params;
            const body = req.body || {};
            assertSettingsRevision(Number(body.revision));
            const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
            const idx = lists.findIndex(l => l.id === id);
            if (idx === -1) throw createApiError(404, 'List not found');
            if (lists.length <= 1) throw createApiError(400, 'Cannot delete the last list');
            if (id === 'default') throw createApiError(400, 'Default list cannot be deleted');

            let targetId = 'default';
            if (!lists.some(l => l.id === targetId)) {
                lists.unshift({ id: 'default', name: 'Default' });
                targetId = 'default';
            }

            const nextItems = items.map(item => {
                if ((item.listId || 'default') === id) {
                    return { ...item, listId: targetId };
                }
                return item;
            });
            const nextLists = lists.filter(l => l.id !== id);
            const nextSettings = normalizeSettingsShape({ ...settings, lists: nextLists });
            await runJsonFileTransaction([
                {
                    label: 'settings',
                    targetPath: SETTINGS_FILE,
                    nextValue: getPersistentSettingsSnapshot(nextSettings)
                },
                {
                    label: 'items',
                    targetPath: DATA_FILE,
                    nextValue: nextItems
                }
            ]);
            settings = nextSettings;
            bumpSettingsRevision();
            items = normalizeItemsForPersistence(nextItems, { allowDuplicateCanonicalUrls: false });
            bumpItemsRevision();
            return {
                success: true,
                movedTo: targetId,
                lists: getListsSnapshot(),
                items,
                revision: itemsRevision,
                settingsRevision
            };
        });
        res.json(result);
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(500).json({ error: e.message || 'Failed to delete list' });
    }
});

app.get('/api/alert-rules', (req, res) => {
    res.json({ alertRules: getAlertRules(), revision: settingsRevision });
});

app.post('/api/alert-rules', async (req, res) => {
    try {
        const result = await runStateMutation(async () => {
            const body = req.body || {};
            assertSettingsRevision(Number(body.revision));
            const incoming = { ...body };
            delete incoming.revision;
            const nextAlertRules = {
                ...DEFAULT_ALERT_RULES,
                ...(settings.alertRules || {}),
                ...incoming
            };
            const nextSettings = normalizeSettingsShape({ ...settings, alertRules: nextAlertRules });
            await saveSettings(nextSettings);
            settings = nextSettings;
            bumpSettingsRevision();
            return { success: true, alertRules: nextAlertRules, revision: settingsRevision };
        });
        res.json(result);
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(500).json({ error: e.message || 'Failed to save alert rules' });
    }
});

app.get('/api/diagnostics', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const itemId = req.query.itemId ? String(req.query.itemId) : null;
    const listId = req.query.listId ? String(req.query.listId) : null;
    const filtered = diagnostics.filter(d => {
        if (itemId && d.itemId !== itemId) return false;
        if (listId && d.listId !== listId) return false;
        return true;
    }).slice(0, limit);
    res.json({ entries: filtered, total: diagnostics.length });
});

app.delete('/api/diagnostics', async (req, res) => {
    try {
        await runStateMutation(async () => {
            const nextDiagnostics = [];
            await saveDiagnostics(nextDiagnostics);
            diagnostics = nextDiagnostics;
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to clear diagnostics' });
    }
});

app.get('/api/audit', (req, res) => {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 300)));
    res.json({ entries: auditLog.slice(0, limit), total: auditLog.length });
});

app.post('/api/audit', async (req, res) => {
    try {
        const body = req.body || {};
        const action = String(body.action || '').trim();
        if (!action) return res.status(400).json({ error: 'action is required' });
        const details = body.details && typeof body.details === 'object' ? body.details : {};
        const source = String(body.source || 'ui').trim() || 'ui';
        await addAuditEntry(action, details, source);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to write audit log' });
    }
});

app.delete('/api/audit', async (req, res) => {
    try {
        await runStateMutation(async () => {
            const nextAuditLog = [];
            await saveAuditLog(nextAuditLog);
            auditLog = nextAuditLog;
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to clear audit log' });
    }
});

// Selector Doctor: Test a selector
app.post('/api/test-selector', async (req, res) => {
    const { url, selector } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        await validateFetchUrl(url);
        const html = await fetchWithPuppeteer(url);
        const result = parseHtml(html, selector, url);
        res.json({
            success: true,
            price: result.price,
            currency: result.currency,
            confidence: result.confidence,
            source: result.source || null,
            selectorUsed: result.selectorUsed,
            suggestions: result.suggestions || [],
            availability: result.availability || { status: 'unknown', confidence: 0, reason: '', source: null },
            debug: result.debug || null
        });
    } catch (e) {
        const isValidationError = [
            'Invalid URL',
            'Only http/https URLs are allowed',
            'Refusing localhost fetch',
            'Host is not allowlisted',
            'Failed to resolve hostname',
            'Hostname has no DNS records',
            'Refusing private/link-local destination'
        ].includes(e.message);
        res.status(isValidationError ? 400 : 500).json({ error: e.message });
    }
});

app.post('/api/extract', async (req, res) => {
    const { url, selector } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        await validateFetchUrl(url);
        const html = await fetchWithPuppeteer(url);
        const result = parseHtml(html, selector || null, url);
        const title = extractTitleFromHtml(html);
        res.json({
            success: true,
            price: result.price,
            currency: result.currency,
            title: title,
            confidence: result.confidence,
            source: result.source || null,
            selectorUsed: result.selectorUsed,
            suggestions: result.suggestions || [],
            availability: result.availability || { status: 'unknown', confidence: 0, reason: '', source: null },
            debug: result.debug || null
        });
    } catch (e) {
        const isValidationError = [
            'Invalid URL',
            'Only http/https URLs are allowed',
            'Refusing localhost fetch',
            'Host is not allowlisted',
            'Failed to resolve hostname',
            'Hostname has no DNS records',
            'Refusing private/link-local destination'
        ].includes(e.message);
        res.status(isValidationError ? 400 : 500).json({ error: e.message });
    }
});

// Update specific item property (e.g. selector)
app.patch('/api/items/:id', async (req, res) => {
    try {
        const savedItem = await runItemsMutation(async () => {
            const { id } = req.params;
            const updates = isPlainObject(req.body) ? req.body : {};
            assertItemsRevision(Number(updates.revision));
            const index = items.findIndex(i => i.id === id);
            if (index === -1) {
                throw createApiError(404, 'Item not found');
            }

            const currentItem = items[index];
            const nextName = typeof updates.name === 'string' ? updates.name.trim() : currentItem.name;
            const nextUrl = typeof updates.url === 'string' ? updates.url.trim() : currentItem.url;
            const nextSelector = typeof updates.selector === 'string' ? updates.selector.trim() || null : (currentItem.selector || null);
            if (!nextName) {
                throw createApiError(400, 'Name is required');
            }
            if (!nextUrl) {
                throw createApiError(400, 'URL is required');
            }
            try {
                const parsedUrl = new URL(nextUrl);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    throw createApiError(400, 'Only http/https URLs are allowed');
                }
            } catch (error) {
                if (error.status) {
                    throw error;
                }
                throw createApiError(400, 'Invalid URL');
            }
            const nextCanonicalUrl = normalizeTrackedUrl(nextUrl);

            if (nextCanonicalUrl && items.some((item, itemIndex) => itemIndex !== index && normalizeTrackedUrl(item.canonicalUrl || item.url) === nextCanonicalUrl)) {
                throw createApiError(400, 'Item already tracked');
            }

            if (TEST_PATCH_DELAY_MS) {
                await delayMs(TEST_PATCH_DELAY_MS);
            }

            return replaceItemState(id, {
                ...currentItem,
                name: nextName,
                url: nextUrl,
                canonicalUrl: nextCanonicalUrl,
                selector: nextSelector
            }, { allowDuplicateCanonicalUrls: false });
        });
        res.json({ success: true, item: savedItem, revision: itemsRevision });
    } catch (e) {
        if (e.status && e.payload) {
            return res.status(e.status).json(e.payload);
        }
        res.status(getItemValidationStatus(e.message || '')).json({ error: e.message || 'Failed to update item' });
    }
});

// Backup System Endpoints
app.get('/api/backups', async (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            return res.json([]);
        }
        const files = (await fsPromises.readdir(BACKUP_DIR))
            .filter(f => (f.startsWith('prices-') || f.startsWith('manual-pre-restore-')) && f.endsWith('.json'));

        const backupStats = await Promise.all(files.map(async f => {
            const stats = await fsPromises.stat(path.join(BACKUP_DIR, f));
            let preview = { itemCount: null, listCount: null, rangeStart: null, rangeEnd: null, encrypted: false };
            try {
                preview = await readBackupSummary(f);
            } catch (error) {
                preview = {
                    itemCount: null,
                    listCount: null,
                    rangeStart: null,
                    rangeEnd: null,
                    encrypted: false,
                    unsupported: true,
                    corrupt: true,
                    error: error.message || 'Backup preview failed'
                };
            }
            return { name: f, date: stats.mtime, preview, encrypted: Boolean(preview && preview.encrypted) };
        }));

        backupStats.sort((a, b) => b.date - a.date); // Newest first
        res.json(backupStats);
    } catch (e) {
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

app.get('/api/backups/preview', async (req, res) => {
    const filename = String(req.query.filename || '').trim();
    if (!filename) return res.status(400).json({ error: 'Filename is required' });
    if (path.basename(filename) !== filename) return res.status(400).json({ error: 'Invalid filename' });
    const backupPath = path.join(BACKUP_DIR, filename);
    try {
        await fsPromises.access(backupPath);
        const preview = await readBackupSummary(filename);
        res.json({ success: true, filename, preview, encrypted: Boolean(preview && preview.encrypted) });
    } catch (e) {
        res.status(500).json({ error: `Failed preview: ${e.message}` });
    }
});

app.post('/api/backups/export', async (req, res) => {
    if (!hasBackupEncryptionConfigured()) {
        return res.status(400).json({ error: 'Set a backup password before exporting backups.' });
    }
    if (!(await ensureBackupEncryptionSessionUnlocked())) {
        return res.status(400).json({ error: 'Re-enter the backup password after restart before exporting backups.' });
    }

    try {
        const snapshot = buildBackupSnapshot();
        const encryptionConfig = getBackupEncryptionConfig();
        const envelope = buildEncryptedBackupEnvelope(
            snapshot,
            getActiveBackupEncryptionKeyBuffer(),
            encryptionConfig.salt
        );
        res.json({
            success: true,
            filename: `centsible-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
            backup: envelope
        });
    } catch (e) {
        res.status(500).json({ error: `Failed to export backup: ${e.message}` });
    }
});

app.post('/api/backups/import', async (req, res) => {
    const body = req.body || {};
    const backupInput = body.backup;
    const password = String(body.password || '');
    if (!backupInput) return res.status(400).json({ error: 'Backup payload is required' });

    try {
        await runStateMutation(async () => executeBackupRestore(backupInput, password));
        res.json({ success: true, message: 'Backup imported successfully' });
    } catch (e) {
        res.status(400).json({ error: `Failed to import backup: ${e.message}` });
    }
});

app.post('/api/backups/restore', async (req, res) => {
    const { filename, password = '' } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'Filename is required' });
    if (path.basename(filename) !== filename) return res.status(400).json({ error: 'Invalid filename' });

    const backupPath = path.join(BACKUP_DIR, filename);
    try {
        await fsPromises.access(backupPath);
        const raw = await fsPromises.readFile(backupPath, 'utf8');
        await runStateMutation(async () => executeBackupRestore(raw, password));
        res.json({ success: true, message: `Restored from ${filename}` });
    } catch (e) {
        res.status(400).json({ error: `Failed to restore: ${e.message}` });
    }
});

function isPrivateOrSpecialIp(ipAddress) {
    const family = net.isIP(ipAddress);
    if (!family) return true;

    if (family === 4) {
        const octets = ipAddress.split('.').map(Number);
        const [a, b] = octets;
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        return false;
    }

    const normalized = ipAddress.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    return false;
}

async function validateFetchUrl(rawUrl) {
    // SSRF guardrail: parse URL, validate protocol, resolve DNS, reject local/private targets.
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are allowed');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost') {
        throw new Error('Refusing localhost fetch');
    }

    if (FETCH_ALLOWED_HOSTS.length && !FETCH_ALLOWED_HOSTS.includes(hostname)) {
        throw new Error('Host is not allowlisted');
    }

    let resolved;
    try {
        resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new Error('Failed to resolve hostname');
    }

    if (!resolved.length) {
        throw new Error('Hostname has no DNS records');
    }

    if (resolved.some(record => isPrivateOrSpecialIp(record.address))) {
        throw new Error('Refusing private/link-local destination');
    }
}

// Proxy Fetch (for UI immediate checks)
app.get('/api/fetch', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });

    try {
        await validateFetchUrl(url);
        console.log(`[Proxy] Fetching: ${url}`);
        const html = await fetchWithPuppeteer(url);
        res.send(html);
    } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        const isValidationError = [
            'Invalid URL',
            'Only http/https URLs are allowed',
            'Refusing localhost fetch',
            'Host is not allowlisted',
            'Failed to resolve hostname',
            'Hostname has no DNS records',
            'Refusing private/link-local destination'
        ].includes(error.message);
        res.status(isValidationError ? 400 : 500).json({ error: error.message });
    }
});


// Initialization
(async () => {
    await recoverPendingJsonFileTransaction();
    await migrateLegacyProjectRootData();
    await loadSettings();
    await loadData();
    await loadDiagnostics();
    await loadAuditLog();
    if (!DISABLE_STARTUP_NETWORK) {
        await refreshExchangeRates();
    }

    // Start Background Job
    const activeCheckIntervalMs = DISABLE_SCHEDULED_JOBS
        ? sanitizeCheckIntervalMs(settings.checkIntervalMs)
        : scheduleBackgroundChecks();
    if (!DISABLE_SCHEDULED_JOBS && !DISABLE_STARTUP_NETWORK) {
        setInterval(refreshExchangeRates, 60 * 60 * 1000);
    }

    // Initial check (optional, but good to have recent data on startup)
    // checkPrices(); 

    // Perform initial backup
    if (!DISABLE_SCHEDULED_JOBS) {
        await performBackup();
        // Schedule daily backups
        setInterval(() => performBackup(), 24 * 60 * 60 * 1000);
    }

    const server = app.listen(PORT, () => {
        console.log(`[Storage] Using data path: ${DATA_ROOT}`);
        if (hasExplicitCorsAllowlist) {
            console.log(`[CORS] Restricted mode. Allowed origins: ${allowedOrigins.join(', ')}`);
        } else {
            console.log('[CORS] Open mode. Set ALLOWED_ORIGINS to enforce an origin allowlist.');
        }
        console.log(`
Centsible Server (with Persistence) running on http://localhost:${PORT}
-------------------------------------------------------
Background checks running every ${activeCheckIntervalMs / 60000} minutes.
        `);
    });

    // Graceful Shutdown
    const shutdown = async () => {
        console.log('Shutting down...');
        if (browserInstance) {
            console.log('Closing browser...');
            await browserInstance.close().catch((e) => {
                console.warn('[Shutdown] Browser close warning:', e.message);
            });
            browserInstance = null;
        }
        server.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });
        // Force exit if hanging
        setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

})();




