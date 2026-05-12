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

const ACTIVITY_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STEAM_NAME_REFRESH_MS = 24 * 60 * 60 * 1000;
const RAID_ALERT_RATIO = 0.6;
const RAID_ALERT_OFF_HOUR_THRESHOLD = 20; /* percent — below this, the group hour counts as "off" */
const RAID_ALERT_COOLDOWN_MS = 30 * 60 * 1000; /* don't refire within 30 min */
let _lastActivityRecomputeAt = 0;

module.exports = {
    handler: async function (client, firstTime = false) {
        const searchSteamProfiles = (client.battlemetricsIntervalCounter === 0) ? true : false;
        const calledSteamProfiles = new Object();

        if (!firstTime) await client.updateBattlemetricsInstances();

        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            const rustplus = client.rustplusInstances[guildId];

            if (!firstTime) await module.exports.handleBattlemetricsChanges(client, guildId);

            /* If a previous version of the bot left a "BM all online players"
               info-channel message around, sweep it once on next poll. */
            if (instance.informationMessageId.battlemetricsPlayers) {
                await DiscordTools.deleteMessageById(guildId, instance.channelId.information,
                    instance.informationMessageId.battlemetricsPlayers);
                instance.informationMessageId.battlemetricsPlayers = null;
                client.setInstance(guildId, instance);
            }

            for (const [trackerId, content] of Object.entries(instance.trackers)) {
                const battlemetricsId = content.battlemetricsId;
                const bmInstance = client.battlemetricsInstances[battlemetricsId];

                if (!bmInstance || !bmInstance.lastUpdateSuccessful) continue;

                /* Snapshot every tracked player's current online state into
                   activity_log. This is the foundation for the typical-play-hours
                   hint and the off-hours raid alarm. Cheap insert per player. */
                const trackedIds = content.players.map(p => p.playerId).filter(Boolean);
                let onlineNowCount = 0;
                if (trackedIds.length > 0) {
                    const onlineSet = new Set(bmInstance.onlinePlayers.map(String));
                    ActivityDb.logSnapshot(trackedIds, onlineSet, Math.floor(Date.now() / 1000));
                    onlineNowCount = trackedIds.filter(id => onlineSet.has(String(id))).length;
                }

                /* Off-hours raid alarm: if the group's typical online rate at
                   the current local hour is below the off-hours threshold AND
                   at least 60% of the tracker is online right now, fire once
                   (with a cooldown so we don't spam during a sustained event). */
                if (content.raidAlert && trackedIds.length >= 2 && !firstTime) {
                    const ratio = onlineNowCount / trackedIds.length;
                    if (ratio >= RAID_ALERT_RATIO) {
                        const now = new Date();
                        const dow = now.getDay();
                        const hour = now.getHours();
                        if (ActivityDb.isOffHourForGroup(trackedIds, dow, hour, RAID_ALERT_OFF_HOUR_THRESHOLD)) {
                            const nowSec = Math.floor(Date.now() / 1000);
                            const last = ActivityDb.getLastAlertAt(`${guildId}:${trackerId}`);
                            if ((nowSec - last) * 1000 >= RAID_ALERT_COOLDOWN_MS) {
                                ActivityDb.setLastAlertAt(`${guildId}:${trackerId}`, nowSec);
                                await module.exports.fireRaidAlert(client, guildId, trackerId,
                                    content, onlineNowCount, trackedIds.length);
                            }
                        }
                    }
                }

                /* Steam profile names rarely change. Scrape only when:
                     - the per-player record has never been scraped, OR
                     - it's been more than STEAM_NAME_REFRESH_MS since the last scrape.
                   Bot startup (`firstTime`) seeds names for any player that was added
                   before this field existed. */
                if (firstTime || searchSteamProfiles) {
                    const nowMs = Date.now();
                    for (const player of content.players) {
                        if (player.steamId === null) continue;

                        const lastAt = player.steamNameLastScrapedAt || 0;
                        if (!firstTime && (nowMs - lastAt) < STEAM_NAME_REFRESH_MS) continue;

                        let name = null;
                        if (calledSteamProfiles.hasOwnProperty(player.steamId)) {
                            name = calledSteamProfiles[player.steamId];
                        }
                        else {
                            name = await Scrape.scrapeSteamProfileName(client, player.steamId);
                            calledSteamProfiles[player.steamId] = name;
                        }
                        if (name === null) continue;

                        player.steamNameLastScrapedAt = nowMs;
                        name = (content.clanTag !== '' ? `${content.clanTag} ` : '') + `${name}`;

                        if (player.name !== name) {
                            await module.exports.trackerNewNameDetected(client, guildId, trackerId, battlemetricsId,
                                player.name, name);

                            const newPlayerId = Object.keys(bmInstance.players)
                                .find(e => bmInstance.players[e]['name'] === name);
                            player.playerId = newPlayerId ? newPlayerId : null;
                            player.name = name;
                        }
                    }

                    client.setInstance(guildId, instance);

                    if (firstTime) {
                        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                        continue;
                    }
                }

                const trackerPlayerIds = content.players.map(e => e.playerId);

                /* Check if Player just changed name */
                for (const player of bmInstance.nameChangedPlayers.filter(e => trackerPlayerIds.includes(e.id))) {
                    for (const playerT of content.players) {
                        if (playerT.playerId !== player.id) continue;

                        await module.exports.trackerNewNameDetected(client, guildId, trackerId, battlemetricsId,
                            player.from, player.to);
                    }
                }

                /* Check if Player just came online */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.newPlayers.includes(e))) {
                    for (const player of content.players) {
                        if (player.playerId !== playerId) continue;

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
                }

                /* Check if Player just came online */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.loginPlayers.includes(e))) {
                    for (const player of content.players) {
                        if (player.playerId !== playerId) continue;

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
                }

                /* Check if Player just went offline */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.logoutPlayers.includes(e))) {
                    for (const player of content.players) {
                        if (player.playerId !== playerId) continue;

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
                }

                client.setInstance(guildId, instance);

                await DiscordMessages.sendTrackerMessage(guildId, trackerId);
            }
        }

        if (client.battlemetricsIntervalCounter === 29) {
            client.battlemetricsIntervalCounter = 0;
        }
        else {
            client.battlemetricsIntervalCounter += 1;
        }

        /* Aggregate the last 30 days into the (player, dow, hour) pattern grid
           once per day, and purge anything older than 30 days. */
        const nowMs = Date.now();
        if (nowMs - _lastActivityRecomputeAt >= ACTIVITY_RECOMPUTE_INTERVAL_MS) {
            try {
                ActivityDb.purgeOld(30);
                ActivityDb.recomputePatterns(30);
            }
            catch (e) {
                client.log(client.intlGet(null, 'errorCap'),
                    `ActivityDb recompute failed: ${e.message}`, 'error');
            }
            _lastActivityRecomputeAt = nowMs;
        }
    },

    handleBattlemetricsChanges: async function (client, guildId) {
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
            const battlemetricsId = content.battlemetricsId;
            const bmInstance = client.battlemetricsInstances[battlemetricsId];

            if (!bmInstance || (bmInstance && !bmInstance.lastUpdateSuccessful)) continue;
            if (battlemetricsIds.includes(battlemetricsId)) continue;

            battlemetricsIds.push(battlemetricsId);
        }

        /* Go through each battlemetrics instance and notify changes */
        for (const battlemetricsId of battlemetricsIds) {
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
                    description = client.intlGet(interaction.guildId, 'andMorePlayers', {
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
                    const name = bmInstance.players[playerId]['name'].replace('[', '(').replace(']', ')');
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
                    description = client.intlGet(interaction.guildId, 'andMorePlayers', {
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
                    const name = bmInstance.players[playerId]['name'].replace('[', '(').replace(']', ')');
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
                    description = client.intlGet(interaction.guildId, 'andMorePlayers', {
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
}