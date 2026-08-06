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

const Builder = require('@discordjs/builders');

const BmToken = require('../util/battlemetricsToken.js');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');

module.exports = {
    name: 'battlemetrics',

    getData(client, guildId) {
        return new Builder.SlashCommandBuilder()
            .setName('battlemetrics')
            .setDescription(client.intlGet(guildId, 'commandsBattlemetricsDesc'))
            .addSubcommand(subcommand => subcommand
                .setName('set')
                .setDescription(client.intlGet(guildId, 'commandsBattlemetricsSetDesc'))
                .addStringOption(option => option
                    .setName('token')
                    .setDescription(client.intlGet(guildId, 'commandsBattlemetricsTokenDesc'))
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('clear')
                .setDescription(client.intlGet(guildId, 'commandsBattlemetricsClearDesc')))
            .addSubcommand(subcommand => subcommand
                .setName('status')
                .setDescription(client.intlGet(guildId, 'commandsBattlemetricsStatusDesc')));
    },

    async execute(client, interaction) {
        const guildId = interaction.guildId;

        const verifyId = Math.floor(100000 + Math.random() * 900000);
        client.logInteraction(interaction, verifyId, 'slashCommand');

        if (!await client.validatePermissions(interaction)) return;

        /* The token is bot-wide (Battlemetrics instances are shared between
           guilds), and it is a paid credential — administrators only. */
        if (!client.isAdministrator(interaction)) {
            const str = client.intlGet(guildId, 'missingPermission');
            await client.interactionReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
            client.log(client.intlGet(null, 'warningCap'), str);
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        switch (interaction.options.getSubcommand()) {
            case 'set': {
                const token = interaction.options.getString('token');

                try {
                    BmToken.setToken(token);
                }
                catch (e) {
                    const str = client.intlGet(guildId, 'battlemetricsTokenNotSaved', { error: e.message });
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                    client.log(client.intlGet(null, 'errorCap'), str, 'error');
                    return;
                }

                /* Deliberately never log the token itself — only that it changed. */
                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                    id: `${verifyId}`,
                    value: 'set, battlemetrics token (redacted)'
                }));

                /* Pick the key up immediately instead of waiting for a restart. */
                await client.updateBattlemetricsInstances();

                const str = client.intlGet(guildId, 'battlemetricsTokenSaved', {
                    token: BmToken.getMaskedToken()
                });
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0, str));
                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'battlemetricsTokenSavedLog'));
                return;
            } break;

            case 'clear': {
                try {
                    BmToken.clearToken();
                }
                catch (e) {
                    const str = client.intlGet(guildId, 'battlemetricsTokenNotCleared', { error: e.message });
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                    client.log(client.intlGet(null, 'errorCap'), str, 'error');
                    return;
                }

                await client.updateBattlemetricsInstances();

                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                    id: `${verifyId}`,
                    value: 'clear, battlemetrics token'
                }));

                /* Clearing only removes the token stored by this command — an
                   RPP_BATTLEMETRICS_TOKEN env var takes over again if set. */
                const str = BmToken.isEnabled() ?
                    client.intlGet(guildId, 'battlemetricsTokenClearedEnvActive') :
                    client.intlGet(guildId, 'battlemetricsTokenCleared');
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0, str));
                client.log(client.intlGet(null, 'infoCap'), str);
                return;
            } break;

            case 'status': {
                const enabled = BmToken.isEnabled();
                const source = BmToken.getSource();

                await client.interactionEditReply(interaction, {
                    embeds: [DiscordEmbeds.getEmbed({
                        color: enabled ? Constants.COLOR_ACTIVE : Constants.COLOR_INACTIVE,
                        title: client.intlGet(guildId, 'battlemetricsCap'),
                        fields: [
                            {
                                name: client.intlGet(guildId, 'status'),
                                value: enabled ?
                                    client.intlGet(guildId, 'battlemetricsStatusEnabled') :
                                    client.intlGet(guildId, 'battlemetricsStatusDisabled'),
                                inline: true
                            },
                            {
                                name: client.intlGet(guildId, 'battlemetricsTokenSource'),
                                value: client.intlGet(guildId, `battlemetricsTokenSource_${source}`),
                                inline: true
                            },
                            {
                                name: client.intlGet(guildId, 'battlemetricsToken'),
                                value: BmToken.getMaskedToken() ?? '​',
                                inline: true
                            },
                            {
                                name: client.intlGet(guildId, 'battlemetricsTrackedServers'),
                                value: `${Object.keys(client.battlemetricsInstances).length}`,
                                inline: true
                            }
                        ]
                    })],
                    ephemeral: true
                });

                client.log(client.intlGet(null, 'infoCap'),
                    client.intlGet(null, 'battlemetricsShowingStatus'));
                return;
            } break;

            default: {
            } break;
        }

        return;
    },
};
