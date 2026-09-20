const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON']);
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

function extractionOptions(value = {}) {
    const currencyOverride = String(value.currencyOverride || '').trim().toUpperCase() || null;
    const priceLocale = String(value.priceLocale || '').trim() || null;
    if (currencyOverride && !SUPPORTED_CURRENCIES.has(currencyOverride)) throw new Error('Unsupported currency override');
    if (priceLocale) {
        try {
            if (!Intl.NumberFormat.supportedLocalesOf([priceLocale]).length) throw new Error();
        } catch { throw new Error('Invalid price locale'); }
    }
    return { currencyOverride, priceLocale };
}

function resolveCurrency(text, hint = null) {
    const raw = String(text || '').toUpperCase();
    const codes = new Set((raw.match(/\b[A-Z]{3}\b/g) || []).filter(code => ISO_CURRENCIES.has(code)));
    if (/₺|\bTL\b/.test(raw)) codes.add('TRY');
    if (/€/.test(raw)) codes.add('EUR');
    if (/£/.test(raw)) codes.add('GBP');
    if (/\bUS\$/.test(raw)) codes.add('USD');
    if (/\b(?:CA|C)\$/.test(raw)) codes.add('CAD');
    if (/\b(?:AU|A)\$/.test(raw)) codes.add('AUD');
    if (codes.size > 1) return { currency: null, error: 'Conflicting currency labels on the price' };
    const explicit = [...codes][0];
    if (explicit && !SUPPORTED_CURRENCIES.has(explicit)) return { currency: null, error: `Unsupported currency: ${explicit}` };
    if (explicit && hint && explicit !== hint) return { currency: null, error: `Currency conflict: page says ${explicit}, expected ${hint}` };
    const currency = explicit || hint;
    if (raw.includes('$') && currency && !['USD', 'CAD', 'AUD'].includes(currency)) return { currency: null, error: 'Currency conflict: dollar symbol with a different currency' };
    if (/[¥￥]/.test(raw) && currency && !['JPY', 'CNY'].includes(currency)) return { currency: null, error: 'Currency conflict: yen/yuan symbol with a different currency' };
    if (!currency) return { currency: null, error: 'Currency is uncertain. Choose a currency override for this item.' };
    return { currency, error: null };
}

function parseAmount(raw, locale = null) {
    let value = String(raw ?? '').trim();
    if (locale) {
        const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
        const decimal = parts.find(part => part.type === 'decimal')?.value || '.';
        const group = parts.find(part => part.type === 'group')?.value;
        // Space grouping is commonly emitted as normal, nonbreaking or narrow space.
        if (group && /\s/.test(group)) value = value.replace(/[\s\u00a0\u202f]/g, group);
        const pieces = value.split(decimal);
        if (pieces.length > 2 || (pieces.length === 2 && !/^\d+$/.test(pieces[1]))) return null;
        let integer = pieces[0];
        if (group && integer.includes(group)) {
            const groups = integer.split(group);
            if (!/^\d{1,3}$/.test(groups[0]) || !groups.slice(1).every(part => /^\d{3}$/.test(part))) return null;
            integer = groups.join('');
        }
        if (!/^\d+$/.test(integer)) return null;
        value = integer + (pieces.length === 2 ? '.' + pieces[1] : '');
    } else {
        value = value.replace(/[\s'’]/g, '');
        if (!/^\d+(?:[.,]\d+)*$/.test(value)) return null;
        if (value.includes('.') && value.includes(',')) {
            const decimal = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ',';
            const group = decimal === '.' ? ',' : '.';
            const [integer, fraction, extra] = value.split(decimal);
            if (extra !== undefined || !/^\d{1,2}$/.test(fraction)) return null;
            const groups = integer.split(group);
            if (!/^\d{1,3}$/.test(groups[0]) || !groups.slice(1).every(part => /^\d{3}$/.test(part))) return null;
            value = groups.join('') + '.' + fraction;
        } else if (/[.,]/.test(value)) {
            const parts = value.split(value.includes(',') ? ',' : '.');
            if (parts.slice(1).every(part => part.length === 3) && parts[0].length <= 3) value = parts.join('');
            else if (parts.length === 2 && parts[1].length <= 2) value = parts.join('.');
            else return null;
        }
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
module.exports = { SUPPORTED_CURRENCIES, extractionOptions, resolveCurrency, parseAmount };
