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

const Discord = require('discord.js');

const Client = require('../../index.ts');
const Constants = require('../util/constants.js');
const DiscordTools = require('./discordTools.js');
const InstanceUtils = require('../util/instanceUtils.js');
const Timer = require('../util/timer');
const ActivityDb = require('../util/activityDb.js');

function isValidUrl(url) {
    if (url.startsWith('https') || url.startsWith('http')) return true;
    return false;
}

module.exports = {
    getEmbed: function (options = {}) {
        const embed = new Discord.EmbedBuilder();

        if (options.hasOwnProperty('title')) embed.setTitle(options.title);
        if (options.hasOwnProperty('color')) embed.setColor(options.color);
        if (options.hasOwnProperty('description')) embed.setDescription(options.description);
        if (options.hasOwnProperty('thumbnail') && options.thumbnail !== '') embed.setThumbnail(options.thumbnail);
        if (options.hasOwnProperty('image')) embed.setImage(options.image);
        if (options.hasOwnProperty('url') && options.url !== '') embed.setURL(options.url);
        if (options.hasOwnProperty('author')) embed.setAuthor(options.author);
        if (options.hasOwnProperty('footer')) embed.setFooter(options.footer);
        if (options.hasOwnProperty('timestamp')) embed.setTimestamp();
        if (options.hasOwnProperty('fields')) embed.setFields(...options.fields);

        return embed;
    },

    getSmartSwitchEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].switches[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: `${entity.name}${grid}`,
            color: entity.active ? Constants.COLOR_ACTIVE : Constants.COLOR_INACTIVE,
            description: `**ID**: \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            fields: [{
                name: Client.client.intlGet(guildId, 'customCommand'),
                value: `\`${instance.generalSettings.prefix}${entity.command}\``,
                inline: true
            }],
            timestamp: true
        });
    },

    getServerEmbed: async function (guildId, serverId) {
        const instance = Client.client.getInstance(guildId);
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        const server = instance.serverList[serverId];
        let hoster = Client.client.intlGet(guildId, 'unknown');
        if (credentials.hasOwnProperty(server.steamId)) {
            const hosterUser = await DiscordTools.getUserById(guildId, credentials[server.steamId].discord_user_id);
            if (hosterUser) hoster = hosterUser.user.username;
        }

        let description = '';
        if (server.battlemetricsId !== null) {
            const bmId = server.battlemetricsId;
            const bmIdLink = `[${bmId}](${Constants.BATTLEMETRICS_SERVER_URL}${bmId})`;
            description += `__**${Client.client.intlGet(guildId, 'battlemetricsId')}:**__ ${bmIdLink}\n`;

            const bmInstance = Client.client.battlemetricsInstances[bmId];
            if (bmInstance) {
                description += `__**${Client.client.intlGet(guildId, 'streamerMode')}:**__ `;
                description += (bmInstance.streamerMode ? Client.client.intlGet(guildId, 'onCap') :
                    Client.client.intlGet(guildId, 'offCap')) + '\n';
            }
        }
        description += `\n${server.description}`;

        const fields = [{
            name: Client.client.intlGet(guildId, 'connect'),
            value: `\`${server.connect === null ?
                Client.client.intlGet(guildId, 'unavailable') : server.connect}\``,
            inline: true
        },
        {
            name: Client.client.intlGet(guildId, 'hoster'),
            value: `\`${hoster} (${server.steamId})\``,
            inline: false
        }];

        if (server.battlemetricsId !== null &&
            instance.generalSettings.displayInformationBattlemetricsUpcomingWipes) {
            const bmInstance = Client.client.battlemetricsInstances[server.battlemetricsId];
            if (bmInstance && bmInstance.rustWipes) {
                const upcomingWipes = bmInstance.getUpcomingWipesOrderedByTime();
                const mapWipe = upcomingWipes.find(e => e.type === 'map');
                const fullWipe = upcomingWipes.find(e => e.type === 'full');

                if (mapWipe || fullWipe) {
                    if (mapWipe) {
                        fields.push({
                            name: Client.client.intlGet(guildId, 'nextMapWipe'),
                            value: `<t:${Math.floor(mapWipe.discordTimestamp)}:R>`,
                            inline: true
                        });
                    }
                    if (fullWipe) {
                        fields.push({
                            name: Client.client.intlGet(guildId, 'nextFullWipe'),
                            value: `<t:${Math.floor(fullWipe.discordTimestamp)}:R>`,
                            inline: true
                        });
                    }
                }
                else if (upcomingWipes.length > 0) {
                    fields.push({
                        name: Client.client.intlGet(guildId, 'nextWipe'),
                        value: `<t:${Math.floor(upcomingWipes[0].discordTimestamp)}:R>`,
                        inline: true
                    });
                }
            }
        }

        return module.exports.getEmbed({
            title: `${server.title}`,
            color: Constants.COLOR_DEFAULT,
            description: description,
            thumbnail: `${server.img}`,
            fields: fields
        });
    },

    getTrackerEmbed: function (guildId, trackerId) {
        const instance = Client.client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        const battlemetricsId = tracker.battlemetricsId;
        const bmInstance = Client.client.battlemetricsInstances[battlemetricsId];

        const successful = bmInstance && bmInstance.lastUpdateSuccessful ? true : false;
        const active = tracker.active !== false;

        const battlemetricsLink = `[${battlemetricsId}](${Constants.BATTLEMETRICS_SERVER_URL}${battlemetricsId})`;

        /* Count how many tracked players are online right now, and use that to
           drive the "Server Status" light: green if anyone in the group is in
           the server, red if the whole group is offline. This is more useful
           than reflecting the raw server up/down state, which is rarely the
           thing you care about when watching a tracker. */
        let onlineCount = 0;
        const totalCount = tracker.players.length;
        if (successful) {
            for (const p of tracker.players) {
                if (!p.playerId) continue;
                const bmPlayer = bmInstance.players[p.playerId];
                if (bmPlayer && bmPlayer.status) onlineCount += 1;
            }
        }
        const serverStatus = !successful ? Constants.NOT_FOUND_EMOJI :
            (onlineCount > 0 ? Constants.ONLINE_EMOJI : Constants.OFFLINE_EMOJI);

        let description = `__**Battlemetrics ID:**__ ${battlemetricsLink}\n`;
        description += `__**${Client.client.intlGet(guildId, 'tracking')}:**__ ` +
            (active ? Client.client.intlGet(guildId, 'activeCap') :
                `${Client.client.intlGet(guildId, 'pausedCap')} ⏸️`) + '\n';
        description += `__**${Client.client.intlGet(guildId, 'serverId')}:**__ ${tracker.serverId}\n`;
        description += `__**${Client.client.intlGet(guildId, 'serverStatus')}:**__ ${serverStatus}\n`;
        description += `__**${Client.client.intlGet(guildId, 'streamerMode')}:**__ `;
        description += (!bmInstance ? Constants.NOT_FOUND_EMOJI : (bmInstance.streamerMode ?
            Client.client.intlGet(guildId, 'onCap') : Client.client.intlGet(guildId, 'offCap'))) + '\n';
        description += `__**${Client.client.intlGet(guildId, 'groupOnline')}:**__ ${onlineCount}/${totalCount}`;

        /* Group active-hours hint (averaged across all players with enough samples). */
        const groupPlayerIds = tracker.players.map(p => p.playerId).filter(Boolean);
        const groupHint = ActivityDb.getGroupActiveHint(groupPlayerIds);
        if (groupHint) {
            description += `\n__**${Client.client.intlGet(guildId, 'groupActive')}:**__ ${groupHint}`;
        }

        let totalCharacters = description.length;
        let fieldIndex = 0
        let playerName = [''], playerStatus = [''];
        let playerNameCharacters = 0, playerStatusCharacters = 0;
        for (const player of tracker.players) {
            /* Plain name (not a link) + small markdown links to BM/Steam profiles.
               Layout: `Name  [B](bmUrl) [S](steamUrl)`. Either link is omitted
               if the corresponding ID is missing. */
            const nameMaxLength = Constants.EMBED_FIELD_MAX_WIDTH_LENGTH_3;
            const rawName = `${player.name || '-'}`;
            const displayName = rawName.length <= nameMaxLength
                ? rawName : rawName.substring(0, nameMaxLength - 2) + '..';

            const links = [];
            if (player.playerId !== null && player.playerId !== undefined) {
                links.push(`[B](${Constants.BATTLEMETRICS_PROFILE_URL}${player.playerId})`);
            }
            if (player.steamId !== null && player.steamId !== undefined) {
                links.push(`[S](https://steamcommunity.com/profiles/${player.steamId})`);
            }
            const nameLine = links.length
                ? `${displayName}  ${links.join(' ')}\n`
                : `${displayName}\n`;

            let status = '';
            if (!successful || !bmInstance.players.hasOwnProperty(player.playerId)) {
                status += `${Constants.NOT_FOUND_EMOJI}\n`;
            }
            else {
                let time = null;
                if (bmInstance.players[player.playerId]['status']) {
                    time = bmInstance.getOnlineTime(player.playerId);
                    status += `${Constants.ONLINE_EMOJI}`;
                }
                else {
                    time = bmInstance.getOfflineTime(player.playerId);
                    status += `${Constants.OFFLINE_EMOJI}`;
                }
                status += time !== null ? ` [${time[1]}]` : '';
                /* Per-player active-hours hint moved to the Report button —
                   the inline tracker UI now only shows the group-level
                   typical-play window so the list stays scannable. */
                status += '\n';
            }

            if (totalCharacters + (nameLine.length + status.length) >= Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                break;
            }

            if ((playerNameCharacters + nameLine.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                (playerStatusCharacters + status.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                fieldIndex += 1;
                playerName.push('');
                playerStatus.push('');
                playerNameCharacters = 0;
                playerStatusCharacters = 0;
            }

            playerNameCharacters += nameLine.length;
            playerStatusCharacters += status.length;
            totalCharacters += nameLine.length + status.length;

            playerName[fieldIndex] += nameLine;
            playerStatus[fieldIndex] += status;
        }

        const fields = [];
        for (let i = 0; i < (fieldIndex + 1); i++) {
            /* Discord lays inline fields in rows of up to 3. Padding each page
               with a 3rd empty inline field makes every page consume exactly
               one row, so pages stack vertically without the tall non-inline
               spacer that used to leave a visible gap. */
            fields.push({
                name: i === 0 ? `__${Client.client.intlGet(guildId, 'name')}__\n\u200B` : '\u200B',
                value: playerName[i] !== '' ? playerName[i] : Client.client.intlGet(guildId, 'empty'),
                inline: true
            });
            fields.push({
                name: i === 0 ? `__${Client.client.intlGet(guildId, 'status')}__\n\u200B` : '\u200B',
                value: playerStatus[i] !== '' ? playerStatus[i] : Client.client.intlGet(guildId, 'empty'),
                inline: true
            });
            fields.push({ name: '\u200B', value: '\u200B', inline: true });
        }

        return module.exports.getEmbed({
            title: `${tracker.name}`,
            color: Constants.COLOR_DEFAULT,
            description: description,
            thumbnail: `${tracker.img}`,
            footer: { text: `${tracker.title}` },
            fields: fields,
            timestamp: true
        });
    },

    getSmartAlarmEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].alarms[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';
        let description = `**ID**: \`${entityId}\`\n`;
        description += `**${Client.client.intlGet(guildId, 'lastTrigger')}:** `;

        if (entity.lastTrigger !== null) {
            const lastTriggerDate = new Date(entity.lastTrigger * 1000);
            const timeSinceTriggerSeconds = Math.floor((new Date() - lastTriggerDate) / 1000);
            const time = Timer.secondsToFullScale(timeSinceTriggerSeconds);
            description += `${time}`;
        }

        return module.exports.getEmbed({
            title: `${entity.name}${grid}`,
            color: entity.active ? Constants.COLOR_ACTIVE : Constants.COLOR_DEFAULT,
            description: description,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            fields: [{
                name: Client.client.intlGet(guildId, 'message'),
                value: `\`${entity.message}\``,
                inline: true
            }, {
                name: Client.client.intlGet(guildId, 'customCommand'),
                value: `\`${instance.generalSettings.prefix}${entity.command}\``,
                inline: false
            }],
            timestamp: true
        });
    },

    getStorageMonitorEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].storageMonitors[entityId];
        const rustplus = Client.client.rustplusInstances[guildId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        let description = `**ID** \`${entityId}\``;

        if (!rustplus) {
            return module.exports.getEmbed({
                title: `${entity.name}${grid}`,
                color: Constants.COLOR_DEFAULT,
                description: `${description}\n${Client.client.intlGet(guildId, 'statusNotConnectedToServer')}`,
                thumbnail: `attachment://${entity.image}`,
                footer: { text: `${entity.server}` },
                timestamp: true
            });
        }

        if (rustplus && rustplus.storageMonitors[entityId].capacity === 0) {
            return module.exports.getEmbed({
                title: `${entity.name}${grid}`,
                color: Constants.COLOR_DEFAULT,
                description:
                    `${description}\n${Client.client.intlGet(guildId, 'statusNotElectronicallyConnected')}`,
                thumbnail: `attachment://${entity.image}`,
                footer: { text: `${entity.server}` },
                timestamp: true
            });
        }

        description += `\n**${Client.client.intlGet(guildId, 'type')}** ` +
            `\`${entity.type !== null ? Client.client.intlGet(guildId, entity.type) :
                Client.client.intlGet(guildId, 'unknown')}\``;

        const items = rustplus.storageMonitors[entityId].items;
        const expiry = rustplus.storageMonitors[entityId].expiry;
        const capacity = rustplus.storageMonitors[entityId].capacity;

        description += `\n**${Client.client.intlGet(guildId, 'slots')}** `;
        description += `\`(${items.length}/${capacity})\``

        if (entity.type === 'toolCupboard') {
            let seconds = 0;
            if (expiry !== 0) {
                seconds = (new Date(expiry * 1000) - new Date()) / 1000;
            }

            let upkeep = null;
            if (seconds === 0) {
                upkeep = `:warning:\`${Client.client.intlGet(guildId, 'decayingCap')}\`:warning:`;
                instance.serverList[serverId].storageMonitors[entityId].upkeep =
                    Client.client.intlGet(guildId, 'decayingCap');
            }
            else {
                let upkeepTime = Timer.secondsToFullScale(seconds);
                upkeep = `\`${upkeepTime}\``;
                instance.serverList[serverId].storageMonitors[entityId].upkeep = `${upkeepTime}`;
            }
            description += `\n**${Client.client.intlGet(guildId, 'upkeep')}** ${upkeep}`;
            Client.client.setInstance(guildId, instance);
        }

        let itemName = '', itemQuantity = '', storageItems = new Object();
        for (const item of items) {
            if (storageItems.hasOwnProperty(item.itemId)) {
                storageItems[item.itemId] += item.quantity;
            }
            else {
                storageItems[item.itemId] = item.quantity;
            }
        }

        for (const [id, quantity] of Object.entries(storageItems)) {
            itemName += `\`${Client.client.items.getName(id)}\`\n`;
            itemQuantity += `\`${quantity}\`\n`;
        }

        if (itemName === '') itemName = Client.client.intlGet(guildId, 'empty');
        if (itemQuantity === '') itemQuantity = Client.client.intlGet(guildId, 'empty');

        return module.exports.getEmbed({
            title: `${entity.name}${grid}`,
            color: Constants.COLOR_DEFAULT,
            description: description,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            fields: [
                { name: Client.client.intlGet(guildId, 'item'), value: itemName, inline: true },
                { name: Client.client.intlGet(guildId, 'quantity'), value: itemQuantity, inline: true }
            ],
            timestamp: true
        });
    },

    getSmartSwitchGroupEmbed: function (guildId, serverId, groupId) {
        const instance = Client.client.getInstance(guildId);
        const group = instance.serverList[serverId].switchGroups[groupId];

        let switchName = '', switchId = '', switchActive = '';
        for (const groupSwitchId of group.switches) {
            if (instance.serverList[serverId].switches.hasOwnProperty(groupSwitchId)) {
                const sw = instance.serverList[serverId].switches[groupSwitchId];
                const active = sw.active;
                switchName += `${sw.name}${sw.location !== null ? ` ${sw.location}` : ''}\n`;
                switchId += `${groupSwitchId}\n`;
                if (sw.reachable) {
                    switchActive += `${(active) ? Constants.ONLINE_EMOJI : Constants.OFFLINE_EMOJI}\n`;
                }
                else {
                    switchActive += `${Constants.NOT_FOUND_EMOJI}\n`;
                }
            }
            else {
                instance.serverList[serverId].switchGroups[groupId].switches =
                    instance.serverList[serverId].switchGroups[groupId].switches.filter(e => e !== groupSwitchId);
            }
        }
        Client.client.setInstance(guildId, instance);

        if (switchName === '') switchName = Client.client.intlGet(guildId, 'none');
        if (switchId === '') switchId = Client.client.intlGet(guildId, 'none');
        if (switchActive === '') switchActive = Client.client.intlGet(guildId, 'none');

        const fields = [
            {
                name: Client.client.intlGet(guildId, 'customCommand'),
                value: `\`${instance.generalSettings.prefix}${group.command}\``,
                inline: false
            }
        ];

        if (group.alarmId) {
            const alarm = instance.serverList[serverId].alarms[group.alarmId];
            const alarmName = alarm ? alarm.name : `ID: ${group.alarmId}`;
            const current = group.alarmCurrentCount || 0;
            const required = group.alarmTriggerCount || 5;
            fields.push({
                name: 'Linked Alarm',
                value: `${alarmName} (${current}/${required})`,
                inline: false
            });
        }

        fields.push(
            { name: Client.client.intlGet(guildId, 'switches'), value: switchName, inline: true },
            { name: 'ID', value: switchId, inline: true },
            { name: Client.client.intlGet(guildId, 'status'), value: switchActive, inline: true }
        );

        return module.exports.getEmbed({
            title: group.name,
            color: Constants.COLOR_DEFAULT,
            description: `**ID**: \`${groupId}\``,
            thumbnail: `attachment://${group.image}`,
            footer: { text: `${instance.serverList[serverId].title}` },
            fields: fields,

            timestamp: true
        });
    },

    getNotFoundSmartDeviceEmbed: function (guildId, serverId, entityId, type) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId][type][entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: `${entity.name}${grid}`,
            color: Constants.COLOR_INACTIVE,
            description: `**ID**: \`${entityId}\`\n` +
                `${Client.client.intlGet(guildId, 'statusNotFound')} ${Constants.NOT_FOUND_EMOJI}`,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` }
        });
    },

    getStorageMonitorRecycleEmbed: function (guildId, serverId, entityId, items) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].storageMonitors[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        let itemName = '', itemQuantity = '';
        for (const item of items['recycler']) {
            itemName += `\`${Client.client.items.getName(item.itemId)}\`\n`;
            itemQuantity += `\`${item.quantity}\`\n`;
        }

        const embed = module.exports.getEmbed({
            title: `${Client.client.intlGet(guildId, 'resultRecycling')}:`,
            color: Constants.COLOR_DEFAULT,
            thumbnail: 'attachment://recycler.png',
            footer: { text: `${entity.server} | ${Client.client.intlGet(guildId, 'messageDeletedIn30')}` },
            description: `**${Client.client.intlGet(guildId, 'name')}** ` +
                `\`${entity.name}${grid}\`\n**ID** \`${entityId}\``
        });

        if (itemName === '') itemName = Client.client.intlGet(guildId, 'empty');
        if (itemQuantity === '') itemQuantity = Client.client.intlGet(guildId, 'empty');

        embed.addFields(
            { name: Client.client.intlGet(guildId, 'item'), value: itemName, inline: true },
            { name: Client.client.intlGet(guildId, 'quantity'), value: itemQuantity, inline: true }
        );

        return embed;
    },

    getDecayingNotificationEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].storageMonitors[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'isDecaying', {
                device: `${entity.name}${grid}`
            }),
            color: Constants.COLOR_INACTIVE,
            description: `**ID** \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            timestamp: true
        });
    },

    getStorageMonitorDisconnectNotificationEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].storageMonitors[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'isNoLongerConnected', {
                device: `${entity.name}${grid}`
            }),
            color: Constants.COLOR_INACTIVE,
            description: `**ID** \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            timestamp: true
        });
    },

    getStorageMonitorNotFoundEmbed: async function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        const entity = server.storageMonitors[entityId];
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        const user = credentials.hasOwnProperty(server.steamId) ?
            await DiscordTools.getUserById(guildId, credentials[server.steamId].discord_user_id) : undefined;
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'smartDeviceNotFound', {
                device: `${entity.name}${grid}`,
                user: user ? user.user.username : Client.client.intlGet(guildId, 'unknown')
            }),
            color: Constants.COLOR_INACTIVE,
            description: `**ID** \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            timestamp: true
        });
    },

    getSmartSwitchNotFoundEmbed: async function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        const entity = instance.serverList[serverId].switches[entityId];
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        const user = credentials.hasOwnProperty(server.steamId) ?
            await DiscordTools.getUserById(guildId, credentials[server.steamId].discord_user_id) : undefined;
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'smartDeviceNotFound', {
                device: `${entity.name}${grid}`,
                user: user ? user.user.username : Client.client.intlGet(guildId, 'unknown')
            }),
            color: Constants.COLOR_INACTIVE,
            description: `**ID** \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            timestamp: true
        });
    },

    getSmartAlarmNotFoundEmbed: async function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        const entity = server.alarms[entityId];
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        const user = credentials.hasOwnProperty(server.steamId) ?
            await DiscordTools.getUserById(guildId, credentials[server.steamId].discord_user_id) : undefined;
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'smartDeviceNotFound', {
                device: `${entity.name}${grid}`,
                user: user ? user.user.username : Client.client.intlGet(guildId, 'unknown')
            }),
            color: Constants.COLOR_INACTIVE,
            description: `**ID** \`${entityId}\``,
            thumbnail: `attachment://${entity.image}`,
            footer: { text: `${entity.server}` },
            timestamp: true
        });
    },

    getNewsEmbed: function (guildId, data) {
        return module.exports.getEmbed({
            title: `${Client.client.intlGet(guildId, 'newsCap')}: ${data.title}`,
            color: Constants.COLOR_DEFAULT,
            description: `${data.message}`,
            thumbnail: Constants.DEFAULT_SERVER_IMG,
            timestamp: true
        });
    },

    getTeamLoginEmbed: function (guildId, body, png) {
        return module.exports.getEmbed({
            color: Constants.COLOR_ACTIVE,
            timestamp: true,
            footer: { text: body.name },
            author: {
                name: Client.client.intlGet(guildId, 'userJustConnected', { name: body.targetName }),
                iconURL: (png !== null) ? png : Constants.DEFAULT_SERVER_IMG,
                url: `${Constants.STEAM_PROFILES_URL}${body.targetId}`
            }
        });
    },

    getPlayerDeathEmbed: function (data, body, png) {
        return module.exports.getEmbed({
            color: Constants.COLOR_INACTIVE,
            thumbnail: png,
            title: data.title,
            timestamp: true,
            footer: { text: body.name },
            url: body.targetId !== '' ? `${Constants.STEAM_PROFILES_URL}${body.targetId}` : ''
        });
    },

    getAlarmRaidAlarmEmbed: function (data, body) {
        return module.exports.getEmbed({
            color: Constants.COLOR_ACTIVE,
            timestamp: true,
            footer: { text: body.name },
            title: data.title,
            description: data.message,
            thumbnail: (body.img !== '' && isValidUrl(body.img)) ? body.img : 'attachment://rocket.png'
        });
    },

    getAlarmEmbed: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].alarms[entityId];
        const grid = entity.location !== null ? ` (${entity.location})` : '';

        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            thumbnail: `attachment://${entity.image}`,
            title: `${entity.name}${grid}`,
            footer: { text: entity.server },
            timestamp: true,
            fields: [
                { name: 'ID', value: `\`${entityId}\``, inline: true },
                { name: Client.client.intlGet(guildId, 'message'), value: `\`${entity.message}\``, inline: true }]
        });

    },

    getEventEmbed: function (guildId, serverId, text, image, color = Constants.COLOR_DEFAULT) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        return module.exports.getEmbed({
            color: color,
            thumbnail: `attachment://${image}`,
            title: text,
            footer: { text: server.title, iconURL: server.img },
            timestamp: true
        });
    },

    getActionInfoEmbed: function (color, str, footer = null, ephemeral = true) {
        return {
            embeds: [module.exports.getEmbed({
                color: color === 0 ? Constants.COLOR_DEFAULT : Constants.COLOR_INACTIVE,
                description: `\`\`\`diff\n${(color === 0) ? '+' : '-'} ${str}\n\`\`\``,
                footer: footer !== null ? { text: footer } : null
            })],
            ephemeral: ephemeral
        };
    },

    getServerChangedStateEmbed: function (guildId, serverId, state) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        return module.exports.getEmbed({
            color: state ? Constants.COLOR_INACTIVE : Constants.COLOR_ACTIVE,
            title: state ?
                Client.client.intlGet(guildId, 'serverJustOffline') :
                Client.client.intlGet(guildId, 'serverJustOnline'),
            thumbnail: server.img,
            timestamp: true,
            footer: { text: server.title }
        });
    },

    getServerWipeDetectedEmbed: function (guildId, serverId) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            title: Client.client.intlGet(guildId, 'wipeDetected'),
            image: `attachment://${guildId}_map_full.png`,
            timestamp: true,
            footer: { text: server.title }
        });
    },

    getServerConnectionInvalidEmbed: function (guildId, serverId) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        return module.exports.getEmbed({
            color: Constants.COLOR_INACTIVE,
            title: Client.client.intlGet(guildId, 'serverInvalid'),
            thumbnail: server.img,
            timestamp: true,
            footer: { text: server.title }
        });
    },

    getActivityNotificationEmbed: function (guildId, serverId, color, text, steamId, png, title = null) {
        const instance = Client.client.getInstance(guildId);
        const footerTitle = title !== null ? title : instance.serverList[serverId].title;
        return module.exports.getEmbed({
            color: color,
            timestamp: true,
            footer: { text: footerTitle },
            author: {
                name: text,
                iconURL: (png !== null) ? png : Constants.DEFAULT_SERVER_IMG,
                url: `${Constants.STEAM_PROFILES_URL}${steamId}`
            }
        });
    },

    getUpdateServerInformationEmbed: function (rustplus) {
        const guildId = rustplus.guildId;
        const instance = Client.client.getInstance(guildId);

        const time = rustplus.getCommandTime(true);
        const timeLeftTitle = Client.client.intlGet(rustplus.guildId, 'timeTill', {
            event: rustplus.time.isDay() ? Constants.NIGHT_EMOJI : Constants.DAY_EMOJI
        });
        const playersFieldName = Client.client.intlGet(guildId, 'players');
        const timeFieldName = Client.client.intlGet(guildId, 'time');
        const wipeFieldName = Client.client.intlGet(guildId, 'wipe');
        const mapSizeFieldName = Client.client.intlGet(guildId, 'mapSize');
        const mapSeedFieldName = Client.client.intlGet(guildId, 'mapSeed');
        const mapSaltFieldName = Client.client.intlGet(guildId, 'mapSalt');
        const mapFieldName = Client.client.intlGet(guildId, 'map');

        const embed = module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'serverInfo'),
            color: Constants.COLOR_DEFAULT,
            thumbnail: 'attachment://server_info_logo.png',
            footer: { text: instance.serverList[rustplus.serverId].title },
            fields: [
                { name: playersFieldName, value: `\`${rustplus.getCommandPop(true)}\``, inline: true },
                { name: timeFieldName, value: `\`${time[0]}\``, inline: true },
                { name: wipeFieldName, value: `\`${rustplus.getCommandWipe(true)}\``, inline: true }],
            timestamp: true
        });

        if (time[1] !== null) {
            embed.addFields(
                { name: timeLeftTitle, value: `\`${time[1]}\``, inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: '\u200B', value: '\u200B', inline: true });
        }
        else {
            embed.addFields({ name: '\u200B', value: '\u200B', inline: false });
        }

        embed.addFields(
            { name: mapSizeFieldName, value: `\`${rustplus.info.mapSize}\``, inline: true },
            { name: mapSeedFieldName, value: `\`${rustplus.info.seed}\``, inline: true },
            { name: mapSaltFieldName, value: `\`${rustplus.info.salt}\``, inline: true },
            { name: mapFieldName, value: `\`${rustplus.info.map}\``, inline: true });

        if (instance.serverList[rustplus.serverId].connect !== null) {
            embed.addFields({
                name: Client.client.intlGet(guildId, 'connect'),
                value: `\`${instance.serverList[rustplus.serverId].connect}\``,
                inline: false
            });
        }

        const battlemetricsId = instance.serverList[rustplus.serverId].battlemetricsId;
        if (battlemetricsId && instance.generalSettings.displayInformationBattlemetricsUpcomingWipes) {
            const bmInstance = Client.client.battlemetricsInstances[battlemetricsId];
            if (bmInstance && bmInstance.rustWipes) {
                const upcomingWipes = bmInstance.getUpcomingWipesOrderedByTime();
                const mapWipe = upcomingWipes.find(e => e.type === 'map');
                const fullWipe = upcomingWipes.find(e => e.type === 'full');

                if (mapWipe || fullWipe) {
                    if (mapWipe) {
                        embed.addFields({
                            name: Client.client.intlGet(guildId, 'nextMapWipe'),
                            value: `<t:${Math.floor(mapWipe.discordTimestamp)}:R>`,
                            inline: true
                        });
                    }
                    if (fullWipe) {
                        embed.addFields({
                            name: Client.client.intlGet(guildId, 'nextFullWipe'),
                            value: `<t:${Math.floor(fullWipe.discordTimestamp)}:R>`,
                            inline: true
                        });
                    }
                }
                else if (upcomingWipes.length > 0) {
                    embed.addFields({
                        name: Client.client.intlGet(guildId, 'nextWipe'),
                        value: `<t:${Math.floor(upcomingWipes[0].discordTimestamp)}:R>`,
                        inline: true
                    });
                }
            }
        }

        return embed;
    },

    getUpdateEventInformationEmbed: function (rustplus) {
        const guildId = rustplus.guildId;
        const instance = Client.client.getInstance(guildId);

        const cargoshipFieldName = Client.client.intlGet(guildId, 'cargoship');
        const patrolHelicopterFieldName = Client.client.intlGet(guildId, 'patrolHelicopter');
        const smallOilRigFieldName = Client.client.intlGet(guildId, 'smallOilRig');
        const largeOilRigFieldName = Client.client.intlGet(guildId, 'largeOilRig');
        const chinook47FieldName = Client.client.intlGet(guildId, 'chinook47');
        const travelingVendorFieldName = Client.client.intlGet(guildId, 'travelingVendor');
        const deepSeaFieldName = Client.client.intlGet(guildId, 'deepSea');

        const cargoShipMessage = rustplus.getCommandCargo(true);
        const patrolHelicopterMessage = rustplus.getCommandHeli(true);
        const smallOilMessage = rustplus.getCommandSmall(true);
        const largeOilMessage = rustplus.getCommandLarge(true);
        const ch47Message = rustplus.getCommandChinook(true);
        const travelingVendorMessage = rustplus.getCommandTravelingVendor(true);
        const deepSeaMessage = rustplus.getCommandDeepSea(true);

        return module.exports.getEmbed({
            title: Client.client.intlGet(guildId, 'eventInfo'),
            color: Constants.COLOR_DEFAULT,
            thumbnail: 'attachment://event_info_logo.png',
            description: Client.client.intlGet(guildId, 'inGameEventInfo'),
            footer: { text: instance.serverList[rustplus.serverId].title },
            fields: [
                { name: cargoshipFieldName, value: `\`${cargoShipMessage}\``, inline: true },
                { name: patrolHelicopterFieldName, value: `\`${patrolHelicopterMessage}\``, inline: true },
                { name: smallOilRigFieldName, value: `\`${smallOilMessage}\``, inline: true },
                { name: largeOilRigFieldName, value: `\`${largeOilMessage}\``, inline: true },
                { name: chinook47FieldName, value: `\`${ch47Message}\``, inline: true },
                { name: travelingVendorFieldName, value: `\`${travelingVendorMessage}\``, inline: true },
                { name: deepSeaFieldName, value: `\`${deepSeaMessage}\``, inline: true }
            ],
            timestamp: true
        });
    },

    getUpdateTeamInformationEmbed: function (rustplus) {
        const guildId = rustplus.guildId;
        const instance = Client.client.getInstance(guildId);

        const title = Client.client.intlGet(guildId, 'teamMemberInfo');
        const teamMemberFieldName = Client.client.intlGet(guildId, 'teamMember');
        const statusFieldName = Client.client.intlGet(guildId, 'status');
        const locationFieldName = Client.client.intlGet(guildId, 'location');
        const footer = instance.serverList[rustplus.serverId].title;

        /* Hoist the lite-server lookup out of the per-player loop — the paired
           check below is just a key-existence test, so use hasOwnProperty
           instead of rebuilding Object.keys() twice per player. */
        const serverListLite = instance.serverListLite[rustplus.serverId];

        let totalCharacters = title.length + teamMemberFieldName.length + statusFieldName.length + locationFieldName.length + footer.length;
        let fieldIndex = 0;
        let teammateName = [''], teammateStatus = [''], teammateLocation = [''];
        let teammateNameCharacters = 0, teammateStatusCharacters = 0, teammateLocationCharacters = 0;
        for (const player of rustplus.team.players) {
            let name = player.name === '' ? '-' : `[${player.name}](${Constants.STEAM_PROFILES_URL}${player.steamId})`;
            name += (player.teamLeader) ? `${Constants.LEADER_EMOJI}\n` : '\n';
            let status = '';
            let location = (player.isOnline || player.isAlive) ? `${player.pos.string}\n` : '-\n';

            if (player.isOnline) {
                const isAfk = player.getAfkSeconds() >= Constants.AFK_TIME_SECONDS;
                const afkTime = player.getAfkTime('dhs');

                status += (isAfk) ? Constants.AFK_EMOJI : Constants.ONLINE_EMOJI;
                status += (player.isAlive) ? ((isAfk) ? Constants.SLEEPING_EMOJI : Constants.ALIVE_EMOJI) :
                    Constants.DEAD_EMOJI;
                status += (serverListLite.hasOwnProperty(player.steamId)) ?
                    Constants.PAIRED_EMOJI : '';
                status += (isAfk) ? ` ${afkTime}\n` : '\n';
            }
            else {
                const offlineTime = player.getOfflineTime('s');
                status += Constants.OFFLINE_EMOJI;
                status += (player.isAlive) ? Constants.SLEEPING_EMOJI : Constants.DEAD_EMOJI;
                status += (serverListLite.hasOwnProperty(player.steamId)) ?
                    Constants.PAIRED_EMOJI : '';
                status += (offlineTime !== null) ? offlineTime : '';
                status += '\n';
            }

            if (totalCharacters + (name.length + status.length + location.length) >=
                Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                break;
            }

            if ((teammateNameCharacters + name.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                (teammateStatusCharacters + status.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                (teammateLocationCharacters + location.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                fieldIndex += 1;

                teammateName.push('');
                teammateStatus.push('');
                teammateLocation.push('');

                teammateNameCharacters = 0;
                teammateStatusCharacters = 0;
                teammateLocationCharacters = 0;
            }

            teammateNameCharacters += name.length;
            teammateStatusCharacters += status.length;
            teammateLocationCharacters += location.length;

            totalCharacters += name.length + status.length + location.length;

            teammateName[fieldIndex] += name;
            teammateStatus[fieldIndex] += status;
            teammateLocation[fieldIndex] += location;
        }

        const fields = [];
        for (let i = 0; i < (fieldIndex + 1); i++) {
            fields.push({
                name: i === 0 ? teamMemberFieldName : '\u200B',
                value: teammateName[i] !== '' ? teammateName[i] : Client.client.intlGet(guildId, 'empty'),
                inline: true
            });
            fields.push({
                name: i === 0 ? statusFieldName : '\u200B',
                value: teammateStatus[i] !== '' ? teammateStatus[i] : Client.client.intlGet(guildId, 'empty'),
                inline: true
            });
            fields.push({
                name: i === 0 ? locationFieldName : '\u200B',
                value: teammateLocation[i] !== '' ? teammateLocation[i] : Client.client.intlGet(guildId, 'empty'),
                inline: true
            });
        }

        return module.exports.getEmbed({
            title: title,
            color: Constants.COLOR_DEFAULT,
            thumbnail: 'attachment://team_info_logo.png',
            footer: { text: footer },
            fields: fields,
            timestamp: true
        });
    },

    getDiscordCommandResponseEmbed: function (rustplus, response) {
        const instance = Client.client.getInstance(rustplus.guildId);

        let string = '';
        if (Array.isArray(response)) {
            for (const str of response) {
                string += `${str}\n`;
            }
        }
        else {
            string = response;
        }

        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            description: `**${string}**`,
            footer: { text: `${instance.serverList[rustplus.serverId].title}` }
        });
    },

    getCredentialsShowEmbed: async function (guildId) {
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        let names = '';
        let steamIds = '';
        let hoster = '';

        for (const credential in credentials) {
            if (credential === 'hoster') continue;

            const user = await DiscordTools.getUserById(guildId, credentials[credential].discord_user_id);
            names += `${user ? user.user.username : Client.client.intlGet(guildId, 'unknown')}\n`;
            steamIds += `${credential}\n`;
            hoster += `${credential === credentials.hoster ? `${Constants.LEADER_EMOJI}\n` : '\u200B\n'}`;
        }

        if (names === '') names = Client.client.intlGet(guildId, 'empty');
        if (steamIds === '') steamIds = Client.client.intlGet(guildId, 'empty');
        if (hoster === '') hoster = Client.client.intlGet(guildId, 'empty');

        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            title: Client.client.intlGet(guildId, 'fcmCredentials'),
            fields: [
                { name: Client.client.intlGet(guildId, 'name'), value: names, inline: true },
                { name: 'SteamID', value: steamIds, inline: true },
                { name: Client.client.intlGet(guildId, 'hoster'), value: hoster, inline: true }]
        });
    },

    getUserSendEmbed: function (guildId, serverId, sender, str) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            timestamp: true,
            footer: { text: server.title },
            description: `**${sender}**: ${str}`
        });
    },

    getHelpEmbed: function (guildId) {
        const repository = 'https://github.com/alexemanuelol/rustplusplus';
        const credentials = `${repository}/blob/master/docs/credentials.md`;
        const pairServer = `${repository}/blob/master/docs/pair_and_connect_to_server.md`;
        const commands = `${repository}/blob/master/docs/commands.md`;

        const description =
            `→ [${Client.client.intlGet(guildId, 'commandsHelpHowToCredentials')}](${credentials})\n` +
            `→ [${Client.client.intlGet(guildId, 'commandsHelpHowToPairServer')}](${pairServer})\n` +
            `→ [${Client.client.intlGet(guildId, 'commandsHelpCommandList')}](${commands})`;

        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            timestamp: true,
            title: `rustplusplus Help`,
            description: description
        });
    },

    getUptimeEmbed: function (guildId, uptime) {
        return module.exports.getEmbed({
            color: Constants.COLOR_DEFAULT,
            timestamp: true,
            title: uptime
        });
    },

    getBattlemetricsEventEmbed: function (guildId, battlemetricsId, title, description, fields = null) {
        const instance = Client.client.getInstance(guildId);
        const bmInstance = Client.client.battlemetricsInstances[battlemetricsId];

        const serverId = `${bmInstance.server_ip}-${bmInstance.server_port}`;

        let thumbnail = '';
        if (instance.serverList.hasOwnProperty(serverId)) {
            thumbnail = instance.serverList[serverId].img
        }
        const embed = module.exports.getEmbed({
            title: title,
            color: Constants.COLOR_DEFAULT,
            timestamp: true,
            thumbnail: thumbnail,
            footer: { text: bmInstance.server_name }
        });

        if (fields !== null) {
            embed.addFields(fields);
        }

        if (description !== '') {
            embed.setDescription(description);
        }

        return embed;
    },

    getItemEmbed: function (guildId, itemName, itemId, type) {
        /* Slim form: title + id only. RustLabs sub-details (decay, craft,
           recycle, research, etc.) were removed when the lookup commands
           were dropped — use rustlabs.com for the deeper info. */
        void type;
        return module.exports.getEmbed({
            title: `${itemName} (${itemId})`,
            color: Constants.COLOR_DEFAULT,
            timestamp: true
        });
    },

    /* Per-tracker activity report. Adapted from upstream's per-player
       login/logout-event flavor to work with our snapshot+pattern SQLite
       schema, so no migration of stored data is required. */
    getTrackerActivityReportEmbed: function (guildId, trackerId) {
        const instance = Client.client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        const bmInstance = Client.client.battlemetricsInstances[tracker.battlemetricsId];

        let description = `__**${Client.client.intlGet(guildId, 'tracker')}:**__ ${tracker.name}\n`;
        description += `__**${Client.client.intlGet(guildId, 'serverId')}:**__ ${tracker.serverId}\n\n`;

        const fmtAbsRel = (sec) => sec
            ? `<t:${sec}:f> (<t:${sec}:R>)`
            : 'Never';

        let totalCharacters = description.length + 200;

        for (const player of tracker.players) {
            if (!player.playerId) continue;
            const live = bmInstance && bmInstance.players ? bmInstance.players[player.playerId] : null;
            const report = ActivityDb.generatePlayerReport(player.playerId, player.name || '-', live);
            const statusEmoji = report.isOnline ? Constants.ONLINE_EMOJI : Constants.OFFLINE_EMOJI;

            let block = `${statusEmoji} **${report.playerName}**\n`;
            if (report.sampleCount === 0) {
                block += `> No activity data recorded yet.\n\n`;
            }
            else {
                block += `> 🔗 **Last connected:** ${fmtAbsRel(report.lastConnectedSec)}\n`;
                block += `> 🛑 **Last disconnected:** ${fmtAbsRel(report.lastDisconnectedSec)}\n`;
                block += `> 👁 **Last seen:** ${fmtAbsRel(report.lastSeenSec)}\n`;
                block += `> 💤 **Likely sleep:** ${report.sleepWindow}\n`;
                block += `> 🎮 **Likely playing:** ${report.playWindow}\n`;
                if (report.peakHours.length > 0) {
                    const peakStr = report.peakHours
                        .map(h => `${String(h.hour).padStart(2, '0')}:00`)
                        .join(', ');
                    block += `> 🔥 **Peak hours:** ${peakStr}\n`;
                }
                block += '\n';
            }

            /* Stop adding players once we're near Discord's 6000-char total
               limit — the alternative (silently dropping fields) would be
               worse for the reader than a clear cutoff. */
            if (totalCharacters + block.length > Constants.EMBED_MAX_TOTAL_CHARACTERS - 200) break;
            totalCharacters += block.length;
            description += block;
        }

        /* Group weekly activity: per-weekday averaged online windows across
           all tracked players. Replaces the per-player hourly chart so the
           report leads with "when is this group usually online" rather than
           a snapshot of one player's day. */
        const fields = [];
        const groupPlayerIds = tracker.players.map(p => p.playerId).filter(Boolean);
        const weeklyValue = ActivityDb.formatGroupWeeklySchedule(groupPlayerIds);
        if (weeklyValue && weeklyValue.length <= Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
            fields.push({
                name: `🗓 ${Client.client.intlGet(guildId, 'groupActive')} (weekly)`,
                value: weeklyValue,
                inline: false
            });
        }

        const embed = module.exports.getEmbed({
            title: `📋 Activity Report`,
            color: Constants.COLOR_DEFAULT,
            description: description,
            thumbnail: `${tracker.img}`,
            footer: { text: `${tracker.title} | ${tracker.players.length} player(s)` },
            timestamp: true
        });
        if (fields.length > 0) embed.addFields(...fields);
        return embed;
    },
}