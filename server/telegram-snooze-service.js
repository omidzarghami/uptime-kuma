const axios = require("axios");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { setSnooze } = require("./monitor-snooze");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

/** @type {Map<string, { abort: AbortController, offset: number, serverUrl: string }>} */
const pollers = new Map();

let refreshTimer = null;
let running = false;

/**
 * Build axios config with optional HTTP(S)_PROXY / SOCKS proxy.
 * @returns {object} Axios config
 */
function getAxiosConfig() {
    const config = {};
    const proxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY;
    const socks = process.env.socks_proxy || process.env.SOCKS_PROXY;

    if (socks) {
        const agent = new SocksProxyAgent(socks);
        config.httpAgent = agent;
        config.httpsAgent = agent;
    } else if (proxy) {
        config.httpAgent = new HttpProxyAgent(proxy);
        config.httpsAgent = new HttpsProxyAgent(proxy);
    }

    return config;
}

/**
 * Load unique Telegram bot tokens that have snooze buttons enabled.
 * @returns {Promise<{ token: string, serverUrl: string }[]>}
 */
async function loadSnoozeBots() {
    const rows = await R.getAll("SELECT config FROM notification WHERE active = 1");
    const bots = new Map();

    for (const row of rows) {
        let config;
        try {
            config = JSON.parse(row.config);
        } catch {
            continue;
        }

        if (config.type !== "telegram" || !config.telegramBotToken || !config.telegramEnableSnooze) {
            continue;
        }

        const token = config.telegramBotToken;
        if (!bots.has(token)) {
            bots.set(token, {
                token,
                serverUrl: config.telegramServerUrl || "https://api.telegram.org",
            });
        }
    }

    return [...bots.values()];
}

/**
 * Handle a single Telegram update (callback_query for snooze).
 * @param {string} token Bot token
 * @param {string} serverUrl Telegram API base URL
 * @param {object} update Telegram update object
 * @returns {Promise<void>}
 */
async function handleUpdate(token, serverUrl, update) {
    const cq = update.callback_query;
    if (!cq || !cq.data) {
        return;
    }

    if (cq.data.startsWith("uks:noop:")) {
        await answerCallback(token, serverUrl, cq.id, "Already snoozed");
        return;
    }

    // Format: uks:{monitorId}:{minutes}
    const match = /^uks:(\d+):(\d+)$/.exec(cq.data);
    if (!match) {
        return;
    }

    const monitorID = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const allowed = new Set([30, 60, 120, 360, 1440]);

    if (!allowed.has(minutes)) {
        await answerCallback(token, serverUrl, cq.id, "Invalid snooze duration");
        return;
    }

    const monitor = await R.getRow("SELECT id, name FROM monitor WHERE id = ?", [monitorID]);
    if (!monitor) {
        await answerCallback(token, serverUrl, cq.id, "Monitor not found");
        return;
    }

    const until = await setSnooze(monitorID, minutes);
    const label = minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
    const text = `Snoozed ${label} (until ${until} UTC)`;

    await answerCallback(token, serverUrl, cq.id, text);

    if (cq.message) {
        try {
            const config = getAxiosConfig();
            await axios.post(
                `${serverUrl}/bot${token}/editMessageReplyMarkup`,
                {
                    chat_id: cq.message.chat.id,
                    message_id: cq.message.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: `😴 ${text}`, callback_data: "uks:noop:0" }]],
                    },
                },
                config
            );
        } catch (e) {
            log.debug("telegram-snooze", `Could not edit reply markup: ${e.message}`);
        }
    }
}

/**
 * Answer a Telegram callback query.
 * @param {string} token Bot token
 * @param {string} serverUrl API base
 * @param {string} callbackQueryId Callback query id
 * @param {string} text Toast text
 * @returns {Promise<void>}
 */
async function answerCallback(token, serverUrl, callbackQueryId, text) {
    const config = getAxiosConfig();
    await axios.post(
        `${serverUrl}/bot${token}/answerCallbackQuery`,
        {
            callback_query_id: callbackQueryId,
            text,
            show_alert: false,
        },
        config
    );
}

/**
 * Long-poll getUpdates for one bot token.
 * @param {string} token Bot token
 * @param {string} serverUrl API base
 * @returns {Promise<void>}
 */
async function pollLoop(token, serverUrl) {
    const state = pollers.get(token);
    if (!state) {
        return;
    }

    const config = getAxiosConfig();

    // Ensure polling works (clear any previous webhook)
    try {
        await axios.post(`${serverUrl}/bot${token}/deleteWebhook`, { drop_pending_updates: false }, config);
    } catch (e) {
        log.warn("telegram-snooze", `deleteWebhook failed: ${e.message}`);
    }

    while (running && pollers.has(token)) {
        const current = pollers.get(token);
        if (!current) {
            break;
        }

        try {
            const res = await axios.get(`${serverUrl}/bot${token}/getUpdates`, {
                ...config,
                params: {
                    offset: current.offset,
                    timeout: 25,
                    allowed_updates: JSON.stringify(["callback_query"]),
                },
                timeout: 35000,
                signal: current.abort.signal,
            });

            const updates = res.data?.result || [];
            for (const update of updates) {
                current.offset = update.update_id + 1;
                try {
                    await handleUpdate(token, serverUrl, update);
                } catch (e) {
                    log.error("telegram-snooze", `Handle update failed: ${e.message}`);
                }
            }
        } catch (e) {
            if (e.name === "CanceledError" || e.code === "ERR_CANCELED" || !running) {
                break;
            }
            log.warn("telegram-snooze", `getUpdates error: ${e.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

/**
 * Sync active pollers with notification configs.
 * @returns {Promise<void>}
 */
async function refreshBots() {
    if (!running) {
        return;
    }

    const bots = await loadSnoozeBots();
    const wanted = new Set(bots.map((b) => b.token));

    for (const token of [...pollers.keys()]) {
        if (!wanted.has(token)) {
            const state = pollers.get(token);
            state.abort.abort();
            pollers.delete(token);
            log.info("telegram-snooze", "Stopped poller for removed/disabled bot");
        }
    }

    for (const bot of bots) {
        if (pollers.has(bot.token)) {
            continue;
        }

        const abort = new AbortController();
        pollers.set(bot.token, {
            abort,
            offset: 0,
            serverUrl: bot.serverUrl,
        });
        log.info("telegram-snooze", "Started Telegram snooze poller for a bot");
        pollLoop(bot.token, bot.serverUrl).catch((e) => {
            log.error("telegram-snooze", `Poller crashed: ${e.message}`);
            pollers.delete(bot.token);
        });
    }
}

/**
 * Start the Telegram snooze callback service (long-polling).
 * @returns {Promise<void>}
 */
async function startTelegramSnoozeService() {
    if (running) {
        return;
    }
    running = true;
    await refreshBots();
    refreshTimer = setInterval(() => {
        refreshBots().catch((e) => log.error("telegram-snooze", e.message));
    }, 60000);
    log.info("telegram-snooze", "Telegram snooze service started");
}

/**
 * Stop all pollers.
 * @returns {void}
 */
function stopTelegramSnoozeService() {
    running = false;
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
    for (const [, state] of pollers) {
        state.abort.abort();
    }
    pollers.clear();
    log.info("telegram-snooze", "Telegram snooze service stopped");
}

module.exports = {
    startTelegramSnoozeService,
    stopTelegramSnoozeService,
    refreshBots,
};
