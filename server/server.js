const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const notifier = require('node-notifier'); // Notifications

require('dotenv').config({ path: path.join(__dirname, '../.env') });

puppeteer.use(StealthPlugin());

// ... imports ...

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, '../prices.json');
const SETTINGS_FILE = path.join(__dirname, '../settings.json');
const DIAGNOSTICS_FILE = path.join(__dirname, '../diagnostics.json');
const BACKUP_DIR = path.join(__dirname, '../backups');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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

function normalizeOrigin(origin) {
    if (!origin) return '';
    try {
        return new URL(origin).origin.toLowerCase();
    } catch (_) {
        return String(origin).trim().replace(/\/+$/, '').toLowerCase();
    }
}

function resolveBrowserExecutablePath() {
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
let lastCheckTime = null;
let isChecking = false;
let checkingItemId = null;
let browserInstance = null; // Single persistent browser
let diagnostics = [];
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
    alertRules: { ...DEFAULT_ALERT_RULES }
};

// --- Settings Management ---
async function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = await fsPromises.readFile(SETTINGS_FILE, 'utf8');
            settings = { ...settings, ...JSON.parse(data) };
        }
        if (!Array.isArray(settings.lists) || !settings.lists.length) {
            settings.lists = [...DEFAULT_LISTS];
        }
        settings.alertRules = { ...DEFAULT_ALERT_RULES, ...(settings.alertRules || {}) };
        // Environment values have final priority.
        settings.discordWebhook = process.env.DISCORD_WEBHOOK || settings.discordWebhook;
        settings.telegramWebhook = process.env.TELEGRAM_BOT_TOKEN || settings.telegramWebhook;
        settings.telegramChatId = process.env.TELEGRAM_CHAT_ID || settings.telegramChatId;
    } catch (e) {
        console.error('[Settings] Load failed:', e.message);
    }
}

async function saveSettings() {
    try {
        const persistentSettings = { ...settings };
        if (process.env.DISCORD_WEBHOOK) persistentSettings.discordWebhook = '';
        if (process.env.TELEGRAM_BOT_TOKEN) persistentSettings.telegramWebhook = '';
        if (process.env.TELEGRAM_CHAT_ID) persistentSettings.telegramChatId = '';
        await fsPromises.writeFile(SETTINGS_FILE, JSON.stringify(persistentSettings, null, 2));
    } catch (e) {
        console.error('[Settings] Save failed:', e.message);
    }
}

async function loadDiagnostics() {
    try {
        if (!fs.existsSync(DIAGNOSTICS_FILE)) {
            diagnostics = [];
            return;
        }
        const data = await fsPromises.readFile(DIAGNOSTICS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        diagnostics = Array.isArray(parsed) ? parsed.slice(0, 2000) : [];
    } catch (e) {
        console.error('[Diagnostics] Load failed:', e.message);
        diagnostics = [];
    }
}

async function saveDiagnostics() {
    try {
        await fsPromises.writeFile(DIAGNOSTICS_FILE, JSON.stringify(diagnostics.slice(0, 2000), null, 2));
    } catch (e) {
        console.error('[Diagnostics] Save failed:', e.message);
    }
}

function addDiagnostic(entry) {
    diagnostics.unshift({
        time: new Date().toISOString(),
        ...entry
    });
    if (diagnostics.length > 2000) diagnostics = diagnostics.slice(0, 2000);
    saveDiagnostics().catch(() => { });
}

// --- Backup Logic ---
async function performBackup() {
    try {
        try {
            await fsPromises.access(BACKUP_DIR);
        } catch {
            await fsPromises.mkdir(BACKUP_DIR, { recursive: true });
        }

        try {
            await fsPromises.access(DATA_FILE);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(BACKUP_DIR, `prices-${timestamp}.json`);
            await fsPromises.copyFile(DATA_FILE, backupPath);
            console.log(`[Backup] Saved to: ${backupPath}`);
            cleanOldBackups();
        } catch (e) {
            // Data file might not exist yet
        }
    } catch (e) {
        console.error('[Backup] Failed:', e.message);
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
        listCount: listSet.size || 1,
        rangeStart: minDate ? minDate.toISOString() : null,
        rangeEnd: maxDate ? maxDate.toISOString() : null
    };
}

async function readBackupSummary(filename) {
    const backupPath = path.join(BACKUP_DIR, filename);
    const raw = await fsPromises.readFile(backupPath, 'utf8');
    const parsed = JSON.parse(raw);
    return summarizeItemsSnapshot(parsed);
}
// --------------------

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        const normalizedOrigin = normalizeOrigin(origin);
        if (!origin || !hasExplicitCorsAllowlist || allowedOrigins.includes(normalizedOrigin)) {
            callback(null, true);
            return;
        }
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error('CORS blocked for this origin'));
    }
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../'))); // Serve frontend files

// Root Route fallback
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// User Agents for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

// Helper Functions
function isLegacyDemoItem(item) {
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

async function loadData() {
    try {
        const data = await fsPromises.readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const fallbackListId = (settings.lists && settings.lists[0] && settings.lists[0].id) || 'default';
        items = (Array.isArray(parsed) ? parsed : [])
            .filter(item => !isLegacyDemoItem(item))
            .map(item => ({
                ...item,
                listId: item.listId || fallbackListId
            }));
        console.log(`Loaded ${items.length} items from disk.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No data file found, starting with empty list.');
            items = []; // Or add demo items here if you want
            // saveDemoItems();
        } else {
            console.error('Failed to load data:', error.message);
        }
    }
}

async function saveData() {
    try {
        await fsPromises.writeFile(DATA_FILE, JSON.stringify(items, null, 2));
    } catch (error) {
        console.error('Failed to save data:', error.message);
    }
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
async function notifyAll(title, message) {
    // 1. Local Notification
    notifier.notify({
        title: title,
        message: message,
        sound: true,
        wait: true
    });

    // 2. Discord Webhook
    if (settings.discordWebhook) {
        try {
            const discordUrl = buildDiscordWebhookUrl(settings.discordWebhook);
            await axios.post(discordUrl, {
                content: `**${title}**\n${message}`
            });
        } catch (e) {
            if (e.response) {
                console.error('[Discord Webhook] Failed:', e.response.status, JSON.stringify(e.response.data));
            } else {
                console.error('[Discord Webhook] Failed:', e.message);
            }
        }
    }

    // 3. Telegram Webhook (Simple bot implementation)
    if (settings.telegramWebhook && settings.telegramChatId) {
        try {
            const url = `https://api.telegram.org/bot${settings.telegramWebhook}/sendMessage`;
            await axios.post(url, {
                chat_id: settings.telegramChatId,
                text: `*${title}*\n${message}`,
                parse_mode: 'Markdown'
            });
        } catch (e) {
            console.error('[Telegram Webhook] Failed:', e.message);
        }
    }
}

function getAlertRules() {
    return { ...DEFAULT_ALERT_RULES, ...(settings.alertRules || {}) };
}

function shouldSendAlert(alertKey, cooldownMinutes) {
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

// Background Task: Check Prices
async function checkPrices() {
    if (isChecking) return;
    isChecking = true;
    console.log(`[${new Date().toLocaleTimeString()}] Starting background check...`);

    let updatedCount = 0;
    const rules = getAlertRules();

    for (let item of items) {
        checkingItemId = item.id;
        const nowIso = new Date().toISOString();
        const nowTs = Date.now();
        const oldPrice = Number(item.currentPrice);
        try {
            const html = await fetchWithPuppeteer(item.url);
            const extraction = parseHtml(html, item.selector, item.url);
            const currentPrice = extraction.price;
            const currency = extraction.currency;
            const availability = extraction.availability || { status: 'unknown', confidence: 0, reason: '', source: null };
            const isOutOfStock = availability.status === 'out_of_stock';
            item.stockStatus = availability.status || 'unknown';
            item.stockConfidence = Number(availability.confidence || 0);
            item.stockReason = availability.reason || '';
            item.stockSource = availability.source || null;

            if (currentPrice !== null || isOutOfStock) {
                item.currency = currency || 'USD';
                item.lastCheckAttempt = nowIso;
                // Update item
                if (!isOutOfStock && currentPrice !== item.currentPrice) {
                    if (rules.priceDropEnabled && Number.isFinite(oldPrice) && currentPrice < oldPrice) {
                        const dropAmount = (oldPrice - currentPrice).toFixed(2);
                        if (shouldSendAlert(`drop:${item.id}`, rules.notifyCooldownMinutes)) {
                            console.log(`[Price Drop] ${item.name} dropped by ${dropAmount}!`);
                            notifyAll('Price Drop Alert', `${item.name} is now ${currentPrice} (Was ${oldPrice})`);
                        }
                    }

                    if (rules.targetHitEnabled && item.targetPrice && currentPrice <= item.targetPrice && oldPrice > item.targetPrice) {
                        if (shouldSendAlert(`target:${item.id}`, rules.notifyCooldownMinutes)) {
                            console.log(`[Target Hit] ${item.name} hit target of ${item.targetPrice}!`);
                            notifyAll('Target Price Hit', `${item.name} is now ${currentPrice}, meeting your target of ${item.targetPrice}!`);
                        }
                    }

                    if (rules.priceDrop24hEnabled && Array.isArray(item.history) && item.history.length > 1) {
                        const reference = findPriceNear24h(item.history, nowTs);
                        if (reference && Number(reference.price) > 0) {
                            const pctDrop = ((Number(reference.price) - Number(currentPrice)) / Number(reference.price)) * 100;
                            if (pctDrop >= Number(rules.priceDrop24hPercent || 0) && currentPrice < oldPrice) {
                                if (shouldSendAlert(`drop24h:${item.id}`, rules.notifyCooldownMinutes)) {
                                    notifyAll('24h Drop Alert', `${item.name} dropped ${pctDrop.toFixed(2)}% in ~24h (now ${currentPrice}).`);
                                }
                            }
                        }
                    }

                    if (rules.allTimeLowEnabled) {
                        const historyPrices = Array.isArray(item.history) ? item.history.map(h => Number(h.price)).filter(Number.isFinite) : [];
                        const minBefore = Math.min(...historyPrices, Number.isFinite(oldPrice) ? oldPrice : Number.POSITIVE_INFINITY);
                        if (currentPrice < minBefore) {
                            if (shouldSendAlert(`atl:${item.id}`, rules.notifyCooldownMinutes)) {
                                notifyAll('All-Time Low', `${item.name} reached a new all-time low at ${currentPrice}.`);
                            }
                        }
                    }

                    if (currentPrice !== null) {
                        item.currentPrice = currentPrice;
                        // Add history entry if distinct from last check
                        const lastHistory = item.history[item.history.length - 1];
                        if (!lastHistory || lastHistory.price !== currentPrice || (Date.now() - new Date(lastHistory.date).getTime() > 24 * 60 * 60 * 1000)) {
                            item.history.push({ date: new Date().toISOString(), price: currentPrice });
                        }
                    }
                }

                // Internal USD Conversion
                item.currency = item.currency || 'USD'; // Default if not found
                if (Number.isFinite(currentPrice)) {
                    item.lastSeenPrice = Number(currentPrice);
                    item.priceInUSD = convertToUSD(currentPrice, item.currency);
                }
                item.extractionConfidence = extraction.confidence || 0;
                item.lastChecked = nowIso;
                item.lastCheckStatus = 'ok';
                item.lastCheckError = '';
                updatedCount++;

                if (isOutOfStock && shouldSendAlert(`oos:${item.id}`, rules.notifyCooldownMinutes)) {
                    notifyAll('Out of Stock', `${item.name} appears to be out of stock.`);
                }

                if (rules.lowConfidenceEnabled && Number(item.extractionConfidence || 0) > 0 && Number(item.extractionConfidence) < Number(rules.lowConfidenceThreshold || 0)) {
                    if (shouldSendAlert(`lowconf:${item.id}`, rules.notifyCooldownMinutes)) {
                        notifyAll('Low Extraction Confidence', `${item.name} confidence is ${Math.round(item.extractionConfidence)}.`);
                    }
                }

                addDiagnostic({
                    itemId: item.id,
                    itemName: item.name,
                    url: item.url,
                    listId: item.listId || 'default',
                    ok: true,
                    price: currentPrice,
                    currency: item.currency,
                    confidence: extraction.confidence || 0,
                    source: extraction.source || null,
                    selectorUsed: extraction.selectorUsed || null,
                    stockStatus: item.stockStatus,
                    outOfStock: isOutOfStock,
                    stockReason: item.stockReason || '',
                    error: null
                });
            } else {
                item.lastCheckAttempt = nowIso;
                item.lastCheckStatus = 'fail';
                item.lastCheckError = 'No price extracted';
                addDiagnostic({
                    itemId: item.id,
                    itemName: item.name,
                    url: item.url,
                    listId: item.listId || 'default',
                    ok: false,
                    price: null,
                    currency: item.currency || null,
                    confidence: extraction.confidence || 0,
                    source: extraction.source || null,
                    selectorUsed: extraction.selectorUsed || null,
                    stockStatus: item.stockStatus || 'unknown',
                    outOfStock: false,
                    stockReason: item.stockReason || '',
                    error: 'No price extracted'
                });
            }
        } catch (error) {
            console.error(`Failed to check ${item.name}: ${error.message}`);
            item.lastCheckAttempt = nowIso;
            item.lastCheckStatus = 'fail';
            item.lastCheckError = error.message;
            addDiagnostic({
                itemId: item.id,
                itemName: item.name,
                url: item.url,
                listId: item.listId || 'default',
                ok: false,
                price: null,
                currency: item.currency || null,
                confidence: 0,
                source: null,
                selectorUsed: item.selector || null,
                stockStatus: item.stockStatus || 'unknown',
                outOfStock: false,
                stockReason: item.stockReason || '',
                error: error.message
            });
            if (rules.staleEnabled) {
                const last = item.lastChecked ? new Date(item.lastChecked).getTime() : 0;
                const staleMs = Number(rules.staleHours || 0) * 60 * 60 * 1000;
                if (!last || (nowTs - last) > staleMs) {
                    if (shouldSendAlert(`stale:${item.id}`, rules.notifyCooldownMinutes)) {
                        notifyAll('Stale Price Item', `${item.name} has not had a successful check for over ${rules.staleHours}h.`);
                    }
                }
            }
        }
        // Small delay to be polite
        await new Promise(r => setTimeout(r, 2000));
    }
    checkingItemId = null;

    if (updatedCount > 0) {
        await saveData();
    }

    lastCheckTime = new Date();
    isChecking = false;
    console.log(`[${new Date().toLocaleTimeString()}] Background check complete. Updated ${updatedCount} items.`);
}

// API Endpoints

// Get Items & Status
app.get('/api/items', (req, res) => {
    try {
        res.json({
            items: items,
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
    if (!req.body || !Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid data format' });
    }
    const fallbackListId = (settings.lists && settings.lists[0] && settings.lists[0].id) || 'default';
    items = req.body.map(item => ({
        ...item,
        listId: item.listId || fallbackListId
    }));
    await saveData();
    res.json({ success: true, count: items.length });
});

// Manual Trigger
app.post('/api/check-now', (req, res) => {
    if (isChecking) return res.status(429).json({ error: 'Already checking' });
    checkPrices(); // Run async without awaiting
    res.json({ success: true, message: 'Background check started' });
});

// Test Notification
app.post('/api/test-notification', async (req, res) => {
    const { type } = req.body;
    if (type === 'target') {
        await notifyAll('Test: Target Hit', 'This is a test notification for a target price hit.');
    } else {
        await notifyAll('Test: Price Drop', 'This is a test notification for a generic price drop.');
    }
    res.json({ success: true });
});

// Settings Endpoints
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', async (req, res) => {
    settings = { ...settings, ...req.body };
    if (process.env.DISCORD_WEBHOOK) settings.discordWebhook = process.env.DISCORD_WEBHOOK;
    if (process.env.TELEGRAM_BOT_TOKEN) settings.telegramWebhook = process.env.TELEGRAM_BOT_TOKEN;
    if (process.env.TELEGRAM_CHAT_ID) settings.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    await saveSettings();
    res.json({ success: true });
});

app.get('/api/lists', (req, res) => {
    const lists = Array.isArray(settings.lists) && settings.lists.length ? settings.lists : [...DEFAULT_LISTS];
    const counts = items.reduce((acc, item) => {
        const key = item.listId || 'default';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    res.json({
        lists: lists.map(l => ({ ...l, itemCount: counts[l.id] || 0 }))
    });
});

app.post('/api/lists', async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
    if (lists.some(l => String(l.name).toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({ error: 'List already exists' });
    }
    const id = `list_${Date.now()}`;
    lists.push({ id, name });
    settings.lists = lists;
    await saveSettings();
    res.json({ success: true, list: { id, name }, lists });
});

app.patch('/api/lists/:id', async (req, res) => {
    const { id } = req.params;
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
    const idx = lists.findIndex(l => l.id === id);
    if (idx === -1) return res.status(404).json({ error: 'List not found' });
    lists[idx].name = name;
    settings.lists = lists;
    await saveSettings();
    res.json({ success: true, lists });
});

app.post('/api/lists/:id/delete', async (req, res) => {
    const { id } = req.params;
    const lists = Array.isArray(settings.lists) ? settings.lists : [...DEFAULT_LISTS];
    const idx = lists.findIndex(l => l.id === id);
    if (idx === -1) return res.status(404).json({ error: 'List not found' });
    if (lists.length <= 1) return res.status(400).json({ error: 'Cannot delete the last list' });
    if (id === 'default') return res.status(400).json({ error: 'Default list cannot be deleted' });

    let targetId = 'default';
    if (!lists.some(l => l.id === targetId)) {
        lists.unshift({ id: 'default', name: 'Default' });
        targetId = 'default';
    }

    items = items.map(item => {
        if ((item.listId || 'default') === id) {
            return { ...item, listId: targetId };
        }
        return item;
    });

    settings.lists = lists.filter(l => l.id !== id);
    await saveSettings();
    await saveData();
    res.json({ success: true, lists: settings.lists, movedTo: targetId });
});

app.get('/api/alert-rules', (req, res) => {
    res.json({ alertRules: getAlertRules() });
});

app.post('/api/alert-rules', async (req, res) => {
    const incoming = req.body || {};
    settings.alertRules = {
        ...DEFAULT_ALERT_RULES,
        ...(settings.alertRules || {}),
        ...incoming
    };
    await saveSettings();
    res.json({ success: true, alertRules: settings.alertRules });
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
    diagnostics = [];
    await saveDiagnostics();
    res.json({ success: true });
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
    const { id } = req.params;
    const updates = req.body;

    const index = items.findIndex(i => i.id === id);
    if (index === -1) return res.status(404).json({ error: 'Item not found' });

    items[index] = { ...items[index], ...updates };
    await saveData();
    res.json({ success: true, item: items[index] });
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
            let preview = { itemCount: null, listCount: null, rangeStart: null, rangeEnd: null };
            try {
                preview = await readBackupSummary(f);
            } catch { }
            return { name: f, date: stats.mtime, preview };
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
    const backupPath = path.join(BACKUP_DIR, filename);
    try {
        await fsPromises.access(backupPath);
        const preview = await readBackupSummary(filename);
        res.json({ success: true, filename, preview });
    } catch (e) {
        res.status(500).json({ error: `Failed preview: ${e.message}` });
    }
});

app.post('/api/backups/restore', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Filename is required' });

    const backupPath = path.join(BACKUP_DIR, filename);
    try {
        await fsPromises.access(backupPath);
        // Safety backup of current state
        try {
            if (fs.existsSync(DATA_FILE)) {
                const safetyPath = path.join(BACKUP_DIR, `manual-pre-restore-${Date.now()}.json`);
                await fsPromises.copyFile(DATA_FILE, safetyPath);
            }
        } catch (e) { }

        await fsPromises.copyFile(backupPath, DATA_FILE);
        await loadData(); // Reload memory state
        res.json({ success: true, message: `Restored from ${filename}` });
    } catch (e) {
        res.status(500).json({ error: `Failed to restore: ${e.message}` });
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
    await loadSettings();
    await loadData();
    await loadDiagnostics();
    await refreshExchangeRates();

    // Start Background Job
    setInterval(checkPrices, CHECK_INTERVAL_MS);
    setInterval(refreshExchangeRates, 60 * 60 * 1000);

    // Initial check (optional, but good to have recent data on startup)
    // checkPrices(); 

    // Perform initial backup
    await performBackup();
    // Schedule daily backups
    setInterval(() => performBackup(), 24 * 60 * 60 * 1000);

    const server = app.listen(PORT, () => {
        if (hasExplicitCorsAllowlist) {
            console.log(`[CORS] Restricted mode. Allowed origins: ${allowedOrigins.join(', ')}`);
        } else {
            console.log('[CORS] Open mode. Set ALLOWED_ORIGINS to enforce an origin allowlist.');
        }
        console.log(`
Centsible Server (with Persistence) running on http://localhost:${PORT}
-------------------------------------------------------
Background checks running every ${CHECK_INTERVAL_MS / 60000} minutes.
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




