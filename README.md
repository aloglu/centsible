# Centsible

Self-hosted price tracking with price history, target/drop/stock alerts, Discord and Telegram, encrypted backups, and an extraction lab. The web UI and scheduler run together; your browser does not need to stay open.

## Install with Docker Compose

Requires Docker Engine and the Compose v2 plugin. Run these commands in this repository:

```sh
cp .env.example .env
# Edit .env if you want notification destinations or a different host port.
docker compose up -d --build --wait --wait-timeout 180
```

Open **http://localhost:3000** (or your server's address). Add a product URL, configure Discord/Telegram in Settings, and send a test notification. Configure a backup password in Settings. All persistent state lives in the `./data` bind mount; container replacement preserves it.

This is a fresh-install release using SQLite. It does not automatically load old `prices.json` / `settings.json` files. Encrypted full-state exports can be deliberately imported in Settings; old extraction errors in imported history are not automatically repaired.

Use this app on a trusted LAN or behind an authenticated reverse proxy. It has no built-in account authentication. CORS is not authentication. The container health check confirms the web process responds; **System Activity → System Health & Deliveries** reports checks, stale items, pending alerts, retries, and backups.

## Update

Export an encrypted backup in Settings if you want a portable recovery copy. Then:

```sh
git pull --ff-only
./scripts/update.sh
```

The helper saves the current image under a timestamped rollback tag, makes a consistent database snapshot, builds the new image while the old app remains available, and replaces the container only after the build succeeds. It waits for the new container's health check. A failed build leaves the old container running; a failed health check reports the rollback image and leaves logs available for diagnosis.

Upgrade snapshots are local **unencrypted** SQLite copies including destination credentials, created with mode `0600` in `data/upgrade-snapshots/`. Keep this directory private. They are separate from encrypted in-app exports and are not automatically deleted. Review/remove older snapshots when you no longer need them.

For the first upgrade from the old JSON release, use a fresh data directory and the normal installation command; the new update helper expects the running release to support SQLite snapshots.

### Roll back

Use the image tag and snapshot printed by the update helper:

1. Stop the app: `docker compose stop centsible`.
2. Move the entire current `data` directory aside to retain it for investigation.
3. Create a new `data` directory and copy the desired `before-update-….sqlite` snapshot into it as `centsible.sqlite`. Keep the file private and writable by the container. If necessary, use `sudo` for files written by Docker. Do not copy an old `-wal` or `-shm` file beside it.
4. Start the previous image: `CENTSIBLE_IMAGE=centsible:rollback-TIMESTAMP docker compose up -d --no-build --wait`.

A database from a newer unsupported schema is rejected instead of being silently overwritten. Restoring a snapshot can replay notifications that were still pending when that snapshot was taken.

## Configuration

Compose reads `.env` and passes the following settings into the container. UI settings are persisted; nonempty environment values override the corresponding UI setting.

| Variable | Purpose |
| --- | --- |
| `PORT` | Host-facing port, default `3000`; container uses `3000` |
| `BIND_ADDRESS` | Host bind address, default `0.0.0.0`; use `127.0.0.1` for local-only access |
| `TZ` | Container timezone, default `Europe/Istanbul` |
| `DISCORD_WEBHOOK` | Discord webhook URL |
| `DISCORD_PROXY_BASE` | Optional Discord webhook proxy |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram destination |
| `BACKUP_PASSWORD` | Same password configured in Settings; allows automatic encrypted backups to resume after restart |
| `ALLOWED_ORIGINS` | Optional comma-separated browser origins, e.g. `http://192.168.1.50:3000` |
| `FETCH_ALLOWED_HOSTS` | Optional exact hostnames for product navigation; public CDN subresources remain allowed |
| `DATA_DIR` | Manual-install data path; Compose always uses the mounted `/app/data` |

Without `BACKUP_PASSWORD`, re-enter the configured backup password in Settings after a restart to unlock automated backups. System Activity shows when backups are locked or failing. The password itself and derived key are not saved in the database.

## Reliability behavior

- Price updates and pending notifications commit together in SQLite. Delivery retries survive restarts, use bounded requests and backoff, and track Discord and Telegram independently. Successful channels are not intentionally resent when another fails. Rate-limit delays are respected.
- Delivery is **at least once**: if a destination accepts a message but the process stops before recording success, a retry can duplicate it. There is no silent retry limit; persistent failures remain visible in System Activity. Removing a destination leaves its pending deliveries visible until it is configured again.
- Targets notify once per eligible episode or changed target, including when an item is already below a newly configured target. Leaving and re-entering the target range rearms the alert. Cooldowns apply per item and alert type; pending events are not replaced by later checks.
- Manual and scheduled checks use the same validation, history, and alert logic. A scan starts on startup and runs on the configured interval. Checks and browser jobs do not overlap without bounds.
- Extraction uses product-scoped structured data, site selectors, and guarded DOM candidates. Ambiguous prices, broken custom selectors, weak evidence, and currency changes preserve the last trusted price. Moves below half or above twice the trusted price require a matching check at least one minute later (within 24 hours).
- Only selectors explicitly chosen by you are treated as custom selectors. Use Extractor Lab for sites with several variants/offers. Automated extraction cannot guarantee support for every site or access challenge.
- Three consecutive failures or an overdue successful check can generate a health alert, limited to once per day per item. A subsequent successful check generates a recovery notice. No external monitoring service is required.

History is retained; SQLite updates an individual item's record on checks instead of rewriting the whole collection. The UI still loads full history, so very large portfolios may eventually need pagination or archival.

## Backups

Settings supports encrypted export, import, and restore. Backups include items/history, lists, settings, diagnostics, activity, notification queues, and cooldowns. Automatic encrypted snapshots are attempted at startup and daily while unlocked. Restore replaces state transactionally and creates an encrypted safety backup first.

The live database is `data/centsible.sqlite` with SQLite-managed WAL files. Do not copy only the database file while the app is running; use an in-app export or the consistent snapshot helper:

```sh
docker compose exec -T centsible node server/scripts/snapshot.js
```

## Manual development

Requires Node.js **24 or newer** and Chromium (or Puppeteer's managed browser).

```sh
cp .env.example .env
cd server
npm ci
npm start
```

`npm ci` normally downloads Puppeteer's browser. To use system Chromium, install with `PUPPETEER_SKIP_DOWNLOAD=true npm ci` and set `PUPPETEER_EXECUTABLE_PATH=/path/to/chromium` if it isn't in a standard Linux location. State defaults to the repository's `data/` directory.

```sh
cd server
npm test
```

Tests use temporary databases and local fixtures, including failed delivery/restart, extraction edge cases, backup/restore and concurrent state edits. Browser integration tests run when `PUPPETEER_EXECUTABLE_PATH` or `/usr/bin/chromium` is available. CI runs the suite before publishing images and smoke-tests Compose startup.

Implementation references: [Node SQLite](https://nodejs.org/api/sqlite.html), [Puppeteer readiness checks](https://pptr.dev/api/puppeteer.page.waitforfunction), [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits).

## License

MIT. See [LICENSE](LICENSE).

### Currency and blocked websites

Prices and targets use the item's native currency (including TRY, EUR and GBP). Extraction requires currency evidence from the page; a bare dollar sign or country domain is not enough. Use **Currency & number format (optional)** when adding an item, in Extractor Lab, or in the item editor to supply missing currency information or disambiguate rendered numbers such as `1.299`. Machine-readable prices keep their decimal meaning. Overrides cannot relabel existing history or contradict an explicit page currency.

Human-verification challenges and access refusals are failed checks: the last trusted price and history remain intact. The app does not solve challenges. Its normal check schedule remains unchanged; an explicit `Retry-After` response temporarily prevents further requests to the same origin. That wait is held in memory and resets when the app restarts. A site that continues to require human verification may remain unavailable to the scraper.
