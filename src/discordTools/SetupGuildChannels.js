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

const DiscordTools = require('../discordTools/discordTools.js');
const PermissionHandler = require('../handlers/permissionHandler.js');

/* Channels whose permission write has already been reported as failing, keyed
   `guildId:channelId`. Setup touches ~15 channels per guild and a missing
   Manage Roles fails every one of them for the same reason. */
const _warnedChannelPerms = new Set();

module.exports = async (client, guild, category) => {
    await addTextChannel(client.intlGet(guild.id, 'channelNameInformation'), 'information', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameServers'), 'servers', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameSettings'), 'settings', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameCommands'), 'commands', client, guild, category, true);
    await addTextChannel(client.intlGet(guild.id, 'channelNameEvents'), 'events', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameTeamchat'), 'teamchat', client, guild, category, true);
    await addTextChannel(client.intlGet(guild.id, 'channelNameTeamchatTranslated'),
        'teamchatTranslated', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameSwitches'), 'switches', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameSwitchGroups'), 'switchGroups', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameAlarms'), 'alarms', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameCustomAlarm'),
        'customAlarm', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameStorageMonitors'),
        'storageMonitors', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameActivity'), 'activity', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameTrackers'), 'trackers', client, guild, category);
    await addTextChannel(client.intlGet(guild.id, 'channelNameLogs'), 'logs', client, guild, category);
};

async function addTextChannel(name, idName, client, guild, parent, permissionWrite = false) {
    const instance = client.getInstance(guild.id);

    let channel = undefined;
    if (instance.channelId[idName] !== null) {
        channel = DiscordTools.getTextChannelById(guild.id, instance.channelId[idName]);
    }
    if (channel === undefined) {
        channel = await DiscordTools.addTextChannel(guild.id, name);
        /* addTextChannel returns undefined if creation failed (e.g. missing
           permissions) — bail out rather than dereference channel.id below. */
        if (channel === undefined) {
            client.log(client.intlGet(null, 'errorCap'),
                client.intlGet(null, 'couldNotCreateTextChannel', { name: name }), 'error');
            return;
        }
        instance.channelId[idName] = channel.id;
        client.setInstance(guild.id, instance);

        try {
            await channel.setParent(parent.id);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                client.intlGet(null, 'couldNotSetParent', { channelId: channel.id }), 'error');
        }
    }

    if (channel !== undefined && instance.firstTime) {
        try {
            await channel.setParent(parent.id);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                client.intlGet(null, 'couldNotSetParent', { channelId: channel.id }), 'error');
        }
    }

    const perms = PermissionHandler.getPermissionsReset(client, guild, permissionWrite);

    try {
        await channel.permissionOverwrites.set(perms);
        _warnedChannelPerms.delete(`${guild.id}:${channel.id}`);
    }
    catch (e) {
        /* Today this surfaces only as the context-free "Unhandled Rejection"
           from the fire-and-forget lockPermissions() below, which names neither
           the channel nor the Discord error code. Warn once per channel — this
           runs for ~15 channels per guild at startup and a missing Manage Roles
           fails all of them identically. Cleared on success above so a fixed
           and then re-broken permission reports again. */
        const key = `${guild.id}:${channel.id}`;
        if (!_warnedChannelPerms.has(key)) {
            _warnedChannelPerms.add(key);
            client.log(client.intlGet(null, 'errorCap'),
                client.intlGet(null, 'couldNotSetSingleChannelPermissions', {
                    channel: name,
                    channelId: channel.id,
                    error: `${e.code || ''} ${e.message}`.trim()
                }), 'error');
        }
    }

    /* Currently, this halts the entire application... Too lazy to fix...
       It is possible to just remove the channels and let the bot recreate them with correct name language */
    //channel.setName(name);

    channel.lockPermissions();
}