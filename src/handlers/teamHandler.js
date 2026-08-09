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

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const Scrape = require('../util/scrape.js');

/* Process-wide, because Steam throttles the host rather than the team. */
let _lastAvatarPrimeAt = 0;
/* Consecutive failed prime scrapes. checkChanges runs on every poll (10 s by
   default) whether or not anything changed, and a failed avatar is only cached
   for five minutes — so with Steam refusing us the backfill would otherwise
   become a permanent ~6-requests-per-5-minutes retry loop that never backs off,
   against an idle team that made zero requests before any of this existed. */
let _avatarFailures = 0;
/* Two overlapping checkChanges runs (messageBroadcastTeamChanged does not await
   it) would both see the same joiner as uncached, because the cache is only
   written once the scrape resolves. */
const _avatarInFlight = new Set();

/* Once a failure has been seen, the backfill's floor is a minute and doubles
   from there. A working Steam is still paced only by steamScrapeDelayMs. */
const AVATAR_FAILURE_FLOOR_MS = 60 * 1000;
const AVATAR_FAILURE_MAX_MS = 60 * 60 * 1000;
/* How many faces one invocation may fetch back to back. A squad forming up
   arrives as one teamChanged broadcast, and eight immediate sequential profile
   GETs is precisely the burst that gets the host refused. */
const AVATAR_IMMEDIATE_MAX = 4;
/* Total wall-clock the immediate fetches may hold up team-change handling. The
   scraper's own timeout is 15 s, so without this a cap of 4 could stall the
   notifications — and the team-state update behind them — for a full minute. */
const AVATAR_IMMEDIATE_BUDGET_MS = 6 * 1000;

function avatarBackfillIntervalMs() {
    const base = Config.battlemetrics.steamScrapeDelayMs;
    if (_avatarFailures === 0) return base;
    const raw = Math.max(base, AVATAR_FAILURE_FLOOR_MS) * Math.pow(2, Math.min(_avatarFailures, 7) - 1);
    return Math.min(raw, AVATAR_FAILURE_MAX_MS);
}

/* One scrape per id at a time, and a running tally of whether Steam is
   answering at all. */
async function primeOne(client, steamId) {
    if (_avatarInFlight.has(steamId)) return;
    _avatarInFlight.add(steamId);
    try {
        const png = await Scrape.scrapeSteamProfilePicture(client, steamId);
        if (png) _avatarFailures = 0;
        else _avatarFailures += 1;
    }
    finally {
        _avatarInFlight.delete(steamId);
    }
}

module.exports = {
    handler: async function (rustplus, client, teamInfo) {
        /* Handle team changes */
        await module.exports.checkChanges(rustplus, client, teamInfo);
    },

    checkChanges: async function (rustplus, client, teamInfo) {
        let instance = client.getInstance(rustplus.guildId);
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;
        const server = instance.serverList[serverId];

        if (rustplus.team.isLeaderSteamIdChanged(teamInfo)) return;

        const newPlayers = rustplus.team.getNewPlayers(teamInfo);
        const leftPlayers = rustplus.team.getLeftPlayers(teamInfo);

        /* Ahead of the notifications below so a joiner's — and a leaver's —
           embed already carries their face. A Steam problem must never stop the
           team-change handling it precedes: the embeds cope with a missing
           avatar on their own. */
        try {
            await module.exports.primeTeamAvatars(client, teamInfo, newPlayers, leftPlayers);
        }
        catch (e) { /* logged by the scraper itself */ }

        for (const steamId of leftPlayers) {
            const player = rustplus.team.getPlayer(steamId);
            const str = client.intlGet(guildId, 'playerLeftTheTeam', { name: player.name });
            await DiscordMessages.sendActivityNotificationMessage(
                guildId, serverId, Constants.COLOR_GREY, str, steamId);
            if (instance.generalSettings.connectionNotify) await rustplus.sendInGameMessage(str);
            rustplus.log(client.intlGet(null, 'infoCap'), str);
            rustplus.updateConnections(steamId, str);
        }

        for (const steamId of newPlayers) {
            for (const player of teamInfo.members) {
                if (player.steamId.toString() === steamId) {
                    const str = client.intlGet(guildId, 'playerJoinedTheTeam', { name: player.name });
                    await DiscordMessages.sendActivityNotificationMessage(
                        guildId, serverId, Constants.COLOR_ACTIVE, str, steamId);
                    if (instance.generalSettings.connectionNotify) await rustplus.sendInGameMessage(str);
                    rustplus.log(client.intlGet(null, 'infoCap'), str);
                    rustplus.updateConnections(steamId, str);
                }
            }
        }

        for (const player of rustplus.team.players) {
            if (leftPlayers.includes(player.steamId)) continue;
            for (const playerUpdated of teamInfo.members) {
                if (player.steamId === playerUpdated.steamId.toString()) {
                    if (player.isGoneDead(playerUpdated)) {
                        const location = player.pos === null ? 'spawn' : player.pos.string;
                        const str = client.intlGet(guildId, 'playerJustDied', {
                            name: player.name,
                            location: location
                        });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, serverId, Constants.COLOR_INACTIVE, str, player.steamId);
                        if (instance.generalSettings.deathNotify) rustplus.sendInGameMessage(str);
                        rustplus.log(client.intlGet(null, 'infoCap'), str);
                        rustplus.updateDeaths(player.steamId, {
                            name: player.name,
                            location: player.pos
                        });
                    }

                    if (player.isGoneAfk(playerUpdated)) {
                        if (instance.generalSettings.afkNotify) {
                            const str = client.intlGet(guildId, 'playerJustWentAfk', { name: player.name });
                            rustplus.sendInGameMessage(str);
                            rustplus.log(client.intlGet(null, 'infoCap'), str);
                        }
                    }

                    if (player.isAfk() && player.isMoved(playerUpdated)) {
                        if (instance.generalSettings.afkNotify) {
                            const afkTime = player.getAfkTime('dhs');
                            const str = client.intlGet(guildId, 'playerJustReturned', {
                                name: player.name,
                                time: afkTime
                            });
                            rustplus.sendInGameMessage(str);
                            rustplus.log(client.intlGet(null, 'infoCap'), str);
                        }
                    }

                    if (player.isGoneOnline(playerUpdated)) {
                        const str = client.intlGet(guildId, 'playerJustConnected', { name: player.name });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, serverId, Constants.COLOR_ACTIVE, str, player.steamId);
                        if (instance.generalSettings.connectionNotify) await rustplus.sendInGameMessage(str);
                        rustplus.log(client.intlGet(null, 'infoCap'),
                            client.intlGet(null, 'playerJustConnectedTo', {
                                name: player.name,
                                server: server.title
                            }));
                        rustplus.updateConnections(player.steamId, str);
                    }

                    if (player.isGoneOffline(playerUpdated)) {
                        const str = client.intlGet(guildId, 'playerJustDisconnected', { name: player.name });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, serverId, Constants.COLOR_INACTIVE, str, player.steamId);
                        if (instance.generalSettings.connectionNotify) await rustplus.sendInGameMessage(str);
                        rustplus.log(client.intlGet(null, 'infoCap'),
                            client.intlGet(null, 'playerJustDisconnectedFrom', {
                                name: player.name,
                                server: server.title
                            }));
                        rustplus.updateConnections(player.steamId, str);
                    }
                    break;
                }
            }
        }
    },

    /**
     * Fill the avatar cache for the current team, and only when it is actually
     * needed. Someone who has just joined or just left is fetched immediately —
     * those are the two moments a face becomes relevant, and the leaver is by
     * definition no longer in the roster, so they have to be named explicitly.
     * Everyone else (a cold cache after a restart, an expired TTL) trickles in
     * one profile per interval, so a six-man team repopulates gradually instead
     * of firing six requests at Steam at once.
     *
     * The immediate half is capped, and once Steam starts failing the backfill
     * backs off exponentially instead of retrying forever at poll rate.
     */
    primeTeamAvatars: async function (client, teamInfo, newPlayers, leftPlayers = []) {
        /* The documented way to switch the cache off is to set the TTL to 0.
           Nothing is stored then, so every member looks uncached on every poll
           and this would turn into a permanent one-request-per-poll loop —
           strictly more Steam traffic than the per-event scraping it replaced.
           Opting out has to mean opting out: the notification path falls back
           to fetching per event on its own. */
        if (Config.battlemetrics.steamAvatarCacheMs === 0) return;

        const immediate = [];
        const backfill = [];

        /* A cached failure counts as "not needed": re-asking a Steam that is
           already refusing us on every death only digs deeper. */
        for (const steamId of leftPlayers) {
            if (Scrape.getCachedSteamProfilePicture(steamId) !== undefined) continue;
            immediate.push(steamId);
        }

        for (const member of teamInfo.members) {
            /* The Rust+ protobuf hands steamId over as a Long-like object. */
            const steamId = member.steamId.toString();
            if (Scrape.getCachedSteamProfilePicture(steamId) !== undefined) continue;
            (newPlayers.includes(steamId) ? immediate : backfill).push(steamId);
        }

        /* While Steam is refusing us, even the "we need this now" path is worth
           only one request — the rest would be identical failures. */
        const immediateMax = _avatarFailures === 0 ? AVATAR_IMMEDIATE_MAX : 1;

        /* checkChanges is awaited before the team state is updated, and it is
           also invoked un-awaited from the Rust+ teamChanged broadcast — so
           every second spent here is a second in which a second run can start
           against the stale team and duplicate every join/leave notification.
           A slow Steam must not widen that window: once the deadline passes the
           remaining faces are demoted to the backfill and the notifications go
           out without them, which the embeds already handle. */
        const deadline = Date.now() + AVATAR_IMMEDIATE_BUDGET_MS;
        let immediateDone = 0;
        for (const steamId of immediate.slice(0, immediateMax)) {
            if (Date.now() >= deadline) break;
            await primeOne(client, steamId);
            immediateDone += 1;
        }
        for (const steamId of immediate.slice(immediateDone, immediateMax)) backfill.push(steamId);
        /* Anything over the cap is not urgent enough to burst for. */
        for (const steamId of immediate.slice(immediateMax)) backfill.push(steamId);

        if (backfill.length === 0) return;
        if (Date.now() - _lastAvatarPrimeAt < avatarBackfillIntervalMs()) return;
        _lastAvatarPrimeAt = Date.now();
        await primeOne(client, backfill[0]);
    },
}
