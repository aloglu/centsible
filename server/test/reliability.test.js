const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { parseHtml, assessExtraction, normalizePriceString } = require('../lib/extraction');
const { emptyRuntime, enqueue, evaluateAlerts, evaluateHealth, reference24h } = require('../lib/alerts');
const { deliver, retryDelay } = require('../lib/delivery');
const now = Date.parse('2026-09-20T12:00:00Z');
const settings = { discordWebhook: 'https://discord.com/api/webhooks/example/token', telegramWebhook: 'token', telegramChatId: '123' };
const rules = { priceDropEnabled: true, targetHitEnabled: true, allTimeLowEnabled: true, priceDrop24hEnabled: true, priceDrop24hPercent: 5, notifyCooldownMinutes: 240, staleEnabled: true, staleHours: 12 };
const item = { id: 'one', name: 'Product', url: 'https://shop.example/product', currency: 'EUR', currentPrice: 100, targetPrice: 90, stockStatus: 'in_stock', history: [{ price: 100, date: new Date(now - 86400000).toISOString() }] };
const extraction = (price, currency = 'EUR') => ({ price, currency, confidence: 95, availability: { status: 'in_stock', confidence: 90 } });

test('locale prices retain thousands groups instead of truncating to cents', () => {
    for (const [raw, expected] of [['1.299',1299],['1,299',1299],['1.299,99',1299.99],['1,299.99',1299.99],['1\u202f299,99',1299.99],["1’299.99",1299.99],['1299.99',1299.99],['12,50',12.5]]) {
        assert.equal(normalizePriceString(raw), expected, raw);
    }
    const result = parseHtml('<div class="current-price">1.299 EUR</div>', null, 'https://example.de/product');
    assert.equal(result.price, 1299);
    assert.equal(normalizePriceString('1.2.3'), null);
});
test('structured prices match the product URL and ignore recommendations', () => {
    const html = `<script type="application/ld+json">${JSON.stringify([
        { '@type': 'Product', url: item.url, offers: { price: '1299.99', priceCurrency: 'EUR' } },
        { '@type': 'Product', url: 'https://shop.example/other', offers: { price: '9.99', priceCurrency: 'EUR', availability: 'https://schema.org/OutOfStock' } }
    ])}</script>`;
    const result = parseHtml(html, null, item.url);
    assert.equal(result.price, 1299.99);
    assert.notEqual(result.availability.status, 'out_of_stock');
});
test('conflicting offers and broken explicit selectors are rejected', () => {
    const html = '<meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="100"><meta itemprop="price" content="50">';
    assert.match(parseHtml(html, null, item.url).rejection, /Conflicting/);
    assert.match(parseHtml(html, '.missing', item.url).rejection, /custom selector/);
    assert.equal(parseHtml('<div class="price">100 EUR</div><div id="chosen">80 EUR</div>', '#chosen', item.url).price, 80);
});
test('challenge pages, installments and crossed-out prices are not accepted', () => {
    assert.throws(() => parseHtml('<title>Just a moment...</title><div class="price">10 EUR</div>', null, item.url), /challenge/);
    assert.equal(parseHtml('<div class="price">12 monthly payments of 10 EUR</div>', null, item.url).price, null);
    assert.equal(parseHtml('<del class="price">100 EUR</del><div class="current-price">80 EUR</div>', null, item.url).price, 80);
});
test('a large drop requires a separate later confirmation and currency changes remain blocked', () => {
    assert.match(assessExtraction(item, extraction(10), now), /Confirming/);
    const pending = { ...item, pendingPrice: { price: 10, currency: 'EUR', at: new Date(now).toISOString() } };
    assert.match(assessExtraction(pending, extraction(10), now + 1000), /Confirming/);
    assert.equal(assessExtraction(pending, extraction(10), now + 60000), null);
    assert.match(assessExtraction(item, extraction(100, 'USD'), now), /currency/);
    assert.match(assessExtraction(item, { ...extraction(80), confidence: 20 }, now), /confidence/);
});
test('eligible targets notify even without a fresh crossing and rearm after moving above', () => {
    const runtime = emptyRuntime();
    const current = { ...item, currentPrice: 80, targetPrice: 90 };
    const next = { ...current };
    evaluateAlerts(current, next, rules, runtime, settings, now);
    assert.equal(next.alertedTarget, 90);
    assert.equal(runtime.events.filter(e => e.key === 'target:one').length, 1);
    evaluateAlerts(next, { ...next }, rules, runtime, settings, now + 86400000);
    assert.equal(runtime.events.filter(e => e.key === 'target:one').length, 1);
    const above = { ...next, currentPrice: 100 };
    evaluateAlerts(next, above, rules, runtime, settings, now + 86400000);
    assert.equal(above.alertedTarget, null);
});
test('failed delivery stays queued across checks, channels, and database restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centsible-store-'));
    let store = new Store(root);
    try {
        store.write('items', [item]);
        const runtime = emptyRuntime();
        const next = { ...item, currentPrice: 80 };
        evaluateAlerts(item, next, rules, runtime, settings, now);
        store.transaction(() => { store.updateItem(next); store.set('runtime', runtime); });
        const event = runtime.events[0];
        const failure = await deliver('discord', event, settings, { post: async () => { const e = new Error('token secret'); e.response = { status: 429, data: { retry_after: 60 } }; throw e; } });
        assert.equal(failure.success, false);
        assert.equal(failure.retryAfterMs, 60000);
        assert(!failure.error.includes('secret'));
        event.channels.discord.error = failure.error;
        event.channels.discord.attempts++;
        event.channels.discord.nextAttempt = now + failure.retryAfterMs;
        event.channels.telegram.deliveredAt = new Date(now).toISOString();
        store.write('runtime', runtime);
        store.close(); store = new Store(root);
        assert.equal(store.get('items')[0].currentPrice, 80);
        const saved = store.get('runtime');
        assert.equal(saved.events[0].channels.discord.deliveredAt, null);
        assert(saved.events[0].channels.telegram.deliveredAt);
        assert.equal(enqueue(saved, settings, event.key, event.title, event.message, now + 86400000), false);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('price and alert intent roll back together when a transaction fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centsible-rollback-'));
    const store = new Store(root);
    try {
        store.write('items', [item]); store.write('runtime', emptyRuntime());
        assert.throws(() => store.transaction(() => {
            store.updateItem({ ...item, currentPrice: 1 });
            store.set('runtime', { events: ['bad'] });
            throw new Error('interrupted write');
        }));
        assert.equal(store.get('items')[0].currentPrice, 100);
        assert.deepEqual(store.get('runtime').events, []);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('stale checks alert independently of scraping and recovery is a separate event', () => {
    const runtime = emptyRuntime();
    const stale = { ...item, lastChecked: new Date(now - 13 * 3600000).toISOString() };
    assert(evaluateHealth(stale, rules, runtime, settings, now));
    assert(!evaluateHealth(stale, rules, runtime, settings, now + 60000));
    const next = { ...stale, currentPrice: 100 };
    evaluateAlerts({ ...stale, healthAlerted: true }, next, rules, runtime, settings, now + 120000);
    assert(runtime.events.some(e => e.key === 'recovery:one'));
    assert.equal(next.healthAlerted, false);
});
test('24h comparisons do not substitute newer points or ancient history', () => {
    assert.equal(reference24h([{ price: 100, date: new Date(now - 3600000).toISOString() }], now), null);
    assert.equal(reference24h([{ price: 100, date: new Date(now - 10 * 86400000).toISOString() }], now), null);
    assert.equal(reference24h(item.history, now).price, 100);
});
test('delivery escapes mentions, uses plain Telegram text and explicit deadlines', async () => {
    const calls = [];
    const post = async (...args) => { calls.push(args); return { data: { ok: true } }; };
    const event = { title: 'Price Drop', message: '[product_name] @everyone' };
    assert((await deliver('discord', event, settings, { post })).success);
    assert((await deliver('telegram', event, settings, { post })).success);
    assert.deepEqual(calls[0][1].allowed_mentions, { parse: [] });
    assert.equal(calls[1][1].parse_mode, undefined);
    assert.equal(calls[0][2].timeout, 15000);
    assert.equal(retryDelay({ response: { headers: { 'retry-after': '120' } } }, 1), 120000);
});


test('product identity ignores tracking parameters but preserves variant identity', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', url: item.url,
        offers: { price: '100', priceCurrency: 'EUR' } })}</script>`;
    assert.equal(parseHtml(html, null, item.url + '?utm_source=email').price, 100);
    assert.equal(parseHtml(html, null, item.url + '?variant=blue').price, null);
});
