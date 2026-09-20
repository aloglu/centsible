const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHtml } = require('../lib/extraction');
const { parseAmount, extractionOptions } = require('../lib/currency');
const { parseRetryAfter, responseError } = require('../lib/website-errors');
const url = 'https://shop.example/product';
test('native TRY, EUR, GBP and USD prices retain their currency and magnitude', () => {
    for (const [text, currency] of [['1.299,99 TL','TRY'], ['₺1.299,99','TRY'], ['1 299,99 €','EUR'], ['£1,299.99','GBP'], ['US$1,299.99','USD']]) {
        const result = parseHtml(`<div id="price">${text}</div>`, '#price', url);
        assert.equal(result.rejection, undefined, text);
        assert.equal(result.price, 1299.99, text);
        assert.equal(result.currency, currency, text);
        const structured = parseHtml(`<script type="application/ld+json">${JSON.stringify({'@type':'Product',offers:{price:1299.99,priceCurrency:currency}})}</script>`, null, url);
        assert.equal(structured.price, 1299.99);
        assert.equal(structured.currency, currency);
    }
});
test('ambiguous currencies require explicit evidence or an item override', () => {
    for (const host of ['example.com','example.tr','amazon.de']) {
        const result = parseHtml('<div id="price">$1,299.99</div>', '#price', `https://${host}/product`);
        assert.equal(result.price, null);
        assert.match(result.rejection, /uncertain/);
    }
    assert.equal(parseHtml('<div id="price">$1,299.99</div>', '#price', url, {currencyOverride:'CAD'}).currency, 'CAD');
    assert.match(parseHtml('<div id="price">£100</div>', '#price', url, {currencyOverride:'USD'}).rejection, /conflict/i);
    assert.match(parseHtml('<meta itemprop="priceCurrency" content="EUR"><div id="price">100</div>', '#price', url, {currencyOverride:'TRY'}).rejection, /conflict/i);
    assert.match(parseHtml('<div id="price">100 INR</div>', '#price', url).rejection, /Unsupported/);
});
test('locale overrides disambiguate rendered numbers without changing machine-readable decimals', () => {
    assert.equal(parseAmount('1.299','en-US'),1.299);
    assert.equal(parseAmount('1.299','tr-TR'),1299);
    assert.equal(parseAmount('1.299,99','en-US'),null);
    assert.equal(parseAmount('1\u202f299,99','fr-FR'),1299.99);
    assert.equal(parseHtml('<meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="1.299">', null, url, {priceLocale:'tr-TR'}).price,1.299);
    assert.equal(parseHtml('<div id="price">1.299</div>', '#price', url, {currencyOverride:'EUR',priceLocale:'en-US'}).price,1.299);
    assert.throws(() => extractionOptions({priceLocale:'bad_locale'}), /Invalid/);
    assert.throws(() => extractionOptions({currencyOverride:'INVALID'}), /Unsupported/);
});
test('challenge and rate-limit responses expose typed errors and explicit retry dates', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    assert.equal(parseRetryAfter('120',now),now+120000);
    assert.equal(parseRetryAfter('Sun, 20 Sep 2026 12:02:00 GMT',now),now+120000);
    for (const raw of [undefined,'','nonsense','-1','0','Sun, 20 Sep 2026 11:00:00 GMT']) assert.equal(parseRetryAfter(raw,now),null);
    assert.equal(responseError(200,{'cf-mitigated':'challenge'}).code,'challenge');
    assert.equal(responseError(403).code,'access_blocked');
    assert.equal(responseError(429,{'retry-after':'120'},now).retryAt,now+120000);
    assert.equal(responseError(200),null);
});
