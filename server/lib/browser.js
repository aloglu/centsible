const puppeteer = require('puppeteer-extra');
const { FetchProxy } = require('./fetch-proxy');
const { WebsiteError, parseRetryAfter, responseError } = require('./website-errors');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

class BrowserFetcher {
    constructor({ validateUrl, executablePath }) {
        this.validateUrl = validateUrl;
        this.executablePath = executablePath;
        this.launching = null;
        this.tail = Promise.resolve();
        this.waiting = 0;
        this.closed = false;
        this.proxy = new FetchProxy(validateUrl);
        this.proxyPort = null;
        this.retryUntil = new Map();
    }
    async browser() {
        if (!this.launching) {
            this.proxyPort ||= this.proxy.start();
            const port = await this.proxyPort;
            this.launching = puppeteer.launch({
                headless: true, executablePath: this.executablePath,
                handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--proxy-bypass-list=<-loopback>', `--proxy-server=http://127.0.0.1:${port}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
            }).catch(error => { this.launching = null; throw error; });
        }
        const browser = await this.launching;
        if (!browser.connected) { this.launching = null; return this.browser(); }
        return browser;
    }
    async fetch(url, selector = null) {
        if (this.closed) throw new Error('Server is shutting down');
        if (this.waiting >= 20) throw new Error('The extraction queue is full; try again shortly');
        this.waiting++;
        // Serialize pages to bound Chromium memory and prevent concurrent launch
        // races. Every job has a deadline, including page creation and cleanup.
        const result = this.tail.then(() => this.fetchPage(url, selector));
        this.tail = result.catch(() => {});
        try { return await result; } finally { this.waiting--; }
    }
    async fetchPage(url, selector) {
        let page;
        let timer;
        let expired = false;
        const job = async () => {
            const origin = new URL(url).origin;
            for (const [host, until] of this.retryUntil) if (until <= Date.now()) this.retryUntil.delete(host);
            const until = this.retryUntil.get(origin);
            if (until && until > Date.now()) throw new WebsiteError('retry_later', `Website requested a wait until ${new Date(until).toISOString()}; retaining the last trusted price`, until);
            await this.validateUrl(url);
            const browser = await this.browser();
            if (expired || this.closed) throw new Error('Extraction cancelled');
            const context = await browser.createBrowserContext();
            try {
                page = await context.newPage();
                if (expired || this.closed) throw new Error('Extraction cancelled');
                await page.setViewport({ width: 1440, height: 1000 });
                // Use the installed Chromium's version, not a stale/random UA.
                await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
                page.setDefaultTimeout(12000);
                await page.setRequestInterception(true);
                page.on('request', async request => {
                    try {
                        if (expired || ['image', 'font', 'media'].includes(request.resourceType())) {
                            await request.abort(); return;
                        }
                        const requestUrl = request.url();
                        if (/^(data|blob):/.test(requestUrl) && !request.isNavigationRequest()) {
                            await request.continue(); return;
                        }
                        await this.validateUrl(requestUrl, { subresource: !request.isNavigationRequest() });
                        if (!request.isInterceptResolutionHandled()) await request.continue();
                    } catch {
                        if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
                    }
                });
                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                if (!response) throw new WebsiteError('http_error', 'Website returned no response');
                const headers = response.headers();
                const retryAt = parseRetryAfter(headers['retry-after']);
                if (retryAt) this.retryUntil.set(origin, retryAt);
                const error = responseError(response.status(), headers);
                if (error) throw error;
                await this.validateUrl(page.url());
                await page.waitForFunction(custom => {
                    const selectors = custom ? [custom] : ['meta[itemprop="price"]', 'meta[property="product:price:amount"]', '[itemprop="price"]', '[class*="price"]', '[class*="Price"]', 'script[type="application/ld+json"]'];
                    for (const selector of selectors) {
                        try {
                            if (Array.from(document.querySelectorAll(selector)).some(el => /\d/.test(el.getAttribute('content') || el.textContent || el.value || ''))) return true;
                        } catch { /* invalid custom selector is reported by extraction */ }
                    }
                    return /out of stock|sold out|currently unavailable|stokta yok|tükendi/i.test(document.body?.innerText || '');
                }, { timeout: 12000, polling: 250 }, selector).catch(() => {});
                // Let the DOM settle, but don't wait indefinitely for analytics.
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
                return await page.content();
            } finally {
                await Promise.race([context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            }
        };
        try {
            return await Promise.race([job(), new Promise((_, reject) => {
                timer = setTimeout(() => {
                    expired = true;
                    this.reset().catch(() => {});
                    reject(new Error('Extraction exceeded its 70-second deadline'));
                }, 70000);
            })]);
        } finally { clearTimeout(timer); }
    }
    async reset() {
        const launching = this.launching;
        this.launching = null;
        if (launching) {
            const browser = await launching.catch(() => null);
            if (browser) {
                const kill = setTimeout(() => browser.process()?.kill('SIGKILL'), 2000);
                try { await browser.close(); } finally { clearTimeout(kill); }
            }
        }
    }
    async close() { this.closed = true; await this.reset(); if (this.proxyPort) await this.proxy.close(); }
}
module.exports = { BrowserFetcher };
