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
const BmToken = require('./battlemetricsToken.js');
const Client = require('../../index.ts');
const Utils = require('./utils.js');

const CACHE_TTL_MS = 60_000;
const CACHE_FLOOR = 5;
const MAX_RESULTS = 25;
/* The resolver asks for a much bigger page than the dropdown does. filter[search]
   is a substring match, so a short query easily fills 25 rows with near misses
   and pushes a second, genuinely identical name onto page 2 — where the
   "exactly one exact match" ambiguity guard cannot see it, and the tracker gets
   linked to whichever of the two happened to land on page 1. */
const RESOLVE_PAGE_SIZE = 100;
/* Autocomplete writes one entry per keystroke prefix, per server. Without a cap
   the map is retained for the process lifetime and grows with everything anyone
   has ever typed. */
const CACHE_MAX = 500;

const _cache = new Map();
/* Server ids whose search is currently failing, keyed `serverId::reason`, so an
   ongoing outage is reported once instead of on every poll and every keystroke.
   Mirrors _warnedBadSteamIds / _warnedDuplicateLinks in battlemetricsHandler. */
const _warnedSearchFailures = new Set();

/* Both callers promise never to throw into the Discord autocomplete handler,
   and one of these sites sits outside its try block — so logging must not be
   able to break that promise. Client.client is undefined until index.ts reaches
   its last line, and this module is inside that require cycle. Same guard as
   activityDb._logDisabled. */
function _log(key, args) {
    try {
        Client.client.log(Client.client.intlGet(null, 'warningCap'),
            Client.client.intlGet(null, key, args));
    }
    catch (e) { /* nothing to log with */ }
}

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

/* Returns `success` alongside the results because the two zero-length outcomes
   have to be told apart: "this server has nobody by that name" is an answer the
   tracker resolver may act on (and back off from), "Battlemetrics was down" is
   not — burning a retry slot on an outage would push a perfectly resolvable
   player into a 24-hour backoff. */
async function _apiSearch(serverId, query, pageSize = MAX_RESULTS) {
    /* The page size is part of the key: the resolver's 100-row answer and the
       dropdown's 25-row answer are different pages of the same query, and
       serving one from the other would either re-introduce the page-1
       ambiguity blind spot or truncate the dropdown's own cache entry. */
    const key = `${serverId}::${pageSize}::${query.toLowerCase()}`;
    const cached = _cache.get(key);
    if (cached && (_now() - cached.at) < CACHE_TTL_MS) {
        return { results: cached.results, success: true, pageSize: pageSize };
    }
    if (cached) _cache.delete(key);

    const url = `https://api.battlemetrics.com/players?filter[search]=${encodeURIComponent(query)}` +
        `&filter[servers]=${encodeURIComponent(serverId)}&page[size]=${pageSize}`;
    let results = [];
    let success = false;
    let failReason = null;
    try {
        const response = await BmRateLimiter.scheduleGet(url, { timeout: 8000 });
        if (response && response.data && Array.isArray(response.data.data)) {
            results = response.data.data.map(p => ({
                id: String(p.id),
                name: p.attributes && p.attributes.name ? p.attributes.name : String(p.id),
                isOnline: false,
            }));
            success = true;
        }
    }
    catch (e) {
        /* On failure, fall back to whatever we had locally — never throw into
           the autocomplete handler. */
        results = [];
        failReason = e.response ? `HTTP ${e.response.status}` : (e.code || e.message);
    }

    /* Nothing else covers this path: the rate limiter rethrows without logging
       and Battlemetrics.#logRequestFailure is never on it. The resolver turns
       the failure into apiFailed, which deliberately does NOT count as an
       attempt — so the row skips its backoff and retries every 60 s forever,
       burning a lookup slot each cycle, and until now said nothing at all.

       Emitted outside the catch on purpose: a 200 with an unexpected body also
       leaves success false and reaches the same silent skip, so a catch-only
       version would miss half the cases. */
    if (!success) {
        if (failReason === null) failReason = 'malformed response';
        /* Keyed on server+reason and cleared on the next success, so this is a
           state-change edge: one line when an outage starts, silence while it
           lasts, re-armed once it recovers. It has to be — this runs from the
           60 s poll AND once per autocomplete keystroke. The query itself is
           never interpolated: it is arbitrary user input. */
        const warnKey = `${serverId}::${failReason}`;
        if (!_warnedSearchFailures.has(warnKey)) {
            _warnedSearchFailures.add(warnKey);
            _log('battlemetricsPlayerSearchFailed', { serverId: serverId, reason: failReason });
        }
    }
    else if (_warnedSearchFailures.size > 0) {
        for (const k of [..._warnedSearchFailures]) {
            if (k.startsWith(`${serverId}::`)) _warnedSearchFailures.delete(k);
        }
    }

    /* Only cache successful responses (including a genuine "no matches"). A
       transient API error must not be cached, or it would suppress retries for
       the whole TTL even after the API recovers. */
    if (success) {
        /* Map iterates in insertion order, so the first key is the oldest. */
        if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
        _cache.set(key, { at: _now(), results });
    }
    return { results, success, pageSize };
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
    const { results: apiResults } = await Promise.race([
        _apiSearch(serverId, trimmed),
        new Promise(resolve => setTimeout(() => resolve({ results: [], success: false }), 2200)),
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

    /* The TTL has to be honoured here too. Without it this scan could adopt a
       name that was cached weeks ago and has since changed — and it would keep
       walking entries that the keyed read in _apiSearch has long since
       written off. */
    const now = _now();
    for (const [key, entry] of _cache) {
        if ((now - entry.at) >= CACHE_TTL_MS) {
            _cache.delete(key);
            continue;
        }
        const hit = entry.results.find(r => r.id === playerId);
        if (hit && hit.name && hit.name !== playerId) return hit.name;
    }

    try {
        const url = `https://api.battlemetrics.com/players/${encodeURIComponent(playerId)}`;
        const response = await BmRateLimiter.scheduleGet(url, { timeout: 8000 });
        const name = response && response.data && response.data.data &&
            response.data.data.attributes && response.data.data.attributes.name;
        if (name) return String(name);
    }
    catch (e) {
        /* The caller falls back to the id either way, but "Battlemetrics has no
           name for this player" and "the deep-heal burst just got us rate
           limited" are not the same thing — and the caller then suppresses
           retries for DEEP_HEAL_MISS_TTL_MS, so a second UPDATE click also
           appears to do nothing. Nothing else logs this path.

           With no token configured scheduleGet throws immediately; that is a
           switched-off integration, not a failure worth reporting. */
        if (BmToken.isEnabled()) {
            _log('battlemetricsNameLookupFailed', {
                playerId: playerId,
                error: e.response ? `HTTP ${e.response.status}` : (e.code || e.message)
            });
        }
    }

    return null;
}

/**
 * Find the one roster entry whose name matches exactly. Exactly one match wins:
 * pointing a tracker at the wrong Battlemetrics profile is worse than leaving
 * the row unresolved, and the `.find()` this replaces silently took whichever
 * duplicate the roster happened to list first.
 *
 * Matching stays case-sensitive on purpose — a BM display name is a character-
 * exact copy of the Steam persona, so folding case only invites mislinking
 * `Bob` to `bob`.
 *
 * @param {object} bmInstance The Battlemetrics instance for the tracker's server, or null.
 * @param {string} name       The name to match.
 * @param {Map<string, Array<string>>} [index] A prebuilt index from
 *      buildRosterIndex. The resolver runs this match for every unresolved row
 *      on every poll, and a roster accumulates every player seen during the bot
 *      run — re-normalising all of them per row is the one place this gets
 *      expensive. Omit it and the roster is walked directly, which is what
 *      every one-off caller wants.
 * @returns {string|null} The BM player ID, or null when zero or several match.
 */
function matchRosterName(bmInstance, name, index = null) {
    const target = Utils.normalizePlayerName(name);
    if (!target) return null;

    if (index) {
        const hits = index.get(target);
        return hits && hits.length === 1 ? hits[0] : null;
    }

    if (!bmInstance || !bmInstance.players) return null;
    const hits = Object.keys(bmInstance.players)
        .filter(id => Utils.normalizePlayerName(bmInstance.players[id].name) === target);
    return hits.length === 1 ? hits[0] : null;
}

/**
 * Normalised roster name -> every player id carrying it. Duplicates are kept so
 * the caller can still refuse to guess between two identically named players.
 *
 * @param {object} bmInstance The Battlemetrics instance, or null.
 * @returns {Map<string, Array<string>>}
 */
function buildRosterIndex(bmInstance) {
    const index = new Map();
    if (!bmInstance || !bmInstance.players) return index;

    for (const [id, player] of Object.entries(bmInstance.players)) {
        const key = Utils.normalizePlayerName(player && player.name);
        if (!key) continue;
        const existing = index.get(key);
        if (existing) existing.push(id);
        else index.set(key, [id]);
    }
    return index;
}

/**
 * Turn a player name into a Battlemetrics player ID: the live roster first
 * (free), then the search API.
 *
 * Unlike `search()` this is not raced against a response budget — it runs from
 * the background poll, so waiting on the rate-limited queue is exactly right.
 *
 * @param {object} bmInstance  The Battlemetrics instance for the tracker's server, or null.
 * @param {string} bmServerId  The BM server ID (scopes the API search).
 * @param {string} name        The name to resolve.
 * @returns {Promise<{id: string|null, apiFailed: boolean}>}
 */
async function resolveIdByName(bmInstance, bmServerId, name) {
    const target = Utils.normalizePlayerName(name);
    if (!target) return { id: null, apiFailed: false };

    const local = matchRosterName(bmInstance, target);
    if (local) return { id: local, apiFailed: false };

    /* The live roster only holds players seen online during this bot run, so
       someone who has been offline the whole time can never match locally —
       filter[search] does find them. A single character is refused because that
       filter then returns an essentially arbitrary page of the server's
       population, which would mislink rather than fail. */
    if (!bmServerId || target.length < 2) return { id: null, apiFailed: false };

    const { results, success, pageSize } = await _apiSearch(bmServerId, target, RESOLVE_PAGE_SIZE);
    if (!success) return { id: null, apiFailed: true };

    const hits = results.filter(r => Utils.normalizePlayerName(r.name) === target);
    if (hits.length !== 1) return { id: null, apiFailed: false };

    /* A full page means there is a page 2 we did not look at, so "exactly one
       exact match" is only a claim about the rows we happened to receive. A
       second account with the identical name could be sitting just past the
       cut, and linking the tracker to the wrong human is worse than leaving
       the row unresolved — the roster path will link it correctly the moment
       they come online. */
    if (results.length >= pageSize) return { id: null, apiFailed: false };

    return { id: String(hits[0].id), apiFailed: false };
}

module.exports = { search, resolveNameById, resolveIdByName, matchRosterName, buildRosterIndex };
