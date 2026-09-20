class WebsiteError extends Error {
    constructor(code, message, retryAt = null) {
        super(message);
        this.code = code;
        this.retryAt = retryAt;
    }
}
function parseRetryAfter(value, now = Date.now()) {
    if (value == null || String(value).trim() === '') return null;
    const raw = String(value).trim();
    const at = /^\d+$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
    return Number.isFinite(at) && at > now && at <= 8640000000000000 ? at : null;
}
function responseError(status, headers = {}, now = Date.now()) {
    const retryAt = parseRetryAfter(headers['retry-after'], now);
    if (String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge') {
        return new WebsiteError('challenge', 'Website requires human verification; retaining the last trusted price', retryAt);
    }
    if (status === 429) return new WebsiteError('rate_limited', 'Website is limiting requests; retaining the last trusted price', retryAt);
    if (status === 403) return new WebsiteError('access_blocked', 'Website refused access (HTTP 403); retaining the last trusted price', retryAt);
    if (status >= 400) return new WebsiteError('http_error', `Website returned HTTP ${status}; retaining the last trusted price`, retryAt);
    return null;
}
module.exports = { WebsiteError, parseRetryAfter, responseError };
