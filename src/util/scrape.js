/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

const Axios = require('axios');

const Config = require('../../config');
const Constants = require('../util/constants.js');
const Utils = require('../util/utils.js');

/* An unbounded request can wedge a caller indefinitely — the Battlemetrics
   poll reaches in here once per tracked player, so one hung socket stalls the
   whole cycle. Steam also hands the default axios user-agent a 403 often
   enough to be worth identifying ourselves. Redirects must stay enabled:
   /profiles/<id> 302s to /id/<vanity> for anyone with a custom URL, which is
   a large share of real accounts. */
const REQUEST_OPTIONS = {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
        'User-Agent': 'rustplusplus (+https://github.com/alexemanuelol/rustplusplus)',
        'Accept-Language': 'en'
    }
};

const STEAMID64_REGEX = new RegExp(`^\\d{${Constants.STEAMID64_LENGTH}}$`);

/* Kept without the /g/ flag and at module scope on purpose: a global regex
   carries lastIndex between exec() calls, which would make every other lookup
   miss. */
const PERSONA_NAME_REGEX = /class="actual_persona_name">(.+?)<\/span>/m;

/* Non-greedy so we stop at the first `_full.jpg` (the avatar, which Steam
   also emits early in og:image) instead of letting `.*` run to the last one on
   the page and capture a corrupted span. */
const AVATAR_REGEX = /<img src="(.*?_full.jpg)(.*?(?="))/;

/**
 *  Turn a failed scrape into a reason a human can act on. The distinction
 *  matters: a 429 means back off, a 403 means the host IP is refused and no
 *  amount of pacing will help, and a timeout means neither.
 *  @param {object} response The response (or failure marker) from scrape().
 *  @return {string} A short, loggable reason.
 */
function describeFailure(response) {
    const status = response ? response.status : undefined;

    if (status === 429) {
        /* Steam only sends Retry-After once it is actually throttling, so when
           it is present it is the single most useful number in the log. */
        const retryAfter = response.headers ? response.headers['retry-after'] : undefined;
        return retryAfter ?
            `HTTP 429, rate limited by Steam, retry-after ${retryAfter}s` :
            'HTTP 429, rate limited by Steam';
    }
    if (status === 403) return 'HTTP 403, Steam refused the request (the host IP may be blocked)';
    if (status === 404) return 'HTTP 404, no such profile';
    if (typeof status === 'number') return `HTTP ${status}`;

    if (response && response.scrapeErrorCode) return `${response.scrapeErrorCode}, no HTTP response`;
    if (response && response.scrapeErrorMessage) return `${response.scrapeErrorMessage}, no HTTP response`;

    return 'no HTTP response';
}

/* Scrape caches. The death and login handlers scrape one avatar per event, so a
   busy team re-asks Steam for the same faces all wipe long and eventually gets
   throttled — the errors then look like a broken scraper rather than self-
   inflicted traffic. Failures are cached too, briefly: once Steam is refusing
   us, retrying on every death only digs deeper. */
const CACHE_MAX = 500;
const CACHE_FAILURE_TTL_MS = 5 * 60 * 1000;

/* The success TTL is read through a function rather than captured, so a test
   (or a future runtime toggle) can change the Config value after module load. */
function createTtlCache(successTtlFn) {
    const map = new Map(); /* key -> { at, ttl, value } */
    return {
        /* undefined = nothing live cached, null = a cached failure. */
        get(key) {
            const entry = map.get(key);
            if (!entry) return undefined;
            if (Date.now() - entry.at > entry.ttl) {
                map.delete(key);
                return undefined;
            }
            return entry.value;
        },
        set(key, value) {
            /* A configured TTL of 0 means the cache is off, and that has to
               include failures. Caching those anyway left "disabled" still
               short-circuiting five minutes of lookups after one transient
               error — not the per-event scraping the setting promises. */
            const successTtl = successTtlFn();
            if (successTtl === 0) return;

            const ttl = value === null ? CACHE_FAILURE_TTL_MS : successTtl;

            /* Map iterates in insertion order, so the first key is the oldest. */
            if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
            map.set(key, { at: Date.now(), ttl: ttl, value: value });
        },
        clear() {
            map.clear();
        }
    };
}

const _avatarCache = createTtlCache(() => Config.battlemetrics.steamAvatarCacheMs);
const _nameCache = createTtlCache(() => Config.battlemetrics.steamNameCacheMs);

/**
 *  Whether a value is a usable SteamID64. Guards against a malformed id
 *  producing a request for a bare profile URL, which fails in a way that
 *  looks identical to Steam being down.
 *  @param {*} steamId The candidate id.
 *  @return {boolean}
 */
function isValidSteamId(steamId) {
    return typeof steamId === 'string' && STEAMID64_REGEX.test(steamId);
}

module.exports = {
    scrape: async function (url) {
        try {
            return await Axios.get(url, REQUEST_OPTIONS);
        }
        catch (e) {
            /* Preserve why this failed. An HTTP error carries a response with
               the status code; a transport error (timeout, DNS, reset) carries
               only a code. Returning a bare {} — as this used to — collapsed
               every cause into one indistinguishable "failed" line, which is
               the difference between "back off" and "your IP is blocked". */
            if (e.response) return e.response;
            return {
                status: undefined,
                scrapeErrorCode: e.code || null,
                scrapeErrorMessage: e.message || null
            };
        }
    },

    isValidSteamId: isValidSteamId,

    /**
     *  Drop every cached avatar. Only needed so tests can start from a known
     *  state — nothing in the running bot has a reason to call it.
     */
    clearAvatarCache: function () {
        _avatarCache.clear();
    },

    /**
     *  Drop every cached persona name. Tests only, same as above.
     */
    clearNameCache: function () {
        _nameCache.clear();
    },

    /**
     *  Read the avatar cache without ever reaching Steam. Notification paths
     *  use this so a death or a login costs nothing; the cache is filled by the
     *  team-avatar priming step instead.
     *  @param {*} steamId The player's SteamID64.
     *  @return {string|null|undefined} The URL, null for a cached failure, or
     *      undefined when nothing is cached.
     */
    getCachedSteamProfilePicture: function (steamId) {
        return _avatarCache.get(`${steamId}`.trim());
    },

    /**
     *  Read the persona-name cache without ever reaching Steam. The tracker
     *  resolver checks this before it spends its process-wide Steam slot: a
     *  cache hit costs no request, so charging the slot for one would defer a
     *  player who genuinely needs the network for another whole interval.
     *  @param {*} steamId The player's SteamID64.
     *  @return {string|null|undefined} The name, null for a cached failure, or
     *      undefined when nothing is cached.
     */
    getCachedSteamProfileName: function (steamId) {
        return _nameCache.get(`${steamId}`.trim());
    },

    scrapeSteamProfilePicture: async function (client, steamId) {
        const id = `${steamId}`.trim();
        const link = `${Constants.STEAM_PROFILES_URL}${id}`;

        if (!isValidSteamId(id)) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'scrapeInvalidSteamId', {
                steamId: id === '' ? '(empty)' : id
            }), 'error');
            return null;
        }

        /* A cached failure is returned without logging again — the first one
           already said why, and repeating it once per death buries the log. */
        const cached = _avatarCache.get(id);
        if (cached !== undefined) return cached;

        const response = await module.exports.scrape(link);

        if (!response || response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfilePicture', {
                reason: describeFailure(response),
                link: link
            }), 'error');
            _avatarCache.set(id, null);
            return null;
        }

        const png = AVATAR_REGEX.exec(response.data);
        if (png) {
            _avatarCache.set(id, png[1]);
            return png[1];
        }

        /* The page loaded but did not parse. Silence here used to make a Steam
           markup change indistinguishable from a profile that genuinely has no
           avatar, so say so — this is the line that tells you the scraper, not
           the network, is what broke. */
        client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'scrapeProfilePictureNotFound', {
            link: link
        }), 'error');
        _avatarCache.set(id, null);
        return null;
    },

    scrapeSteamIdFromVanity: async function (client, vanity) {
        /* Encode the vanity segment — it comes from user input (a typed handle
           or a pasted profile URL) and could contain URL-significant chars. */
        const safeVanity = encodeURIComponent(vanity);
        const link = `https://steamcommunity.com/id/${safeVanity}`;
        const response = await module.exports.scrape(`${link}?xml=1`);

        if (!response || response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfileName', {
                reason: describeFailure(response),
                link: link
            }), 'error');
            return null;
        }

        let match = response.data.match(/<steamID64>(\d{17})<\/steamID64>/);
        if (match) {
            return match[1];
        }

        match = response.data.match(/steamcommunity\.com\/profiles\/(\d{17})/);
        if (match) {
            return match[1];
        }

        /* Steam answers an unknown vanity with 200 and an <error> body rather
           than a 404, so without this the single most common outcome -- a
           typo'd handle -- was indistinguishable from Steam throttling us. Its
           own wording is the reason worth reporting when it is there. */
        const steamError = /<error>(.*?)<\/error>/.exec(response.data);
        if (steamError) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'scrapeVanityNotFound', {
                reason: Utils.decodeHtml(steamError[1]),
                link: link
            }));
            return null;
        }

        client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'scrapeVanityNotResolved', {
            link: link
        }), 'error');
        return null;
    },

    /**
     *  Scrape a Steam persona name.
     *  @param {object} client The Discord client (for logging).
     *  @param {*} steamId The player's SteamID64.
     *  @param {object} options `cache: true` serves and fills the name cache.
     *      It is opt-in because a user typing a player into the add-player
     *      modal wants the name Steam has right now, while background callers
     *      (the tracker resolver, the blacklist/whitelist listings) are happy
     *      with a name that is hours old and would otherwise re-ask Steam for
     *      the same handful of profiles on every invocation.
     *  @return {Promise<string|null>}
     */
    scrapeSteamProfileName: async function (client, steamId, options = {}) {
        const id = `${steamId}`.trim();
        const link = `${Constants.STEAM_PROFILES_URL}${id}`;
        const useCache = options.cache === true;
        /* Still writes to the cache, only refuses to read it. The resolver uses
           this when it suspects the name it holds is the reason its searches
           keep missing — serving that same name back from the cache would make
           the refresh a no-op until the TTL expired hours later. */
        const forceRefresh = options.refresh === true;

        if (!isValidSteamId(id)) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'scrapeInvalidSteamId', {
                steamId: id === '' ? '(empty)' : id
            }), 'error');
            return null;
        }

        /* A cached failure is returned without logging again — the first one
           already said why, and repeating it buries the log. */
        if (useCache && !forceRefresh) {
            const cached = _nameCache.get(id);
            if (cached !== undefined) return cached;
        }

        const response = await module.exports.scrape(link);

        if (!response || response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfileName', {
                reason: describeFailure(response),
                link: link
            }), 'error');
            if (useCache) _nameCache.set(id, null);
            return null;
        }

        const data = PERSONA_NAME_REGEX.exec(response.data);
        if (data) {
            const name = Utils.decodeHtml(data[1]);
            if (useCache) _nameCache.set(id, name);
            return name;
        }

        client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'scrapeProfileNameNotFound', {
            link: link
        }), 'error');
        if (useCache) _nameCache.set(id, null);
        return null;
    },
}
