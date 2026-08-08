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
const Path = require('path');

const BattlemetricsHandler = require('../handlers/battlemetricsHandler.js');
const BmToken = require('../util/battlemetricsToken.js');
const Config = require('../../config');

module.exports = {
    /* discord.js renamed this event to 'clientReady' to distinguish it from the
       gateway READY event, and v15 will only emit it under the new name. The
       enum resolves to whichever name the installed version uses, so this keeps
       firing across the whole ^14.21.0 range and into v15 -- unlike a literal,
       which would be wrong on one side of the rename or the other. */
    name: Discord.Events.ClientReady,
    once: true,
    async execute(client) {
        for (const guild of client.guilds.cache) {
            require('../util/CreateInstanceFile')(client, guild[1]);
            require('../util/CreateCredentialsFile')(client, guild[1]);
            client.fcmListenersLite[guild[0]] = new Object();
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'loggedInAs', {
            name: client.user.tag
        }));

        try {
            await client.user.setUsername(Config.discord.username);
        }
        catch (e) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetUsername'));
        }

        try {
            await client.user.setAvatar(Path.join(__dirname, '..', 'resources/images/rustplusplus_logo.png'));
        }
        catch (e) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetAvatar'));
        }

        client.user.setPresence({
            activities: [{ name: '/help', type: Discord.ActivityType.Listening }],
            status: 'online'
        });

        client.uptimeBot = new Date();

        for (let guildArray of client.guilds.cache) {
            const guild = guildArray[1];

            try {
                await guild.members.me.setNickname(Config.discord.username);
            }
            catch (e) {
                client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetNickname'));
            }
            await client.syncCredentialsWithUsers(guild);
            await client.setupGuild(guild);
        }

        /* Battlemetrics requires an API token now. The poll loop below stays
           armed either way — the handler no-ops while no token is configured,
           so `/battlemetrics set` starts things up without a bot restart. */
        if (!BmToken.isEnabled()) {
            client.log(client.intlGet(null, 'warningCap'),
                client.intlGet(null, 'battlemetricsDisabledNoToken'));
        }

        await client.updateBattlemetricsInstances();
        /* The handler is async; setInterval ignores the returned promise, so a
           single unguarded throw would surface as an unhandled rejection every
           cycle. Wrap it to log instead and keep the poll loop alive. The
           `polling` flag prevents re-entrancy: with large rosters the startup
           Steam-scrape burst can exceed the 60s interval, and overlapping runs
           would mutate the same tracker objects concurrently. `.finally`
           guarantees the flag resets even if the handler throws. */
        let polling = false;
        const runBattlemetricsPoll = (firstTime) => {
            if (polling) return;
            polling = true;
            Promise.resolve(BattlemetricsHandler.handler(client, firstTime))
                .catch(e => {
                    client.log(client.intlGet(null, 'errorCap'),
                        `Battlemetrics poll failed: ${e.message}`, 'error');
                })
                .finally(() => { polling = false; });
        };
        runBattlemetricsPoll(true);
        /* Offset the recurring poll by a random fraction of the cycle so
           multiple bot instances don't synchronize their bursts. */
        const pollJitter = Math.floor(Math.random() * 30000);
        setTimeout(() => {
            client.battlemetricsIntervalId = setInterval(runBattlemetricsPoll, 60000, false);
        }, pollJitter);

        client.createRustplusInstancesFromConfig();
    },
};