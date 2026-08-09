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

/* Parse an integer env var, falling back to `def` unless the value is a finite
   integer >= min. Unlike `parseInt(...) || def`, this lets a deliberate `0`
   through (when min is 0) and rejects negatives/NaN instead of passing them on. */
function envInt(name, def, min = 0) {
    const v = parseInt(process.env[name], 10);
    return Number.isInteger(v) && v >= min ? v : def;
}

module.exports = {
    general: {
        pollingIntervalMs: envInt('RPP_POLLING_INTERVAL', 10000, 1),
        showCallStackError: process.env.RPP_LOG_CALL_STACK === 'true',
        reconnectIntervalMs: envInt('RPP_RECONNECT_INTERVAL', 15000, 1),
    },
    battlemetrics: {
        /* Spacing/jitter for the global Battlemetrics request queue. Raising
           these spreads the per-cycle burst of server polls (one per tracked
           server) over a wider, more random window so big groups stop tripping
           Battlemetrics' short-window rate limits. A value of 0 is allowed
           (disables that component of the pacing). */
        requestSpacingMs: envInt('RPP_BM_REQUEST_SPACING_MS', 1500),
        requestJitterMs: envInt('RPP_BM_REQUEST_JITTER_MS', 1500),
        /* Base delay between background Steam scrapes. Only the teammate-avatar
           backfill is paced by it now, one profile per interval, so a team that
           reconnects with a cold cache repopulates gradually instead of firing
           one request per member at once. */
        steamScrapeDelayMs: envInt('RPP_STEAM_SCRAPE_DELAY_MS', 1500),
        /* Background Steam use is bootstrap-only: the one scheduled request the
           tracker loop can make is the attempt to turn an unresolved SteamID
           into a Battlemetrics playerId. Once a player has that id their name
           comes from the Battlemetrics roster forever after. This is the
           process-wide minimum gap between two such requests. */
        steamResolveIntervalMs: envInt('RPP_STEAM_RESOLVE_INTERVAL_MS', 5 * 60 * 1000),
        /* How many unresolved players the resolver examines per poll cycle.
           Most cost nothing (they match the live roster); at most one of them
           can reach Steam, and only if the interval above has elapsed. */
        trackerResolvePerCycle: envInt('RPP_TRACKER_RESOLVE_PER_CYCLE', 3, 0),
        /* How long a scraped Steam persona name stays reusable, for the callers
           that opt into the cache (the tracker resolver and the blacklist /
           whitelist listings). 0 disables the cache. */
        steamNameCacheMs: envInt('RPP_STEAM_NAME_CACHE_MS', 6 * 60 * 60 * 1000),
        /* How long a scraped Steam avatar URL stays reusable. Death and login
           notifications scrape one per event, so an active team asks Steam for
           the same handful of faces dozens of times an hour and gets 429'd for
           it. Avatars change rarely enough that hours of staleness is a fair
           trade. 0 disables the cache — which also switches off the background
           team-avatar priming, because with nothing stored every member would
           look uncached on every 10 s poll and the priming would become a
           permanent request stream instead of the opt-out it is meant to be. */
        steamAvatarCacheMs: envInt('RPP_STEAM_AVATAR_CACHE_MS', 6 * 60 * 60 * 1000),
        /* Battlemetrics API token. Their API now requires an authenticated
           (paid) key for the server/player endpoints this bot uses. This env
           var is only the fallback — the runtime source of truth is
           src/util/battlemetricsToken.js, which also holds a token set with
           the `/battlemetrics set` slash command. With no token from either
           source the whole Battlemetrics integration stays switched off. */
        token: process.env.RPP_BATTLEMETRICS_TOKEN || '',
    },
    discord: {
        username: process.env.RPP_DISCORD_USERNAME || 'rustplusplus',
        clientId: process.env.RPP_DISCORD_CLIENT_ID || '',
        token: process.env.RPP_DISCORD_TOKEN || '',
        needAdminPrivileges: process.env.RPP_NEED_ADMIN_PRIVILEGES === undefined
            ? true : process.env.RPP_NEED_ADMIN_PRIVILEGES === 'true', /* If true, only admins can delete (server, switch..), manage credentials and reset a channel */
    },
    translate: {
        /* If set, the team-chat translator routes through this LibreTranslate
           instance instead of the (unreliable) free Google web endpoint. Point
           at a sidecar container, e.g. `http://libretranslate:5000`. */
        libretranslateUrl: process.env.RPP_LIBRETRANSLATE_URL || '',
        libretranslateApiKey: process.env.RPP_LIBRETRANSLATE_API_KEY || '',
    }
};
