# Centsible

A self-hosted price tracker with price history, target alerts, and Discord and Telegram notifications. Checks run in the background, so your browser does not need to stay open.

## Features

- Track product prices, availability, and history across websites.
- Receive price-drop, target-price, stock, and tracking-health alerts.
- Track prices in their native currency, including TRY, EUR, and GBP.
- Diagnose extraction problems with Extractor Lab and custom selectors.
- Export and restore encrypted backups, including notification state.

## Quick start

Requires Docker Engine and the Docker Compose v2 plugin. From the repository directory:

```sh
cp .env.example .env
# Adjust .env if needed.
docker compose up -d --build --wait --wait-timeout 180
```

Open [localhost:3000](http://localhost:3000), or your server's address. Then:

1. Add a product URL and an optional target price.
2. Configure Discord or Telegram in **Settings** and send a test notification.
3. Set a backup password. To unlock automatic backups after restarts, set the same password as `BACKUP_PASSWORD` in `.env` and recreate the container.

Persistent data lives in `./data` and survives container replacement. Check **System Activity → System Health & Deliveries** periodically for tracking and notification failures.

**Access:** Centsible has no built-in authentication. Use a trusted LAN or an authenticated reverse proxy. For local-only access, set `BIND_ADDRESS=127.0.0.1` in `.env` before starting.

**Existing installations:** This release uses SQLite and does not automatically migrate old JSON files. Read the [upgrade guidance](docs/OPERATIONS.md#upgrading-from-json-storage) before updating an older installation.

## Updating

For installations already using SQLite:

```sh
git pull --ff-only
./scripts/update.sh
```

The helper creates a database snapshot and builds the replacement before restarting the app. See [updates, backups, and rollback](docs/OPERATIONS.md) for recovery instructions and snapshot handling.

## Tracking limitations

Some sites may block automated access or require human verification. Failed or uncertain checks preserve the last trusted price. If a currency or number format is unclear, use the optional controls when adding or editing an item. See [price tracking and alerts](docs/TRACKING.md) for extraction behavior, currencies, and notification guarantees.

## Documentation

- [Configuration](docs/CONFIGURATION.md) — environment variables, notification destinations, and network access.
- [Updates and backups](docs/OPERATIONS.md) — updates, rollback, encrypted exports, and recovery.
- [Price tracking and alerts](docs/TRACKING.md) — currencies, blocked websites, validation, and retries.
- [Local development](docs/DEVELOPMENT.md) — Node.js setup and tests.
- [Verification notes](docs/VERIFICATION.md) — tested behavior and known verification limits.

## License

Released under the [MIT License](LICENSE).
