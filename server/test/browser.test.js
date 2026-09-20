const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { BrowserFetcher } = require('../lib/browser');
const { parseHtml } = require('../lib/extraction');

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test('browser waits for a delayed product price and rejects HTTP errors and blocked redirects', { skip: !executablePath }, async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/bad') { res.writeHead(503); res.end('unavailable'); return; }
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://blocked.invalid/' }); res.end(); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><body><div id="price"></div><script>setTimeout(()=>document.getElementById("price").textContent="1.299,99 EUR", 2300)</script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://fixture.invalid:${server.address().port}`;
    const fetcher = new BrowserFetcher({ executablePath, validateUrl: async url => {
        if (new URL(url).hostname !== 'fixture.invalid') throw new Error('Blocked');
        return { address: '127.0.0.1' };
    } });
    t.after(async () => { await fetcher.close(); await new Promise(resolve => server.close(resolve)); });
    const html = await fetcher.fetch(base, '#price');
    assert.equal(parseHtml(html, '#price', base).price, 1299.99);
    await assert.rejects(fetcher.fetch(`${base}/bad`), /503/);
    await assert.rejects(fetcher.fetch(`${base}/redirect`));
});

test('HTTPS tunnels connect only to the validator-approved IP', async t => {
    const net = require('node:net');
    const { FetchProxy } = require('../lib/fetch-proxy');
    const origin = net.createServer(socket => socket.once('data', bytes => socket.end(`received:${bytes}`)));
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    const proxy = new FetchProxy(async url => {
        if (new URL(url).hostname !== 'fixture.invalid') throw new Error('Blocked');
        return { address: '127.0.0.1' };
    });
    const port = await proxy.start();
    t.after(async () => { await proxy.close(); await new Promise(resolve => origin.close(resolve)); });
    const tunnel = async hostname => new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: `${hostname}:${origin.address().port}` });
        request.on('error', reject);
        request.on('connect', (response, socket) => {
            if (response.statusCode !== 200) { socket.destroy(); resolve({ status: response.statusCode }); return; }
            socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Tunnel timeout')); });
            socket.on('error', reject);
            socket.once('data', bytes => { socket.destroy(); resolve({ status: 200, body: bytes.toString() }); });
            socket.write('ping');
        });
        request.end();
    });
    assert.deepEqual(await tunnel('fixture.invalid'), { status: 200, body: 'received:ping' });
    assert.equal((await tunnel('blocked.invalid')).status, 403);
});

test('browser identifies challenges and honors only explicit Retry-After waits', { skip: !executablePath }, async t => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
        hits++;
        if (req.url === '/challenge') { res.writeHead(200, {'cf-mitigated':'challenge'}); res.end('verify'); return; }
        if (req.url === '/denied') { res.writeHead(403); res.end('denied'); return; }
        if (req.url === '/limited') { res.writeHead(429, {'Retry-After':'2'}); res.end('wait'); return; }
        res.end('<div class="price">100 EUR</div>');
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = `http://fixture.invalid:${server.address().port}`;
    const fetcher = new BrowserFetcher({executablePath, validateUrl: async () => ({address:'127.0.0.1'})});
    t.after(async () => { await fetcher.close(); await new Promise(resolve => server.close(resolve)); });
    await assert.rejects(fetcher.fetch(base+'/challenge'), e => e.code === 'challenge');
    await assert.rejects(fetcher.fetch(base+'/denied'), e => e.code === 'access_blocked');
    await assert.rejects(fetcher.fetch(base+'/limited'), e => e.code === 'rate_limited' && e.retryAt > Date.now());
    const before = hits;
    await assert.rejects(fetcher.fetch(base+'/product'), e => e.code === 'retry_later');
    assert.equal(hits,before);
    await new Promise(resolve => setTimeout(resolve,2100));
    assert.match(await fetcher.fetch(base+'/product'), /100 EUR/);
    assert.equal(hits,before+1);
});

test('proxy handles peer resets while CONNECT validation is pending', async t => {
    const net = require('node:net');
    const { FetchProxy } = require('../lib/fetch-proxy');
    let entered;
    let release;
    const validating = new Promise(resolve => { entered = resolve; });
    const validation = new Promise(resolve => { release = resolve; });
    const proxy = new FetchProxy(async () => { entered(); await validation; throw new Error('Blocked'); });
    const port = await proxy.start();
    t.after(async () => { release(); await proxy.close(); });
    const socket = net.connect({host:'127.0.0.1',port});
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect',resolve));
    socket.write('CONNECT blocked.invalid:443 HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n');
    await validating;
    const disconnected = new Promise(resolve => socket.once('close',resolve));
    socket.resetAndDestroy();
    await disconnected;
    await new Promise(resolve => setTimeout(resolve,50));
    release();
    await new Promise(resolve => setTimeout(resolve,50));
    assert.equal(proxy.sockets.size,0);
});
