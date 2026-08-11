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

const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const Scrape = require('../util/scrape.js');
const ActivityDb = require('../util/activityDb.js');
const PlayerSearch = require('../util/battlemetricsPlayerSearch.js');
const BmToken = require('../util/battlemetricsToken.js');
const Utils = require('../util/utils.js');
const Config = require('../../config');

const ACTIVITY_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RAID_ALERT_RATIO = 0.6;
const RAID_ALERT_OFF_HOUR_THRESHOLD = 20; /* percent — below this, the group hour counts as "off" */
const RAID_ALERT_COOLDOWN_MS = 30 * 60 * 1000; /* don't refire within 30 min */
/* Per-player history required to count toward the raid alarm. The "is this an
   off hour?" verdict and the "is the group online now?" ratio are computed over
   the SAME eligible set (players with at least this many samples) so a single
   long-tracked player's pattern can't stand in for the whole group. */
const RAID_ALERT_MIN_SAMPLES = 500;

/* Steam is a bootstrap, not a data source. The only scheduled Steam request the
   tracker loop can make is the attempt to turn an unresolved SteamID into a
   Battlemetrics player id; from then on the player's name comes off the roster
   we already fetch once per server per cycle for free. These budgets cap what a
   single cycle may spend, so a large backlog of unresolvable ids can never
   crowd out the routine work or push the cycle past the 60 s poll window. */
const RESOLVE_MAX_PER_CYCLE = Config.battlemetrics.trackerResolvePerCycle;
const RESOLVE_MAX_BM_LOOKUPS_PER_CYCLE = 2;
const RESOLVE_BACKOFF_BASE_MS = 30 * 60 * 1000;
const RESOLVE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const STEAM_RESOLVE_INTERVAL_MS = Config.battlemetrics.steamResolveIntervalMs;
/* After this many failed attempts the stored persona name is the prime suspect
   — it is the only input the Battlemetrics search gets — so the row is allowed
   one Steam refresh. Below it, Steam is never asked about a player whose name
   we already know. */
const RESOLVE_STEAM_REFRESH_AFTER = 3;

/* Lifetime Rust hours. The number moves by at most a few hours a day, so it is
   refreshed roughly daily and only a couple of players per cycle, which keeps
   the added load at a fixed handful of requests per minute no matter how large
   the tracked roster grows. */
const HOURS_REFRESH_INTERVAL_MS = Config.battlemetrics.trackerHoursRefreshMs;
const HOURS_MAX_PER_CYCLE = Config.battlemetrics.trackerHoursPerCycle;
/* Consecutive empty playtime answers, with none ever having succeeded, before
   we call it a broken endpoint rather than a run of private profiles. */
const PLAYTIME_EMPTY_WARN_THRESHOLD = 10;

/* The UPDATE button's deep heal makes one rate-limited Battlemetrics request
   per placeholder, and a click can be repeated. Without these it is the only
   unbounded per-player request loop left on the tracker path: 40 placeholders
   is 40 serialised requests, and every one of them holds up the 60 s poll. */
const DEEP_HEAL_MAX_LOOKUPS = 10;
const DEEP_HEAL_MISS_TTL_MS = 10 * 60 * 1000;

let _lastActivityRecomputeAt = 0;
/* Process-wide, not per guild or per tracker: Steam rate-limits the host, so
   the gate has to span every tracker the bot serves. */
let _lastBackgroundSteamAt = 0;
/* Malformed stored ids are worth saying once, never once per cycle. */
const _warnedBadSteamIds = new Set();
/* Same reasoning: a tracker holding the same human twice is a configuration
   problem the operator has to fix, not a line for every poll cycle. */
const _warnedDuplicateLinks = new Set();
/* Lifetime-hours health. A single empty answer is ordinary (private profile);
   a long unbroken run of them without ever having succeeded means the endpoint
   or its response shape changed, which is otherwise invisible. */
let _playtimeEverSucceeded = false;
let _playtimeConsecutiveEmpty = 0;
let _warnedPlaytimeUnavailable = false;
/* Battlemetrics ids the deep heal has already asked about and got nothing for.
   Without this every repeat click re-issues the whole set. */
const _deepHealMisses = new Map();
let _deepHealRunning = false;

/* A tracker counts as active unless it's been explicitly paused. Older
   instance files predate the field, so treat a missing flag as active. */
function _isTrackerActive(tracker) {
    return tracker.active !== false;
}

module.exports = {
    handler: async function (client, firstTime = false) {
        /* Local housekeeping (activity DB maintenance, legacy message sweep)
           makes no API calls, so it has to keep running even while the
           Battlemetrics integration is switched off — otherwise clearing the
           token would silently stop 30-day snapshot purging and raid-alarm row
           pruning for as long as the bot stays up. */
        await module.exports.runLocalHousekeeping(client);

        /* Without an API token every call below would 401 — skip the rest of
           the cycle rather than burning requests and log noise on it. */
        if (!BmToken.isEnabled()) return;

        /* Dedupe activity-log snapshots within one poll cycle: a player tracked
           on two active trackers (or across guilds) would otherwise insert two
           rows with the same checked_at, inflating sample counts and risking
           conflicting online states. Snapshot each BM player at most once. */
        const snapshottedThisCycle = new Set();

        if (!firstTime) await client.updateBattlemetricsInstances();

        const freshInstances = module.exports.consumeSuppressionFlags(client);

        /* Ahead of every per-guild and per-tracker step on purpose: a player who
           has just been added and has no Battlemetrics id yet is invisible to
           all of it, so linking them must never queue behind the routine work of
           trackers that are already functioning. It reads the roster the call
           above just refreshed, and its budgets bound it to at most one Steam
           and two Battlemetrics requests. */
        try {
            await module.exports.runResolutionPass(client);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                `Tracker resolution pass failed: ${e.message}`, 'error');
        }

        /* After the resolution pass, and non-fatally: lifetime hours are a
           decoration on the card, so nothing about them may interrupt the
           notifications the cycle exists to send. It runs before the tracker
           cards are drawn below so a figure fetched this cycle is rendered this
           cycle rather than a minute later. */
        try {
            await module.exports.runPlaytimePass(client);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                `Tracker playtime pass failed: ${e.message}`, 'error');
        }

        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            const rustplus = client.rustplusInstances[guildId];

            /* A guild the bot has joined but never had an instance file written
               for reaches here with nothing to iterate. */
            if (!instance || !instance.trackers) continue;

            /* Same reasoning as the per-tracker guard below, one level up: the
               guild-global embeds are a nice-to-have, the trackers are not. */
            if (!firstTime) {
                try {
                    await module.exports.handleBattlemetricsChanges(client, guildId, freshInstances);
                }
                catch (e) {
                    client.log(client.intlGet(null, 'errorCap'),
                        `Battlemetrics change report failed for guild ${guildId}: ${e.message}`, 'error');
                }
            }

            for (const [trackerId, content] of Object.entries(instance.trackers)) {
                /* One tracker's failure used to abort the cycle for every
                   tracker after it, in this guild and in all the ones that had
                   not been reached yet — a single Discord 5xx on a message edit
                   was enough. Trackers are the most-used feature, so they get
                   isolated from each other. */
                try {
                    /* Paused tracker: do no API work at all — no server poll, no
                       activity snapshot, no resolution attempt. This is the lever
                       for staying under Battlemetrics/Steam limits when too many
                       players are being tracked. */
                    if (!_isTrackerActive(content)) continue;

                    const battlemetricsId = content.battlemetricsId;
                    const bmInstance = client.battlemetricsInstances[battlemetricsId];

                    if (!bmInstance || !bmInstance.lastUpdateSuccessful) continue;

                    /* Adopt the Battlemetrics roster's spelling of every resolved
                       player's name. This runs before the name-change alert loop
                       below on purpose: the alert reports from/to out of
                       bmInstance.nameChangedPlayers, so the stored name can be
                       corrected here and still leave the alert accurate — which
                       is what finally makes a rename persist instead of only
                       being announced. */
                    if (module.exports.syncTrackerPlayerNames(content, bmInstance)) {
                        client.setInstance(guildId, instance);
                    }

                    /* Snapshot every tracked player's current online state into
                       activity_log. This is the foundation for the typical-play-hours
                       hint and the off-hours raid alarm. Cheap insert per player. */
                    /* Deduped: an instance file can already hold the same
                       Battlemetrics id on two rows (added once by SteamID and
                       once by BM id), and a doubled row would insert two
                       activity_log samples at the same checked_at — inflating
                       that human's sample count and double-weighting them in
                       the off-hours raid alarm. */
                    const trackedIds = Array.from(
                        new Set(content.players.map(p => p.playerId).filter(Boolean)));
                    let onlineSet = null;
                    if (trackedIds.length > 0) {
                        onlineSet = new Set(bmInstance.onlinePlayers.map(String));
                        const newIds = trackedIds.filter(id => !snapshottedThisCycle.has(id));
                        if (newIds.length > 0) {
                            ActivityDb.logSnapshot(newIds, onlineSet, Math.floor(Date.now() / 1000));
                            for (const id of newIds) snapshottedThisCycle.add(id);
                        }
                    }

                    /* Off-hours raid alarm: if the group's typical online rate at
                       the current local hour is below the off-hours threshold AND
                       at least 60% of the group is online right now, fire once
                       (with a cooldown so we don't spam during a sustained event).
                       Both checks use the eligible set (players with enough history)
                       so the verdict and the ratio describe the same players. */
                    if (content.raidAlert && !firstTime && onlineSet) {
                        const eligibleIds = trackedIds.filter(id =>
                            ActivityDb.getSampleCount(id) >= RAID_ALERT_MIN_SAMPLES);
                        if (eligibleIds.length >= 2) {
                            const eligibleOnline = eligibleIds.filter(id => onlineSet.has(String(id))).length;
                            const ratio = eligibleOnline / eligibleIds.length;
                            if (ratio >= RAID_ALERT_RATIO) {
                                const now = new Date();
                                const dow = now.getDay();
                                const hour = now.getHours();
                                if (ActivityDb.isOffHourForGroup(eligibleIds, dow, hour,
                                    RAID_ALERT_OFF_HOUR_THRESHOLD, RAID_ALERT_MIN_SAMPLES)) {
                                    const nowSec = Math.floor(Date.now() / 1000);
                                    const last = ActivityDb.getLastAlertAt(`${guildId}:${trackerId}`);
                                    if ((nowSec - last) * 1000 >= RAID_ALERT_COOLDOWN_MS) {
                                        ActivityDb.setLastAlertAt(`${guildId}:${trackerId}`, nowSec);
                                        await module.exports.fireRaidAlert(client, guildId, trackerId,
                                            content, eligibleOnline, eligibleIds.length);
                                    }
                                }
                            }
                        }
                    }

                    /* On the very first cycle the roster's login/logout deltas
                       describe the bot starting up, not anything a player did, so
                       draw the tracker and skip the notifications. */
                    if (firstTime) {
                        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                        continue;
                    }

                    /* This instance has only just been built (bot start, or a
                       tracker coming back off pause): its roster deltas are the
                       whole online population, not anything a player did. */
                    if (freshInstances.has(battlemetricsId)) {
                        client.setInstance(guildId, instance);
                        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                        continue;
                    }

                    /* Every loop below walks `content.players` and reports once
                       per distinct Battlemetrics id. The old form iterated the
                       id list and then re-scanned the players for each, so a
                       tracker holding one human on two rows sent four embeds
                       and four in-game lines for a single login. */
                    const trackerPlayerIds = new Set(content.players.map(e => e.playerId).filter(Boolean));

                    /* Check if Player just changed name */
                    const renamed = new Set();
                    for (const player of bmInstance.nameChangedPlayers) {
                        if (!trackerPlayerIds.has(player.id) || renamed.has(player.id)) continue;
                        renamed.add(player.id);

                        await module.exports.trackerNewNameDetected(client, guildId, trackerId, battlemetricsId,
                            player.from, player.to);
                    }

                    /* Check if Player just came online. Battlemetrics reports a
                       player it has never seen before in newPlayers and one it
                       has in loginPlayers; both mean the same thing here. */
                    const connectedIds = new Set([...bmInstance.newPlayers, ...bmInstance.loginPlayers]);
                    const notified = new Set();
                    for (const player of content.players) {
                        if (!player.playerId || notified.has(player.playerId)) continue;
                        if (!connectedIds.has(player.playerId)) continue;
                        notified.add(player.playerId);

                        const str = client.intlGet(guildId, 'playerJustConnectedTracker', {
                            name: player.name,
                            tracker: content.name
                        });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, content.serverId, Constants.COLOR_ACTIVE, str, null, content.title,
                            content.everyone);
                        if (rustplus && (rustplus.serverId === content.serverId) && content.inGame) {
                            rustplus.sendInGameMessage(str);
                        }
                    }

                    /* Check if Player just went offline */
                    const logoutIds = new Set(bmInstance.logoutPlayers);
                    notified.clear();
                    for (const player of content.players) {
                        if (!player.playerId || notified.has(player.playerId)) continue;
                        if (!logoutIds.has(player.playerId)) continue;
                        notified.add(player.playerId);

                        const str = client.intlGet(guildId, 'playerJustDisconnectedTracker', {
                            name: player.name,
                            tracker: content.name
                        });

                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, content.serverId, Constants.COLOR_INACTIVE, str, null, content.title,
                            content.everyone);
                        if (rustplus && (rustplus.serverId === content.serverId) && content.inGame) {
                            rustplus.sendInGameMessage(str);
                        }
                    }

                    client.setInstance(guildId, instance);

                    await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                }
                catch (e) {
                    client.log(client.intlGet(null, 'errorCap'),
                        `Tracker #${trackerId} cycle failed: ${e.message}`, 'error');
                }
            }
        }
    },

    /**
     *  Maintenance that touches only local state (SQLite activity log, stale
     *  Discord messages). Runs on every poll cycle regardless of whether the
     *  Battlemetrics integration has a token.
     */
    runLocalHousekeeping: async function (client) {
        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            if (!instance) continue;

            /* If a previous version of the bot left a "BM all online players"
               info-channel message around, sweep it once on next poll. */
            if (instance.informationMessageId.battlemetricsPlayers) {
                await DiscordTools.deleteMessageById(guildId, instance.channelId.information,
                    instance.informationMessageId.battlemetricsPlayers);
                instance.informationMessageId.battlemetricsPlayers = null;
                client.setInstance(guildId, instance);
            }
        }

        /* Aggregate the last 30 days into the (player, dow, hour) pattern grid
           once per day, and purge anything older than 30 days. */
        const nowMs = Date.now();
        if (nowMs - _lastActivityRecomputeAt < ACTIVITY_RECOMPUTE_INTERVAL_MS) return;

        try {
            ActivityDb.purgeOld(30);
            ActivityDb.recomputePatterns(30);

            /* Sweep raid-alarm cooldown rows for trackers that no longer
               exist (covers trackers removed while the bot was offline or
               by editing the instance file directly). */
            const validAlertKeys = [];
            for (const guildItem of client.guilds.cache) {
                const gId = guildItem[0];
                const inst = client.getInstance(gId);
                if (!inst) continue;
                for (const tId of Object.keys(inst.trackers || {})) {
                    validAlertKeys.push(`${gId}:${tId}`);
                }
            }
            ActivityDb.pruneAlertsExcept(validAlertKeys);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                `ActivityDb recompute failed: ${e.message}`, 'error');
        }
        _lastActivityRecomputeAt = nowMs;
    },

    handleBattlemetricsChanges: async function (client, guildId, freshInstances = new Set()) {
        const instance = client.getInstance(guildId);
        const settings = instance.generalSettings;

        const activeServer = instance.activeServer;
        const server = instance.serverList[activeServer];
        const battlemetricsIdActiveServer = server ? server.battlemetricsId : null;

        const battlemetricsIds = [];
        if (battlemetricsIdActiveServer && client.battlemetricsInstances.hasOwnProperty(battlemetricsIdActiveServer) &&
            client.battlemetricsInstances[battlemetricsIdActiveServer].lastUpdateSuccessful) {
            battlemetricsIds.push(battlemetricsIdActiveServer);
        }

        for (const [trackerId, content] of Object.entries(instance.trackers)) {
            if (!_isTrackerActive(content)) continue;

            const battlemetricsId = content.battlemetricsId;
            const bmInstance = client.battlemetricsInstances[battlemetricsId];

            if (!bmInstance || (bmInstance && !bmInstance.lastUpdateSuccessful)) continue;
            if (battlemetricsIds.includes(battlemetricsId)) continue;

            battlemetricsIds.push(battlemetricsId);
        }

        /* Go through each battlemetrics instance and notify changes */
        for (const battlemetricsId of battlemetricsIds) {
            /* Same reason as in the tracker loop: a just-built instance reports
               the whole online population as newPlayers, which is a startup
               artefact and not a login anybody performed. */
            if (freshInstances.has(battlemetricsId)) continue;

            const bmInstance = client.battlemetricsInstances[battlemetricsId];

            /* Server name changed? */
            if (settings.battlemetricsServerNameChanges && bmInstance.serverEvaluation.hasOwnProperty('server_name')) {
                const oldName = bmInstance.serverEvaluation['server_name'].from;
                const newName = bmInstance.serverEvaluation['server_name'].to;

                const title = client.intlGet(guildId, 'battlemetricsServerNameChanged');
                const description = `__**${client.intlGet(guildId, 'old')}:**__ ${oldName}\n` +
                    `__**${client.intlGet(guildId, 'new')}:**__ ${newName}`;

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title, description);
            }

            /* Players whos name have changed */
            if (settings.battlemetricsGlobalNameChanges && bmInstance.nameChangedPlayers.length !== 0) {
                const title = client.intlGet(guildId, 'battlemetricsPlayersNameChanged');

                const oldNameFieldName = client.intlGet(guildId, 'old');
                const playerIdFieldName = client.intlGet(guildId, 'playerId');
                const newNameFieldName = client.intlGet(guildId, 'new');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */

                let oldName = [''], playerId = [''], newName = [''];
                let oldNameCharacters = 0, playerIdCharacters = 0, newNameCharacters = 0;
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const player of bmInstance.nameChangedPlayers) {
                    playerCounter += 1;
                    const fieldRowMaxLength = Constants.EMBED_FIELD_MAX_WIDTH_LENGTH_3;

                    let oldN = `${player.from}`;
                    oldN = oldN.length <= fieldRowMaxLength ? oldN : oldN.substring(0, fieldRowMaxLength - 2) + '..';
                    oldN += '\n';

                    const id = `[${player.id}](${Constants.BATTLEMETRICS_PROFILE_URL + `${player.id}`})\n`;

                    let newN = `${player.to}`;
                    newN = newN.length <= fieldRowMaxLength ? newN : newN.substring(0, fieldRowMaxLength - 2) + '..';
                    newN += '\n';



                    if (totalCharacters + (oldN.length + id.length + newN.length) >=
                        Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if ((oldNameCharacters + oldN.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                        (playerIdCharacters + id.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                        (newNameCharacters + newN.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldIndex += 1;

                        oldName.push('');
                        playerId.push('');
                        newName.push('');

                        oldNameCharacters = 0;
                        playerIdCharacters = 0;
                        newNameCharacters = 0;
                    }

                    oldNameCharacters += oldN.length;
                    playerIdCharacters += id.length;
                    newNameCharacters += newN.length;

                    totalCharacters += oldN.length + id.length + newN.length;

                    oldName[fieldIndex] += oldN;
                    playerId[fieldIndex] += id;
                    newName[fieldIndex] += newN;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: bmInstance.nameChangedPlayers.length - playerCounter
                    });
                }

                const fields = [];
                for (let i = 0; i < (fieldIndex + 1); i++) {
                    fields.push({
                        name: i === 0 ? oldNameFieldName : '\u200B',
                        value: oldName[i] !== '' ? oldName[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                    fields.push({
                        name: i === 0 ? playerIdFieldName : '\u200B',
                        value: playerId[i] !== '' ? playerId[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                    fields.push({
                        name: i === 0 ? newNameFieldName : '\u200B',
                        value: newName[i] !== '' ? newName[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, fields);
            }

            /* Players that just logged in */
            if (settings.battlemetricsGlobalLogin &&
                (bmInstance.loginPlayers.length !== 0 || bmInstance.newPlayers.length !== 0)) {
                const playerIds = Array.from(new Set(bmInstance.loginPlayers.concat(bmInstance.newPlayers)));
                const title = client.intlGet(guildId, 'battlemetricsPlayersLogin');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */
                let fieldCharacters = 0;

                const fields = [''];
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const playerId of playerIds) {
                    playerCounter += 1;
                    const bmPlayer = bmInstance.players[playerId];
                    if (!bmPlayer || !bmPlayer['name']) continue;
                    const name = bmPlayer['name'].replace('[', '(').replace(']', ')');
                    const playerStr = `[${name}](${Constants.BATTLEMETRICS_PROFILE_URL + `${playerId}`})\n`;

                    if (totalCharacters + playerStr.length >= Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if (fieldCharacters + playerStr.length >= Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldCharacters = 0;
                        fieldIndex += 1;
                        fields.push('');
                    }

                    fields[fieldIndex] += playerStr;
                    totalCharacters += playerStr.length;
                    fieldCharacters += playerStr.length;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: playerIds.length - playerCounter
                    });
                }

                let fieldCounter = 0;
                const outPutFields = [];
                for (const field of fields) {
                    outPutFields.push({
                        name: '\u200B',
                        value: field === '' ? '\u200B' : field,
                        inline: true
                    });
                    fieldCounter += 1;
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, outPutFields);
            }

            /* Players that just logged out */
            if (settings.battlemetricsGlobalLogout && bmInstance.logoutPlayers.length !== 0) {
                const title = client.intlGet(guildId, 'battlemetricsPlayersLogout');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */
                let fieldCharacters = 0;

                const fields = [''];
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const playerId of bmInstance.logoutPlayers) {
                    playerCounter += 1;
                    const bmPlayer = bmInstance.players[playerId];
                    if (!bmPlayer || !bmPlayer['name']) continue;
                    const name = bmPlayer['name'].replace('[', '(').replace(']', ')');
                    const playerStr = `[${name}](${Constants.BATTLEMETRICS_PROFILE_URL + `${playerId}`})\n`;

                    if (totalCharacters + playerStr.length >= Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if (fieldCharacters + playerStr.length >= Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldCharacters = 0;
                        fieldIndex += 1;
                        fields.push('');
                    }

                    fields[fieldIndex] += playerStr;
                    totalCharacters += playerStr.length;
                    fieldCharacters += playerStr.length;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: bmInstance.logoutPlayers.length - playerCounter
                    });
                }

                let fieldCounter = 0;
                const outPutFields = [];
                for (const field of fields) {
                    outPutFields.push({
                        name: '\u200B',
                        value: field === '' ? '\u200B' : field,
                        inline: true
                    });
                    fieldCounter += 1;
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, outPutFields);
            }
        }
    },

    trackerNewNameDetected: async function (client, guildId, trackerId, battlemetricsId, oldName, newName) {
        const instance = client.getInstance(guildId);
        const trackerName = instance.trackers[trackerId].name;

        const title = client.intlGet(guildId, 'battlemetricsTrackerPlayerNameChanged');
        const description = `__**${client.intlGet(guildId, 'tracker')}:**__ ${trackerName}\n\n` +
            `__**${client.intlGet(guildId, 'old')}:**__ ${oldName}\n` +
            `__**${client.intlGet(guildId, 'new')}:**__ ${newName}`;

        await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title, description, null,
            instance.trackers[trackerId].everyone);
    },

    fireRaidAlert: async function (client, guildId, trackerId, tracker, onlineCount, totalCount) {
        const rustplus = client.rustplusInstances[guildId];
        const str = client.intlGet(guildId, 'trackerRaidAlertText', {
            tracker: tracker.name,
            online: onlineCount,
            total: totalCount
        });

        await DiscordMessages.sendActivityNotificationMessage(
            guildId, tracker.serverId, Constants.COLOR_ACTIVE, str, null, tracker.title, true);

        if (rustplus && rustplus.serverId === tracker.serverId) {
            /* Force-send: bypass the in-game mute so this alert reaches team chat
               even when bot chatter is muted, same pattern as Smart Alarms. */
            rustplus.sendInGameMessage(str, true);
        }

        client.log(client.intlGet(null, 'infoCap'),
            `Raid alert fired for tracker #${trackerId} (${onlineCount}/${totalCount} online)`);
    },

    /* True if the stored display name is just a placeholder we should replace
       with whatever BM reports (empty/null, '-', or literally the BM id). */
    _isPlaceholderName: function (player) {
        if (!player.name) return true;
        const n = String(player.name).trim();
        if (n === '' || n === '-') return true;
        if (player.playerId && n === String(player.playerId)) return true;
        return false;
    },

    /* The tracker's clanTag is a Discord-side decoration; Battlemetrics never
       carries it, so it is added on the way out and stripped on the way in. */
    _composeName: function (clanTag, baseName) {
        return clanTag ? `${clanTag} ${baseName}` : `${baseName}`;
    },

    _stripClanTag: function (name, clanTag) {
        const n = `${name ?? ''}`;
        if (!clanTag) return n;
        const prefix = `${clanTag} `;
        return n.startsWith(prefix) ? n.slice(prefix.length) : n;
    },

    /* Every add path (modal, slash command, resolver) has to write the same
       shape, or a row added by one of them is silently invisible to the
       backoff bookkeeping of another. */
    makeTrackerPlayer: function ({ name, steamId = null, playerId = null, steamNameLastScrapedAt = 0 }) {
        return {
            name: name,
            steamId: steamId,
            playerId: playerId,
            steamNameLastScrapedAt: steamNameLastScrapedAt,
            resolveAttempts: 0,
            resolveNextAttemptAt: 0,
            /* Lifetime Rust hours, filled in by runPlaytimePass. `null` means
               "not known yet"; the timestamp records the last *attempt*, so a
               profile that never answers is retried on the same slow schedule
               as one that does instead of every cycle. */
            rustHours: null,
            rustHoursUpdatedAt: 0
        };
    },

    /**
     * One-way sync, Battlemetrics -> tracker: every resolved player's stored
     * name is replaced by the roster's, with the tracker's clanTag applied.
     * This is where a renamed player's name actually changes now — Steam is
     * never asked about a player who already has a Battlemetrics id.
     *
     * Deliberately silent: the alert for a rename comes from
     * bmInstance.nameChangedPlayers, which only reports genuine renames seen
     * during this bot run. Alerting from here instead would fire a burst of
     * stale "name changed" messages on the first cycle after every restart.
     *
     * Returns true if anything changed. Safe to call cheaply on every poll.
     */
    syncTrackerPlayerNames: function (tracker, bmInstance) {
        let changed = false;
        for (const player of tracker.players) {
            if (!player.playerId) continue;
            const bmPlayer = bmInstance && bmInstance.players[player.playerId];
            if (!bmPlayer || !bmPlayer.name) continue;
            const desired = module.exports._composeName(tracker.clanTag, bmPlayer.name);
            if (player.name === desired) continue;
            player.name = desired;
            changed = true;
        }
        return changed;
    },

    /* Kept under its old name for the UPDATE button and the deep heal: the
       placeholder-only heal it used to be is a strict subset of the sync. */
    healTrackerPlayerNames: function (tracker, bmInstance) {
        return module.exports.syncTrackerPlayerNames(tracker, bmInstance);
    },

    /**
     * Re-apply a changed clanTag to every stored name, immediately. Editing the
     * tag used to only set the field and wait for the next Steam re-scrape to
     * rewrite the names, which meant it appeared to do nothing for up to a day
     * — and nothing at all once Steam started refusing us.
     */
    retagTrackerPlayerNames: function (tracker, oldTag, newTag) {
        let changed = false;
        for (const player of tracker.players) {
            /* A placeholder carries no name to retag; leave it for the sync. */
            if (module.exports._isPlaceholderName(player)) continue;
            const base = module.exports._stripClanTag(player.name, oldTag);
            const composed = module.exports._composeName(newTag, base);
            if (player.name === composed) continue;
            player.name = composed;
            changed = true;
        }
        return changed;
    },

    /**
     * On-demand heal used by the UPDATE button: first try the live BM cache
     * (instant), then for any entries still unresolved fall back to a direct
     * BM /players/{id} HTTP lookup so we don't have to wait for the player
     * to come online and appear in the cache.
     *
     * The HTTP half is deliberately bounded in three ways, because it hangs off
     * a button anyone can click twice: at most DEEP_HEAL_MAX_LOOKUPS requests
     * per click (a tracker bulk-populated from autocomplete can hold dozens of
     * placeholders, and every request sits on the shared Battlemetrics queue at
     * 1.5-3 s spacing, stalling the 60 s poll behind it), one request per
     * distinct id however many rows share it, and nothing re-asked for
     * DEEP_HEAL_MISS_TTL_MS after it came back empty. A second click while the
     * first is still running only re-runs the free cache heal.
     */
    deepHealTrackerPlayerNames: async function (tracker, bmInstance) {
        let changed = module.exports.healTrackerPlayerNames(tracker, bmInstance);
        if (_deepHealRunning) return changed;

        const now = Date.now();
        const pendingById = new Map();
        for (const player of tracker.players) {
            if (!player.playerId || !module.exports._isPlaceholderName(player)) continue;
            const key = `${player.playerId}`;

            const missedAt = _deepHealMisses.get(key);
            if (missedAt !== undefined) {
                if ((now - missedAt) < DEEP_HEAL_MISS_TTL_MS) continue;
                _deepHealMisses.delete(key);
            }

            if (!pendingById.has(key)) pendingById.set(key, []);
            pendingById.get(key).push(player);
        }
        if (pendingById.size === 0) return changed;

        _deepHealRunning = true;
        try {
            let budget = DEEP_HEAL_MAX_LOOKUPS;
            for (const [playerId, rows] of pendingById) {
                if (budget <= 0) break;
                budget -= 1;

                const resolved = await PlayerSearch.resolveNameById(bmInstance, playerId);
                if (!resolved) {
                    _deepHealMisses.set(playerId, Date.now());
                    continue;
                }
                for (const row of rows) row.name = module.exports._composeName(tracker.clanTag, resolved);
                changed = true;
            }
        }
        finally {
            _deepHealRunning = false;
        }
        return changed;
    },

    /**
     * Move the process-wide Steam gate. Only needed so a test can open it
     * without waiting out the interval, or close it to exercise the
     * Battlemetrics-only path — nothing in the running bot calls it.
     * @param {number} at Timestamp of the last background Steam request.
     */
    _setBackgroundSteamAt: function (at) {
        _lastBackgroundSteamAt = at;
    },

    /**
     * Forget what we know about playtime health. Same reasoning as above: the
     * counters are process-wide, so a test that wants to exercise the warning
     * threshold has to start from a known state.
     */
    _resetPlaytimeHealth: function () {
        _playtimeEverSucceeded = false;
        _playtimeConsecutiveEmpty = 0;
        _warnedPlaytimeUnavailable = false;
    },

    /**
     * Every tracked player, across every guild, that has a SteamID but no
     * Battlemetrics id yet.
     *
     * Players in backoff are still returned, flagged `eligible: false`. The
     * backoff exists to rate-limit Steam and Battlemetrics *requests*, and
     * dropping the player here applied it one level too high — it also
     * excluded them from the free, zero-request roster match, so someone who
     * became trivially resolvable by simply logging in stayed untracked for up
     * to 24 hours. The flag lets the pass run the free step for everyone and
     * spend requests only on the eligible.
     *
     * Sorted so a player nobody has tried yet always comes before one that has
     * already failed a few times: a freshly added player must never wait behind
     * a backlog of ids that will never resolve.
     *
     * @returns {Array<{guildId: string, instance: object, trackerId: string,
     *      tracker: object, player: object, bmInstance: object|undefined,
     *      eligible: boolean}>}
     */
    collectResolutionCandidates: function (client) {
        const now = Date.now();
        const candidates = [];

        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            if (!instance || !instance.trackers) continue;

            for (const [trackerId, tracker] of Object.entries(instance.trackers)) {
                if (!_isTrackerActive(tracker)) continue;
                if (tracker.battlemetricsId === null) continue;

                /* May be undefined when that server's poll failed. Not a reason
                   to skip: the search endpoint doesn't need the roster. */
                const bmInstance = client.battlemetricsInstances[tracker.battlemetricsId];

                for (const player of tracker.players) {
                    if (player.playerId) continue;

                    const steamId = `${player.steamId ?? ''}`;
                    if (!Scrape.isValidSteamId(steamId)) {
                        if (steamId !== '' && !_warnedBadSteamIds.has(steamId)) {
                            _warnedBadSteamIds.add(steamId);
                            client.log(client.intlGet(null, 'warningCap'),
                                `Tracker #${trackerId}: stored SteamID ${steamId} is malformed, ` +
                                `that player can never be linked to Battlemetrics`);
                        }
                        continue;
                    }

                    /* Missing in instance files written before this existed, and
                       0 means "eligible now", which is the right default. */
                    const eligible = (player.resolveNextAttemptAt || 0) <= now;

                    candidates.push({ guildId, instance, trackerId, tracker, player, bmInstance, eligible });
                }
            }
        }

        candidates.sort((a, b) => {
            /* Anyone allowed to spend a request comes first, so the per-cycle
               request budgets are never eaten by rows that cannot use them. */
            if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
            const attemptsDiff = (a.player.resolveAttempts || 0) - (b.player.resolveAttempts || 0);
            if (attemptsDiff !== 0) return attemptsDiff;
            return (a.player.resolveNextAttemptAt || 0) - (b.player.resolveNextAttemptAt || 0);
        });

        return candidates;
    },

    /**
     * Every tracked player whose lifetime Rust hours are missing or stale,
     * deduped by Battlemetrics id.
     *
     * The dedupe is the point: the figure is a property of the human, not of
     * the tracker they appear on, so one request answers for every row that
     * shares the id — across trackers and across guilds. Without it a clan
     * tracked in two guilds would pay twice for the same number.
     *
     * Sorted oldest-first so a newly added player, whose timestamp is 0, is
     * always served before a refresh of someone already showing a figure.
     *
     * @returns {Array<{playerId: string, bmInstance: object, updatedAt: number,
     *      rows: Array<{guildId: string, instance: object, player: object}>}>}
     */
    collectPlaytimeCandidates: function (client) {
        const now = Date.now();
        const byPlayerId = new Map();

        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            if (!instance || !instance.trackers) continue;

            for (const tracker of Object.values(instance.trackers)) {
                if (!_isTrackerActive(tracker)) continue;
                if (tracker.battlemetricsId === null) continue;

                /* The playtime endpoint is per player, not per server, so any
                   working instance can carry the request — but a server whose
                   own poll is failing is a bad bet for an extra call. */
                const bmInstance = client.battlemetricsInstances[tracker.battlemetricsId];
                if (!bmInstance || !bmInstance.lastUpdateSuccessful) continue;

                for (const player of tracker.players) {
                    if (!player.playerId) continue;

                    const key = `${player.playerId}`;
                    const existing = byPlayerId.get(key);
                    if (existing) {
                        existing.rows.push({ guildId, instance, player });
                        /* The staleness of the group is the staleness of its
                           least recently updated row: a row added later has
                           nothing stored and must not be left waiting behind a
                           copy that was filled in yesterday. */
                        existing.updatedAt = Math.min(existing.updatedAt, player.rustHoursUpdatedAt || 0);
                        continue;
                    }

                    byPlayerId.set(key, {
                        playerId: key,
                        bmInstance: bmInstance,
                        updatedAt: player.rustHoursUpdatedAt || 0,
                        rows: [{ guildId, instance, player }]
                    });
                }
            }
        }

        const candidates = [];
        for (const candidate of byPlayerId.values()) {
            if ((now - candidate.updatedAt) < HOURS_REFRESH_INTERVAL_MS) continue;
            candidates.push(candidate);
        }

        candidates.sort((a, b) => a.updatedAt - b.updatedAt);

        return candidates;
    },

    /**
     * Fill in lifetime Rust hours for the stalest few tracked players.
     *
     * One Battlemetrics request per player, HOURS_MAX_PER_CYCLE of them per
     * cycle, so this adds a constant trickle to the shared request queue rather
     * than scaling with the roster: 40 tracked players simply take 40 cycles to
     * populate the first time, and after that each is refreshed about once a
     * day.
     *
     * A profile that answers with nothing — private, or a key whose plan does
     * not cover the endpoint — has its timestamp stamped anyway. That is what
     * stops the same dead id from consuming the cycle's whole budget forever,
     * at the cost of one wasted request per player per refresh interval.
     */
    runPlaytimePass: async function (client) {
        if (HOURS_REFRESH_INTERVAL_MS === 0 || HOURS_MAX_PER_CYCLE === 0) return;

        const candidates = module.exports.collectPlaytimeCandidates(client);
        if (candidates.length === 0) return;

        const dirtyGuilds = new Map();
        let budget = HOURS_MAX_PER_CYCLE;

        for (const candidate of candidates) {
            if (budget <= 0) break;
            budget -= 1;

            let hours = null;
            try {
                hours = await candidate.bmInstance.getRustLifetimeHours(candidate.playerId);
            }
            catch (e) {
                /* Treated exactly like an empty answer: stamp the attempt and
                   move on, so a persistent failure costs one request per
                   interval instead of one per cycle. */
                client.log(client.intlGet(null, 'warningCap'),
                    `Could not read Rust playtime for Battlemetrics player ${candidate.playerId}: ${e.message}`,
                    'warning');
            }

            /* A 200 that carries no playtime is the normal answer for a private
               profile, so it must not log per player. "Every request, forever,
               and not one success" is a different thing entirely: it means the
               response shape changed under us — the request asks for a sparse
               fieldset (fields[server]=name) and the parser gates on the game
               relationship and meta.timePlayed surviving it. That failure is
               otherwise completely silent, because a non-200 is logged by
               Battlemetrics#logRequestFailure and a throw is logged above,
               while this path is neither: hours stays null, the timestamp is
               stamped anyway, and every hours column stays blank forever. */
            if (hours === null) {
                _playtimeConsecutiveEmpty += 1;
                if (!_playtimeEverSucceeded && !_warnedPlaytimeUnavailable &&
                    _playtimeConsecutiveEmpty >= PLAYTIME_EMPTY_WARN_THRESHOLD) {
                    _warnedPlaytimeUnavailable = true;
                    client.log(client.intlGet(null, 'warningCap'),
                        client.intlGet(null, 'battlemetricsPlaytimeUnavailable', {
                            count: _playtimeConsecutiveEmpty
                        }), 'warning');
                }
            }
            else {
                _playtimeEverSucceeded = true;
                _playtimeConsecutiveEmpty = 0;
                _warnedPlaytimeUnavailable = false;
            }

            const stampedAt = Date.now();
            for (const row of candidate.rows) {
                /* Only overwrite a known figure with another known figure — a
                   failed refresh should leave yesterday's number on the card
                   rather than blanking it. */
                if (hours !== null) row.player.rustHours = hours;
                row.player.rustHoursUpdatedAt = stampedAt;
                dirtyGuilds.set(row.guildId, row.instance);
            }
        }

        for (const [guildId, instance] of dirtyGuilds) client.setInstance(guildId, instance);
    },

    /**
     * The entire Steam surface of the tracker loop. Tries to turn unresolved
     * SteamIDs into Battlemetrics player ids, cheapest route first:
     *
     *   A. the stored name against the live roster — free, no request at all;
     *   B. Steam, once per cycle at most and never more often than
     *      STEAM_RESOLVE_INTERVAL_MS process-wide;
     *   C. Battlemetrics, roster then search (which also finds players who have
     *      been offline for the whole bot run).
     *
     * A player who fails for a real reason backs off exponentially from 30 min
     * to a 24 h ceiling, so a SteamID that will never resolve costs a handful of
     * requests on its first day and one a day after that. Deferring for lack of
     * budget, and an outage at either end, must not count as an attempt.
     */
    /**
     * A Battlemetrics instance that has never seen its server before reports the
     * entire online population as newPlayers on its first evaluation. That is
     * the truth for a bot that just started, and a lie for a tracker the
     * operator merely un-paused — un-pausing drops and re-creates the instance,
     * and the burst that followed was one Discord post and one in-game line per
     * tracked player who happened to be online, all reporting logins that never
     * happened. Such an instance is marked at construction; this consumes the
     * mark for exactly one cycle. The snapshot, the roster sync and the tracker
     * card all still run.
     *
     * Only a poll that actually produced a roster may consume it: a failed first
     * poll stores the instance with no players at all, and spending the mark on
     * that cycle would leave the first SUCCESSFUL evaluation — the one that
     * really does report everyone as new — free to fire the burst.
     *
     * @param {object} client The Discord client.
     * @return {Set<string>} The Battlemetrics ids whose notifications to skip.
     */
    consumeSuppressionFlags: function (client) {
        const fresh = new Set();

        for (const [bmId, bmInstance] of Object.entries(client.battlemetricsInstances)) {
            if (!bmInstance || !bmInstance.suppressNotifications) continue;
            if (!bmInstance.lastUpdateSuccessful) continue;

            bmInstance.suppressNotifications = false;
            fresh.add(bmId);
        }

        return fresh;
    },

    runResolutionPass: async function (client) {
        const now = Date.now();
        const candidates = module.exports.collectResolutionCandidates(client);
        if (candidates.length === 0) return;

        let bmBudget = RESOLVE_MAX_BM_LOOKUPS_PER_CYCLE;
        let steamBudget = (now - _lastBackgroundSteamAt) >= STEAM_RESOLVE_INTERVAL_MS ? 1 : 0;
        /* How many candidates may spend a request this cycle. The free roster
           match below runs for everyone regardless — it is a comparison against
           a map we already hold, so metering it only delays resolutions that
           cost nothing. */
        let examineBudget = RESOLVE_MAX_PER_CYCLE;
        /* The same person can be tracked from several trackers or guilds; one
           Steam request answers for all of them. */
        const scrapedThisPass = new Map();
        const dirtyGuilds = new Map();
        /* The free match now runs for every unresolved row, including the ones
           in backoff, so the roster is indexed once per pass instead of being
           re-normalised per row. */
        const rosterIndexes = new Map();

        for (const candidate of candidates) {
            const { tracker, player, bmInstance } = candidate;
            let steamCalled = false;
            let bmCalled = false;
            let apiFailed = false;
            let scraped = null;

            /* A. Free: whatever name we already store, minus the clanTag. */
            let base = module.exports._isPlaceholderName(player) ?
                null : module.exports._stripClanTag(player.name, tracker.clanTag);

            let rosterIndex = rosterIndexes.get(tracker.battlemetricsId);
            if (rosterIndex === undefined) {
                rosterIndex = PlayerSearch.buildRosterIndex(bmInstance);
                rosterIndexes.set(tracker.battlemetricsId, rosterIndex);
            }

            let id = base ? PlayerSearch.matchRosterName(bmInstance, base, rosterIndex) : null;

            /* Everything past this point costs a request, so it is only for
               candidates that are out of backoff and still within the cycle's
               examination budget. */
            const mayRequest = !id && candidate.eligible && examineBudget > 0;
            if (mayRequest) examineBudget -= 1;

            /* B. Steam — the bootstrap, and nothing else. It is asked only when
                  we have no usable name to search Battlemetrics with: a stored
                  persona is exactly what step C wants, so re-scraping it would
                  spend the one slot the design allows per interval on a name we
                  already hold, and defer the player who has none. A row that
                  has failed repeatedly is allowed one refresh, because a stale
                  stored name is the one case where the name we hold is the
                  reason the search keeps missing. */
            const nameIsStale = (player.resolveAttempts || 0) >= RESOLVE_STEAM_REFRESH_AFTER;
            if (mayRequest && (!base || nameIsStale) && bmBudget > 0) {
                if (scrapedThisPass.has(player.steamId)) {
                    scraped = scrapedThisPass.get(player.steamId);
                }
                else {
                    /* A cached name costs no request, so it must not close the
                       process-wide gate — doing that let a pass that made zero
                       HTTP calls lock out the player who genuinely needed one
                       for another whole interval. The stale-name refresh is the
                       exception: reading the cache there would hand back the
                       very name we already suspect, so it goes to the network. */
                    const cached = nameIsStale ? undefined :
                        Scrape.getCachedSteamProfileName(player.steamId);
                    if (cached !== undefined) {
                        scraped = cached;
                        scrapedThisPass.set(player.steamId, scraped);
                    }
                    else if (steamBudget > 0) {
                        steamBudget -= 1;
                        _lastBackgroundSteamAt = Date.now();
                        steamCalled = true;
                        scraped = await Scrape.scrapeSteamProfileName(client, player.steamId,
                            { cache: true, refresh: nameIsStale });
                        scrapedThisPass.set(player.steamId, scraped);
                    }
                }
                if (scraped) base = Utils.normalizePlayerName(scraped);
            }

            /* C. Battlemetrics. */
            if (mayRequest && !id && base && bmBudget > 0) {
                bmBudget -= 1;
                bmCalled = true;
                const resolved = await PlayerSearch.resolveIdByName(bmInstance, tracker.battlemetricsId, base);
                id = resolved.id;
                apiFailed = resolved.apiFailed;
            }

            if (id) {
                /* Never point two rows of the same tracker at one Battlemetrics
                   player: the login/logout loops and the activity snapshot both
                   walk `tracker.players`, so a duplicate doubles every
                   notification and every activity_log sample — which in turn
                   double-weights that human in the off-hours raid alarm. The
                   add paths only dedupe on SteamID, so the same person added
                   once by SteamID and once by Battlemetrics id lands here. */
                const duplicate = tracker.players.some(p => p !== player && `${p.playerId}` === `${id}`);
                if (duplicate) {
                    const key = `${candidate.guildId}:${candidate.trackerId}:${player.steamId}`;
                    if (!_warnedDuplicateLinks.has(key)) {
                        _warnedDuplicateLinks.add(key);
                        client.log(client.intlGet(null, 'warningCap'),
                            `Tracker #${candidate.trackerId}: ${player.steamId} resolves to Battlemetrics ` +
                            `player ${id}, which this tracker already tracks — leaving the duplicate row ` +
                            `unlinked. Remove one of the two entries.`);
                    }
                    continue;
                }

                player.playerId = id;
                const bmName = bmInstance && bmInstance.players[id] && bmInstance.players[id].name;
                player.name = module.exports._composeName(tracker.clanTag, bmName || base);
                player.resolveAttempts = 0;
                player.resolveNextAttemptAt = 0;
                if (steamCalled && scraped) player.steamNameLastScrapedAt = Date.now();
                dirtyGuilds.set(candidate.guildId, candidate.instance);

                client.log(client.intlGet(null, 'infoCap'),
                    `Tracker #${candidate.trackerId}: resolved ${player.steamId} to ` +
                    `Battlemetrics player ${id} (${player.name})`);
                continue;
            }

            /* Only a definitive negative counts against the player. A
               Battlemetrics outage is not one — that is what `apiFailed` is
               for, and burning the attempt anyway pushed perfectly resolvable
               players into hours of backoff for a failure that was not theirs.
               A Steam call that came back empty does count, but only when it
               was the sole thing asked: that is the "we asked the one source
               that could identify this id and got nothing" case, and letting it
               off would leave a dead SteamID hogging the global Steam slot
               every interval forever. */
            const attempted = (bmCalled && !apiFailed) || (steamCalled && !bmCalled);
            if (!attempted) continue;

            /* The exponent is clamped so Math.pow cannot run away on a
               years-old instance file, and the jitter — which keeps a batch of
               players added together from retrying in lockstep — is applied
               before the ceiling, not after, so the ceiling is a real one. */
            const attempts = (player.resolveAttempts || 0) + 1;
            const raw = RESOLVE_BACKOFF_BASE_MS * Math.pow(2, Math.min(attempts, 10) - 1);
            const backoff = Math.min(Math.round(raw * (0.9 + Math.random() * 0.2)), RESOLVE_BACKOFF_MAX_MS);
            player.resolveAttempts = attempts;
            player.resolveNextAttemptAt = Date.now() + backoff;
            if (steamCalled && scraped) player.steamNameLastScrapedAt = Date.now();
            dirtyGuilds.set(candidate.guildId, candidate.instance);

            client.log(client.intlGet(null, 'warningCap'),
                `Tracker #${candidate.trackerId}: could not link ${player.steamId} to a Battlemetrics ` +
                `player (attempt ${attempts}, next in ${Math.round(backoff / 60000)} min)`);
        }

        for (const [guildId, instance] of dirtyGuilds) client.setInstance(guildId, instance);
    },
}