const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../lib/store');
const { createValidator, isPrivateOrSpecialIp } = require('../lib/network');

test('private, loopback, mapped IPv6 and special destinations are rejected', async () => {
    for (const ip of ['127.0.0.1','10.0.0.2','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1','fc00::1']) assert(isPrivateOrSpecialIp(ip), ip);
    assert(!isPrivateOrSpecialIp('93.184.216.34'));
    assert(!isPrivateOrSpecialIp('2606:4700:4700::1111'));
    const validate = createValidator(['shop.example'], async host => [{ address: host === 'internal.example' ? '127.0.0.1' : '93.184.216.34' }]);
    await assert.rejects(validate('file:///etc/passwd'), /http/);
    await assert.rejects(validate('http://internal.example', { subresource: true }), /private/);
    await assert.rejects(validate('https://other.example'), /allowlisted/);
    assert.equal((await validate('https://cdn.example', { subresource: true })).address, '93.184.216.34');
    assert.equal((await validate('https://shop.example')).address, '93.184.216.34');
});

test('upgrade snapshot includes committed WAL state and has private permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centsible-snapshot-'));
    const store = new Store(root);
    try {
        store.write('items', [{ id: 'one', price: 99 }]);
        store.write('runtime', { events: ['pending'] });
        const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/snapshot.js')], {
            env: { ...process.env, DATA_DIR: root }, encoding: 'utf8', timeout: 10000
        });
        assert.equal(result.status, 0, result.stderr);
        const filename = result.stdout.trim();
        assert(filename, `Snapshot process returned no filename: ${result.stderr}`);
        const snapshot = new DatabaseSync(filename, { readOnly: true });
        try {
            assert.equal(JSON.parse(snapshot.prepare('SELECT value FROM items').get().value).price, 99);
            assert.deepEqual(JSON.parse(snapshot.prepare("SELECT value FROM state WHERE key='runtime'").get().value).events, ['pending']);
        } finally { snapshot.close(); }
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('update takes a snapshot before building and never replaces the container after a failed build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centsible-update-test-'));
    try {
        const docker = path.join(root, 'docker');
        fs.writeFileSync(docker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_TEST_LOG"
case "$*" in
  'compose images -q centsible') echo fixture-image ;;
  'compose build --pull') exit "\${BUILD_EXIT:-0}" ;;
esac
`, { mode: 0o755 });
        const run = (failure) => {
            const log = path.join(root, `commands-${failure}`);
            const result = spawnSync('bash', [path.join(__dirname, '../../scripts/update.sh')], {
                env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DOCKER_TEST_LOG: log, BUILD_EXIT: String(failure) }, encoding: 'utf8'
            });
            return { result, commands: fs.readFileSync(log, 'utf8') };
        };
        const success = run(0);
        assert.equal(success.result.status, 0);
        assert(success.commands.indexOf('snapshot.js') < success.commands.indexOf('compose build --pull'));
        assert(success.commands.includes('compose up -d --wait'));
        const failure = run(1);
        assert.notEqual(failure.result.status, 0);
        assert(!failure.commands.includes('compose up'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
