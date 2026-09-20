const http = require('node:http');
const net = require('node:net');

// Chromium resolves its connections through this loopback-only proxy. The
// validator returns an approved IP and the socket connects to that exact IP,
// closing the DNS-rebinding gap between validation and browser navigation.
class FetchProxy {
    constructor(validateUrl) {
        this.validateUrl = validateUrl;
        this.sockets = new Set();
        this.server = http.createServer(async (request, response) => {
            let upstream;
            try {
                const target = await this.validateUrl(request.url, { subresource: true });
                const url = new URL(request.url);
                if (url.protocol !== 'http:') throw new Error('Unsupported proxy request');
                upstream = http.request({ hostname: target.address, port: Number(url.port || 80),
                    method: request.method, path: url.pathname + url.search,
                    headers: { ...request.headers, host: url.host }, timeout: 45000 }, remote => {
                    response.writeHead(remote.statusCode, remote.headers);
                    remote.pipe(response);
                });
                upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
                upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
                response.on('close', () => upstream.destroy());
                request.pipe(upstream);
            } catch {
                response.writeHead(403); response.end('Destination blocked');
            }
        });
        this.server.on('connection', socket => {
            this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
        });
        this.server.on('connect', async (request, client, head) => {
            try {
                const url = new URL(`https://${request.url}`);
                const target = await this.validateUrl(url.href, { subresource: true });
                if (client.destroyed) return;
                const upstream = net.connect({ host: target.address, port: Number(url.port || 443) });
                this.sockets.add(upstream);
                upstream.on('close', () => { this.sockets.delete(upstream); client.destroy(); });
                client.on('close', () => upstream.destroy());
                client.on('error', () => upstream.destroy());
                upstream.setTimeout(45000, () => upstream.destroy());
                upstream.on('error', () => client.destroy());
                upstream.on('connect', () => {
                    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    if (head.length) upstream.write(head);
                    client.pipe(upstream); upstream.pipe(client);
                });
            } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
        });
        this.server.on('clientError', (_error, socket) => socket.destroy());
    }
    async start() {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', resolve);
        });
        return this.server.address().port;
    }
    async close() {
        for (const socket of this.sockets) socket.destroy();
        await new Promise(resolve => this.server.close(resolve));
    }
}
module.exports = { FetchProxy };
