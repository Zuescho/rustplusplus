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
    const clearAll = db.prepare('DELETE FROM activity_patterns');
    const apply = db.transaction(() => {
        /* Rebuild the whole table so players that aged out of the window
           don't keep stale pattern rows forever. */
        clearAll.run();
        for (const [playerId, weekGrid] of grid.entries()) {
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

/* Compact one-line "when is this group online" hint shown inline on the
   tracker embed. Averages the group's (dow, hour) grid across all seven
   days into a single 24-hour profile, then emits contiguous active hour
   ranges as "~HH–HH daily". The per-weekday breakdown lives on the
   Report embed via formatGroupWeeklySchedule — this stays one line. */
function getGroupActiveHint(playerIds, options = {}) {
    const threshold = options.threshold ?? 15;
    if (playerIds.length === 0) return '';
    const minSamples = options.minSamples ?? 200;
    const eligible = playerIds.filter(p => getSampleCount(p) >= minSamples);
    if (eligible.length === 0) return '';

    const grid = getGroupGrid(eligible);

    const hourly = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const v = grid[d][h];
            if (v !== null && v !== undefined) {
                hourly[h] += v;
                counts[h] += 1;
            }
        }
    }
    for (let h = 0; h < 24; h++) hourly[h] = counts[h] > 0 ? hourly[h] / counts[h] : 0;

    const ranges = [];
    let start = null;
    for (let h = 0; h < 24; h++) {
        if (hourly[h] >= threshold && start === null) start = h;
        else if (hourly[h] < threshold && start !== null) {
            ranges.push([start, h - 1]);
            start = null;
        }
    }
    if (start !== null) ranges.push([start, 23]);

    if (ranges.length === 0) return '';
    return `~${formatRanges(ranges)} daily`;
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

   Driven entirely off the aggregated (player, dow, hour) pattern grid plus
   the activity_log transitions — no per-window rollups, no hourly chart. */

/* Most recent online→offline and offline→online transitions, returned as
   unix seconds (or null if never observed in our retained history). Scans
   newest-first so a player with thousands of rows costs O(transition-depth)
   in practice — both values are usually populated within the first handful
   of rows.

   No artificial row limit: with 30-day retention and 60s polls we have at
   most ~43k rows per player, which SQLite scans on the existing index
   without breaking a sweat. Returning null for "never observed a
   transition" is correct — the embed renders that as "Never", which is
   honest about what we know. A fabricated-from-oldest-row timestamp would
   be misleading for a player who's been steadily online since before our
   retention window began. */
function getLastTransitions(playerId) {
    if (!isAvailable()) return { lastConnectedAt: null, lastDisconnectedAt: null };
    const rows = db.prepare(
        'SELECT is_online, checked_at FROM activity_log WHERE player_id = ? ORDER BY checked_at DESC'
    ).all(String(playerId));
    if (rows.length === 0) return { lastConnectedAt: null, lastDisconnectedAt: null };

    let lastConnectedAt = null;
    let lastDisconnectedAt = null;
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

/* Compose everything into a single per-player report object. `live` is
   optional: if a BattleMetrics instance entry for this player is passed in,
   we trust its `status`/`updatedAt`/`logoutDate` for the live verdict
   instead of the (slower, polled) SQL state. */
function generatePlayerReport(playerId, displayName, live = null) {
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
        peakHours,
        sampleCount,
    };
}

/* Per-weekday active windows for the whole tracker group. Same threshold and
   sample-eligibility rules as getGroupActiveHint, but returns all seven days
   in Mon→Sun order so the embed can show explicit per-day rows without the
   "collapse identical days" behavior the hint uses. Days with no qualifying
   range get an empty `ranges` array. */
function getGroupWeeklySchedule(playerIds, options = {}) {
    const threshold = options.threshold ?? 15;
    const minSamples = options.minSamples ?? 200;
    if (playerIds.length === 0) return [];
    const eligible = playerIds.filter(p => getSampleCount(p) >= minSamples);
    if (eligible.length === 0) return [];

    const grid = getGroupGrid(eligible);
    const perDay = summarizeWindowsWeekly(grid, threshold);

    const order = [1, 2, 3, 4, 5, 6, 0];
    return order.map(dow => ({ day: DAY_NAMES[dow], ranges: perDay[dow] }));
}

/* Render the schedule as a multi-line string suitable for an embed field.
   Returns '' when no day in the week meets the activity threshold. */
function formatGroupWeeklySchedule(playerIds, options = {}) {
    const schedule = getGroupWeeklySchedule(playerIds, options);
    if (schedule.length === 0) return '';
    const active = schedule.filter(d => d.ranges.length > 0);
    if (active.length === 0) return '';
    return active.map(d => `\`${d.day}\` ~${formatRanges(d.ranges)}`).join('\n');
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
    getLastTransitions,
    getPeakHours,
    generatePlayerReport,
    getGroupWeeklySchedule,
    formatGroupWeeklySchedule,
    DAY_NAMES,
};
