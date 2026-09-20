const crypto = require('node:crypto');

function emptyRuntime() {
    return { events: [], cooldowns: {}, lastCheckStarted: null, lastCheckCompleted: null, backup: null };
}
function channelsFor(settings) {
    return [settings.discordWebhook && 'discord', settings.telegramWebhook && settings.telegramChatId && 'telegram'].filter(Boolean);
}
function enqueue(runtime, settings, key, title, message, now = Date.now(), cooldownMinutes = 240) {
    const channels = channelsFor(settings);
    if (!channels.length) return false;
    if (runtime.events.some(e => e.key === key && Object.values(e.channels).some(c => !c.deliveredAt))) return false;
    if (now - (runtime.cooldowns[key] || 0) < Math.max(1, Number(cooldownMinutes) || 240) * 60000) return false;
    runtime.cooldowns[key] = now;
    runtime.events.push({
        id: crypto.randomUUID(), key, title, message: `${message}\nObserved: ${new Date(now).toISOString()}`, createdAt: new Date(now).toISOString(),
        channels: Object.fromEntries(channels.map(channel => [channel, { attempts: 0, nextAttempt: now, deliveredAt: null, error: null }]))
    });
    return true;
}
function prune(runtime, now = Date.now()) {
    const completed = runtime.events.filter(e => Object.values(e.channels).every(c => c.deliveredAt)).slice(-200);
    const pending = runtime.events.filter(e => Object.values(e.channels).some(c => !c.deliveredAt));
    runtime.events = [...completed, ...pending];
    for (const [key, at] of Object.entries(runtime.cooldowns)) {
        if (now - at > 30 * 86400000) delete runtime.cooldowns[key];
    }
}
function reference24h(history, now) {
    // Use the last known price at the boundary, never a newer point. A gap of
    // more than 48h means there is no defensible 24h comparison.
    const target = now - 86400000;
    return (history || []).reduce((best, point) => {
        const at = Date.parse(point.date);
        return at <= target && target - at <= 48 * 3600000 && Number.isFinite(point.price)
            && (!best || at > Date.parse(best.date)) ? point : best;
    }, null);
}
function evaluateAlerts(current, next, rules, runtime, settings, now = Date.now()) {
    const send = (kind, title, message) => enqueue(runtime, settings, `${kind}:${current.id}`, title,
        `${current.name}: ${message}\n${current.url}`, now, rules.notifyCooldownMinutes);
    const validPrice = next.stockStatus !== 'out_of_stock' && Number.isFinite(next.currentPrice);
    const oldPrice = current.currentPrice;
    const price = next.currentPrice;
    const money = `${price} ${next.currency || ''}`.trim();
    if (validPrice && Number.isFinite(oldPrice) && price < oldPrice) {
        if (rules.priceDropEnabled) send('drop', 'Price Drop', `${money} (was ${oldPrice} ${next.currency || ''}).`);
        const reference = reference24h(current.history, now);
        if (rules.priceDrop24hEnabled && reference && reference.price > 0) {
            const percent = (reference.price - price) / reference.price * 100;
            if (percent >= Number(rules.priceDrop24hPercent)) send('drop24h', '24h Price Drop', `${percent.toFixed(2)}% lower; now ${money}.`);
        }
    }
    const lowest = (current.history || []).reduce((min, p) => Number.isFinite(p.price) ? Math.min(min, p.price) : min,
        Number.isFinite(oldPrice) ? oldPrice : Infinity);
    if (validPrice && rules.allTimeLowEnabled && lowest !== Infinity && price < lowest) {
        send('atl', 'All-Time Low', `new low of ${money}.`);
    }
    // Once per target/eligibility episode. Targets changed while already below
    // the threshold are evaluated too; queued deliveries survive later checks.
    if (!validPrice || !(Number(next.targetPrice) > 0) || price > Number(next.targetPrice)) {
        next.alertedTarget = null;
    } else if (rules.targetHitEnabled && current.alertedTarget !== Number(next.targetPrice)) {
        if (send('target', 'Target Price Hit', `${money}, meeting your target of ${next.targetPrice}.`)) next.alertedTarget = Number(next.targetPrice);
    }
    if (rules.lowConfidenceEnabled && Number(next.extractionConfidence || 0) < Number(rules.lowConfidenceThreshold || 55)) {
        send('lowconf', 'Low Extraction Confidence', `extraction confidence is ${next.extractionConfidence || 0}.`);
    }
    const previousStock = current.lastKnownStockStatus || current.stockStatus;
    if (previousStock !== 'out_of_stock' && next.stockStatus === 'out_of_stock') send('oos', 'Out of Stock', 'the product is out of stock.');
    if (previousStock === 'out_of_stock' && next.stockStatus === 'in_stock') send('stock', 'Back in Stock', `available again at ${money}.`);
    if (current.healthAlerted) {
        send('recovery', 'Price Checks Recovered', `checks are working again; latest price ${money}.`);
        next.healthAlerted = false;
    }
}
function evaluateHealth(item, rules, runtime, settings, now = Date.now()) {
    if (item.purchased) return false;
    const last = Date.parse(item.lastChecked || item.createdAt) || now;
    const stale = rules.staleEnabled && now - last > Math.max(1, Number(rules.staleHours) || 12) * 3600000;
    const failing = Number(item.consecutiveFailures || 0) >= 3;
    if (!stale && !failing) return false;
    const title = stale ? 'Price Check Overdue' : 'Price Checks Failing';
    const message = `${item.name}: ${item.lastCheckError || 'No successful check within the expected period.'}\n${item.url}`;
    return enqueue(runtime, settings, `health:${item.id}`, title, message, now, Math.max(1440, rules.notifyCooldownMinutes || 0));
}
module.exports = { emptyRuntime, channelsFor, enqueue, prune, reference24h, evaluateAlerts, evaluateHealth };
