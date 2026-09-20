const axios = require('axios');

function retryDelay(error, attempts, now = Date.now()) {
    const header = error.response?.headers?.['retry-after'];
    const serverSeconds = Number(error.response?.data?.retry_after ?? error.response?.data?.parameters?.retry_after);
    const headerMs = Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - now;
    const hinted = Number.isFinite(serverSeconds) ? serverSeconds * 1000 : headerMs;
    return Math.max(1000, Number.isFinite(hinted) && hinted > 0 ? hinted : Math.min(6 * 3600000, 30000 * 2 ** Math.min(attempts - 1, 10)));
}
async function deliver(channel, event, settings, options = {}) {
    const post = options.post || axios.post;
    const requestOptions = { timeout: 15000, maxRedirects: 0, signal: AbortSignal.timeout(20000) };
    try {
        if (channel === 'discord') {
            if (!settings.discordWebhook) throw new Error('Destination is not configured');
            await post(settings.discordWebhook, {
                content: `**${event.title}**\n${event.message}`.slice(0, 2000),
                allowed_mentions: { parse: [] }
            }, requestOptions);
        } else if (channel === 'telegram') {
            if (!settings.telegramWebhook || !settings.telegramChatId) throw new Error('Destination is not configured');
            // Plain text avoids Telegram rejecting arbitrary product names as Markdown.
            const response = await post(`https://api.telegram.org/bot${settings.telegramWebhook}/sendMessage`, {
                chat_id: settings.telegramChatId,
                text: `${event.title}\n${event.message}`.slice(0, 4096)
            }, requestOptions);
            if (response.data?.ok === false) {
                const error = new Error('Telegram rejected the message');
                error.response = response;
                throw error;
            }
        } else throw new Error('Unsupported channel');
        return { success: true, error: null };
    } catch (error) {
        // Do not persist request URLs or response bodies containing credentials.
        const status = Number(error.response?.status || error.response?.data?.error_code);
        return {
            success: false,
            error: status ? `Delivery rejected (HTTP ${status})` : (error.code === 'ECONNABORTED' || error.name === 'TimeoutError' ? 'Delivery timed out' : 'Delivery failed; check the destination and network'),
            retryAfterMs: retryDelay(error, options.attempts || 1)
        };
    }
}
module.exports = { deliver, retryDelay };
