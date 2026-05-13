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
        for (const [playerId, days] of grid.entries()) {
            clearOld.run(playerId);
            for (let dow = 0; dow < 7; dow++) {
                for (let hour = 0; hour < 24; hour++) {
                    const cell = days[dow][hour];
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
    DAY_NAMES,
};
