# Updates and backups

[Back to README](../README.md)

## Update

Export an encrypted backup in Settings if you want a portable recovery copy. Then:

```sh
git pull --ff-only
./scripts/update.sh
```

The helper saves the current image under a timestamped rollback tag, makes a consistent database snapshot, builds the new image while the old app remains available, and replaces the container only after the build succeeds. It waits for the new container's health check. A failed build leaves the old container running; a failed health check reports the rollback image and leaves logs available for diagnosis.

Upgrade snapshots are local **unencrypted** SQLite copies including destination credentials, created with mode `0600` in `data/upgrade-snapshots/`. Keep this directory private. They are separate from encrypted in-app exports and are not automatically deleted. Review/remove older snapshots when you no longer need them.

For the first upgrade from the old JSON release, use a fresh data directory and the normal installation command; the new update helper expects the running release to support SQLite snapshots.

## Roll back

Use the image tag and snapshot printed by the update helper:

1. Stop the app: `docker compose stop centsible`.
2. Move the entire current `data` directory aside to retain it for investigation.
3. Create a new `data` directory and copy the desired `before-update-….sqlite` snapshot into it as `centsible.sqlite`. Keep the file private and writable by the container. If necessary, use `sudo` for files written by Docker. Do not copy an old `-wal` or `-shm` file beside it.
4. Start the previous image: `CENTSIBLE_IMAGE=centsible:rollback-TIMESTAMP docker compose up -d --no-build --wait`.

A database from a newer unsupported schema is rejected instead of being silently overwritten. Restoring a snapshot can replay notifications that were still pending when that snapshot was taken.

## Backups

Settings supports encrypted export, import, and restore. Backups include items/history, lists, settings, diagnostics, activity, notification queues, and cooldowns. Automatic encrypted snapshots are attempted at startup and daily while unlocked. Restore replaces state transactionally and creates an encrypted safety backup first.

The live database is `data/centsible.sqlite` with SQLite-managed WAL files. Do not copy only the database file while the app is running; use an in-app export or the consistent snapshot helper:

```sh
docker compose exec -T centsible node server/scripts/snapshot.js
```

## Upgrading from JSON storage

This release uses SQLite and does not automatically load old `prices.json` or `settings.json` files. Encrypted full-state exports can be deliberately imported in Settings; old extraction errors in imported history are not automatically repaired.

## Checking app health

The container health check confirms that the web process responds. **System Activity → System Health & Deliveries** reports checks, stale items, pending alerts, retries, and backups. Check this view periodically for failures that need attention.
