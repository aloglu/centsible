# Price tracking and alerts

[Back to README](../README.md)

## Currencies and number formats

Prices and targets use the item's native currency (including TRY, EUR and GBP). Extraction requires currency evidence from the page; a bare dollar sign or country domain is not enough. Use **Currency & number format (optional)** when adding an item, in Extractor Lab, or in the item editor to supply missing currency information or disambiguate rendered numbers such as `1.299`. Machine-readable prices keep their decimal meaning. Overrides cannot relabel existing history or contradict an explicit page currency.

## Blocked websites

Human-verification challenges and access refusals are failed checks: the last trusted price and history remain intact. The app does not solve challenges. Its normal check schedule remains unchanged; an explicit `Retry-After` response temporarily prevents further requests to the same origin. That wait is held in memory and resets when the app restarts. A site that continues to require human verification may remain unavailable to the scraper.

## Reliability behavior

- Price updates and pending notifications commit together in SQLite. Delivery retries survive restarts, use bounded requests and backoff, and track Discord and Telegram independently. Successful channels are not intentionally resent when another fails. Rate-limit delays are respected.
- Delivery is **at least once**: if a destination accepts a message but the process stops before recording success, a retry can duplicate it. There is no silent retry limit; persistent failures remain visible in System Activity. Removing a destination leaves its pending deliveries visible until it is configured again.
- Targets notify once per eligible episode or changed target, including when an item is already below a newly configured target. Leaving and re-entering the target range rearms the alert. Cooldowns apply per item and alert type; pending events are not replaced by later checks.
- Manual and scheduled checks use the same validation, history, and alert logic. A scan starts on startup and runs on the configured interval. Checks and browser jobs do not overlap without bounds.
- Extraction uses product-scoped structured data, site selectors, and guarded DOM candidates. Ambiguous prices, broken custom selectors, weak evidence, and currency changes preserve the last trusted price. Moves below half or above twice the trusted price require a matching check at least one minute later (within 24 hours).
- Only selectors explicitly chosen by you are treated as custom selectors. Use Extractor Lab for sites with several variants/offers. Automated extraction cannot guarantee support for every site or access challenge.
- Three consecutive failures or an overdue successful check can generate a health alert, limited to once per day per item. A subsequent successful check generates a recovery notice. No external monitoring service is required.

History is retained; SQLite updates an individual item's record on checks instead of rewriting the whole collection. The UI still loads full history, so very large portfolios may eventually need pagination or archival.
