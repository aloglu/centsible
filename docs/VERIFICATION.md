# Reliability verification

Verified locally on 2026-09-20 with Node 24.21.0 and system Chromium.

- Full suite: **39 passed, 0 failed, 0 skipped** (`node --test` from `server/`).
- Dependency audit: **0 reported vulnerabilities** after updating the lockfile.
- Browser UI: individual refresh updates the saved price; System Activity renders check/delivery health without JavaScript errors. Currency settings can be saved in the editor and used by subsequent refreshes. The rendered health panel and currency editor were visually inspected.
- Browser extraction: delayed JavaScript prices, rejected HTTP errors, blocked redirects, HTTP/HTTPS connections pinned to validated IPs, challenge headers, and explicit Retry-After waits followed by resumed requests.
- Price validation: TRY/EUR/GBP/USD extraction, ambiguous currency rejection, per-item currency/locale settings across restarts, locale number formats, product/variant identity, conflicting offers, custom-selector failures, challenge pages, confidence limits, and unusual-price confirmation.
- Notifications: target eligibility, cooldowns, per-channel outcomes, rate-limit hints, health/recovery, atomic persistence, and failed delivery followed by successful retry after a process restart. Delivery tests use local/mocked destinations, not real Discord or Telegram accounts.
- Storage/backups: SQLite rollback and restart, encrypted export/import/restore, concurrent edits, live database snapshot including WAL state, and private snapshot permissions.
- Installation/update: Compose configuration and shell syntax validate; a mocked Docker test verifies snapshot-before-build ordering and that a failed build never replaces the running container.

## Verification limits

Docker daemon access is denied on this machine and passwordless sudo is unavailable. A full local image build and Compose startup could not be run. CI now performs that smoke test and runs regressions before image publication; those remote CI jobs have not been executed as part of this local change.

No deployment or real notification delivery was performed. Extraction fixtures cover known failure classes but do not establish support for every live retailer. Alert delivery is at least once: a crash after remote acceptance but before recording success can cause a duplicate.

## Fresh-install behavior

SQLite is the source of truth. Old root JSON files are not automatically migrated. Encrypted exports may be deliberately imported. Upgrade snapshots are private, unencrypted local recovery files; portable in-app backups remain encrypted. See the README for install, update, and rollback commands.

## CI follow-up

Both workflows await Puppeteer's executable path and write it directly to the GitHub environment file after checking that the browser exists. The Docker publication workflow now installs the test browser explicitly, matching CI. The environment writer was verified locally with system Chromium.

A CONNECT peer reset during asynchronous destination validation reproduced the reported unhandled `ECONNRESET` against the previous proxy implementation. The regression passes with socket error handling attached immediately on connection; the full Node 24 suite passes all 39 tests. GitHub-hosted workflow execution remains unverified until these changes are pushed.
