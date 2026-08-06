/*
    Copyright (C) 2023 Alexander Emanuelsson (alexemanuelol)

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

/*
    Mute a teammate's in-game chat so it stops being relayed to the Discord
    team-chat channels. The typical case is a second bot sharing the team: it
    echoes every notification into team chat, which then floods the Discord
    channel with a duplicate of what the Discord side already posted.

    Muting only affects the Discord relay — the player still shows up in game,
    still counts for the team, and their in-game commands still work.
*/

const Builder = require('@discordjs/builders');

const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');

const MAX_CHOICES = 25;
const STEAM_ID_REGEX = /^\d{17}$/;

/**
 *  The team roster of the guild's active Rust+ connection, if there is one.
 *  @param {object} client The Discord bot client.
 *  @param {string} guildId The guild id.
 *  @return {Array} Array of { steamId, name }.
 */
function getTeamPlayers(client, guildId) {
    const rustplus = client.rustplusInstances[guildId];
    if (!rustplus || !rustplus.team || !Array.isArray(rustplus.team.players)) return [];

    return rustplus.team.players.map(p => ({
        steamId: `${p.steamId}`,
        name: p.name ?? `${p.steamId}`
    }));
}

function getMuted(instance) {
    return (instance && instance.mutedTeammates && typeof instance.mutedTeammates === 'object') ?
        instance.mutedTeammates : {};
}

function formatEntry(steamId, entry) {
    const name = entry && entry.name ? entry.name : steamId;
    return `• ${name} (${steamId})`;
}

module.exports = {
    name: 'mute',

    getData(client, guildId) {
        return new Builder.SlashCommandBuilder()
            .setName('mute')
            .setDescription(client.intlGet(guildId, 'commandsMuteDesc'))
            .addSubcommand(subcommand => subcommand
                .setName('add')
                .setDescription(client.intlGet(guildId, 'commandsMuteAddDesc'))
                .addStringOption(option => option
                    .setName('teammate')
                    .setDescription(client.intlGet(guildId, 'commandsMuteTeammateDesc'))
                    .setRequired(true)
                    .setAutocomplete(true)))
            .addSubcommand(subcommand => subcommand
                .setName('remove')
                .setDescription(client.intlGet(guildId, 'commandsMuteRemoveDesc'))
                .addStringOption(option => option
                    .setName('teammate')
                    .setDescription(client.intlGet(guildId, 'commandsMuteRemoveTeammateDesc'))
                    .setRequired(true)
                    .setAutocomplete(true)))
            .addSubcommand(subcommand => subcommand
                .setName('list')
                .setDescription(client.intlGet(guildId, 'commandsMuteListDesc')));
    },

    async autocomplete(client, interaction) {
        try {
            const instance = client.getInstance(interaction.guildId);
            const focused = interaction.options.getFocused(true);
            if (focused.name !== 'teammate') {
                await interaction.respond([]);
                return;
            }

            const query = `${focused.value ?? ''}`.toLowerCase();
            const muted = getMuted(instance);
            const sub = interaction.options.getSubcommand();

            /* `remove` suggests what is currently muted (which may include
               players who have since left the team); `add` suggests the live
               roster minus anyone already muted. */
            const candidates = sub === 'remove' ?
                Object.entries(muted).map(([steamId, entry]) => ({
                    steamId, name: (entry && entry.name) ? entry.name : steamId
                })) :
                getTeamPlayers(client, interaction.guildId)
                    .filter(p => !Object.prototype.hasOwnProperty.call(muted, p.steamId));

            const choices = candidates
                .filter(p => p.name.toLowerCase().includes(query) || p.steamId.includes(query))
                .slice(0, MAX_CHOICES)
                .map(p => ({ name: `${p.name} (${p.steamId})`.slice(0, 100), value: p.steamId }));

            await interaction.respond(choices);
        }
        catch (e) {
            /* Never let autocomplete throw — Discord renders that as a UI error. */
            try { await interaction.respond([]); } catch { /* ignore */ }
        }
    },

    async execute(client, interaction) {
        const guildId = interaction.guildId;
        const instance = client.getInstance(guildId);

        const verifyId = Math.floor(100000 + Math.random() * 900000);
        client.logInteraction(interaction, verifyId, 'slashCommand');

        if (!await client.validatePermissions(interaction)) return;

        await interaction.deferReply({ ephemeral: true });

        if (!instance.mutedTeammates || typeof instance.mutedTeammates !== 'object' ||
            Array.isArray(instance.mutedTeammates)) {
            instance.mutedTeammates = {};
        }

        switch (interaction.options.getSubcommand()) {
            case 'add': {
                /* The option is autocompleted, but Discord still lets people
                   type anything — accept a raw steam id as well. */
                const value = `${interaction.options.getString('teammate')}`.trim();
                const teamPlayers = getTeamPlayers(client, guildId);
                const match = teamPlayers.find(p => p.steamId === value) ??
                    teamPlayers.find(p => p.name.toLowerCase() === value.toLowerCase());

                const steamId = match ? match.steamId : value;
                if (!STEAM_ID_REGEX.test(steamId)) {
                    const str = client.intlGet(guildId, 'couldNotFindTeammate', { name: value });
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                    client.log(client.intlGet(null, 'warningCap'), str);
                    return;
                }

                if (Object.prototype.hasOwnProperty.call(instance.mutedTeammates, steamId)) {
                    const str = client.intlGet(guildId, 'teammateAlreadyMuted', {
                        user: formatEntry(steamId, instance.mutedTeammates[steamId]).slice(2)
                    });
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                    return;
                }

                const name = match ? match.name : steamId;
                instance.mutedTeammates[steamId] = { name: name, mutedAt: new Date().toISOString() };
                client.setInstance(guildId, instance);

                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                    id: `${verifyId}`,
                    value: `add, ${steamId}`
                }));

                const str = client.intlGet(guildId, 'teammateMuted', { user: `${name} (${steamId})` });
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0, str));
                client.log(client.intlGet(null, 'infoCap'), str);
                return;
            } break;

            case 'remove': {
                const value = `${interaction.options.getString('teammate')}`.trim();

                let steamId = Object.prototype.hasOwnProperty.call(instance.mutedTeammates, value) ? value : null;
                if (steamId === null) {
                    /* Allow removing by name too. */
                    const entry = Object.entries(instance.mutedTeammates).find(([, e]) =>
                        e && typeof e.name === 'string' && e.name.toLowerCase() === value.toLowerCase());
                    if (entry) steamId = entry[0];
                }

                if (steamId === null) {
                    const str = client.intlGet(guildId, 'teammateNotMuted', { user: value });
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                    return;
                }

                const name = instance.mutedTeammates[steamId].name ?? steamId;
                delete instance.mutedTeammates[steamId];
                client.setInstance(guildId, instance);

                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                    id: `${verifyId}`,
                    value: `remove, ${steamId}`
                }));

                const str = client.intlGet(guildId, 'teammateUnmuted', { user: `${name} (${steamId})` });
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0, str));
                client.log(client.intlGet(null, 'infoCap'), str);
                return;
            } break;

            case 'list': {
                const entries = Object.entries(instance.mutedTeammates);
                const body = entries.length > 0 ?
                    entries.map(([steamId, entry]) => formatEntry(steamId, entry)).join('\n') :
                    client.intlGet(guildId, 'empty');

                await client.interactionEditReply(interaction, {
                    embeds: [DiscordEmbeds.getEmbed({
                        color: Constants.COLOR_DEFAULT,
                        title: client.intlGet(guildId, 'mutedTeammates'),
                        description: body.slice(0, 4096)
                    })],
                    ephemeral: true
                });

                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'showingMutedTeammates'));
                return;
            } break;

            default: {
            } break;
        }

        return;
    },
};
