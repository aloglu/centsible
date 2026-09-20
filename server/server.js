const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { createValidator } = require('./lib/network');
const crypto = require('crypto');
const { parseHtml, extractTitleFromHtml, assessExtraction } = require('./lib/extraction');
const { BrowserFetcher } = require('./lib/browser');
const { Store } = require('./lib/store');
const { extractionOptions } = require('./lib/currency');
const { deliver } = require('./lib/delivery');
const { emptyRuntime, channelsFor, enqueue, prune, evaluateAlerts, evaluateHealth } = require('./lib/alerts');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = process.env.CENTSIBLE_PROJECT_ROOT
    ? path.resolve(process.env.CENTSIBLE_PROJECT_ROOT)
    : path.join(__dirname, '../');
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, 'data');
const DATA_ROOT = process.env.DATA_DIR
    ? path.resolve(PROJECT_ROOT, process.env.DATA_DIR)
    : DEFAULT_DATA_ROOT;
const DATA_FILE = 'items';
const SETTINGS_FILE = 'settings';
const DIAGNOSTICS_FILE = 'diagnostics';
const AUDIT_FILE = 'audit';
const store = new Store(DATA_ROOT);
let runtime = normalizeRuntime(store.get('runtime', null));
const startedAt = Date.now();
const BACKUP_DIR = path.join(DATA_ROOT, 'backups');
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_CHECK_INTERVAL_MS = 24 * 24 * 60 * 60 * 1000; // Keep below the Node timer limit
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
const validateFetchUrl = createValidator(FETCH_ALLOWED_HOSTS);
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
const browserFetcher = new BrowserFetcher({ validateUrl: validateFetchUrl, executablePath: resolveBrowserExecutablePath() });
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

async function commitState(entries) {
    store.transaction(() => {
        for (const entry of entries) store.set(entry.targetPath, entry.nextValue);
    });
}

async function loadSettings() {
    try {
        const fileSettings = store.get(SETTINGS_FILE, {});
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
        throw new Error(`Settings could not be loaded: ${e.message}`);
    }
}

async function saveSettings(nextSettings = settings) {
    try {
        store.write(SETTINGS_FILE, getPersistentSettingsSnapshot(nextSettings));
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
    diagnostics = normalizeDiagnosticsEntries(store.get(DIAGNOSTICS_FILE, []));
}

async function saveDiagnostics(nextDiagnostics = diagnostics) {
    try {
        store.write(DIAGNOSTICS_FILE, normalizeDiagnosticsEntries(nextDiagnostics));
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
    auditLog = normalizeAuditEntries(store.get(AUDIT_FILE, []));
}

async function saveAuditLog(nextAuditLog = auditLog) {
    try {
        store.write(AUDIT_FILE, normalizeAuditEntries(nextAuditLog));
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
        audit: cloneJsonState(Array.isArray(auditLog) ? auditLog : []),
        runtime: cloneJsonState(runtime)
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

async function performBackup({ alreadyLocked = false } = {}) {
    const work = async () => {
        const result = await writeNamedBackup(`prices-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        const next = { ...runtime, backup: { lastAttempt: new Date().toISOString(),
            lastSuccess: result.success ? new Date().toISOString() : runtime.backup?.lastSuccess || null,
            error: result.success ? null : result.reason || result.error } };
        store.write('runtime', next); runtime = next;
        return result;
    };
    return alreadyLocked ? work() : runStateMutation(work);
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

    transactionEntries.push({ targetPath: 'runtime', nextValue: normalizedSnapshot.runtime });
    await commitState(transactionEntries);

    items = nextItems;
    bumpItemsRevision();
    settings = nextSettings;
    bumpSettingsRevision();
    diagnostics = nextDiagnostics;
    auditLog = nextAudit;
    runtime = normalizedSnapshot.runtime;
    deliveryGeneration++;
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
        audit: normalizeAuditEntries(snapshot.audit),
        runtime: normalizeRuntime(snapshot.runtime)
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

// Helper Functions
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
            createdAt: normalizeIsoDateStringOrNull(item.createdAt) || new Date().toISOString(),
            listId: nextListId,
            selector: normalizeOptionalStringOrNull(item.selector),
            ...extractionOptions(item),
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
    // A malformed database is a startup error, never an empty collection that
    // could later overwrite existing state.
    items = normalizeItemsForPersistence(store.get(DATA_FILE, []), { allowDuplicateCanonicalUrls: false });
    bumpItemsRevision();
    console.log(`Loaded ${items.length} items from database.`);
}

async function saveData(nextItems = items, options = {}) {
    try {
        const normalized = normalizeItemsForPersistence(nextItems, options);
        store.write(DATA_FILE, normalized);
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

function itemSourceChanged(currentItem, expectedUrl, expectedSelector, expectedOptions = {}) {
    const normalizedExpectedUrl = normalizeOptionalString(expectedUrl, currentItem.url);
    const normalizedExpectedSelector = normalizeSelectorValue(expectedSelector);
    return currentItem.url !== normalizedExpectedUrl
        || normalizeSelectorValue(currentItem.selector) !== normalizedExpectedSelector
        || JSON.stringify(extractionOptions(currentItem)) !== JSON.stringify(extractionOptions(expectedOptions));
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
    if (!isOutOfStock && extraction && extraction.currency) nextItem.currency = extraction.currency;
    nextItem.lastSelectorUsed = extraction?.selectorUsed || null;
    nextItem.extractionConfidence = extraction && extraction.confidence ? extraction.confidence : (nextItem.extractionConfidence || 0);
    nextItem.stockStatus = stockStatus;
    if (stockStatus !== 'unknown') nextItem.lastKnownStockStatus = stockStatus;
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
    nextItem.lastCheckErrorCode = null;
    nextItem.retryAt = null;
    nextItem.consecutiveFailures = 0;
    nextItem.pendingPrice = null;
    nextItem.currency = nextItem.currency || null;
    if (!isOutOfStock && Number.isFinite(price)) {
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
        consecutiveFailures: Number(currentItem.consecutiveFailures || 0) + 1,
        lastCheckError: normalizeOptionalString(errorMessage, 'Check failed')
    };
}

function getItemValidationStatus(errorMessage = '') {
    return errorMessage && (
        errorMessage.startsWith('Invalid')
        || errorMessage.startsWith('Unsupported currency')
        || errorMessage.startsWith('Currency override')
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

async function fetchWithPuppeteer(url, selector = null) {
    if (TEST_FETCH_DELAY_MS) await delayMs(TEST_FETCH_DELAY_MS);
    if (TEST_FAKE_FETCH_HTML) return TEST_FAKE_FETCH_HTML;
    return browserFetcher.fetch(url, selector);
}

// --- Notifications & Webhooks ---
async function notifyAll(title, message, overrideSettings = null) {
    const effective = { ...settings, ...(overrideSettings || {}) };
    effective.discordWebhook = buildDiscordWebhookUrl(effective.discordWebhook);
    const result = {};
    await Promise.all(['discord', 'telegram'].map(async channel => {
        const attempted = channelsFor(effective).includes(channel);
        result[channel] = { attempted, success: false, channel: channel === 'discord' ? 'Discord' : 'Telegram' };
        if (attempted) Object.assign(result[channel], await deliver(channel, { title, message }, effective));
    }));
    return result;
}

function normalizeRuntime(value) {
    if (value == null) return emptyRuntime();
    if (!isPlainObject(value) || !Array.isArray(value.events) || !isPlainObject(value.cooldowns)) throw new Error('Invalid notification state');
    for (const event of value.events) {
        if (!event || typeof event.id !== 'string' || typeof event.key !== 'string' || typeof event.title !== 'string'
            || typeof event.message !== 'string' || !isPlainObject(event.channels) || !Number.isFinite(Date.parse(event.createdAt))) throw new Error('Invalid notification event');
        for (const [channel, state] of Object.entries(event.channels)) {
            if (!['discord', 'telegram'].includes(channel) || !state || !Number.isFinite(state.attempts)
                || !Number.isFinite(state.nextAttempt)) throw new Error('Invalid notification delivery state');
        }
    }
    return { ...emptyRuntime(), ...cloneJsonState(value) };
}

let deliveryRunning = false;
let deliveryGeneration = 0;
let maintenanceTimer = null;
let stopping = false;
async function processNotifications() {
    if (deliveryRunning || stopping) return;
    deliveryRunning = true;
    try {
        // Bound each pass. Channels run independently, so an unavailable
        // destination never blocks the other channel's queue.
        await Promise.all(['discord', 'telegram'].map(async channel => {
            if (Number(runtime.channelRetryAt?.[channel] || 0) > Date.now()) return;
            const due = runtime.events.filter(event => {
                const state = event.channels[channel];
                return state && !state.deliveredAt && state.nextAttempt <= Date.now();
            }).slice(0, 10);
            for (const event of due) {
                if (stopping) break;
                const generation = deliveryGeneration;
                const effective = { ...settings, discordWebhook: buildDiscordWebhookUrl(settings.discordWebhook) };
                const result = await deliver(channel, event, effective, { attempts: event.channels[channel].attempts + 1 });
                await runStateMutation(async () => {
                    // A restore may have replaced the queue while delivery was in flight.
                    const current = runtime.events.find(candidate => candidate.id === event.id);
                    if (generation !== deliveryGeneration || !current || current.channels[channel].deliveredAt) return;
                    const next = cloneJsonState(runtime);
                    const state = next.events.find(candidate => candidate.id === event.id).channels[channel];
                    state.attempts += 1;
                    state.lastAttempt = new Date().toISOString();
                    state.error = result.error;
                    if (result.success) state.deliveredAt = state.lastAttempt;
                    else {
                        state.nextAttempt = Date.now() + result.retryAfterMs;
                        next.channelRetryAt = { ...next.channelRetryAt, [channel]: state.nextAttempt };
                    }
                    prune(next);
                    store.write('runtime', next);
                    runtime = next;
                });
                // Honor destination rate limits across the channel, not just one event.
                if (!result.success) break;
                await delayMs(300);
            }
        }));
    } catch (error) {
        console.error('[Delivery]', error.message);
    } finally { deliveryRunning = false; }
}

async function runHealthChecks() {
    if (stopping) return;
    await runStateMutation(async () => {
        const nextRuntime = cloneJsonState(runtime);
        const changed = [];
        for (const item of items) {
            if (evaluateHealth(item, getAlertRules(), nextRuntime, settings)) changed.push({ ...item, healthAlerted: true });
        }
        prune(nextRuntime);
        if (!changed.length && JSON.stringify(nextRuntime) === JSON.stringify(runtime)) return;
        store.transaction(() => {
            for (const item of changed) store.updateItem(item);
            store.set('runtime', nextRuntime);
        });
        for (const item of changed) items[items.findIndex(i => i.id === item.id)] = item;
        if (changed.length) bumpItemsRevision();
        runtime = nextRuntime;
    });
    await processNotifications();
}

function healthSnapshot() {
    const active = items.filter(item => !item.purchased);
    const staleMs = Math.max(1, Number(getAlertRules().staleHours) || 12) * 3600000;
    const pending = runtime.events.filter(e => Object.values(e.channels).some(c => !c.deliveredAt));
    const failed = pending.filter(e => Object.values(e.channels).some(c => c.error));
    const lastProgress = Date.parse(runtime.lastCheckCompleted || runtime.lastCheckStarted) || startedAt;
    const overdue = active.length > 0 && Date.now() - lastProgress > Math.max(settings.checkIntervalMs * 2, 15 * 60000);
    return {
        version: require('./package.json').version,
        startedAt: new Date(startedAt).toISOString(),
        lastCheckStarted: runtime.lastCheckStarted, lastCheckCompleted: runtime.lastCheckCompleted,
        checking: isChecking, overdue,
        failingItems: active.filter(i => i.lastCheckStatus === 'fail').length,
        staleItems: active.filter(i => Date.now() - (Date.parse(i.lastChecked || i.createdAt) || startedAt) > staleMs).length,
        pendingNotifications: pending.length, failedNotifications: failed.length,
        channels: channelsFor(settings),
        backup: { ...runtime.backup, configured: hasBackupEncryptionConfigured(settings), unlocked: hasUnlockedBackupEncryptionSession(settings) },
        deliveries: runtime.events.slice(-30).reverse().map(e => ({ id: e.id, title: e.title, createdAt: e.createdAt, channels: e.channels }))
    };
}

// Caller holds the state mutation queue. Persist trusted price + alert intent in
// one transaction, then publish memory and start delivery after commit.
async function persistCheck(currentItem, extraction, errorMessage = null, nowIso = new Date().toISOString()) {
    const nextRuntime = cloneJsonState(runtime);
    let nextItem;
    let checkError = typeof errorMessage === 'object' && errorMessage ? errorMessage.message : errorMessage;
    if (!checkError) {
        checkError = assessExtraction(currentItem, extraction, Date.parse(nowIso));
    }
    if (checkError) {
        nextItem = buildFailedCheckItem(currentItem, checkError, nowIso);
        nextItem.lastCheckErrorCode = errorMessage?.code || 'extraction_failed';
        nextItem.retryAt = Number.isFinite(errorMessage?.retryAt) ? errorMessage.retryAt : null;
        if (checkError.startsWith('Confirming unusual price')) {
            const previous = currentItem.pendingPrice;
            nextItem.pendingPrice = previous && previous.currency === extraction.currency
                && Math.abs(previous.price - extraction.price) / extraction.price <= 0.01
                && Date.parse(nowIso) - Date.parse(previous.at) <= 86400000
                ? previous : { price: extraction.price, currency: extraction.currency, at: nowIso };
        } else nextItem.pendingPrice = null;
        const rules = getAlertRules();
        if (rules.lowConfidenceEnabled && extraction && Number(extraction.confidence || 0) < Number(rules.lowConfidenceThreshold || 55)) {
            if (enqueue(nextRuntime, settings, `lowconf:${currentItem.id}`, 'Low Extraction Confidence', `${currentItem.name}: ${checkError}\n${currentItem.url}`, Date.parse(nowIso), rules.notifyCooldownMinutes)) nextItem.healthAlerted = true;
        }
        if (evaluateHealth(nextItem, rules, nextRuntime, settings, Date.parse(nowIso))) nextItem.healthAlerted = true;
    } else {
        nextItem = buildSuccessfulCheckItem(currentItem, extraction, nowIso).nextItem;
        evaluateAlerts(currentItem, nextItem, getAlertRules(), nextRuntime, settings, Date.parse(nowIso));
    }
    const normalized = normalizeIncomingItems([nextItem], currentItem.listId || 'default', { repairIds: false }).items[0];
    store.transaction(() => { store.updateItem(normalized); store.set('runtime', nextRuntime); });
    items[items.findIndex(item => item.id === currentItem.id)] = normalized;
    runtime = nextRuntime;
    bumpItemsRevision();
    if (!DISABLE_SCHEDULED_JOBS) setImmediate(() => processNotifications());
    return normalized;
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
    try {
        await runStateMutation(async () => {
            const next = { ...runtime, lastCheckStarted: new Date().toISOString() };
            store.write('runtime', next); runtime = next;
        });
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
                const html = await fetchWithPuppeteer(fetchUrl, fetchSelector);
                const extraction = parseHtml(html, fetchSelector, fetchUrl, snapshotItem);
                const persisted = await runItemsMutation(async () => {
                    if (!isBackgroundCheckRunActive(runToken)) {
                        return { skipped: true, reason: 'check-invalidated' };
                    }
                    const currentItem = items.find(item => item.id === itemId);
                    if (!currentItem || Boolean(currentItem.purchased)) {
                        return { skipped: true, reason: 'item-missing' };
                    }
                    if (itemSourceChanged(currentItem, fetchUrl, fetchSelector, snapshotItem)) {
                        return { skipped: true, reason: 'source-changed' };
                    }

                    const savedItem = await persistCheck(currentItem, extraction, null, new Date().toISOString());
                    return { skipped: false, savedItem, price: savedItem.currentPrice,
                        isOutOfStock: savedItem.stockStatus === 'out_of_stock', extraction };
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
                    ok: persisted.savedItem.lastCheckStatus === 'ok',
                    price: persisted.price,
                    currency: persisted.savedItem.currency,
                    confidence: persisted.extraction.confidence || 0,
                    source: persisted.extraction.source || null,
                    selectorUsed: persisted.extraction.selectorUsed || null,
                    stockStatus: persisted.savedItem.stockStatus,
                    outOfStock: persisted.isOutOfStock,
                    stockReason: persisted.savedItem.stockReason || '',
                    error: persisted.savedItem.lastCheckError || null
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
                    if (itemSourceChanged(currentItem, fetchUrl, fetchSelector, snapshotItem)) {
                        return { skipped: true, reason: 'source-changed' };
                    }

                    const savedItem = await persistCheck(currentItem, null, error, new Date().toISOString());
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
        await runStateMutation(async () => {
            const next = { ...runtime, lastCheckCompleted: lastCheckTime.toISOString() };
            store.write('runtime', next); runtime = next;
        });
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

app.get('/api/health', (_req, res) => res.json(healthSnapshot()));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

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
            if (itemSourceChanged(currentItem, body.expectedUrl, body.expectedSelector, { currencyOverride: body.expectedCurrencyOverride, priceLocale: body.expectedPriceLocale })) {
                const message = 'Item changed during refresh. Reload and try again.';
                throw createApiError(409, message, getItemsConflictPayload(message));
            }

            return persistCheck(currentItem, isPlainObject(body.extraction) ? body.extraction : {}, body.error ? { message: body.error, code: body.errorCode, retryAt: body.retryAt } : null);

        });

        await addDiagnostic({ itemId: savedItem.id, itemName: savedItem.name, url: savedItem.url,
            listId: savedItem.listId, ok: savedItem.lastCheckStatus === 'ok', price: savedItem.currentPrice,
            currency: savedItem.currency, confidence: savedItem.extractionConfidence,
            selectorUsed: savedItem.lastSelectorUsed, stockStatus: savedItem.stockStatus,
            outOfStock: savedItem.stockStatus === 'out_of_stock', error: savedItem.lastCheckError || null });
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
                    const backupResult = await performBackup({ alreadyLocked: true });
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
            await commitState([
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
        extractionOptions(req.body);
        await validateFetchUrl(url);
        const html = await fetchWithPuppeteer(url, selector);
        const result = parseHtml(html, selector, url, req.body);
        res.json({
            success: true,
            price: result.price,
            currency: result.currency,
            confidence: result.confidence,
            rejection: result.rejection || null,
            source: result.source || null,
            selectorUsed: result.selectorUsed,
            suggestions: result.suggestions || [],
            availability: result.availability || { status: 'unknown', confidence: 0, reason: '', source: null },
            debug: result.debug || null
        });
    } catch (e) {
        const invalid = /Invalid|Unsupported currency|Only http|Refusing|allowlisted|hostname|DNS|Credentials/.test(e.message);
        if (e.retryAt) res.set('Retry-After', String(Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000))));
        res.status(e.code === 'retry_later' || e.code === 'rate_limited' ? 429 : invalid ? 400 : 502)
            .json({ error: e.message, code: e.code || 'extraction_failed', retryAt: e.retryAt || null });
    }
});

app.post('/api/extract', async (req, res) => {
    const { url, selector } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        extractionOptions(req.body);
        await validateFetchUrl(url);
        const html = await fetchWithPuppeteer(url, selector);
        const result = parseHtml(html, selector || null, url, req.body);
        const title = extractTitleFromHtml(html);
        res.json({
            success: true,
            price: result.price,
            currency: result.currency,
            title: title,
            confidence: result.confidence,
            rejection: result.rejection || null,
            source: result.source || null,
            selectorUsed: result.selectorUsed,
            suggestions: result.suggestions || [],
            availability: result.availability || { status: 'unknown', confidence: 0, reason: '', source: null },
            debug: result.debug || null
        });
    } catch (e) {
        const invalid = /Invalid|Unsupported currency|Only http|Refusing|allowlisted|hostname|DNS|Credentials/.test(e.message);
        if (e.retryAt) res.set('Retry-After', String(Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000))));
        res.status(e.code === 'retry_later' || e.code === 'rate_limited' ? 429 : invalid ? 400 : 502)
            .json({ error: e.message, code: e.code || 'extraction_failed', retryAt: e.retryAt || null });
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
            const options = extractionOptions({ ...currentItem, ...updates });
            if (options.currencyOverride && currentItem.currency && options.currencyOverride !== currentItem.currency) {
                throw new Error(`Currency override conflicts with existing ${currentItem.currency} history. Add a new item to track a different currency.`);
            }
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
                selector: nextSelector,
                ...options,
                pendingPrice: null
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

// Initialization
(async () => {
    await loadSettings();
    await loadData();
    await loadDiagnostics();
    await loadAuditLog();
    if (BACKUP_PASSWORD_ENV && hasBackupEncryptionConfigured(settings)) await ensureBackupEncryptionSessionUnlocked(settings);
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

    if (!DISABLE_SCHEDULED_JOBS) {
        maintenanceTimer = setInterval(() => runHealthChecks().catch(e => console.error('[Health]', e.message)), 30000);
        setImmediate(() => { checkPrices(); runHealthChecks().catch(e => console.error('[Health]', e.message)); });
    }

    // Perform initial backup
    if (!DISABLE_SCHEDULED_JOBS) {
        await performBackup();
        // Schedule daily backups
        setInterval(() => performBackup().catch(e => console.error('[Backup]', e.message)), 24 * 60 * 60 * 1000);
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
        stopping = true;
        const shutdownDeadline = setTimeout(() => process.exit(1), 20000);
        shutdownDeadline.unref();
        clearInterval(checkIntervalHandle);
        clearInterval(maintenanceTimer);
        await browserFetcher.close().catch(e => console.warn('[Browser]', e.message));
        server.close(() => {
            console.log('Server closed.');
            store.close();
            process.exit(0);
        });

    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

})().catch(error => { console.error('[Startup]', error.message); process.exitCode = 1; });




