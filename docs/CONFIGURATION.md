# Configuration

[Back to README](../README.md)

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

## Network access

Use Centsible on a trusted LAN or behind an authenticated reverse proxy. It has no built-in account authentication. CORS controls browser origins; it is not authentication. Set `BIND_ADDRESS=127.0.0.1` for local-only access through Docker Compose.
