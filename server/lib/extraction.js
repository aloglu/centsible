const cheerio = require('cheerio');
const { SUPPORTED_CURRENCIES, extractionOptions, resolveCurrency, parseAmount } = require('./currency');
const { WebsiteError } = require('./website-errors');

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

    for (const product of relevantProducts($, targetUrl)) {
        const stack = [product];
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

const normalizePriceString = parseAmount;

function extractNumericCandidates(text) {
    return Array.from(String(text || '').matchAll(/\d+(?:[.,'’\u00a0\u202f ]\d+)*/g)).map(match => match[0].trim()).slice(0, 6);
}

function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function buildCandidate(text, selector, source, preferredCurrency, scoreBase = 0, locale = null, machineReadable = false) {
    const rawText = String(text || '').trim();
    if (!rawText) return null;
    if (rawText.length > 220) return null;

    const { currency, error: currencyError } = resolveCurrency(rawText, preferredCurrency);
    const rawNumbers = extractNumericCandidates(rawText);
    if (rawNumbers.length !== 1) return null;
    const hasExplicitCurrency = /(\u20BA|\u20AC|\u00A3|\$|\bTRY\b|\bUSD\b|\bEUR\b|\bGBP\b|\bJPY\b|\bCAD\b|\bAUD\b|\bCHF\b|\bCNY\b|\bTL\b)/i.test(rawText);
    if (/(installment|taksit|monthly|per month|shipping|delivery|kargo)/i.test(rawText)) return null;
    if (source === 'text' && !hasExplicitCurrency && !/(price|fiyat|sale|deal|discount|ourprice)/i.test(rawText)) return null;

    const price = machineReadable && /^\d+(?:\.\d+)?$/.test(rawText) ? Number(rawText) : normalizePriceString(rawNumbers[0], locale);
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
    if (SUPPORTED_CURRENCIES.has(currency)) score += 8;
    if (price > 0 && price < 2000000) score += 5;

    return {
        price,
        currency,
        currencyError,
        selector: selector || '',
        source,
        score,
        snippet: rawText.replace(/\s+/g, ' ').slice(0, 140)
    };
}

function relevantProducts($, targetUrl) {
    const products = [];
    $('script[type*="ld+json"]').each((_, el) => {
        let root;
        try { root = JSON.parse($(el).contents().text()); } catch { return; }
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            const types = [].concat(node['@type'] || []);
            if (types.some(type => /(?:^|[/#])Product$/.test(type))) products.push(node);
            for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
        }
    });
    const identity = raw => {
        try {
            const url = new URL(raw, targetUrl);
            url.hash = '';
            for (const key of [...url.searchParams.keys()]) {
                if (/^(utm_|gclid$|fbclid$|msclkid$)/i.test(key)) url.searchParams.delete(key);
            }
            return url.href.replace(/\/$/, '');
        } catch { return ''; }
    };
    const target = identity(targetUrl);
    const exact = products.filter(product => [product.url, product['@id'], product.mainEntityOfPage?.['@id']]
        .some(url => url && identity(url) === target));
    if (exact.length) return exact;
    // A single Product without a conflicting URL is usable. Never choose a
    // recommendation arbitrarily just because it occurs first in JSON-LD.
    return products.length === 1 && (!products[0].url || identity(products[0].url) === target) ? products : [];
}

function extractFromJsonLd($, preferredCurrency, targetUrl) {
    const candidates = [];
    for (const product of relevantProducts($, targetUrl)) {
        const offers = [].concat(product.offers || []);
        for (const offer of offers) {
            if (!offer || typeof offer !== 'object') continue;
            // Aggregate ranges aren't the selected variant's payable price.
            const raw = offer.price ?? offer.priceSpecification?.price;
            if (raw == null || !/^\d+(?:\.\d+)?$/.test(String(raw))) continue;
            if (offer.url) {
                try {
                    const url = new URL(offer.url, targetUrl);
                    const target = new URL(targetUrl);
                    if (url.pathname !== target.pathname || (target.search && url.search !== target.search)) continue;
                } catch { continue; }
            }
            const label = offer.priceCurrency || offer.priceSpecification?.priceCurrency || '';
            const { currency, error: currencyError } = resolveCurrency(label, preferredCurrency);
            const price = Number(raw);
            if (!(price > 0) || !Number.isFinite(price)) continue;
            candidates.push({ price, currency, currencyError, selector: 'script[type="application/ld+json"]', source: 'json-ld', score: 95, snippet: `${price} ${currency}` });
        }
    }
    return candidates;
}

function collectSelectorCandidates($, selectors, preferredCurrency, source, scoreBase, locale = null) {
    const candidates = [];
    for (const sel of selectors) {
        let elements;
        try {
            elements = $(sel);
        } catch {
            continue;
        }
        if (!elements || !elements.length) continue;
        elements.slice(0, 10).each((_, el) => {
            const node = $(el);
            if (node.closest('del,s,strike,[hidden],[aria-hidden="true"],aside,[class*="recommend"],[class*="related"],[class*="installment"],[class*="taksit"]').length) return;
            if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(node.attr('style') || '')) return;
            const text = $(el).attr('content')
                || $(el).attr('value')
                || $(el).attr('data-price')
                || $(el).attr('aria-label')
                || $(el).text();
            const machineReadable = node.is('meta[itemprop="price"],meta[property="product:price:amount"],meta[property="og:price:amount"]');
            const candidate = buildCandidate(text, sel, source, preferredCurrency, scoreBase, locale, machineReadable);
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

function parseHtml(htmlString, customSelector = null, targetUrl = '', options = {}) {
    const { currencyOverride, priceLocale } = extractionOptions(options);
    const $ = cheerio.load(htmlString);
    const pageTitle = $('title').text();
    if (/just a moment|access denied|robot check|captcha|verify you are human/i.test(pageTitle) || $('#challenge-running,#cf-challenge-running').length) throw new WebsiteError('challenge', 'Website requires human verification (challenge); retaining the last trusted price');
    const hints = getDomainHints(targetUrl);
    const currencyLabels = $('meta[itemprop="priceCurrency"],meta[property="product:price:currency"],meta[property="og:price:currency"]')
        .map((_, el) => $(el).attr('content')).get().filter(Boolean);
    for (const product of relevantProducts($, targetUrl)) {
        for (const offer of [].concat(product.offers || [])) {
            if (offer?.priceCurrency) currencyLabels.push(offer.priceCurrency);
            else if (offer?.priceSpecification?.priceCurrency) currencyLabels.push(offer.priceSpecification.priceCurrency);
        }
    }
    const currencies = [...new Set(currencyLabels.map(label => String(label).trim().toUpperCase()))];
    const pageCurrencyError = currencies.length > 1 ? 'Conflicting currencies in product metadata'
        : currencies.length === 1 && !SUPPORTED_CURRENCIES.has(currencies[0]) ? `Unsupported currency: ${currencies[0]}`
        : currencyOverride && currencies.length && currencies[0] !== currencyOverride ? `Currency conflict: page says ${currencies[0]}, override is ${currencyOverride}` : null;
    const preferredCurrency = currencyOverride || (currencies.length === 1 && SUPPORTED_CURRENCIES.has(currencies[0]) ? currencies[0] : null);
    const siteSelectors = hints.selectors;
    const isAmazon = isAmazonTarget(targetUrl);
    const candidates = [];
    const availability = detectAvailability($, htmlString, targetUrl);

    candidates.push(...extractFromJsonLd($, preferredCurrency, targetUrl));

    if (customSelector) {
        candidates.push(...collectSelectorCandidates($, [customSelector], preferredCurrency, 'custom', 110, priceLocale));
    }

    const selectors = isAmazon
        ? [...new Set([
            ...siteSelectors,
            'meta[property="og:price:amount"]',
            'meta[itemprop="price"]',
            'meta[property="product:price:amount"]'
        ])]
        : [...new Set([...siteSelectors, ...BASE_PRICE_SELECTORS])];
    candidates.push(...collectSelectorCandidates($, selectors, preferredCurrency, 'selector', 60, priceLocale));

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
            const c = buildCandidate(txt, '', 'text', preferredCurrency, 30, priceLocale);
            if (c) candidates.push(c);
        }
    }

    const amazonScopedCandidates = isAmazon
        ? candidates.filter((c) => {
            const sel = String(c.selector || '').toLowerCase();
            if (c.source === 'custom' || c.source === 'json-ld') return true;
            if (sel.includes('#coreprice') || sel.includes('#priceblock_') || sel.includes('#price_inside_buybox') || sel.includes('#apex_') || sel.includes('twister-plus-price-data-price')) return true;
            if (sel.includes('meta[itemprop="price"]') || sel.includes('meta[property="og:price:amount"]') || sel.includes('meta[property="product:price:amount"]')) return true;
            return false;
        })
        : candidates;

    const ranked = rankCandidates(amazonScopedCandidates);
    const best = ranked[0] || null;
    const conflict = best && ranked.some(c => c !== best && c.score >= best.score - 8
        && (c.currency !== best.currency || Math.abs(c.price - best.price) / best.price > 0.02));
    const rejection = pageCurrencyError || best?.currencyError || (customSelector && !candidates.some(c => c.source === 'custom')
        ? 'The custom selector no longer matches a valid price'
        : conflict ? 'Conflicting product prices; choose a precise selector or variant URL'
        : best && best.score < 65 ? 'No sufficiently reliable product price found'
        : !best && availability.status !== 'out_of_stock' && !preferredCurrency ? 'Currency is uncertain. Choose a currency override for this item.' : null);
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

    if (!best || rejection || shouldSuppressAmazonOutOfStockPrice) {
        return {
            price: null,
            rejection,
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

function assessExtraction(item, extraction, now = Date.now()) {
    if (!extraction || extraction.rejection) return extraction?.rejection || 'No extraction result';
    const availability = extraction.availability || {};
    if (availability.status === 'out_of_stock') {
        return Number(availability.confidence) >= 80 ? null : 'Stock status is uncertain; retaining the last trusted price';
    }
    const price = extraction.price;
    if (!Number.isFinite(price) || price <= 0) return 'No valid product price found';
    if (Number(extraction.confidence || 0) < 65) return 'Extraction confidence is too low; retaining the last trusted price';
    if (!SUPPORTED_CURRENCIES.has(extraction.currency)) return 'Currency is uncertain. Choose a currency override for this item.';
    if (item.currency && extraction.currency !== item.currency) return 'Product currency changed; verify the URL and currency before continuing';
    if (Number.isFinite(item.currentPrice) && item.currentPrice > 0 && (price < item.currentPrice * 0.5 || price > item.currentPrice * 2)) {
        const pending = item.pendingPrice;
        if (!pending || pending.currency !== extraction.currency || Math.abs(pending.price - price) / price > 0.01
            || now - Date.parse(pending.at) < 60000 || now - Date.parse(pending.at) > 86400000) {
            return 'Confirming unusual price on a subsequent check; retaining the last trusted price';
        }
    }
    return null;
}

module.exports = { parseHtml, extractTitleFromHtml, assessExtraction, normalizePriceString, extractNumericCandidates, relevantProducts };
