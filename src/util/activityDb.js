/*
    Persistent per-player online-activity log used by the tracker UI to show
    typical play hours and to fire off-hours raid alarms.

    One row is inserted per tracked player per poll cycle. A periodic aggregator
    folds the last 30 days into a (player, day-of-week, hour) grid of online
    percentages. Day-of-week and hour are computed in the bot's local TZ so the
    "active hours" hint matches the user's perception.

    Data is keyed exclusively by BattleMetrics player_id, NOT tracker id. This
    means moving or splitting a player across trackers preserves their entire
    activity history automatically — the new tracker queries the same player_id
    and gets the same data. Nothing in this module (or anywhere else in the
    codebase) deletes activity rows when a player is removed from a tracker;
    rows only roll off after `purgeOld` (default 30 days).
*/

const Path = require('path');
const Fs = require('fs');

let Database = null;
let db = null;
let _initFailed = false;

const DB_FILE = Path.join(__dirname, '..', '..', 'instances', 'activity.sqlite');

function init() {
    if (db || _initFailed) return db;
    try {
        Database = require('better-sqlite3');
    }
    catch (e) {
        _initFailed = true;
        return null;
    }

    try {
        const dir = Path.dirname(DB_FILE);
        if (!Fs.existsSync(dir)) Fs.mkdirSync(dir, { recursive: true });
        db = new Database(DB_FILE);
        db.pragma('journal_mode = WAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS activity_log (
                player_id TEXT NOT NULL,
                is_online INTEGER NOT NULL,
                checked_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_activity_log_player_checked
                ON activity_log(player_id, checked_at);

            CREATE TABLE IF NOT EXISTS activity_patterns (
                player_id TEXT NOT NULL,
                dow INTEGER NOT NULL,
                hour INTEGER NOT NULL,
                online_pct REAL NOT NULL,
                sample_count INTEGER NOT NULL,
                PRIMARY KEY (player_id, dow, hour)
            );

            CREATE TABLE IF NOT EXISTS tracker_alerts (
                tracker_id TEXT PRIMARY KEY,
                last_fired_at INTEGER NOT NULL
            );
        `);
    }
    catch (e) {
        /* Permission error, corrupt file, locked volume — disable the
           feature rather than crash the whole bot. */
        _initFailed = true;
        db = null;
        return null;
    }
    return db;
}

function isAvailable() {
    init();
    return db !== null;
}

function logSnapshot(playerIds, onlineSet, checkedAtSeconds) {
    if (!isAvailable()) return;
    const insert = db.prepare('INSERT INTO activity_log (player_id, is_online, checked_at) VALUES (?, ?, ?)');
    const txn = db.transaction((ids) => {
        for (const id of ids) {
            if (!id) continue;
            insert.run(String(id), onlineSet.has(String(id)) ? 1 : 0, checkedAtSeconds);
        }
    });
    txn(playerIds);
}

function purgeOld(daysToKeep = 30) {
    if (!isAvailable()) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
    const res = db.prepare('DELETE FROM activity_log WHERE checked_at < ?').run(cutoff);
    return res.changes;
}

/* Aggregate the last `days` of activity_log into activity_patterns. Bucketing
   is done in JS using local time so day-of-week/hour match the user's TZ. */
function recomputePatterns(days = 30) {
    if (!isAvailable()) return;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = db.prepare(
        'SELECT player_id, is_online, checked_at FROM activity_log WHERE checked_at >= ?'
    ).all(cutoff);

    /* grid[playerId][dow][hour] = { online, total } */
    const grid = new Map();
    for (const row of rows) {
        const date = new Date(row.checked_at * 1000);
        const dow = date.getDay();
        const hour = date.getHours();
        let perPlayer = grid.get(row.player_id);
        if (!perPlayer) {
            perPlayer = new Array(7);
            for (let d = 0; d < 7; d++) perPlayer[d] = new Array(24).fill(null);
            grid.set(row.player_id, perPlayer);
        }
        let cell = perPlayer[dow][hour];
        if (!cell) {
            cell = { online: 0, total: 0 };
            perPlayer[dow][hour] = cell;
        }
        cell.total += 1;
        if (row.is_online) cell.online += 1;
    }

    const upsert = db.prepare(
        'INSERT OR REPLACE INTO activity_patterns (player_id, dow, hour, online_pct, sample_count) VALUES (?, ?, ?, ?, ?)'
    );
    const clearOld = db.prepare('DELETE FROM activity_patterns WHERE player_id = ?');
    const apply = db.transaction(() => {
        for (const [playerId, weekGrid] of grid.entries()) {
            clearOld.run(playerId);
            for (let dow = 0; dow < 7; dow++) {
                for (let hour = 0; hour < 24; hour++) {
                    const cell = weekGrid[dow][hour];
                    if (!cell) continue;
                    const pct = (cell.online / cell.total) * 100;
                    upsert.run(playerId, dow, hour, pct, cell.total);
                }
            }
        }
    });
    apply();
}

function getPlayerPattern(playerId) {
    if (!isAvailable()) return [];
    return db.prepare(
        'SELECT dow, hour, online_pct, sample_count FROM activity_patterns WHERE player_id = ?'
    ).all(String(playerId));
}

/* Total samples logged for a player; used to gate the active-hours hint until
   there's enough data to be meaningful. */
function getSampleCount(playerId) {
    if (!isAvailable()) return 0;
    const row = db.prepare(
        'SELECT COUNT(*) AS c FROM activity_log WHERE player_id = ?'
    ).get(String(playerId));
    return row ? row.c : 0;
}

/* Convert hour-of-week grid into a compact "Mon-Fri 18:00-23:00" style hint.
   Returns null when data is too sparse. */
function summarizeWindowsWeekly(grid, threshold) {
    /* grid is a 7x24 array of pct or null */
    const active = new Array(7);
    for (let d = 0; d < 7; d++) {
        active[d] = new Array(24).fill(false);
        for (let h = 0; h < 24; h++) {
            const v = grid[d][h];
            if (v !== null && v !== undefined && v >= threshold) active[d][h] = true;
        }
    }

    /* For each day, find contiguous runs of active hours. Wrap-around across
       midnight is intentionally NOT merged — readers expect day-bounded ranges. */
    const perDay = [];
    for (let d = 0; d < 7; d++) {
        const ranges = [];
        let start = null;
        for (let h = 0; h < 24; h++) {
            if (active[d][h] && start === null) start = h;
            else if (!active[d][h] && start !== null) {
                ranges.push([start, h - 1]);
                start = null;
            }
        }
        if (start !== null) ranges.push([start, 23]);
        perDay.push(ranges);
    }
    return perDay;
}

function formatRanges(ranges) {
    return ranges.map(([s, e]) => `${String(s).padStart(2, '0')}–${String(e + 1).padStart(2, '0')}`).join(', ');
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* Build a short per-player active-hours hint. Returns '' if insufficient data
   or no hours cross the threshold. */
function getPlayerActiveHint(playerId, options = {}) {
    const threshold = options.threshold ?? 15;
    const minSamples = options.minSamples ?? 200;
    if (getSampleCount(playerId) < minSamples) return '';

    const rows = getPlayerPattern(playerId);
    if (rows.length === 0) return '';

    const grid = new Array(7);
    for (let d = 0; d < 7; d++) grid[d] = new Array(24).fill(null);
    for (const r of rows) grid[r.dow][r.hour] = r.online_pct;

    const perDay = summarizeWindowsWeekly(grid, threshold);
    /* Collapse: if every day has the same set of ranges, show once. */
    const signatures = perDay.map(r => JSON.stringify(r));
    const allSame = signatures.every(s => s === signatures[0]);
    if (allSame) {
        if (perDay[0].length === 0) return '';
        return `~${formatRanges(perDay[0])} daily`;
    }

    /* Group consecutive days with the same signature. */
    const groups = [];
    let groupStart = 0;
    for (let d = 1; d <= 7; d++) {
        if (d === 7 || signatures[d] !== signatures[groupStart]) {
            if (perDay[groupStart].length > 0) {
                const label = groupStart === d - 1
                    ? DAY_NAMES[groupStart]
                    : `${DAY_NAMES[groupStart]}–${DAY_NAMES[d - 1]}`;
                groups.push(`${label} ${formatRanges(perDay[groupStart])}`);
            }
            groupStart = d;
        }
    }
    if (groups.length === 0) return '';
    return `~${groups.join(' · ')}`;
}

/* Group aggregate: for each (dow,hour), average online_pct across players. */
function getGroupGrid(playerIds) {
    const grid = new Array(7);
    for (let d = 0; d < 7; d++) grid[d] = new Array(24).fill(null);
    if (playerIds.length === 0) return grid;

    const sums = new Array(7);
    const counts = new Array(7);
    for (let d = 0; d < 7; d++) {
        sums[d] = new Array(24).fill(0);
        counts[d] = new Array(24).fill(0);
    }

    for (const pid of playerIds) {
        const rows = getPlayerPattern(pid);
        for (const r of rows) {
            sums[r.dow][r.hour] += r.online_pct;
            counts[r.dow][r.hour] += 1;
        }
    }
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            if (counts[d][h] > 0) grid[d][h] = sums[d][h] / counts[d][h];
        }
    }
    return grid;
}

function getGroupActiveHint(playerIds, options = {}) {
    const threshold = options.threshold ?? 15;
    if (playerIds.length === 0) return '';
    /* Require at least one player with enough samples. */
    const minSamples = options.minSamples ?? 200;
    const eligible = playerIds.filter(p => getSampleCount(p) >= minSamples);
    if (eligible.length === 0) return '';

    const grid = getGroupGrid(eligible);
    const perDay = summarizeWindowsWeekly(grid, threshold);

    const signatures = perDay.map(r => JSON.stringify(r));
    const allSame = signatures.every(s => s === signatures[0]);
    if (allSame) {
        if (perDay[0].length === 0) return '';
        return `~${formatRanges(perDay[0])} daily`;
    }
    const groups = [];
    let groupStart = 0;
    for (let d = 1; d <= 7; d++) {
        if (d === 7 || signatures[d] !== signatures[groupStart]) {
            if (perDay[groupStart].length > 0) {
                const label = groupStart === d - 1
                    ? DAY_NAMES[groupStart]
                    : `${DAY_NAMES[groupStart]}–${DAY_NAMES[d - 1]}`;
                groups.push(`${label} ${formatRanges(perDay[groupStart])}`);
            }
            groupStart = d;
        }
    }
    if (groups.length === 0) return '';
    return `~${groups.join(' · ')}`;
}

/* True when the group's typical online rate at (dow, hour) is below the
   off-hours threshold (i.e., this is a quiet time). Returns false when there's
   no data OR when sampling is too sparse to trust the verdict — both prevent
   a freshly-started bot from firing the raid alarm before it has any history. */
function isOffHourForGroup(playerIds, dow, hour, offThreshold = 20, minSamplesPerPlayer = 500) {
    if (playerIds.length === 0) return false;
    const eligible = playerIds.filter(p => getSampleCount(p) >= minSamplesPerPlayer);
    if (eligible.length === 0) return false;
    const grid = getGroupGrid(eligible);
    const v = grid[dow][hour];
    if (v === null || v === undefined) return false;
    return v < offThreshold;
}

function getLastAlertAt(trackerId) {
    if (!isAvailable()) return 0;
    const row = db.prepare(
        'SELECT last_fired_at FROM tracker_alerts WHERE tracker_id = ?'
    ).get(String(trackerId));
    return row ? row.last_fired_at : 0;
}

function setLastAlertAt(trackerId, ts) {
    if (!isAvailable()) return;
    db.prepare(
        'INSERT OR REPLACE INTO tracker_alerts (tracker_id, last_fired_at) VALUES (?, ?)'
    ).run(String(trackerId), ts);
}

/* Report builders.

   Our schema is per-poll snapshots (activity_log rows are "is the player
   online right now?" sampled every BM_POLL_SECONDS). All the report metrics
   are derived from that: count the online rows × poll interval for time,
   count 0→1 transitions for sessions, bucket by local hour-of-day for the
   activity chart. We keep activity in SQLite — the tracker player object
   stores no per-player log. */
const BM_POLL_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * 60;

function _windowStartSec(windowSec) {
    return Math.floor(Date.now() / 1000) - windowSec;
}

/* Total online / total sample seconds within a rolling window, plus the
   number of distinct sessions (0→1 transitions). Sessions counts the first
   sample too if it's already online, so a player who never logged off in
   the window still reads as 1 session. */
function getReportStats(playerId, windowSec) {
    if (!isAvailable()) return { onlineSec: 0, totalSec: 0, sessions: 0 };
    const cutoff = _windowStartSec(windowSec);
    const rows = db.prepare(
        'SELECT is_online FROM activity_log WHERE player_id = ? AND checked_at >= ? ORDER BY checked_at ASC'
    ).all(String(playerId), cutoff);
    if (rows.length === 0) return { onlineSec: 0, totalSec: 0, sessions: 0 };

    let onlineCount = 0;
    let sessions = 0;
    let prev = 0;
    for (let i = 0; i < rows.length; i++) {
        const cur = rows[i].is_online ? 1 : 0;
        if (cur === 1) onlineCount += 1;
        if (i === 0 ? cur === 1 : (prev === 0 && cur === 1)) sessions += 1;
        prev = cur;
    }
    return {
        onlineSec: onlineCount * BM_POLL_SECONDS,
        totalSec: rows.length * BM_POLL_SECONDS,
        sessions,
    };
}

/* Minutes online per local hour-of-day across the window. Each `is_online=1`
   sample contributes BM_POLL_SECONDS/60 minutes to the hour bucket of its
   timestamp's local hour. Returns Array(24). */
function getHourlyMinutes(playerId, windowSec) {
    const hours = new Array(24).fill(0);
    if (!isAvailable()) return hours;
    const cutoff = _windowStartSec(windowSec);
    const rows = db.prepare(
        'SELECT is_online, checked_at FROM activity_log WHERE player_id = ? AND checked_at >= ? AND is_online = 1'
    ).all(String(playerId), cutoff);
    const minutesPerSample = BM_POLL_SECONDS / 60;
    for (const r of rows) {
        const h = new Date(r.checked_at * 1000).getHours();
        hours[h] += minutesPerSample;
    }
    return hours;
}

/* Most recent online→offline and offline→online transitions, returned as
   unix seconds (or null if never seen). Scans newest-first so a player with
   thousands of rows costs O(transition-depth) in practice. */
function getLastTransitions(playerId) {
    if (!isAvailable()) return { lastConnectedAt: null, lastDisconnectedAt: null };
    const rows = db.prepare(
        'SELECT is_online, checked_at FROM activity_log WHERE player_id = ? ORDER BY checked_at DESC LIMIT 5000'
    ).all(String(playerId));
    if (rows.length === 0) return { lastConnectedAt: null, lastDisconnectedAt: null };

    let lastConnectedAt = null;
    let lastDisconnectedAt = null;
    /* Walk newest→oldest; the most recent 1 preceded by a 0 is the last
       connect; the most recent 0 preceded by a 1 is the last disconnect. */
    for (let i = 0; i < rows.length - 1; i++) {
        const cur = rows[i].is_online ? 1 : 0;
        const older = rows[i + 1].is_online ? 1 : 0;
        if (lastConnectedAt === null && cur === 1 && older === 0) {
            lastConnectedAt = rows[i].checked_at;
        }
        if (lastDisconnectedAt === null && cur === 0 && older === 1) {
            lastDisconnectedAt = rows[i].checked_at;
        }
        if (lastConnectedAt !== null && lastDisconnectedAt !== null) break;
    }
    /* Edge case: rows only contain a single steady state. Treat the oldest
       row as the implicit transition into that state so the report at least
       has something meaningful to show. */
    const oldest = rows[rows.length - 1];
    if (lastConnectedAt === null && oldest.is_online) lastConnectedAt = oldest.checked_at;
    if (lastDisconnectedAt === null && !oldest.is_online) lastDisconnectedAt = oldest.checked_at;
    return { lastConnectedAt, lastDisconnectedAt };
}

/* Convert the per-player (dow, hour) pattern grid into "likely sleep" and
   "likely play" windows by averaging across days-of-week, then finding the
   longest contiguous block above/below the activity threshold, with
   midnight wrap-around handled by doubling the array. Same shape as the
   upstream "ActivityTracker.generateReport" so the embed code reads
   cleanly, just driven by our aggregated patterns instead of raw events. */
function _summariseDailyWindows(playerId, options = {}) {
    const threshold = options.threshold ?? 15; /* online_pct */
    const minBlock = options.minBlock ?? 2;
    const maxBlock = options.maxBlock ?? 23;
    const rows = getPlayerPattern(playerId);
    if (rows.length === 0) return { sleepWindow: 'Unknown', playWindow: 'Unknown' };

    /* Average online_pct across days of the week for each hour. */
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const r of rows) {
        sums[r.hour] += r.online_pct;
        counts[r.hour] += 1;
    }
    const hourly = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) hourly[h] = counts[h] > 0 ? sums[h] / counts[h] : 0;

    const doubled = [...hourly, ...hourly];
    let bestSleepStart = 0, bestSleepLen = 0;
    let bestPlayStart = 0, bestPlayLen = 0;
    let inactiveStart = -1, inactiveLen = 0;
    let activeStart = -1, activeLen = 0;
    for (let i = 0; i < doubled.length; i++) {
        if (doubled[i] < threshold) {
            if (inactiveStart === -1) inactiveStart = i % 24;
            inactiveLen += 1;
        }
        else {
            if (inactiveLen > bestSleepLen) { bestSleepLen = inactiveLen; bestSleepStart = inactiveStart; }
            inactiveStart = -1; inactiveLen = 0;
        }
        if (doubled[i] >= threshold) {
            if (activeStart === -1) activeStart = i % 24;
            activeLen += 1;
        }
        else {
            if (activeLen > bestPlayLen) { bestPlayLen = activeLen; bestPlayStart = activeStart; }
            activeStart = -1; activeLen = 0;
        }
    }
    if (inactiveLen > bestSleepLen) { bestSleepLen = inactiveLen; bestSleepStart = inactiveStart; }
    if (activeLen > bestPlayLen) { bestPlayLen = activeLen; bestPlayStart = activeStart; }

    const fmt = (start, len) => {
        const end = (start + len) % 24;
        return `${String(start).padStart(2, '0')}:00 - ${String(end).padStart(2, '0')}:00`;
    };

    let sleepWindow = 'Unknown';
    if (bestSleepLen >= 4 && bestSleepLen <= maxBlock) sleepWindow = fmt(bestSleepStart, bestSleepLen);
    else if (bestSleepLen > maxBlock) sleepWindow = 'Inactive (No data)';

    let playWindow = 'Unknown';
    if (bestPlayLen >= minBlock && bestPlayLen <= maxBlock) playWindow = fmt(bestPlayStart, bestPlayLen);
    else if (bestPlayLen > maxBlock) playWindow = '24/7 (Always ON)';

    return { sleepWindow, playWindow };
}

/* Top-N hours (0-23) by averaged online percentage. */
function getPeakHours(playerId, topN = 3) {
    const rows = getPlayerPattern(playerId);
    if (rows.length === 0) return [];
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const r of rows) {
        sums[r.hour] += r.online_pct;
        counts[r.hour] += 1;
    }
    const ranked = [];
    for (let h = 0; h < 24; h++) {
        if (counts[h] > 0) ranked.push({ hour: h, pct: sums[h] / counts[h] });
    }
    ranked.sort((a, b) => b.pct - a.pct);
    return ranked.filter(e => e.pct > 0).slice(0, topN);
}

/* Render the 24-bar hourly chart used in the report embed. Mirrors the
   upstream char ramp so the report looks consistent for users who've
   seen this feature before. Returns a multi-line string. */
function formatHourlyChart(hours) {
    const maxMinutes = Math.max(...hours, 1);
    const ramp = ['░', '▒', '▓', '█'];
    let out = '';
    for (let h = 0; h < 24; h++) {
        const ratio = hours[h] / maxMinutes;
        const filled = Math.round(ratio * 8);
        let bar = '';
        for (let b = 0; b < 8; b++) {
            if (b < filled) {
                if (ratio > 0.75) bar += ramp[3];
                else if (ratio > 0.50) bar += ramp[2];
                else if (ratio > 0.25) bar += ramp[1];
                else bar += ramp[0];
            }
            else bar += '░';
        }
        const mins = Math.round(hours[h]);
        out += `\`${String(h).padStart(2, '0')}:00\` ${bar}${mins > 0 ? ` ${mins}m` : ''}\n`;
    }
    return out;
}

/* Compose everything into a single per-player report object. `live` is
   optional: if a BattleMetrics instance entry for this player is passed in,
   we trust its `status`/`updatedAt`/`logoutDate` for the live verdict
   instead of the (slower, polled) SQL state. */
function generatePlayerReport(playerId, displayName, live = null) {
    const stats24h = getReportStats(playerId, DAY_SECONDS);
    const stats7d = getReportStats(playerId, 7 * DAY_SECONDS);
    const stats30d = getReportStats(playerId, 30 * DAY_SECONDS);
    const hourly7d = getHourlyMinutes(playerId, 7 * DAY_SECONDS);
    const hourlyToday = getHourlyMinutes(playerId, DAY_SECONDS);
    const { sleepWindow, playWindow } = _summariseDailyWindows(playerId);
    const peakHours = getPeakHours(playerId, 3);
    const transitions = getLastTransitions(playerId);
    const sampleCount = getSampleCount(playerId);

    let isOnline = false;
    let lastConnectedSec = transitions.lastConnectedAt;
    let lastDisconnectedSec = transitions.lastDisconnectedAt;
    let lastSeenSec = lastConnectedSec || lastDisconnectedSec;
    if (live) {
        isOnline = !!live.status;
        if (live.updatedAt) {
            const t = Math.floor(new Date(live.updatedAt).getTime() / 1000);
            if (isOnline) lastSeenSec = t;
        }
        if (live.logoutDate && !isOnline) {
            const t = Math.floor(new Date(live.logoutDate).getTime() / 1000);
            lastDisconnectedSec = lastDisconnectedSec || t;
            lastSeenSec = t;
        }
        if (isOnline) lastSeenSec = Math.floor(Date.now() / 1000);
    }

    return {
        playerName: displayName,
        isOnline,
        lastSeenSec,
        lastConnectedSec,
        lastDisconnectedSec,
        sleepWindow,
        playWindow,
        stats24h,
        stats7d,
        stats30d,
        hourly7d,
        hourlyToday,
        peakHours,
        sampleCount,
    };
}

function formatPercentage(onlineSec, totalSec) {
    if (totalSec === 0) return '0%';
    return `${Math.round((onlineSec / totalSec) * 100)}%`;
}

/* Compact "1d 5h 23m" / "47m" / "12s" rendering for a duration in seconds.
   Drops trailing zero units so the output stays readable in narrow embed
   fields. */
function formatDurationSec(sec) {
    if (sec <= 0) return '0m';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || parts.length === 0) parts.push(`${m}m`);
    return parts.join(' ');
}

module.exports = {
    init,
    isAvailable,
    logSnapshot,
    purgeOld,
    recomputePatterns,
    getSampleCount,
    getPlayerActiveHint,
    getGroupActiveHint,
    isOffHourForGroup,
    getLastAlertAt,
    setLastAlertAt,
    /* Report builders */
    getReportStats,
    getHourlyMinutes,
    getLastTransitions,
    getPeakHours,
    formatHourlyChart,
    generatePlayerReport,
    formatPercentage,
    formatDurationSec,
    BM_POLL_SECONDS,
    DAY_NAMES,
};
