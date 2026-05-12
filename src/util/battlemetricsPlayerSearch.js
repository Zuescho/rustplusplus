/*
    Player search for the /tracker slash command autocomplete.

    Discord autocomplete must respond within 3 seconds and is invoked on every
    keystroke. To stay under that budget without thrashing the BM API:
      1. The in-memory bmInstance.players map already holds everyone seen during
         this bot run — matches return instantly without any HTTP call.
      2. BM API is only queried when the local cache produces fewer than CACHE_FLOOR
         results AND the query is at least 2 chars.
      3. API results are cached for CACHE_TTL_MS keyed by (serverId, lowercased query)
         so retyping the same name doesn't refetch.

    Outgoing requests share the same rate-limited queue as the rest of the bot,
    so a typing user can't flood BM's API.
*/

const BmRateLimiter = require('./battlemetricsRateLimiter.js');

const CACHE_TTL_MS = 60_000;
const CACHE_FLOOR = 5;
const MAX_RESULTS = 25;

const _cache = new Map();

function _now() { return Date.now(); }

function _localMatches(bmInstance, query) {
    if (!bmInstance) return [];
    const q = query.toLowerCase();
    const matches = [];
    for (const [id, p] of Object.entries(bmInstance.players)) {
        const name = p.name || '';
        if (name.toLowerCase().includes(q)) {
            matches.push({ id, name, isOnline: !!p.status });
        }
    }
    /* Online first, then alphabetical. */
    matches.sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return matches.slice(0, MAX_RESULTS);
}

async function _apiSearch(serverId, query) {
    const key = `${serverId}::${query.toLowerCase()}`;
    const cached = _cache.get(key);
    if (cached && (_now() - cached.at) < CACHE_TTL_MS) return cached.results;

    const url = `https://api.battlemetrics.com/players?filter[search]=${encodeURIComponent(query)}` +
        `&filter[servers]=${encodeURIComponent(serverId)}&page[size]=${MAX_RESULTS}`;
    let results = [];
    try {
        const response = await BmRateLimiter.scheduleGet(url, { timeout: 8000 });
        if (response && response.data && Array.isArray(response.data.data)) {
            results = response.data.data.map(p => ({
                id: String(p.id),
                name: p.attributes && p.attributes.name ? p.attributes.name : String(p.id),
                isOnline: false,
            }));
        }
    }
    catch (e) {
        /* On failure, fall back to whatever we had locally — never throw into
           the autocomplete handler. */
        results = [];
    }
    _cache.set(key, { at: _now(), results });
    return results;
}

/**
 * @param {object} bmInstance The Battlemetrics instance for the tracker's server.
 * @param {string} serverId   The BM server ID (used to scope the API search).
 * @param {string} query      The user's typed input.
 * @returns {Promise<Array<{id:string, name:string, isOnline:boolean}>>}
 */
async function search(bmInstance, serverId, query) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
        /* Empty query: just surface a few online players so the dropdown isn't blank. */
        if (!bmInstance) return [];
        return Object.entries(bmInstance.players)
            .filter(([, p]) => p.status)
            .map(([id, p]) => ({ id, name: p.name || id, isOnline: true }))
            .slice(0, MAX_RESULTS);
    }

    const local = _localMatches(bmInstance, trimmed);
    if (local.length >= CACHE_FLOOR || trimmed.length < 2 || !serverId) {
        return local;
    }

    /* Discord autocomplete has a 3-second response budget. The BM rate limiter
       can hold a request for >1.5s and the HTTP call itself takes time, so we
       race the API lookup against a hard budget and fall back to local-only
       results if it takes too long. */
    const apiResults = await Promise.race([
        _apiSearch(serverId, trimmed),
        new Promise(resolve => setTimeout(() => resolve([]), 2200)),
    ]);
    const seen = new Set(local.map(p => p.id));
    const merged = [...local];
    for (const r of apiResults) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            /* Mark online if the in-memory map has them as online right now. */
            const liveStatus = bmInstance && bmInstance.players[r.id]
                ? !!bmInstance.players[r.id].status : false;
            merged.push({ ...r, isOnline: liveStatus });
            if (merged.length >= MAX_RESULTS) break;
        }
    }
    return merged;
}

/**
 * Resolve a player's display name from their BM player ID.
 * Tries (in order): the live bmInstance.players cache, the autocomplete
 * search cache, and finally a direct GET /players/{id} via the rate-limited
 * queue. Returns null when nothing can be found.
 *
 * @param {object} bmInstance The Battlemetrics instance for the tracker's server, or null.
 * @param {string} playerId   The BM player ID to resolve.
 * @returns {Promise<string|null>}
 */
async function resolveNameById(bmInstance, playerId) {
    if (!playerId) return null;

    if (bmInstance && bmInstance.players && bmInstance.players[playerId]
        && bmInstance.players[playerId].name) {
        return bmInstance.players[playerId].name;
    }

    for (const { results } of _cache.values()) {
        const hit = results.find(r => r.id === playerId);
        if (hit && hit.name && hit.name !== playerId) return hit.name;
    }

    try {
        const url = `https://api.battlemetrics.com/players/${encodeURIComponent(playerId)}`;
        const response = await BmRateLimiter.scheduleGet(url, { timeout: 8000 });
        const name = response && response.data && response.data.data &&
            response.data.data.attributes && response.data.data.attributes.name;
        if (name) return String(name);
    }
    catch { /* swallow — caller will fall back to the ID */ }

    return null;
}

module.exports = { search, resolveNameById };
