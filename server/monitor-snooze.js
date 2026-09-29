const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { SQL_DATETIME_FORMAT, log } = require("../src/util");

/**
 * Check whether a monitor currently has an active notification snooze.
 * @param {number} monitorID Monitor ID
 * @returns {Promise<boolean>} True if notifications should be suppressed
 */
async function isSnoozed(monitorID) {
    if (!monitorID) {
        return false;
    }

    const row = await R.getRow("SELECT until FROM monitor_snooze WHERE monitor_id = ?", [monitorID]);
    if (!row || !row.until) {
        return false;
    }

    return dayjs.utc(row.until).isAfter(dayjs.utc());
}

/**
 * Get snooze expiry for a monitor, or null if not snoozed.
 * @param {number} monitorID Monitor ID
 * @returns {Promise<?string>} UTC datetime string or null
 */
async function getSnoozeUntil(monitorID) {
    const row = await R.getRow("SELECT until FROM monitor_snooze WHERE monitor_id = ?", [monitorID]);
    if (!row || !row.until) {
        return null;
    }
    if (!dayjs.utc(row.until).isAfter(dayjs.utc())) {
        return null;
    }
    return row.until;
}

/**
 * Snooze all notifications for a monitor for the given duration.
 * @param {number} monitorID Monitor ID
 * @param {number} minutes Duration in minutes
 * @returns {Promise<string>} UTC expiry datetime
 */
async function setSnooze(monitorID, minutes) {
    const until = dayjs.utc().add(minutes, "minute").format(SQL_DATETIME_FORMAT);
    const existing = await R.getRow("SELECT monitor_id FROM monitor_snooze WHERE monitor_id = ?", [monitorID]);

    if (existing) {
        await R.exec("UPDATE monitor_snooze SET until = ? WHERE monitor_id = ?", [until, monitorID]);
    } else {
        await R.exec("INSERT INTO monitor_snooze (monitor_id, until) VALUES (?, ?)", [monitorID, until]);
    }

    log.info("telegram-snooze", `Monitor #${monitorID} snoozed until ${until} (${minutes}m)`);
    return until;
}

/**
 * Clear snooze for a monitor (e.g. when it recovers to UP).
 * @param {number} monitorID Monitor ID
 * @returns {Promise<void>}
 */
async function clearSnooze(monitorID) {
    if (!monitorID) {
        return;
    }
    await R.exec("DELETE FROM monitor_snooze WHERE monitor_id = ?", [monitorID]);
}

/**
 * Remove expired snooze rows.
 * @returns {Promise<void>}
 */
async function cleanupExpiredSnoozes() {
    const now = dayjs.utc().format(SQL_DATETIME_FORMAT);
    await R.exec("DELETE FROM monitor_snooze WHERE until <= ?", [now]);
}

module.exports = {
    isSnoozed,
    getSnoozeUntil,
    setSnooze,
    clearSnooze,
    cleanupExpiredSnoozes,
};
