const dns = require('node:dns').promises;
const net = require('node:net');

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
        if (a === 192 && (b === 168 || b === 0)) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
        if (a === 203 && b === 0) return true;
        if (a >= 224) return true;
        return false;
    }

    const normalized = ipAddress.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('::ffff:')) {
        const suffix = normalized.slice(7);
        if (suffix.includes('.')) return isPrivateOrSpecialIp(suffix);
        const parts = suffix.split(':').map(p => parseInt(p, 16));
        if (parts.length !== 2) return true;
        return isPrivateOrSpecialIp([parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join('.'));
    }
    if (!/^[23][0-9a-f]{3}:/.test(normalized)) return true;
    if (normalized.startsWith('2001:db8:')) return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    return false;
}

function createValidator(allowedHosts = [], lookup = dns.lookup) {
    return async function validateFetchUrl(rawUrl, { subresource = false } = {}) {
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

        if (parsed.username || parsed.password) throw new Error('Credentials in URLs are not allowed');
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (hostname === 'localhost') {
            throw new Error('Refusing localhost fetch');
        }

        if (!subresource && allowedHosts.length && !allowedHosts.includes(hostname)) {
            throw new Error('Host is not allowlisted');
        }

        let resolved;
        try {
            resolved = await lookup(hostname, { all: true, verbatim: true });
        } catch {
            throw new Error('Failed to resolve hostname');
        }

        if (!resolved.length) {
            throw new Error('Hostname has no DNS records');
        }

        if (resolved.some(record => isPrivateOrSpecialIp(record.address))) {
            throw new Error('Refusing private/link-local destination');
        }
        return { address: (resolved.find(record => record.family === 4) || resolved[0]).address, hostname };
    };
}

module.exports = { createValidator, isPrivateOrSpecialIp };
