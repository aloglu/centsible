class Sparkline {
    static generate(historyObject, width = 300, height = 60, color = '#38bdf8', itemId = '') {
        if (!historyObject || historyObject.length < 2) return { html: '', data: null };

        // Downsample to max 50 points
        let data = historyObject;
        if (data.length > 50) {
            const step = Math.ceil(data.length / 50);
            data = data.filter((_, i) => i % step === 0);
            if (data[data.length - 1] !== historyObject[historyObject.length - 1]) {
                data.push(historyObject[historyObject.length - 1]);
            }
        }

        const dataPoints = data.map(h => h.price);
        const max = Math.max(...dataPoints);
        const min = Math.min(...dataPoints);
        const range = max - min || 1;
        const stepX = width / (dataPoints.length - 1);

        // Build points
        let points = dataPoints.map((val, i) => {
            const x = i * stepX;
            const normalizedY = (val - min) / range;
            const y = height - (normalizedY * (height - 10)) - 5;
            return `${x},${y}`;
        }).join(' ');

        // Prepared data for interaction (stored externally)
        const interactionData = data.map((h, i) => {
            let normalizedY = 0.5; // Default middle
            if (range > 0) {
                normalizedY = (h.price - min) / range;
            }
            const y = height - (normalizedY * (height - 10)) - 5;
            return {
                price: h.price,
                date: h.date,
                x: i * stepX,
                y: y
            };
        });

        // Build static data points for visual guidance
        const dataPointsHtml = interactionData.map(p =>
            `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#fff" opacity="0.4" pointer-events="none" />`
        ).join('');

        const html = `
    <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" 
         style="overflow: visible;"
         onmousemove="app.handleSparklineHover(event, '${itemId}', this)"
         onmouseleave="app.handleSparklineLeave(this)">
        <polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" vector-effect="non-scaling-stroke"/>
        ${dataPointsHtml}
        <circle class="hover-dot" r="4" fill="${color}" stroke="#fff" stroke-width="2" style="display:none; pointer-events: none;" />
        <rect x="0" y="0" width="100%" height="100%" fill="transparent" />
    </svg>
    <div class="chart-tooltip" style="z-index: 100; pointer-events: none;"></div>
    `;
        return { html, data: interactionData };
    }
}

/**
 * Price Scraper Logic
 * Uses CORS proxy to fetch HTML and Regex/DOM parsing to find prices.
 */
class Scraper {
    static PROXIES = [
        {
            // Local Node.js Server (Fastest, Recommended)
            url: 'http://localhost:3000/api/fetch?url=',
            type: 'text'
        },
        {
            // JSON response { contents: string }
            url: 'https://api.allorigins.win/get?url=',
            type: 'json'
        },
        {
            // Raw text response
            url: 'https://api.codetabs.com/v1/proxy?quest=',
            type: 'text'
        },
        {
            // Raw text response
            url: 'https://thingproxy.freeboard.io/fetch/',
            type: 'text'
        }
    ];

    static async fetchPrice(targetUrl, customSelector = null) {
        // Prefer backend extraction for consistency with background checks.
        try {
            const res = await fetch('http://localhost:3000/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl, selector: customSelector || null })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.price !== null && data.price !== undefined) {
                    return Number(data.price);
                }
            }
        } catch (e) {
            console.warn('Backend extract failed, trying proxy fallback:', e);
        }

        const encoded = encodeURIComponent(targetUrl);

        for (const proxy of Scraper.PROXIES) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout per proxy

                const response = await fetch(`${proxy.url}${encoded}`, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) throw new Error(`Status ${response.status}`);

                let html = '';
                if (proxy.type === 'json') {
                    const data = await response.json();
                    if (!data.contents) throw new Error("No content");
                    html = data.contents;
                } else {
                    html = await response.text();
                }

                if (!html || html.length < 100) throw new Error("Content too short");

                const price = Scraper.parseHtml(html, customSelector);

                return price;

            } catch (e) {
                console.warn(`Proxy ${proxy.url} failed:`, e);
            }
        }
        return null;
    }

    static parseHtml(htmlString, customSelector = null) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        // 0. Try Custom Selector/ID if provided
        if (customSelector) {
            // Try exact match (ID)
            let el = doc.getElementById(customSelector);
            // Try as query selector (class, id, attr)
            if (!el) {
                try { el = doc.querySelector(customSelector); } catch (e) { }
            }
            // Try as data-test-id (specifically requested by user)
            if (!el) {
                try { el = doc.querySelector(`[data-test-id="${customSelector}"]`); } catch (e) { }
            }
            // Try as class
            if (!el) {
                try { el = doc.querySelector(`.${customSelector}`); } catch (e) { }
            }

            if (el) {
                const price = Scraper.extractPrice(el.textContent || el.getAttribute('content'));
                if (price) return price;
            }
        }

        // 1. Try Meta Tags (Og, Schema)
        const selectors = [
            'meta[property="og:price:amount"]',
            'meta[itemprop="price"]',
            'meta[property="product:price:amount"]',
            'meta[name="twitter:data1"]',
            '.a-price .a-offscreen', // Amazon hidden
            '#priceblock_ourprice',
            '#priceblock_dealprice',
            '.price',
            '.product-price',
            '.prc-dsc',
            '.fiyat',
            '.new-price',
            '.current-price',
            '.product-price-wrapper',
            '.satis_fiyati',
            '.indirimli_fiyat',
            '.discount_price',
            '.card-price-last',
            '.card-price',
            '[data-test-id="price"]',
            '[data-testid="price-container"]'
        ];

        for (let sel of selectors) {
            const el = doc.querySelector(sel);
            if (el) {
                const content = el.getAttribute('content') || el.innerText;
                const price = Scraper.extractPrice(content);
                if (price) return price;
            }
        }

        // 2. Fallback: Regex on body (Risky but sometimes works)
        // Look for currency symbols followed by numbers
        // This is a naive implementation, meant as a last resort
        const bodyText = doc.body.innerText;
        // Search for patterns like $10.99 or £20.00 near "price"
        // Skipping for now to avoid false positives

        return null;
    }

    static extractPrice(text) {
        if (!text) return null;
        text = text.trim();

        // Detect Turkish context (using ₺, TL, TRY or "TL" suffix)
        const isTurkish = /tl|try|₺/i.test(text);

        // Find a potential number pattern
        const match = text.match(/([0-9]{1,3}([.,][0-9]{3})*[.,][0-9]+)|([0-9]+[.,][0-9]+)|([0-9]+)/);

        if (!match) return null;
        let rawNum = match[0];

        if (isTurkish) {
            // Turkish format check: 1.234,56 (dot=thousand, comma=decimal)
            // But also handle US style if forced (e.g. TRY 1,234.56)
            if (rawNum.includes(',') && rawNum.includes('.')) {
                const lastDot = rawNum.lastIndexOf('.');
                const lastComma = rawNum.lastIndexOf(',');
                if (lastComma > lastDot) {
                    // 1.234,56 -> Standard Turkish/Euro
                    rawNum = rawNum.replace(/\./g, '').replace(',', '.');
                } else {
                    // 1,234.56 -> US Style
                    rawNum = rawNum.replace(/,/g, '');
                }
            } else if (rawNum.includes(',')) {
                // 123,45 or 1234,50 -> Decimal
                // Or 1,234 -> Could be 1234 or 1.234
                // In TR context, comma is standard decimal.
                rawNum = rawNum.replace(',', '.');
            } else if (rawNum.includes('.')) {
                // 1.234 -> Could be 1234 (thousands) or 1.234 (decimal)
                // In TR context, dot is thousands.
                // Check if it looks like thousands (3 digits after dot)
                const parts = rawNum.split('.');
                if (parts[parts.length - 1].length === 3) {
                    // 1.234 -> 1234
                    rawNum = rawNum.replace(/\./g, '');
                }
                // else leave it (12.50) -> 12.50
            }
        } else {
            // General/US context
            if (rawNum.includes(',') && rawNum.includes('.')) {
                const lastDot = rawNum.lastIndexOf('.');
                const lastComma = rawNum.lastIndexOf(',');
                if (lastComma > lastDot) {
                    rawNum = rawNum.replace(/\./g, '').replace(',', '.');
                } else {
                    rawNum = rawNum.replace(/,/g, '');
                }
            } else if (rawNum.includes(',')) {
                // 1,234 or 12,34
                if (/,[0-9]{2}$/.test(rawNum)) {
                    rawNum = rawNum.replace(',', '.');
                } else {
                    rawNum = rawNum.replace(/,/g, '');
                }
            }
        }

        return parseFloat(rawNum);
    }
}

/**
 * Main Application
 */
class App {
    constructor() {
        this.items = [];
        this.selectorHistory = [];
        this.sortMethod = 'name_asc';
        this.SERVER_URL = window.location.origin + '/api';
        this.sparklineData = {}; // Initialize storage for chart interactions
        this.exchangeRates = { TRY: 1, USD: 0.03 }; // Default fallback
        this.lastRateFetch = 0;
        this.searchQuery = '';
        this.activeView = 'portfolio';
        this.commandResults = [];
        this.commandSelectionIndex = 0;
        this.refreshPollTimer = null;
        this.itemCheckFlashUntil = new Map();
        this.localCheckingItemIds = new Set();
        this.remoteCheckingItemId = null;
        this.currencyNames = {
            USD: 'us dollar',
            EUR: 'euro',
            GBP: 'british pound',
            TRY: 'turkish lira',
            JPY: 'japanese yen',
            CAD: 'canadian dollar',
            AUD: 'australian dollar',
            CHF: 'swiss franc',
            CNY: 'chinese yuan'
        };
        this.lists = [{ id: 'default', name: 'Default' }];
        this.activeListId = 'all';
        this.newItemListId = 'default';
        this.alertRules = {
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

        this.settings = {
            discordWebhook: '',
            telegramWebhook: '',
            telegramChatId: ''
        };
        this.loadSettings();

        this.init();
    }

    async init() {
        this.setupInputs();
        this.loadUiPreferences();
        await Promise.all([
            this.loadFromServer(),
            this.fetchRates(),
            this.loadLists(),
            this.loadAlertRules()
        ]);

        this.switchView(this.activeView || 'portfolio');
        this.render();
        this.renderSelectors();
        this.renderListControls();
        this.fillAlertRulesForm();

        // Poll server status every 10 seconds
        setInterval(() => this.updateServerStatus(), 10000);

        // Poll for data updates every 30 seconds (keep prices fresh)
        setInterval(async () => {
            const changed = await this.loadFromServer({ silent: true });
            if (changed) this.render();
        }, 30000);

        // Relative time updates (no full re-render to avoid table flicker)
        setInterval(() => this.updateRelativeTimes(), 60000);

        // Menu Toggle Handler
        const trigger = document.getElementById('menuTrigger');
        if (trigger) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeAllMenus();
                document.getElementById('mainHeader').classList.toggle('menu-open');
            });
        }

        // Close menu on click outside
        document.addEventListener('click', (e) => {
            const header = document.getElementById('mainHeader');
            if (header && header.classList.contains('menu-open')) {
                const trigger = document.getElementById('menuTrigger');
                const menu = document.getElementById('headerMenu');
                if (!menu.contains(e.target) && !trigger.contains(e.target)) {
                    header.classList.remove('menu-open');
                }
            }
        });

        // Close modals on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeBackupsModal();
                this.closeHistoryModal();
                this.closeDoctorModal();
                this.closeSettingsModal();
                this.closeListsModal();
                this.closeCommandPalette();
            }
        });

        this.setupGlobalShortcuts();
        this.setupCommandPalette();
        this.setupListsManagerBindings();
    }

    loadUiPreferences() {
        try {
            const savedSort = localStorage.getItem('pt_sort_method');
            const savedView = localStorage.getItem('pt_active_view');
            const savedSearch = localStorage.getItem('pt_search_query');
            const savedActiveList = localStorage.getItem('pt_active_list');
            const savedNewItemList = localStorage.getItem('pt_new_item_list');
            const allowedSorts = new Set([
                'name_asc', 'name_desc',
                'price_asc', 'price_desc',
                'discount_asc', 'discount_desc',
                'checked_asc', 'checked_desc'
            ]);
            if (savedSort && allowedSorts.has(savedSort)) this.sortMethod = savedSort;
            if (savedView) this.activeView = savedView;
            if (savedSearch) this.searchQuery = savedSearch;
            if (savedActiveList) this.activeListId = savedActiveList;
            if (savedNewItemList) this.newItemListId = savedNewItemList;
        } catch (e) {
            console.warn('Could not load UI preferences', e);
        }
    }

    // --- Currency Logic ---

    async fetchRates() {
        try {
            // Cache rates for 1 hour
            if (Date.now() - this.lastRateFetch < 3600000) return;

            // Fetch base TRY rates
            const res = await fetch('https://open.er-api.com/v6/latest/TRY');
            if (res.ok) {
                const data = await res.json();
                if (data && data.rates) {
                    this.exchangeRates = data.rates;
                    this.lastRateFetch = Date.now();
                }
            }
        } catch (e) {
            console.warn('Failed to fetch rates, using defaults', e);
        }
    }

    getCurrency(item) {
        if (item.currency) return item.currency;
        // Infer from URL
        try {
            const u = new URL(item.url);
            const h = u.hostname;
            if (h.endsWith('.tr')) return 'TRY';
            if (h.includes('korayspor') || h.includes('hepsiburada') || h.includes('trendyol') || h.includes('n11') || h.includes('boyner')) return 'TRY';
            if (h.includes('amazon.de')) return 'EUR';
            if (h.includes('amazon.co.uk')) return 'GBP';
            if (h.includes('amazon.jp')) return 'JPY';
            return 'USD'; // Default for .com and others
        } catch {
            return 'USD';
        }
    }

    getNormalizedPrice(item) {
        // Prefer server-calculated normalized price
        if (item.priceInUSD) return item.priceInUSD;

        const currency = this.getCurrency(item);
        const price = item.currentPrice;
        if (!price) return 0;

        // Fallback if backend did not compute normalized value.
        const rate = this.exchangeRates[currency];
        return rate ? (price / rate) : price;
    }

    formatPrice(price, currency) {
        if (typeof price !== 'number') return '-';
        try {
            return price.toLocaleString(currency === 'TRY' ? 'tr-TR' : 'en-US', {
                style: 'currency',
                currency: currency,
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
        } catch (e) {
            return `${price.toFixed(2)} ${currency}`;
        }
    }

    formatDate(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    // --- Server Communications ---

    getItemsSignature(items) {
        if (!Array.isArray(items)) return '';
        return items.map(item => {
            const lastHist = item.history && item.history.length ? item.history[item.history.length - 1] : null;
            return [
                item.id || '',
                item.currentPrice || '',
                item.lastChecked || '',
                item.lastCheckAttempt || '',
                item.lastCheckStatus || '',
                item.stockStatus || '',
                item.stockReason || '',
                item.extractionConfidence || '',
                item.selector || '',
                item.listId || '',
                item.history ? item.history.length : 0,
                lastHist ? lastHist.price : '',
                lastHist ? lastHist.date : ''
            ].join('|');
        }).join('~');
    }

    async loadFromServer(options = {}) {
        const silent = Boolean(options.silent);
        try {
            const res = await fetch(`${this.SERVER_URL}/items`);
            if (!res.ok) throw new Error('Server not reachable');
            const data = await res.json();

            const currentSignature = this.getItemsSignature(this.items);
            let incomingItems = data.items || [];
            const fallbackListId = (this.lists[0] && this.lists[0].id) || 'default';
            incomingItems = incomingItems.map(item => ({
                ...item,
                listId: item.listId || fallbackListId,
                stockStatus: item.stockStatus || 'unknown',
                stockReason: item.stockReason || '',
                stockConfidence: Number(item.stockConfidence || 0),
                stockSource: item.stockSource || null
            }));
            const filteredItems = incomingItems.filter(item => !this.isLegacyDemoItem(item));
            if (filteredItems.length !== incomingItems.length) {
                incomingItems = filteredItems;
                this.items = filteredItems;
                await this.saveToServer();
            }
            const nextSignature = this.getItemsSignature(incomingItems);
            const changed = currentSignature !== nextSignature;

            this.items = incomingItems;

            this.selectorHistory = [];
            this.items.forEach(item => {
                if (item.selector && !this.selectorHistory.includes(item.selector)) {
                    this.selectorHistory.push(item.selector);
                }
            });

            this.updateStatusUI(data.status);
            return changed;
        } catch (e) {
            console.error('Failed to load data:', e);
            if (!silent) this.showToast('Could not connect to server', 'error');
            this.updateStatusUI({ active: false });
            return false;
        }
    }

    isLegacyDemoItem(item) {
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

    async saveToServer() {
        try {
            await fetch(`${this.SERVER_URL}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.items)
            });
        } catch (e) {
            console.error('Failed to save:', e);
            this.showToast('Failed to save changes to server', 'error');
        }
    }

    async updateServerStatus() {
        try {
            const res = await fetch(`${this.SERVER_URL}/items`);
            if (res.ok) {
                const data = await res.json();
                this.updateStatusUI(data.status);
            }
        } catch (e) {
            this.updateStatusUI({ active: false });
        }
    }

    startRefreshStatusPolling() {
        if (this.refreshPollTimer) clearInterval(this.refreshPollTimer);
        this.refreshPollTimer = setInterval(async () => {
            try {
                const res = await fetch(`${this.SERVER_URL}/items`);
                if (!res.ok) return;
                const data = await res.json();
                const incomingItems = Array.isArray(data.items) ? data.items : [];
                const previousById = new Map(this.items.map(item => [item.id, item]));
                this.items = incomingItems.map(item => ({
                    ...item,
                    listId: item.listId || 'default',
                    stockStatus: item.stockStatus || 'unknown',
                    stockReason: item.stockReason || '',
                    stockConfidence: Number(item.stockConfidence || 0),
                    stockSource: item.stockSource || null
                }));
                this.items.forEach(item => {
                    const previous = previousById.get(item.id);
                    const hadNewAttempt = item.lastCheckAttempt && previous && previous.lastCheckAttempt !== item.lastCheckAttempt;
                    if (hadNewAttempt && item.lastCheckStatus === 'ok') {
                        this.markItemCheckFlash(item.id, 10000);
                    }
                });
                this.render();
                this.updateStatusUI(data.status);
                if (!data.status || !data.status.isChecking) {
                    clearInterval(this.refreshPollTimer);
                    this.refreshPollTimer = null;
                }
            } catch {
                clearInterval(this.refreshPollTimer);
                this.refreshPollTimer = null;
            }
        }, 2000);
    }

    // --- Settings & Webhooks ---
    async loadSettings() {
        try {
            const res = await fetch(`${this.SERVER_URL}/settings`);
            if (res.ok) {
                this.settings = { ...this.settings, ...(await res.json()) };
            }
        } catch (e) {
            console.error('Settings load failed:', e);
        }
    }

    async saveSettings() {
        const discord = document.getElementById('discordWebhookInput').value.trim();
        const tgBot = document.getElementById('telegramWebhookInput').value.trim();
        const tgChat = document.getElementById('telegramChatIdInput').value.trim();

        const payload = {
            discordWebhook: discord,
            telegramWebhook: tgBot,
            telegramChatId: tgChat
        };
        this.settings = { ...this.settings, ...payload };

        try {
            const res = await fetch(`${this.SERVER_URL}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                this.showToast('Settings saved!', 'success');
                this.closeSettingsModal();
            }
        } catch (e) {
            this.showToast('Failed to save settings', 'error');
        }
    }

    showSettingsModal() {
        // Close dropdown menu if open
        const header = document.getElementById('mainHeader');
        if (header) header.classList.remove('menu-open');

        const discord = document.getElementById('discordWebhookInput');
        const tgBot = document.getElementById('telegramWebhookInput');
        const tgChat = document.getElementById('telegramChatIdInput');
        const modal = document.getElementById('settingsModal');

        if (discord) discord.value = this.settings.discordWebhook || '';
        if (tgBot) tgBot.value = this.settings.telegramWebhook || '';
        if (tgChat) tgChat.value = this.settings.telegramChatId || '';

        if (modal) {
            modal.classList.add('active');
            modal.style.pointerEvents = 'auto';
        }
    }

    closeSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.pointerEvents = 'none';
        }
    }

    async testNotification(type) {
        try {
            await fetch(`${this.SERVER_URL}/test-notification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type })
            });
            this.showToast(`Test ${type} alert sent!`, 'success');
        } catch (e) {
            console.error('Failed to send test notification:', e);
            this.showToast('Failed to send test alert', 'error');
        }
    }

    async loadLists() {
        try {
            const res = await fetch(`${this.SERVER_URL}/lists`);
            if (!res.ok) return;
            const data = await res.json();
            const incoming = Array.isArray(data.lists) && data.lists.length ? data.lists : [{ id: 'default', name: 'Default' }];
            this.lists = incoming;
            if (!this.lists.some(l => l.id === this.newItemListId)) this.newItemListId = 'default';
            if (this.activeListId !== 'all' && !this.lists.some(l => l.id === this.activeListId)) this.activeListId = 'all';
        } catch (e) {
            console.warn('Could not load lists', e);
        }
    }

    renderListControls() {
        const activeFilter = document.getElementById('activeListFilter');
        const optionLabel = (l) => `${l.name}${Number(l.itemCount || 0) ? ` (${l.itemCount})` : ''}`;
        if (activeFilter) {
            activeFilter.innerHTML = [
                `<option value="all">All Lists</option>`,
                ...this.lists.map(l => `<option value="${l.id}">${optionLabel(l)}</option>`)
            ].join('');
            activeFilter.value = this.activeListId;
            activeFilter.onchange = () => {
                this.activeListId = activeFilter.value;
                localStorage.setItem('pt_active_list', this.activeListId);
                this.render();
            };
        }
    }

    async createList() {
        const name = prompt('List name');
        if (!name || !name.trim()) return;
        try {
            const res = await fetch(`${this.SERVER_URL}/lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create list');
            this.lists = data.lists || this.lists;
            this.renderListControls();
            this.showToast('List created', 'success');
        } catch (e) {
            this.showToast(e.message, 'error');
        }
    }

    showListsModal() {
        try {
            this.closeAllMenus();
            const header = document.getElementById('mainHeader');
            if (header) header.classList.remove('menu-open');
            const modal = document.getElementById('listsModal');
            if (!modal) {
                this.showToast('Lists modal not found in page', 'error');
                return;
            }
            modal.classList.add('active');
            modal.style.pointerEvents = 'auto';
            this.renderListsManager();
        } catch (e) {
            console.error('showListsModal failed:', e);
            this.showToast('Could not open Lists Manager', 'error');
        }
    }

    closeListsModal() {
        const modal = document.getElementById('listsModal');
        if (!modal) return;
        modal.classList.remove('active');
        modal.style.pointerEvents = 'none';
    }

    async createListFromModal() {
        const input = document.getElementById('newListNameInput');
        const name = input ? input.value.trim() : '';
        if (!name) return;
        try {
            const res = await fetch(`${this.SERVER_URL}/lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create list');
            this.lists = data.lists || this.lists;
            if (input) input.value = '';
            this.renderListControls();
            this.renderListsManager();
            this.showToast('List created', 'success');
            this.render();
        } catch (e) {
            this.showToast(e.message, 'error');
        }
    }

    async renameList(listId) {
        const list = this.lists.find(l => l.id === listId);
        if (!list) return;
        const name = prompt('Rename list', list.name);
        if (!name || !name.trim()) return;
        try {
            const res = await fetch(`${this.SERVER_URL}/lists/${encodeURIComponent(listId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Rename failed');
            this.lists = data.lists || this.lists;
            this.renderListControls();
            this.renderListsManager();
            this.render();
            this.showToast('List renamed', 'success');
        } catch (e) {
            this.showToast(e.message, 'error');
        }
    }

    async deleteList(listId) {
        const list = this.lists.find(l => l.id === listId);
        if (!list) return;
        if (this.lists.length <= 1) {
            this.showToast('Cannot delete last list', 'error');
            return;
        }
        if (list.id === 'default') {
            this.showToast('Default list cannot be deleted', 'error');
            return;
        }
        if (!confirm(`Delete list "${list.name}"? Its items will be moved to "Default". This action cannot be undone.`)) return;

        try {
            const res = await fetch(`${this.SERVER_URL}/lists/${encodeURIComponent(listId)}/delete`, {
                method: 'POST'
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
            this.lists = data.lists || this.lists;
            this.items = this.items.map(item => ({
                ...item,
                listId: (item.listId || 'default') === listId ? 'default' : (item.listId || 'default')
            }));
            if (this.activeListId === listId) this.activeListId = 'all';
            localStorage.setItem('pt_active_list', this.activeListId);
            this.renderListControls();
            this.renderListsManager();
            this.render();
            this.showToast('List deleted', 'success');
        } catch (e) {
            this.showToast(e.message, 'error');
        }
    }

    setActiveFilterList(listId) {
        this.activeListId = listId;
        localStorage.setItem('pt_active_list', this.activeListId);
        this.renderListControls();
        this.render();
    }

    setDefaultNewItemList(listId) {
        this.newItemListId = listId;
        localStorage.setItem('pt_new_item_list', this.newItemListId);
        this.renderListControls();
        this.showToast('Default new-item list updated', 'success');
    }

    renderListsManager() {
        const body = document.getElementById('listsManagerBody');
        if (!body) return;
        const listCounts = this.items.reduce((acc, item) => {
            const key = item.listId || 'default';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        body.innerHTML = this.lists.map(l => `
            <div class="list-manager-row">
                <div class="list-manager-main">
                    <div class="list-manager-name">${l.name}</div>
                    <div class="list-manager-meta">
                        ID: ${l.id} | Items: ${listCounts[l.id] || 0}
                        ${this.activeListId === l.id ? '| Active filter' : ''}
                        ${this.newItemListId === l.id ? '| Default for new items' : ''}
                    </div>
                </div>
                <div class="list-manager-actions">
                    <button onclick="app.setActiveFilterList('${l.id}')">View</button>
                    <button onclick="app.setDefaultNewItemList('${l.id}')">Make Default</button>
                    <button onclick="app.renameList('${l.id}')">Rename</button>
                    ${l.id === 'default' ? '' : `<button onclick="app.deleteList('${l.id}')">Delete</button>`}
                </div>
            </div>
        `).join('');
    }

    setupListsManagerBindings() {
        const openButtons = document.querySelectorAll('[onclick="app.showListsModal()"]');
        openButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showListsModal();
            });
        });
    }

    async loadAlertRules() {
        try {
            const res = await fetch(`${this.SERVER_URL}/alert-rules`);
            if (!res.ok) return;
            const data = await res.json();
            this.alertRules = { ...this.alertRules, ...(data.alertRules || {}) };
        } catch (e) {
            console.warn('Could not load alert rules', e);
        }
    }

    fillAlertRulesForm() {
        const bind = (id, key, type = 'checkbox') => {
            const el = document.getElementById(id);
            if (!el) return;
            if (type === 'checkbox') el.checked = Boolean(this.alertRules[key]);
            else el.value = this.alertRules[key] ?? '';
        };
        bind('ruleTargetHit', 'targetHitEnabled');
        bind('rulePriceDrop', 'priceDropEnabled');
        bind('ruleDrop24h', 'priceDrop24hEnabled');
        bind('ruleDrop24hPct', 'priceDrop24hPercent', 'number');
        bind('ruleAllTimeLow', 'allTimeLowEnabled');
        bind('ruleLowConfidence', 'lowConfidenceEnabled');
        bind('ruleLowConfidenceThreshold', 'lowConfidenceThreshold', 'number');
        bind('ruleStale', 'staleEnabled');
        bind('ruleStaleHours', 'staleHours', 'number');
        bind('ruleCooldownMinutes', 'notifyCooldownMinutes', 'number');
    }

    async saveAlertRules() {
        const get = (id) => document.getElementById(id);
        const payload = {
            targetHitEnabled: Boolean(get('ruleTargetHit')?.checked),
            priceDropEnabled: Boolean(get('rulePriceDrop')?.checked),
            priceDrop24hEnabled: Boolean(get('ruleDrop24h')?.checked),
            priceDrop24hPercent: Number(get('ruleDrop24hPct')?.value || 0),
            allTimeLowEnabled: Boolean(get('ruleAllTimeLow')?.checked),
            lowConfidenceEnabled: Boolean(get('ruleLowConfidence')?.checked),
            lowConfidenceThreshold: Number(get('ruleLowConfidenceThreshold')?.value || 0),
            staleEnabled: Boolean(get('ruleStale')?.checked),
            staleHours: Number(get('ruleStaleHours')?.value || 0),
            notifyCooldownMinutes: Number(get('ruleCooldownMinutes')?.value || 240)
        };
        try {
            const res = await fetch(`${this.SERVER_URL}/alert-rules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save rules');
            this.alertRules = { ...this.alertRules, ...(data.alertRules || payload) };
            this.showToast('Alert rules saved', 'success');
            this.renderAlertsPanel();
        } catch (e) {
            this.showToast(e.message, 'error');
        }
    }

    async renderDiagnosticsPanel() {
        const container = document.getElementById('diagnosticsList');
        if (!container) return;
        try {
            const query = this.activeListId && this.activeListId !== 'all' ? `?limit=60&listId=${encodeURIComponent(this.activeListId)}` : '?limit=60';
            const res = await fetch(`${this.SERVER_URL}/diagnostics${query}`);
            const data = await res.json();
            const entries = Array.isArray(data.entries) ? data.entries : [];
            if (!entries.length) {
                container.innerHTML = '<div class="diag-row">No diagnostics yet.</div>';
                return;
            }
            container.innerHTML = entries.slice(0, 40).map(e => `
                <div class="diag-row ${e.ok ? 'ok' : 'fail'}">
                    <div>${e.itemName || e.itemId} ${e.ok ? `${e.outOfStock ? '| Out of stock' : `| ${e.price ?? '-'} ${e.currency || ''}`}` : '| Check failed'}</div>
                    <div class="diag-meta">${new Date(e.time).toLocaleString()} | conf: ${e.confidence ?? 'n/a'} | src: ${e.source || 'n/a'} | sel: ${e.selectorUsed || 'n/a'}${e.stockReason ? ` | stock: ${e.stockReason}` : ''}${e.error ? ` | err: ${e.error}` : ''}</div>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = `<div class="diag-row fail">Failed to load diagnostics: ${e.message}</div>`;
        }
    }

    async clearDiagnostics() {
        if (!confirm('Delete all diagnostics history? This cannot be undone.')) return;
        try {
            const res = await fetch(`${this.SERVER_URL}/diagnostics`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to clear diagnostics');
            await this.renderDiagnosticsPanel();
            this.showToast('Diagnostics cleared', 'success');
        } catch (e) {
            this.showToast(e.message || 'Failed to clear diagnostics', 'error');
        }
    }

    updateStatusUI(status) {
        const textLabel = document.getElementById('statusText');
        const dot = document.getElementById('statusDot');
        if (!textLabel || !dot) return;

        // Connectivity status only
        if (status && status.active) {
            dot.classList.remove('offline', 'checking');
            dot.classList.add('active');
            textLabel.textContent = 'Server Online';
            textLabel.style.color = 'var(--success)';
        } else {
            dot.classList.remove('active', 'checking');
            dot.classList.add('offline');
            textLabel.textContent = 'Server Offline';
            textLabel.style.color = 'var(--danger)';
        }

        this.remoteCheckingItemId = status && status.checkingItemId ? status.checkingItemId : null;
        this.applyCheckingHighlights({ scrollToRemote: true });
    }

    beginItemCheck(itemId) {
        if (!itemId) return;
        this.localCheckingItemIds.add(itemId);
        this.applyCheckingHighlights();
    }

    endItemCheck(itemId) {
        if (!itemId) return;
        this.localCheckingItemIds.delete(itemId);
        this.applyCheckingHighlights();
    }

    applyCheckingHighlights(options = {}) {
        const { scrollToRemote = false } = options;
        const activeIds = new Set(this.localCheckingItemIds);
        if (this.remoteCheckingItemId) activeIds.add(this.remoteCheckingItemId);

        document.querySelectorAll('.currently-checking').forEach(el => el.classList.remove('currently-checking'));
        document.querySelectorAll('button[id^="refresh-"] svg.spin').forEach(el => el.classList.remove('spin'));

        activeIds.forEach((id) => {
            const itemEl = document.querySelector(`.list-item[data-id="${id}"]`);
            if (!itemEl) return;
            itemEl.classList.add('currently-checking');
            const refreshIcon = document.querySelector(`#refresh-${id} svg`);
            if (refreshIcon) refreshIcon.classList.add('spin');
            if (scrollToRemote && this.remoteCheckingItemId === id) {
                itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    }

    async scrapePrice(url, selector) {
        try {
            const response = await fetch(`${this.SERVER_URL}/extract`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, selector: selector || null })
            });
            if (!response.ok) throw new Error("Extraction failed");
            const data = await response.json();

            if (data && data.success) {
                const title = data.title ? String(data.title).trim() : null;
                const availability = data.availability || { status: 'unknown', confidence: 0, reason: '', source: null };
                return {
                    price: data.price !== null && data.price !== undefined ? Number(data.price) : null,
                    title: title && title.length > 70 ? title.substring(0, 67) + '...' : title,
                    currency: data.currency || this.getCurrency({ url }),
                    confidence: data.confidence || 0,
                    source: data.source || null,
                    selectorUsed: data.selectorUsed || null,
                    suggestions: data.suggestions || [],
                    availability
                };
            }
        } catch (e) {
            console.warn("Backend extraction failed, falling back to basic check:", e);
            const price = await Scraper.fetchPrice(url, selector);
            return {
                price,
                title: null,
                currency: this.getCurrency({ url }),
                confidence: 0,
                source: null,
                selectorUsed: null,
                suggestions: [],
                availability: { status: 'unknown', confidence: 0, reason: '', source: null }
            };
        }
    }

    setupInputs() {
        const urlInp = document.getElementById('urlInput');
        const selInp = document.getElementById('selectorInput');
        const nameInp = document.getElementById('nameInput');
        const targetInp = document.getElementById('targetPriceInput');

        // Enter key handler
        [urlInp, selInp, nameInp, targetInp].forEach(input => {
            if (input) {
                input.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') this.addItem();
                });
            }
        });

        const labUrl = document.getElementById('labUrlInput');
        const labSelector = document.getElementById('labSelectorInput');
        [labUrl, labSelector].forEach(input => {
            if (input) {
                input.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') this.runExtractorLab();
                });
            }
        });
    }

    setupGlobalShortcuts() {
        document.addEventListener('keydown', (e) => {
            const isCmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
            if (isCmdK) {
                e.preventDefault();
                this.openCommandPalette();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
                e.preventDefault();
                this.refreshAll();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                this.openCommandPalette();
            }
        });
    }

    setupCommandPalette() {
        const btn = document.getElementById('commandPaletteBtn');
        if (btn) {
            btn.addEventListener('click', () => this.openCommandPalette());
        }

        const input = document.getElementById('commandInput');
        if (!input) return;

        input.addEventListener('input', () => {
            this.commandSelectionIndex = 0;
            this.renderCommandResults(input.value);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.moveCommandSelection(1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.moveCommandSelection(-1);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = this.commandResults[this.commandSelectionIndex];
                if (cmd) this.executeCommand(cmd);
            }
        });
    }

    buildCommandItems(filter = '') {
        const text = String(filter || '').toLowerCase();
        const items = [];
        const base = [
            { label: 'Go to Portfolio', meta: 'View', action: () => this.switchView('portfolio') },
            { label: 'Go to Alerts', meta: 'View', action: () => this.switchView('alerts') },
            { label: 'Go to Extractor Lab', meta: 'View', action: () => this.switchView('extractor') },
            {
                label: 'Show All Items',
                meta: 'List',
                action: () => {
                    this.setActiveFilterList('all');
                    this.switchView('portfolio');
                },
                searchText: 'all list lists items'
            },
            { label: 'Open Lists Manager', meta: 'View', action: () => this.showListsModal() },
            { label: 'Refresh All Items', meta: 'Action', action: () => this.refreshAll(), key: 'Ctrl+Shift+R' },
            { label: 'Open Settings', meta: 'Action', action: () => this.showSettingsModal() },
            { label: 'Focus Add URL', meta: 'Action', action: () => document.getElementById('urlInput')?.focus() },
            { label: 'Run Extractor Lab', meta: 'Action', action: () => this.runExtractorLab() }
        ];
        items.push(...base);
        this.lists.forEach((list) => {
            items.push({
                label: `Show List: ${list.name}`,
                meta: 'List',
                action: () => {
                    this.setActiveFilterList(list.id);
                    this.switchView('portfolio');
                },
                searchText: `${list.name} ${list.id} list filter show`
            });
        });

        this.items.slice(0, 60).forEach(item => {
            const currencyCode = String(item.currency || this.getCurrency(item) || 'USD').toUpperCase();
            const currencyName = this.currencyNames[currencyCode] || '';
            const listName = this.getListName(item.listId || 'default');
            const searchBlob = [
                item.name || '',
                item.url || '',
                item.selector || '',
                currencyCode,
                currencyName,
                listName
            ].join(' ').toLowerCase();
            items.push({
                label: `Refresh: ${item.name}`,
                meta: 'Item',
                action: () => this.refreshItem(item.id),
                searchText: searchBlob
            });
            items.push({
                label: `Open History: ${item.name}`,
                meta: 'Item',
                action: () => this.showHistoryModal(item.id),
                searchText: searchBlob
            });
        });

        if (!text) return items;
        return items.filter(item => {
            const base = `${item.label} ${item.meta}`.toLowerCase();
            const extra = String(item.searchText || '');
            return base.includes(text) || extra.includes(text);
        });
    }

    renderCommandResults(filter = '') {
        const container = document.getElementById('commandResults');
        if (!container) return;

        this.commandResults = this.buildCommandItems(filter).slice(0, 12);
        if (!this.commandResults.length) {
            container.innerHTML = '<div class="command-item"><div class="command-title">No commands found</div></div>';
            return;
        }

        container.innerHTML = this.commandResults.map((cmd, idx) => `
            <div class="command-item ${idx === this.commandSelectionIndex ? 'active' : ''}" data-idx="${idx}">
                <div class="command-main">
                    <div class="command-title" title="${cmd.label}">${cmd.label}</div>
                    <div class="command-meta">${cmd.meta}</div>
                </div>
                ${cmd.key ? `<span class="command-key">${cmd.key}</span>` : ''}
            </div>
        `).join('');

        container.querySelectorAll('.command-item[data-idx]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = Number(el.getAttribute('data-idx'));
                const cmd = this.commandResults[idx];
                if (cmd) this.executeCommand(cmd);
            });
        });
    }

    moveCommandSelection(delta) {
        if (!this.commandResults.length) return;
        this.commandSelectionIndex = (this.commandSelectionIndex + delta + this.commandResults.length) % this.commandResults.length;
        this.renderCommandResults(document.getElementById('commandInput')?.value || '');
    }

    executeCommand(command) {
        if (!command || typeof command.action !== 'function') return;
        this.closeCommandPalette();
        command.action();
    }

    openCommandPalette() {
        const modal = document.getElementById('commandPalette');
        const input = document.getElementById('commandInput');
        if (!modal || !input) return;
        this.commandSelectionIndex = 0;
        modal.classList.add('active');
        modal.style.pointerEvents = 'auto';
        input.value = '';
        this.renderCommandResults('');
        setTimeout(() => input.focus(), 10);
    }

    closeCommandPalette() {
        const modal = document.getElementById('commandPalette');
        if (!modal) return;
        modal.classList.remove('active');
        modal.style.pointerEvents = 'none';
    }

    renderSelectors() {
        const list = document.getElementById('selector-history');
        list.innerHTML = this.selectorHistory.map(sel => `<option value="${sel}">`).join('');
    }

    // --- Core Functionality ---

    async addItem() {
        const urlInp = document.getElementById('urlInput');
        const selInp = document.getElementById('selectorInput');
        const nameInp = document.getElementById('nameInput');
        const targetInp = document.getElementById('targetPriceInput'); // New Input

        const url = urlInp.value.trim();
        const selector = selInp.value.trim();
        const name = nameInp.value.trim();
        const targetPrice = parseFloat(targetInp?.value) || null;

        if (!url) {
            this.showToast("Please enter a URL", "error");
            return;
        }

        const btn = document.getElementById('addBtn');
        btn.classList.add('state-loading');
        btn.innerHTML = `<svg class="spin" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg> Adding...`;

        try {
            // Check if already exists
            if (this.items.some(i => i.url === url)) {
                throw new Error("Item already tracked!");
            }

            // Initial Scrape
            const initialData = await this.scrapePrice(url, selector);
            const initialAvailability = initialData?.availability || { status: 'unknown', confidence: 0, reason: '', source: null };
            const isInitialOutOfStock = initialAvailability.status === 'out_of_stock';
            if (!initialData || (initialData.price === null && !isInitialOutOfStock)) {
                throw new Error("Could not scrape price. Try a custom selector?");
            }
            const initialPrice = initialData.price !== null ? Number(initialData.price) : null;

            const newItem = {
                id: Date.now().toString(),
                url,
                selector: selector || initialData.selectorUsed || null,
                name: name || initialData.title || new URL(url).hostname,
                listId: this.newItemListId || (this.lists[0] && this.lists[0].id) || 'default',
                currentPrice: initialPrice,
                currency: initialData.currency,
                originalPrice: initialPrice,
                targetPrice: targetPrice, // Save Target
                extractionConfidence: initialData.confidence || 0,
                history: initialPrice !== null ? [{
                    price: initialPrice,
                    date: new Date().toISOString()
                }] : [],
                lastChecked: new Date().toISOString(),
                lastCheckAttempt: new Date().toISOString(),
                lastCheckStatus: 'ok',
                lastCheckError: '',
                stockStatus: initialAvailability.status || 'unknown',
                stockConfidence: Number(initialAvailability.confidence || 0),
                stockReason: initialAvailability.reason || '',
                stockSource: initialAvailability.source || null
            };

            this.items.push(newItem);
            await this.saveToServer();
            this.render();
            this.showToast(isInitialOutOfStock ? "Item Added (currently out of stock)" : "Item Added!", "success");

            // Clear inputs
            urlInp.value = '';
            selInp.value = '';
            nameInp.value = '';
            if (targetInp) targetInp.value = '';

        } catch (e) {
            this.showToast(e.message, "error");
            console.error(e);
        } finally {
            btn.classList.remove('state-loading');
            btn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg> Add Item`;
        }
    }

    async deleteItem(id) {
        this.closeAllMenus();
        if (!confirm("Are you sure you want to stop tracking this item?")) return;
        this.items = this.items.filter(i => i.id !== id);
        await this.saveToServer();
        this.render();
        this.showToast("Item Removed", "success");
    }

    async moveItemToList(id, targetListId) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;
        const list = this.lists.find(l => l.id === targetListId);
        if (!list) {
            this.showToast('List not found', 'error');
            return;
        }
        if ((item.listId || 'default') === targetListId) {
            this.closeAllMenus();
            return;
        }
        item.listId = targetListId;
        await this.saveToServer();
        await this.loadLists();
        this.renderListControls();
        this.render();
        this.closeAllMenus();
        this.showToast(`Moved to ${list.name}`, 'success');
    }

    async refreshItem(id) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;
        this.beginItemCheck(id);

        try {
            const extracted = await this.scrapePrice(item.url, item.selector);
            const price = extracted ? extracted.price : null;
            const availability = extracted?.availability || { status: 'unknown', confidence: 0, reason: '', source: null };
            const stockStatus = availability.status || (price !== null ? 'in_stock' : 'unknown');
            const isOutOfStock = stockStatus === 'out_of_stock';

            if (price !== null || isOutOfStock) {
                const oldPrice = item.currentPrice;
                if (!isOutOfStock && price !== null) {
                    item.currentPrice = price;
                } else if (price !== null) {
                    item.lastSeenPrice = Number(price);
                }
                if (extracted && extracted.currency) item.currency = extracted.currency;
                if (extracted && extracted.selectorUsed && !item.selector) item.selector = extracted.selectorUsed;
                item.extractionConfidence = extracted && extracted.confidence ? extracted.confidence : (item.extractionConfidence || 0);
                item.stockStatus = stockStatus;
                item.stockConfidence = Number(availability.confidence || 0);
                item.stockReason = availability.reason || '';
                item.stockSource = availability.source || null;
                item.lastChecked = new Date().toISOString();
                item.lastCheckAttempt = new Date().toISOString();
                item.lastCheckStatus = 'ok';
                item.lastCheckError = '';
                this.markItemCheckFlash(item.id, 10000);

                // Add to history logic
                if (!isOutOfStock && price !== null) {
                    const last = item.history[item.history.length - 1];
                    // If price changed OR it's been a day since last log
                    if (!last || last.price !== price || (new Date() - new Date(last.date) > 86400000)) {
                        item.history.push({
                            date: new Date().toISOString(),
                            price: price
                        });
                    }
                }

                await this.saveToServer(); // Save immediately
                this.render(); // Re-render to show updates

                if (isOutOfStock) {
                    this.showToast(`${item.name} is out of stock`, "error");
                } else if (price < oldPrice) {
                    this.showToast(`Price drop! ${item.name}`, "success");
                } else if (price > oldPrice) {
                    this.showToast(`Price increased: ${item.name}`, "error");
                } else {
                    this.showToast(`Updated: ${item.name}`, "success");
                }
            } else {
                throw new Error("Could not find price");
            }

        } catch (e) {
            console.error(e);
            item.lastCheckAttempt = new Date().toISOString();
            item.lastCheckStatus = 'fail';
            item.lastCheckError = e.message || 'Check failed';
            await this.saveToServer();
            this.render();
            this.showToast(`Failed to update ${item.name}`, "error");
            return;
        } finally {
            this.endItemCheck(id);
        }
    }

    async refreshAll() {
        const btn = document.getElementById('refreshAllBtn');
        btn.classList.add('state-loading');

        // Let frontend do it one by one (visual feedback)
        // OR trigger backend endpoint
        // Let's use backend endpoint for efficiency
        try {
            await fetch(`${this.SERVER_URL}/check-now`, { method: 'POST' });
            this.showToast('Background check started...', 'success');
            this.startRefreshStatusPolling();
        } catch (e) {
            this.showToast('Failed to trigger background check', 'error');
        } finally {
            setTimeout(() => btn.classList.remove('state-loading'), 1000);
        }
    }

    // --- Rendering ---

    handleSearch(query) {
        this.searchQuery = query.toLowerCase().trim();
        localStorage.setItem('pt_search_query', this.searchQuery);
        this.render();
    }

    getVisibleItems() {
        if (!this.activeListId || this.activeListId === 'all') return [...this.items];
        return this.items.filter(item => (item.listId || 'default') === this.activeListId);
    }

    getListName(listId) {
        const found = this.lists.find(l => l.id === listId);
        return found ? found.name : 'Default';
    }

    getSortedItems() {
        let filtered = this.getVisibleItems();

        // Apply Search Filter
        if (this.searchQuery) {
            filtered = filtered.filter(item =>
                item.name.toLowerCase().includes(this.searchQuery) ||
                item.url.toLowerCase().includes(this.searchQuery) ||
                (item.selector && item.selector.toLowerCase().includes(this.searchQuery))
            );
        }

        let sorted = filtered;
        const m = this.sortMethod;

        sorted.sort((a, b) => {
            // Ensure priceInUSD is calculated for sorting
            const aPriceInUSD = this.getNormalizedPrice(a);
            const bPriceInUSD = this.getNormalizedPrice(b);

            if (m === 'price_asc') return aPriceInUSD - bPriceInUSD;
            if (m === 'price_desc') return bPriceInUSD - aPriceInUSD;
            if (m === 'name_asc') return a.name.localeCompare(b.name);
            if (m === 'name_desc') return b.name.localeCompare(a.name);

            // Complex Sorts
            const getDiscount = (item) => {
                if (item.history.length < 2) return 0;
                const max = Math.max(...item.history.map(h => h.price));
                return ((max - item.currentPrice) / max); // % discount
            };

            if (m === 'discount_desc') return getDiscount(b) - getDiscount(a);
            if (m === 'discount_asc') return getDiscount(a) - getDiscount(b);

            // Checked Sorts
            if (m === 'checked_desc') return new Date(b.lastChecked) - new Date(a.lastChecked);
            if (m === 'checked_asc') return new Date(a.lastChecked) - new Date(b.lastChecked);

            return 0;
        });
        return sorted;
    }

    handleHeaderClick(field) {
        // cycle asc -> desc -> asc
        if (this.sortMethod === `${field}_asc`) {
            this.sortMethod = `${field}_desc`;
        } else {
            this.sortMethod = `${field}_asc`;
        }
        localStorage.setItem('pt_sort_method', this.sortMethod);
        this.render();
    }

    getRelativeTime(dateString) {
        const diffMs = new Date() - new Date(dateString);
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const hours = Math.floor(diffMins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    getStockMeta(item) {
        const status = String(item?.stockStatus || 'unknown');
        if (status === 'out_of_stock') {
            return {
                isOut: true,
                text: 'Out of Stock',
                title: item?.stockReason || 'Item appears to be unavailable on the source page.'
            };
        }
        if (status === 'in_stock') {
            return {
                isOut: false,
                text: 'In Stock',
                title: item?.stockReason || 'Item appears available.'
            };
        }
        return {
            isOut: false,
            text: 'Unknown',
            title: item?.stockReason || 'Stock state could not be verified.'
        };
    }

    markItemCheckFlash(itemId, durationMs = 10000) {
        if (!itemId) return;
        const safeMs = Math.max(0, Number(durationMs) || 0);
        const until = Date.now() + safeMs;
        this.itemCheckFlashUntil.set(itemId, until);
        setTimeout(() => {
            const currentUntil = this.itemCheckFlashUntil.get(itemId);
            if (currentUntil && currentUntil <= Date.now()) {
                this.itemCheckFlashUntil.delete(itemId);
                this.render();
            }
        }, safeMs + 50);
    }

    getItemCheckClass(item) {
        if (!item) return '';
        if (item.lastCheckStatus === 'fail') return 'check-fail';
        const until = this.itemCheckFlashUntil.get(item.id);
        if (until && until > Date.now()) return 'check-ok';
        if (until) this.itemCheckFlashUntil.delete(item.id);
        return '';
    }

    getLastCheckMeta(item) {
        if (item.lastCheckStatus === 'fail') {
            return {
                text: 'Failed',
                title: item.lastCheckError || 'Check failed',
                className: 'checked-failed',
                clickable: true
            };
        }
        if (item.stockStatus === 'out_of_stock') {
            return {
                text: this.getRelativeTime(item.lastChecked),
                title: item.stockReason || 'Last check indicates this item is out of stock',
                className: 'checked-oos',
                clickable: false
            };
        }
        return {
            text: this.getRelativeTime(item.lastChecked),
            title: item.lastChecked ? new Date(item.lastChecked).toLocaleString() : '',
            className: '',
            clickable: false
        };
    }

    updateRelativeTimes() {
        this.items.forEach(item => {
            const cell = document.querySelector(`.checked-cell[data-item-id="${item.id}"]`);
            if (!cell) return;
            const meta = this.getLastCheckMeta(item);
            cell.textContent = meta.text;
            cell.title = meta.title;
            cell.classList.toggle('checked-failed', meta.className === 'checked-failed');
            cell.classList.toggle('checked-oos', meta.className === 'checked-oos');
        });
    }

    getSortIcon(field) {
        if (this.sortMethod === `${field}_asc`) return '&#9650;';
        if (this.sortMethod === `${field}_desc`) return '&#9660;';
        return '';
    }

    getTrendMeta(item) {
        let trendClass = 'neutral';
        let trendText = 'Stable';
        const history = item.history || [];
        if (history.length >= 2) {
            const prevPrice = history[history.length - 2] ? history[history.length - 2].price : item.currentPrice;
            if (item.currentPrice < prevPrice) {
                trendClass = 'down';
                trendText = '&#9660; Drop';
            } else if (item.currentPrice > prevPrice) {
                trendClass = 'up';
                trendText = '&#9650; Rise';
            }
            const minPrice = Math.min(...history.map(h => h.price));
            if (item.currentPrice <= minPrice && history.length > 3) {
                trendText = '&#9733; Best Price';
                trendClass = 'best';
            }
        }
        return { trendClass, trendText };
    }

    buildMiniSparkline(hist, color) {
        if (!hist || hist.length < 2) return '';
        const data = hist.map(h => h.price);
        const max = Math.max(...data);
        const min = Math.min(...data);
        const w = 120;
        const h = 30;
        const step = w / (data.length - 1);
        const range = max - min || 1;
        const points = data.map((v, i) => `${i * step},${h - ((v - min) / range * (h - 4)) - 2}`).join(' ');
        return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="overflow:visible; pointer-events: none;">
            <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}" />
            </svg>`;
    }

    getTargetMeta(item, currency) {
        if (item.stockStatus === 'out_of_stock' || !(item.targetPrice && item.targetPrice > 0)) {
            return { isTargetHit: false, targetHtml: '' };
        }
        const isTargetHit = item.currentPrice <= item.targetPrice;
        const targetHtml = `
            <div class="target-price-container" style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
                ${isTargetHit ? '<span style="color: var(--accent); font-weight: bold;">HIT</span>' : `Target: ${this.formatPrice(item.targetPrice, currency)}`}
            </div>
        `;
        return { isTargetHit, targetHtml };
    }

    getBestValueBadge(item) {
        const history = item.history || [];
        if (history.length <= 3) return '';

        const allPrices = history.map(x => x.price);
        const minAll = Math.min(...allPrices);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const thirtyDayPrices = history.filter(x => new Date(x.date) > thirtyDaysAgo).map(x => x.price);
        const min30 = thirtyDayPrices.length ? Math.min(...thirtyDayPrices) : Infinity;

        if (item.currentPrice <= minAll) {
            return '<span class="price-badge badge-all-time-low" title="Current price is at its all-time low!">All-time Low</span>';
        }
        if (item.currentPrice <= min30) {
            return '<span class="price-badge badge-30-day-low" title="Current price is at its lowest in 30 days!">30-Day Low</span>';
        }
        return '';
    }

    getConfidenceMeta(item) {
        const value = Number(item.extractionConfidence || 0);
        if (value >= 80) return { text: `${Math.round(value)}`, className: 'confidence-high' };
        if (value >= 55) return { text: `${Math.round(value)}`, className: 'confidence-mid' };
        return { text: value > 0 ? `${Math.round(value)}` : 'n/a', className: 'confidence-low' };
    }

    getItemStatus(item) {
        const now = Date.now();
        const lastChecked = item.lastChecked ? new Date(item.lastChecked).getTime() : 0;
        const hoursSince = lastChecked ? (now - lastChecked) / 3600000 : 999;
        const conf = Number(item.extractionConfidence || 0);
        if (item.stockStatus === 'out_of_stock') return { text: 'Out of Stock', className: 'status-oos' };
        if (item.targetPrice && item.currentPrice <= item.targetPrice) return { text: 'Target Hit', className: 'status-hit' };
        if (!item.currentPrice) return { text: 'No Price', className: 'status-issue' };
        if (hoursSince > 6) return { text: 'Stale', className: 'status-stale' };
        if (conf > 0 && conf < 55) return { text: 'Low Trust', className: 'status-issue' };
        return { text: 'Healthy', className: 'status-ok' };
    }

    switchView(view) {
        const header = document.getElementById('mainHeader');
        if (header) header.classList.remove('menu-open');
        this.activeView = view;
        localStorage.setItem('pt_active_view', view);
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-view') === view);
        });
        const map = {
            portfolio: document.getElementById('portfolioPanel'),
            alerts: document.getElementById('alertsPanel'),
            extractor: document.getElementById('extractorPanel')
        };
        Object.entries(map).forEach(([k, el]) => {
            if (!el) return;
            el.classList.toggle('active', k === view);
        });
        if (view === 'alerts') {
            this.fillAlertRulesForm();
            this.renderAlertsPanel();
            this.renderDiagnosticsPanel();
        }
    }

    switchViewFromMenu(view) {
        const header = document.getElementById('mainHeader');
        if (header) header.classList.remove('menu-open');
        setTimeout(() => this.switchView(view), 0);
    }

    refreshDashboardMetrics() {
        const items = this.getVisibleItems();
        const tracked = items.length;
        const targetHits = items.filter(i => i.stockStatus !== 'out_of_stock' && i.targetPrice && i.currentPrice <= i.targetPrice).length;
        const threshold = Number(this.alertRules.lowConfidenceThreshold || 55);
        const staleHours = Number(this.alertRules.staleHours || 6);
        const lowConf = items.filter(i => Number(i.extractionConfidence || 0) > 0 && Number(i.extractionConfidence) < threshold).length;
        const stale = items.filter(i => {
            if (!i.lastChecked) return true;
            return (Date.now() - new Date(i.lastChecked).getTime()) > staleHours * 3600000;
        }).length;

        const setText = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(v);
        };
        setText('metricTracked', tracked);
        setText('metricTargetHits', targetHits);
        setText('metricLowConfidence', lowConf);
        setText('metricStale', stale);
    }

    renderAlertsPanel() {
        const list = document.getElementById('alertsList');
        if (!list) return;
        const alerts = [];
        const now = Date.now();
        const rules = this.alertRules || {};
        const items = this.getVisibleItems();
        items.forEach(item => {
            if (rules.targetHitEnabled && item.stockStatus !== 'out_of_stock' && item.targetPrice && item.currentPrice <= item.targetPrice) {
                alerts.push({ severity: 'critical', text: `${item.name}: target hit (${this.formatPrice(item.currentPrice, item.currency || 'USD')})`, id: item.id });
            }
            if (item.stockStatus === 'out_of_stock') {
                alerts.push({ severity: 'warning', text: `${item.name}: out of stock`, id: item.id });
            }
            if (rules.staleEnabled && (!item.lastChecked || (now - new Date(item.lastChecked).getTime()) > Number(rules.staleHours || 6) * 3600000)) {
                alerts.push({ severity: 'warning', text: `${item.name}: stale check`, id: item.id });
            }
            if (rules.lowConfidenceEnabled && Number(item.extractionConfidence || 0) > 0 && Number(item.extractionConfidence) < Number(rules.lowConfidenceThreshold || 55)) {
                alerts.push({ severity: 'warning', text: `${item.name}: low extraction confidence (${Math.round(item.extractionConfidence)})`, id: item.id });
            }
            if (rules.allTimeLowEnabled && Array.isArray(item.history) && item.history.length > 2) {
                const prices = item.history.map(h => Number(h.price)).filter(Number.isFinite);
                const min = Math.min(...prices);
                if (Number(item.currentPrice) <= min) {
                    alerts.push({ severity: 'info', text: `${item.name}: at all-time low`, id: item.id });
                }
            }
        });

        if (!alerts.length) {
            list.innerHTML = '<div class="alert-row ok">No active alerts. System looks healthy.</div>';
            return;
        }
        const priority = { critical: 0, warning: 1, info: 2 };
        alerts.sort((a, b) => (priority[a.severity] - priority[b.severity]));
        list.innerHTML = alerts.map(a => `<div class="alert-row ${a.severity}" onclick="app.showHistoryModal('${a.id}')">${a.text}</div>`).join('');
    }

    async runExtractorLab() {
        const urlInput = document.getElementById('labUrlInput');
        const selectorInput = document.getElementById('labSelectorInput');
        const resultEl = document.getElementById('labResult');
        const runBtn = document.getElementById('labRunBtn');
        const url = urlInput ? urlInput.value.trim() : '';
        const selector = selectorInput ? selectorInput.value.trim() : '';
        if (!url) {
            this.showToast('Enter a URL for extractor lab', 'error');
            return;
        }
        if (runBtn) runBtn.classList.add('state-loading');
        if (resultEl) resultEl.innerHTML = 'Running extraction...';
        try {
            const res = await fetch(`${this.SERVER_URL}/extract`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, selector: selector || null })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Extraction failed');
            const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
            const suggestionButtons = suggestions
                .map(s => s.selector)
                .filter(s => s && s !== '(text candidate)')
                .slice(0, 6)
                .map(sel => `<button class="icon-btn" style="width:auto;height:auto;padding:0.3rem 0.6rem;" onclick="document.getElementById('labSelectorInput').value='${sel.replace(/'/g, "\\'")}';">${sel}</button>`)
                .join('');

            if (resultEl) {
                resultEl.innerHTML = `
                    <div class="lab-grid">
                        <div><span class="lab-label">Price:</span> ${data.price !== null && data.price !== undefined ? this.formatPrice(Number(data.price), data.currency || 'USD') : 'Not found'}</div>
                        <div><span class="lab-label">Currency:</span> ${data.currency || 'n/a'}</div>
                        <div><span class="lab-label">Confidence:</span> ${data.confidence ? Math.round(data.confidence) : 'n/a'}</div>
                        <div><span class="lab-label">Source:</span> ${data.source || 'n/a'}</div>
                        <div><span class="lab-label">Stock:</span> ${data.availability?.status || 'unknown'}</div>
                        <div><span class="lab-label">Selector Used:</span> ${data.selectorUsed || 'none'}</div>
                        <div class="lab-title"><span class="lab-label">Title:</span> ${data.title || 'n/a'}</div>
                    </div>
                    <div class="lab-suggest-wrap">
                        <div class="lab-label" style="margin-bottom:0.4rem;">Suggestions</div>
                        <div class="lab-suggest">${suggestionButtons || '<span style="color:var(--text-muted)">No selector suggestions</span>'}</div>
                    </div>
                `;
            }
        } catch (e) {
            if (resultEl) resultEl.innerHTML = `<span style="color:var(--danger)">Error: ${e.message}</span>`;
        } finally {
            if (runBtn) runBtn.classList.remove('state-loading');
        }
    }

    render() {
        const grid = document.getElementById('productGrid');
        grid.innerHTML = '';

        const itemsToRender = this.getSortedItems();
        grid.className = 'list-view';

        const header = document.createElement('div');
        header.className = 'list-header';
        header.innerHTML = `
            <div onclick="app.handleHeaderClick('name')">Product Name ${this.getSortIcon('name')}</div>
            <div style="cursor: default;">List</div>
            <div onclick="app.handleHeaderClick('price')">Price ${this.getSortIcon('price')}</div>
            <div style="cursor: default;">History</div>
            <div onclick="app.handleHeaderClick('discount')">Trend ${this.getSortIcon('discount')}</div>
            <div style="cursor: default;">Confidence</div>
            <div style="cursor: default;">Status</div>
            <div onclick="app.handleHeaderClick('checked')">Last Check ${this.getSortIcon('checked')}</div>
            <div style="cursor: default;">Actions</div>
        `;
        grid.appendChild(header);

        itemsToRender.forEach((item) => {
            const currency = this.getCurrency(item);
            const priceStr = this.formatPrice(item.currentPrice, currency);
            const stockMeta = this.getStockMeta(item);
            const { trendClass, trendText } = this.getTrendMeta(item);
            const confidence = this.getConfidenceMeta(item);
            const status = this.getItemStatus(item);
            const sparklineColor = trendClass === 'up' ? '#ef4444' : (trendClass === 'down' ? '#22c55e' : '#38bdf8');
            const miniChart = this.buildMiniSparkline(item.history, sparklineColor);
            const { isTargetHit, targetHtml } = this.getTargetMeta(item, currency);
            const hitClass = isTargetHit ? 'target-hit-glow' : '';
            const checkClass = this.getItemCheckClass(item);
            const badgeHtml = this.getBestValueBadge(item);
            const moveToOptions = this.lists
                .filter(l => l.id !== (item.listId || 'default'))
                .map(l => `<button class="actions-menu-item" onclick="event.stopPropagation(); app.moveItemToList('${item.id}','${l.id}')">${l.name}</button>`)
                .join('');
            const lastCheckMeta = this.getLastCheckMeta(item);
            const priceCellHtml = stockMeta.isOut
                ? `<div class="stock-warning" title="${this.escapeHtml(stockMeta.title)}">Out of Stock</div>${item.currentPrice ? `<div class="stock-last-price">Last seen: ${priceStr}</div>` : ''}`
                : `<div>${priceStr}</div>${targetHtml}`;

            const div = document.createElement('div');
            div.className = `list-item ${hitClass} ${checkClass}`;
            div.setAttribute('data-id', item.id);
            div.innerHTML = `
                <div class="badge-container">${badgeHtml}</div>
                <div class="item-main" onclick="app.showHistoryModal('${item.id}')">
                    <div class="item-title" title="${item.name}">${item.name}</div>
                    <a href="${item.url}" target="_blank" class="item-link" onclick="event.stopPropagation()">${new URL(item.url).hostname.replace('www.', '')}</a>
                </div>
                <div class="list-cell">
                    <span class="status-badge status-ok">${this.getListName(item.listId || 'default')}</span>
                </div>
                <div class="price-cell">
                    ${priceCellHtml}
                </div>
                <div class="history-cell" style="position: relative; height: 100%; display: flex; align-items: center;">
                    ${miniChart}
                    <div class="history-click-overlay" style="position: absolute; inset: 0; cursor: pointer; z-index: 10;" title="View Graph"></div>
                </div>
                <div class="trend-cell">
                    <span class="trend-badge ${trendClass}">${trendText}</span>
                </div>
                <div class="confidence-cell">
                    <span class="confidence-badge ${confidence.className}">${confidence.text}</span>
                </div>
                <div class="status-cell">
                    <span class="status-badge ${status.className}" title="${this.escapeHtml(stockMeta.title)}">${status.text}</span>
                </div>
                <div class="checked-cell ${lastCheckMeta.className}" data-item-id="${item.id}" title="${lastCheckMeta.title}">${lastCheckMeta.text}</div>
                <div class="actions-cell">
                    <button class="icon-btn" onclick="app.refreshItem('${item.id}')" id="refresh-${item.id}" title="Refresh">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                    </button>
                    <button class="icon-btn" onclick="app.toggleItemMenu(event, '${item.id}')" title="More Actions">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>
                        </svg>
                    </button>
                    <div class="actions-menu" id="menu-${item.id}" onclick="event.stopPropagation()">
                        <button class="actions-menu-item" onclick="event.stopPropagation(); app.showDoctorModal('${item.id}')">
                            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path d="M4 3a2 2 0 1 0 4 0M4 3v4a3 3 0 0 0 6 0V3M7 10v4a5 5 0 0 0 10 0v-2" />
                                <circle cx="17" cy="10" r="2" />
                            </svg>
                            <span class="actions-menu-label">Edit</span>
                        </button>
                        <div class="actions-submenu-wrap submenu-left">
                            <button class="actions-menu-item actions-submenu-trigger" onclick="event.stopPropagation();" type="button">
                                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                    <path d="M4 7h16M4 12h10M4 17h7" />
                                </svg>
                                <span class="actions-menu-label">Move To</span>
                            </button>
                            <div class="actions-submenu" onclick="event.stopPropagation()">
                                ${moveToOptions || '<div class="actions-menu-item" style="cursor:default; opacity:0.7;">No other lists</div>'}
                            </div>
                        </div>
                        <button class="actions-menu-item danger" onclick="event.stopPropagation(); app.deleteItem('${item.id}')">
                            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                            <span class="actions-menu-label">Remove Item</span>
                        </button>
                    </div>
                </div>
            `;

            div.querySelector('.history-click-overlay').addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    this.showHistoryModal(item.id);
                } catch (err) {
                    console.error(err);
                    this.showToast('Error opening history view', 'error');
                }
            });

            const checkedCell = div.querySelector('.checked-cell');
            if (checkedCell && item.lastCheckStatus === 'fail') {
                checkedCell.style.cursor = 'pointer';
                checkedCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.switchView('alerts');
                    this.renderDiagnosticsPanel();
                });
            }

            grid.appendChild(div);
        });
        this.renderListControls();
        this.refreshDashboardMetrics();
        this.renderAlertsPanel();
        if (this.activeView === 'alerts') {
            this.renderDiagnosticsPanel();
        }
        this.applyCheckingHighlights();
    }
    showHistoryModal(id) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;

        const modal = document.getElementById('historyModal');
        const modalTitle = document.getElementById('historyModalTitle');
        const modalBody = document.getElementById('historyModalBody');
        const modalChart = document.getElementById('historyModalChart');

        modalTitle.textContent = item.name;
        const currency = this.getCurrency(item);

        // Get trend info for display
        let trendIcon = '';
        let trendColor = 'var(--text-muted)';
        const history = item.history || [];
        if (history.length >= 2) {
            const prevPrice = history[history.length - 2] ? history[history.length - 2].price : item.currentPrice;
            if (item.currentPrice < prevPrice) {
                trendIcon = '<span style="color: var(--success);">▼</span>';
                trendColor = 'var(--success)';
            } else if (item.currentPrice > prevPrice) {
                trendIcon = '<span style="color: var(--danger);">▲</span>';
                trendColor = 'var(--danger)';
            }
        }

        // Calculate Extremes
        const prices = (history && history.length > 0) ? history.map(h => h.price) : [item.currentPrice];
        const allTimeLow = Math.min(...prices);
        const allTimeHigh = Math.max(...prices);
        const lowDate = history.find(h => h.price === allTimeLow)?.date || item.lastChecked;
        const highDate = history.find(h => h.price === allTimeHigh)?.date || item.lastChecked;

        modalBody.innerHTML = `
            <div class="modal-info-grid">
                <div class="info-item">
                    <div class="info-label">Current Price</div>
                    <div class="info-value" style="color: var(--text-main); display: flex; align-items: center; gap: 0.5rem;">
                        ${this.formatPrice(item.currentPrice, currency)}
                        <span style="font-size: 0.8em;">${trendIcon}</span>
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">All-time Low</div>
                    <div class="info-value" style="font-size: 1.1rem; color: var(--success);">
                        ${this.formatPrice(allTimeLow, currency)}
                    </div>
                    <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatDate(lowDate)}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">All-time High</div>
                    <div class="info-value" style="font-size: 1.1rem; color: var(--danger);">
                        ${this.formatPrice(allTimeHigh, currency)}
                    </div>
                    <div style="font-size: 0.7rem; color: var(--text-muted);">${this.formatDate(highDate)}</div>
                </div>

                <div class="info-item" style="grid-column: span 2;">
                    <div class="info-label">Product Link</div>
                    <a href="${item.url}" target="_blank" class="info-value" style="font-size: 0.9rem; color: var(--accent); text-decoration: none; word-break: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 100%;">
                        ${item.url}
                    </a>
                </div>
                <div class="info-item">
                    <div class="info-label">Last Checked</div>
                    <div class="info-value" style="font-size: 1rem;">${app.getRelativeTime(item.lastChecked)}</div>
                </div>
            </div>
        `;

        // Generate large chart for modal
        let trendClass = 'neutral';
        if (history.length >= 2) {
            const prevPrice = history[history.length - 2] ? history[history.length - 2].price : item.currentPrice;
            if (item.currentPrice < prevPrice) {
                trendClass = 'down';
            } else if (item.currentPrice > prevPrice) {
                trendClass = 'up';
            }
        }
        const sparklineColor = trendClass === 'up' ? '#ef4444' : (trendClass === 'down' ? '#22c55e' : '#38bdf8');
        const sl = Sparkline.generate(item.history, 600, 300, sparklineColor, `modal-chart-${item.id}`);

        if (!sl.html) {
            modalChart.innerHTML = `
                <div class="empty-chart-message">
                    <p class="empty-title">Insufficient data to generate a chart.</p>
                    <p class="empty-subtitle">Please keep tracking to see price trends over time.</p>
                </div>
            `;
        } else {
            modalChart.innerHTML = sl.html;
        }

        // Store interaction data for modal chart
        if (sl.data) {
            if (!this.sparklineData) this.sparklineData = {};
            this.sparklineData[`modal-chart-${item.id}`] = sl.data;
        }

        // Add hover listeners for the modal chart
        const svgElement = modalChart.querySelector('svg');
        if (svgElement) {
            svgElement.onmousemove = (evt) => this.handleSparklineHover(evt, `modal-chart-${item.id}`, svgElement);
            svgElement.onmouseleave = () => this.handleSparklineLeave(svgElement);
        }

        modal.classList.add('active');
        // Force visibility in case of CSS issues
        modal.style.opacity = '1';
        modal.style.pointerEvents = 'all';

        // Close modal listeners
        const closeBtn = modal.querySelector('.modal-close-button');
        const overlay = modal.querySelector('.modal-overlay');

        // We use a bound function so we can remove it later if needed, 
        // but for now simple onclick override is fine as we are single-instance.
        closeBtn.onclick = () => this.closeHistoryModal();
        overlay.onclick = () => this.closeHistoryModal();
    }

    closeHistoryModal() {
        const modal = document.getElementById('historyModal');
        if (!modal) return;

        modal.classList.remove('active');
        // IMPORTANT: Clear the inline styles we forced on open
        modal.style.opacity = '';
        // Explicitly set to none to ensure no interaction remains
        modal.style.pointerEvents = 'none';

        // Clean up any hover states
        const chart = document.getElementById('historyModalChart');
        if (chart) {
            const tooltip = chart.querySelector('.chart-tooltip');
            const dot = chart.querySelector('.hover-dot');
            if (tooltip) tooltip.style.display = 'none';
            if (dot) dot.style.display = 'none';
        }
    }

    handleSparklineHover(evt, itemId, svg) {
        if (!this.sparklineData || !this.sparklineData[itemId]) return;

        const data = this.sparklineData[itemId];
        const rect = svg.getBoundingClientRect();

        // Dynamically get SVG coordinate system width/height
        let vbWidth = 300; // default
        let vbHeightVal = 60; // default
        if (svg.hasAttribute('viewBox')) {
            const vb = svg.getAttribute('viewBox').split(' ');
            if (vb.length === 4) {
                vbWidth = parseFloat(vb[2]);
                vbHeightVal = parseFloat(vb[3]);
            }
        }

        const mouseX = (evt.clientX - rect.left) * (vbWidth / rect.width);

        // Find nearest point
        let nearest = null;
        let minDesc = Infinity;

        // Simple linear search
        for (let i = 0; i < data.length; i++) {
            const dist = Math.abs(data[i].x - mouseX);
            if (dist < minDesc) {
                minDesc = dist;
                nearest = data[i];
            } else if (dist > minDesc) {
                break;
            }
        }

        if (nearest) {
            const pixelX = nearest.x * (rect.width / vbWidth);
            const pixelY = nearest.y * (rect.height / vbHeightVal);

            const tooltip = svg.parentNode.querySelector('.chart-tooltip');
            if (tooltip) {
                tooltip.innerHTML = `<strong>${app.formatPrice(nearest.price, app.getCurrency(app.items.find(i => itemId.includes(i.id)) || { url: '' }))}</strong><br>${app.formatDate(nearest.date)}`;
                tooltip.style.display = 'block';

                // Calculate offset relative to the container (accounting for padding)
                const container = svg.parentNode;
                const contRect = container.getBoundingClientRect();
                const offsetX = rect.left - contRect.left;
                const offsetY = rect.top - contRect.top;

                // Smart tooltip positioning
                let transform = 'translateX(-50%)'; // Default center
                // If near left edge (first 20%), align left
                if (pixelX < rect.width * 0.2) {
                    transform = 'translateX(0%)';
                }
                // If near right edge (last 20%), align right
                else if (pixelX > rect.width * 0.8) {
                    transform = 'translateX(-100%)';
                }

                tooltip.style.left = `${pixelX + offsetX}px`;
                tooltip.style.top = `${pixelY + offsetY - 50}px`;
                tooltip.style.transform = transform;
            }

            // Update hover dot
            const dot = svg.querySelector('.hover-dot');
            if (dot) {
                dot.setAttribute('cx', nearest.x);
                dot.setAttribute('cy', nearest.y);
                dot.style.display = 'block';
            }
        }
    }

    handleSparklineLeave(svg) {
        const tooltip = svg.parentNode.querySelector('.chart-tooltip');
        if (tooltip) tooltip.style.display = 'none';
        const dot = svg.querySelector('.hover-dot');
        if (dot) dot.style.display = 'none';
    }



    showToast(msg, type = 'success') {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = `toast show ${type}`;
        setTimeout(() => {
            t.classList.remove('show');
        }, 3000);
    }

    // --- Data Export/Import ---
    exportToJSON() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.items, null, 2));
        const anchor = document.createElement('a');
        anchor.setAttribute("href", dataStr);
        anchor.setAttribute("download", `price_tracker_export_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        this.showToast("JSON Exported");
    }

    exportToCSV() {
        if (!this.items.length) return this.showToast("No data to export", "error");

        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Name,List,URL,Current Price,Target Price,Last Checked\n";

        this.items.forEach(item => {
            const row = [
                `"${item.name.replace(/"/g, '""')}"`,
                `"${this.getListName(item.listId || 'default').replace(/"/g, '""')}"`,
                `"${item.url}"`,
                item.currentPrice,
                item.targetPrice || "",
                `"${item.lastChecked}"`
            ].join(",");
            csvContent += row + "\n";
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `price_tracker_export_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        this.showToast("CSV Exported");
    }

    handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                if (Array.isArray(imported)) {
                    if (confirm(`Are you sure you want to import ${imported.length} items? This will REPLACE your current list.`)) {
                        this.items = imported;
                        await this.saveToServer();
                        this.render();
                        this.showToast("Data Imported Successfully");
                    }
                } else {
                    throw new Error("Invalid Format");
                }
            } catch (err) {
                this.showToast("Import failed: Select a valid JSON file", "error");
            }
        };
        reader.readAsText(file);
        // Clear input
        event.target.value = '';
    }

    // --- Backups Management ---
    async showBackupsModal() {
        const modal = document.getElementById('backupsModal');
        const list = document.getElementById('backupsList');
        list.innerHTML = '<div style="text-align:center; padding: 2rem;">Loading backups...</div>';
        modal.classList.add('active');
        modal.style.pointerEvents = 'auto';

        // Close menu if open
        document.getElementById('mainHeader').classList.remove('menu-open');

        try {
            const response = await fetch(`${this.SERVER_URL}/backups`);
            const backups = await response.json();

            if (!backups.length) {
                list.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted);">No backups found on server.</div>';
                return;
            }

            list.innerHTML = backups.map(b => `
                <div class="backup-item">
                    <div class="backup-info">
                        <div class="backup-name">${b.name}</div>
                        <div class="backup-date">${this.formatDate(b.date)} at ${new Date(b.date).toLocaleTimeString()}</div>
                        <div class="backup-date">
                            Items: ${b.preview && b.preview.itemCount !== null ? b.preview.itemCount : 'n/a'}
                            | Lists: ${b.preview && b.preview.listCount !== null ? b.preview.listCount : 'n/a'}
                            | Range: ${b.preview && b.preview.rangeStart ? this.formatDate(b.preview.rangeStart) : '-'} -> ${b.preview && b.preview.rangeEnd ? this.formatDate(b.preview.rangeEnd) : '-'}
                        </div>
                    </div>
                    <div class="backup-actions">
                        <button class="restore-btn" onclick="app.restoreFromBackup('${b.name}')">Restore</button>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            list.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--danger);">Failed to load backups.</div>';
        }

        // Click to close on background
        modal.onclick = (e) => {
            if (e.target === modal) this.closeBackupsModal();
        };
    }

    closeBackupsModal() {
        document.getElementById('backupsModal').classList.remove('active');
        document.getElementById('backupsModal').style.pointerEvents = 'none';
    }

    // --- Scraper Doctor ---
    showDoctorModal(id) {
        this.closeAllMenus();
        this.doctorItemId = id;
        const item = this.items.find(i => i.id === id);
        if (!item) return;

        const modal = document.getElementById('doctorModal');
        const nameEl = document.getElementById('doctorProductName');
        const nameInput = document.getElementById('doctorNameInput');
        const urlInput = document.getElementById('doctorUrlInput');
        const input = document.getElementById('doctorSelectorInput');
        const results = document.getElementById('doctorResults');
        const metaVal = document.getElementById('doctorMetaValue');
        const suggestions = document.getElementById('doctorSuggestions');

        if (nameEl) nameEl.textContent = item.name;
        if (nameInput) nameInput.value = item.name || '';
        if (urlInput) urlInput.value = item.url || '';
        if (input) input.value = item.selector || '';
        if (results) results.style.display = 'none';
        if (metaVal) metaVal.textContent = '';
        if (suggestions) suggestions.innerHTML = '';

        if (modal) {
            modal.classList.add('active');
            modal.style.pointerEvents = 'auto';
        }
    }

    closeDoctorModal() {
        const modal = document.getElementById('doctorModal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.pointerEvents = 'none';
        }
    }

    async testDoctorSelector() {
        const item = this.items.find(i => i.id === this.doctorItemId);
        if (!item) return;

        const url = document.getElementById('doctorUrlInput')?.value.trim() || item.url;
        const selector = document.getElementById('doctorSelectorInput').value.trim();
        const results = document.getElementById('doctorResults');
        const priceVal = document.getElementById('doctorPriceValue');
        const metaVal = document.getElementById('doctorMetaValue');
        const suggestionsEl = document.getElementById('doctorSuggestions');
        const btn = document.getElementById('testDoctorBtn');

        btn.disabled = true;
        btn.textContent = 'Checking...';

        try {
            const res = await fetch(`${this.SERVER_URL}/test-selector`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, selector })
            });
            const data = await res.json();

            results.style.display = 'block';
            if (data.success && data.price !== null && data.price !== undefined) {
                const currency = data.currency || this.getCurrency(item);
                priceVal.textContent = this.formatPrice(Number(data.price), currency);
                priceVal.style.color = 'var(--success)';
                const confidence = data.confidence ? `Confidence: ${Math.round(Number(data.confidence))}` : 'Confidence: n/a';
                const source = data.source ? ` | Source: ${data.source}` : '';
                const selectorUsed = data.selectorUsed ? ` | Used: ${data.selectorUsed}` : '';
                if (metaVal) metaVal.textContent = `${confidence}${source}${selectorUsed}`;
            } else {
                priceVal.textContent = 'No price found.';
                priceVal.style.color = 'var(--danger)';
                if (metaVal) metaVal.textContent = '';
            }

            if (suggestionsEl) {
                const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
                const selectorSuggestions = suggestions
                    .map(s => s.selector)
                    .filter(s => s && s !== '(text candidate)');

                if (!selectorSuggestions.length) {
                    suggestionsEl.innerHTML = '<div style="font-size: 0.75rem; color: var(--text-muted);">No selector suggestions.</div>';
                } else {
                    const unique = [...new Set(selectorSuggestions)].slice(0, 5);
                    suggestionsEl.innerHTML = `
                        <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem;">Suggested Selectors</div>
                        <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                            ${unique.map(sel => `<button type="button" class="icon-btn" data-sel="${sel.replace(/"/g, '&quot;')}" style="padding:0.35rem 0.6rem; font-size:0.75rem;">${sel}</button>`).join('')}
                        </div>
                    `;
                    suggestionsEl.querySelectorAll('button[data-sel]').forEach(el => {
                        el.addEventListener('click', () => {
                            const input = document.getElementById('doctorSelectorInput');
                            if (input) input.value = el.getAttribute('data-sel');
                        });
                    });
                }
            }
        } catch (e) {
            this.showToast('Test failed: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Verify';
        }
    }

    async updateDoctorSelector() {
        const item = this.items.find(i => i.id === this.doctorItemId);
        if (!item) return;

        const name = document.getElementById('doctorNameInput')?.value.trim() || item.name;
        const url = document.getElementById('doctorUrlInput')?.value.trim() || item.url;
        const selector = document.getElementById('doctorSelectorInput').value.trim();
        if (!url) {
            this.showToast('URL is required', 'error');
            return;
        }
        if (!name) {
            this.showToast('Name is required', 'error');
            return;
        }

        try {
            const res = await fetch(`${this.SERVER_URL}/items/${item.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, selector })
            });

            if (res.ok) {
                const data = await res.json();
                const idx = this.items.findIndex(i => i.id === item.id);
                this.items[idx] = data.item;

                this.showToast('Selector updated!', 'success');
                this.closeDoctorModal();
                this.render();
            }
        } catch (e) {
            this.showToast('Failed to update selector', 'error');
        }
    }

    async restoreFromBackup(filename) {
        let previewText = '';
        try {
            const previewRes = await fetch(`${this.SERVER_URL}/backups/preview?filename=${encodeURIComponent(filename)}`);
            if (previewRes.ok) {
                const previewData = await previewRes.json();
                const p = previewData.preview || {};
                previewText = `\nItems: ${p.itemCount ?? 'n/a'} | Lists: ${p.listCount ?? 'n/a'} | Range: ${p.rangeStart ? this.formatDate(p.rangeStart) : '-'} -> ${p.rangeEnd ? this.formatDate(p.rangeEnd) : '-'}`;
            }
        } catch { }
        if (!confirm(`Are you sure you want to restore from ${filename}? This will overwrite your current prices and history.${previewText}`)) return;

        try {
            const response = await fetch(`${this.SERVER_URL}/backups/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const result = await response.json();
            if (result.success) {
                this.showToast("Backup restored successfully!");
                await this.loadFromServer();
                this.render();
                this.closeBackupsModal();
            } else {
                throw new Error(result.error);
            }
        } catch (e) {
            this.showToast(`Restore failed: ${e.message}`, 'error');
        }
    }

    toggleItemMenu(event, id) {
        event.stopPropagation();
        const menu = document.getElementById(`menu-${id}`);
        const row = document.querySelector(`.list-item[data-id="${id}"]`);
        // Close all other item menus
        document.querySelectorAll('.actions-menu').forEach(m => {
            if (m !== menu) m.classList.remove('active');
        });
        document.querySelectorAll('.list-item.menu-open').forEach(r => r.classList.remove('menu-open'));
        if (menu) {
            const willOpen = !menu.classList.contains('active');
            menu.classList.toggle('active');
            if (row && willOpen) row.classList.add('menu-open');
            if (willOpen) {
                requestAnimationFrame(() => this.updateMoveSubmenuDirection(menu));
            }
        }
    }

    updateMoveSubmenuDirection(menu) {
        if (!menu) return;
        const wraps = menu.querySelectorAll('.actions-submenu-wrap');
        wraps.forEach((wrap) => {
            this.updateMoveSubmenuDirectionForWrap(wrap);
            wrap.onmouseenter = () => this.updateMoveSubmenuDirectionForWrap(wrap);
        });
    }

    updateMoveSubmenuDirectionForWrap(wrap) {
        if (!wrap) return;
        const submenu = wrap.querySelector('.actions-submenu');
        if (!submenu) return;
        const rect = wrap.getBoundingClientRect();
        const submenuWidth = Math.max(submenu.offsetWidth || 0, 180);
        const gap = 10;
        const rightSpace = window.innerWidth - rect.right;
        const leftSpace = rect.left;
        const openRight = rightSpace >= (submenuWidth + gap) || (rightSpace > leftSpace);
        wrap.classList.toggle('submenu-right', openRight);
        wrap.classList.toggle('submenu-left', !openRight);
    }

    closeAllMenus() {
        document.querySelectorAll('.actions-menu').forEach(m => m.classList.remove('active'));
        document.querySelectorAll('.list-item.menu-open').forEach(r => r.classList.remove('menu-open'));
    }
}

window.app = new App();

/**
 * Global Tooltip Manager
 * Replaces native browser tooltips with a custom "universal" design
 */
class TooltipManager {
    constructor() {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'custom-tooltip-container';
        document.body.appendChild(this.tooltip);

        this.activeElement = null;
        this.mouseX = 0;
        this.mouseY = 0;

        // Track mouse globally
        document.body.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;

            if (this.activeElement && this.tooltip.classList.contains('visible')) {
                this.updatePosition();
            }
        });

        // Delegate events to document body
        document.body.addEventListener('mouseover', this.handleMouseOver.bind(this));
        document.body.addEventListener('mouseout', this.handleMouseOut.bind(this));
    }

    handleMouseOver(e) {
        this.mouseX = e.clientX;
        this.mouseY = e.clientY;
        const target = e.target.closest('[title], [data-tooltip]');
        if (!target) return;

        if (target.hasAttribute('title')) {
            const text = target.getAttribute('title');
            if (text) {
                target.setAttribute('data-tooltip', text);
                target.removeAttribute('title');
            }
        }

        const text = target.getAttribute('data-tooltip');
        if (!text) return;

        this.activeElement = target;
        this.show(text);
    }

    handleMouseOut(e) {
        if (this.activeElement && (e.target === this.activeElement || this.activeElement.contains(e.target))) {
            if (e.relatedTarget && this.activeElement.contains(e.relatedTarget)) {
                return;
            }
            this.hide();
            this.activeElement = null;
        }
    }

    show(text) {
        this.tooltip.textContent = text;
        this.updatePosition();
        this.tooltip.classList.add('visible');
    }

    hide() {
        this.tooltip.classList.remove('visible');
    }

    updatePosition() {
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;


        const offset = 12;
        let left = this.mouseX + offset;
        let top = this.mouseY + offset + 10;

        // Boundary Checks
        if (left + tooltipRect.width > viewportWidth - 10) {
            left = this.mouseX - tooltipRect.width - offset;
        }

        if (top + tooltipRect.height > viewportHeight - 10) {
            top = this.mouseY - tooltipRect.height - offset;
        }

        if (left < 10) left = 10;
        if (top < 10) top = 10;

        this.tooltip.style.top = `${top}px`;
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.transform = 'translate(0, 0)';
    }
}

// Initialize Universal Tooltips
window.tooltipManager = new TooltipManager();

// Close on click outside
window.addEventListener('click', () => {
    if (window.app) window.app.closeAllMenus();
});




