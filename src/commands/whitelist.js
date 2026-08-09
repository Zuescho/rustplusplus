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

const Builder = require('@discordjs/builders');

const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const Scrape = require('../util/scrape.js');
const Utils = require('../util/utils.js');

module.exports = {
	name: 'whitelist',

	getData(client, guildId) {
		return new Builder.SlashCommandBuilder()
			.setName('whitelist')
			.setDescription(client.intlGet(guildId, 'commandsWhitelistDesc'))
			.addSubcommand(subcommand => subcommand
				.setName('add')
				.setDescription(client.intlGet(guildId, 'commandsWhitelistAddDesc'))
				.addStringOption(option => option
					.setName('steamid')
					.setDescription(client.intlGet(guildId, 'commandsWhitelistSteamidDesc'))
					.setRequired(true)))
			.addSubcommand(subcommand => subcommand
				.setName('remove')
				.setDescription(client.intlGet(guildId, 'commandsWhitelistRemoveDesc'))
				.addStringOption(option => option
					.setName('steamid')
					.setDescription(client.intlGet(guildId, 'commandsWhitelistSteamidDesc'))
					.setRequired(true)))
			.addSubcommand(subcommand => subcommand
				.setName('show')
				.setDescription(client.intlGet(guildId, 'commandsWhitelistShowDesc')));
	},

	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const instance = client.getInstance(guildId);

		const verifyId = Math.floor(100000 + Math.random() * 900000);
		client.logInteraction(interaction, verifyId, 'slashCommand');

		if (!await client.validatePermissions(interaction)) return;

		if (!client.isAdministrator(interaction)) {
			const str = client.intlGet(guildId, 'missingPermission');
			await client.interactionReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
			client.log(client.intlGet(null, 'warningCap'), str);
			return;
		}

		await interaction.deferReply({ ephemeral: true });
		ensureWhitelist(instance);

		switch (interaction.options.getSubcommand()) {
			case 'add': {
				const steamid = interaction.options.getString('steamid').trim();
				const steamName = await getSteamName(client, steamid);

				let successful = 0;
				let str = '';
				if (instance.whitelist['steamIds'].includes(steamid)) {
					str = client.intlGet(guildId, 'userAlreadyInWhitelist', { user: steamName });
					successful = 1;
				}
				else {
					instance.whitelist['steamIds'].push(steamid);
					client.setInstance(guildId, instance);
					str = client.intlGet(guildId, 'userAddedToWhitelist', { user: steamName });
				}

				client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
					id: `${verifyId}`,
					value: `add, ${steamid}`
				}));

				await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(successful, str));
				client.log(client.intlGet(null, 'infoCap'), str);
				return;
			} break;

			case 'remove': {
				const steamid = interaction.options.getString('steamid').trim();
				const steamName = await getSteamName(client, steamid);

				let successful = 0;
				let str = '';
				if (!instance.whitelist['steamIds'].includes(steamid)) {
					str = client.intlGet(guildId, 'userNotInWhitelist', { user: steamName });
					successful = 1;
				}
				else {
					instance.whitelist['steamIds'] =
						instance.whitelist['steamIds'].filter(e => e !== steamid);
					client.setInstance(guildId, instance);
					str = client.intlGet(guildId, 'userRemovedFromWhitelist', { user: steamName });
				}

				client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
					id: `${verifyId}`,
					value: `remove, ${steamid}`
				}));

				await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(successful, str));
				client.log(client.intlGet(null, 'infoCap'), str);
				return;
			} break;

			case 'show': {
				/* Same shape as /blacklist show: a serial loop here meant one
				   15 s scraper timeout per entry, so a long whitelist against a
				   blackholing Steam ran past the 15-minute interaction expiry
				   and the command produced nothing at all. The field truncates
				   at 1024 characters anyway, so there is nothing to gain from
				   looking up past the cap. */
				const all = instance.whitelist['steamIds'];
				const names = await Utils.mapWithConcurrency(
					all.slice(0, Constants.STEAM_NAME_LOOKUP_LIMIT),
					Constants.STEAM_NAME_LOOKUP_CONCURRENCY,
					async (steamId) => await getSteamName(client, steamId, true));
				for (const steamId of all.slice(Constants.STEAM_NAME_LOOKUP_LIMIT)) {
					names.push(`${steamId}`);
				}

				const steamIds = names.map(name => `${name}\n`).join('');

				await client.interactionEditReply(interaction, {
					embeds: [DiscordEmbeds.getEmbed({
						color: Constants.COLOR_DEFAULT,
						title: client.intlGet(guildId, 'whitelist'),
						fields: [
							{
								name: 'SteamId',
								value: steamIds === '' ? '\u200B' : steamIds.slice(0, 1024),
								inline: true
							}]
					})],
					ephemeral: true
				});

				client.log(client.intlGet(guildId, 'infoCap'), client.intlGet(guildId, 'showingWhitelist'));
				return;
			} break;

			default: {
			} break;
		}
	},
};

function ensureWhitelist(instance) {
	if (!instance.hasOwnProperty('whitelist')) instance.whitelist = {};
	if (!instance.whitelist.hasOwnProperty('steamIds')) instance.whitelist['steamIds'] = [];
}

/* `cache` is opt-in per caller: adding or removing an entry is a one-off the
   user is watching, so it takes the live name, while `show` re-reads the whole
   list on every invocation and is happy with names a few hours old. */
async function getSteamName(client, steamid, cache = false) {
	const steamName = await Scrape.scrapeSteamProfileName(client, steamid, { cache: cache });
	if (steamName) return `${steamName} (${steamid})`;
	return `${steamid}`;
}
