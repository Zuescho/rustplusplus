/*
    /tracker slash command — add/remove/list players on existing trackers with
    name autocomplete on both the tracker and the player option. Coexists with
    the existing button/modal UI in the tracker channel.
*/

const Builder = require('@discordjs/builders');

const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const PlayerSearch = require('../util/battlemetricsPlayerSearch.js');
const Scrape = require('../util/scrape.js');

const MAX_CHOICES = 25;

function trackerChoicesFromInstance(instance, query) {
    const q = (query || '').toLowerCase();
    const trackers = Object.entries(instance.trackers || {});
    const matches = trackers
        .map(([id, t]) => ({ id, name: t.name || id }))
        .filter(t => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
        .slice(0, MAX_CHOICES);
    return matches.map(t => ({ name: `${t.name} (#${t.id})`, value: String(t.id) }));
}

function existingPlayerChoices(tracker, query) {
    const q = (query || '').toLowerCase();
    const players = (tracker.players || [])
        .filter(p => !q || (p.name || '').toLowerCase().includes(q) ||
            (p.steamId || '').includes(q) || (p.playerId || '').includes(q))
        .slice(0, MAX_CHOICES);
    return players.map(p => {
        const idForValue = p.playerId || p.steamId;
        const tag = p.playerId ? `BM:${p.playerId}` : `Steam:${p.steamId}`;
        const label = `${p.name || idForValue} (${tag})`.slice(0, 100);
        return { name: label, value: String(idForValue) };
    });
}

module.exports = {
    name: 'tracker',

    getData(client, guildId) {
        return new Builder.SlashCommandBuilder()
            .setName('tracker')
            .setDescription(client.intlGet(guildId, 'commandsTrackerDesc'))
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription(client.intlGet(guildId, 'commandsTrackerAddDesc'))
                .addStringOption(o => o
                    .setName('tracker')
                    .setDescription(client.intlGet(guildId, 'commandsTrackerOptionTrackerDesc'))
                    .setRequired(true)
                    .setAutocomplete(true))
                .addStringOption(o => o
                    .setName('player')
                    .setDescription(client.intlGet(guildId, 'commandsTrackerOptionPlayerDesc'))
                    .setRequired(true)
                    .setAutocomplete(true)))
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription(client.intlGet(guildId, 'commandsTrackerRemoveDesc'))
                .addStringOption(o => o
                    .setName('tracker')
                    .setDescription(client.intlGet(guildId, 'commandsTrackerOptionTrackerDesc'))
                    .setRequired(true)
                    .setAutocomplete(true))
                .addStringOption(o => o
                    .setName('player')
                    .setDescription(client.intlGet(guildId, 'commandsTrackerOptionRemovePlayerDesc'))
                    .setRequired(true)
                    .setAutocomplete(true)))
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription(client.intlGet(guildId, 'commandsTrackerListDesc'))
                .addStringOption(o => o
                    .setName('tracker')
                    .setDescription(client.intlGet(guildId, 'commandsTrackerOptionTrackerDesc'))
                    .setRequired(false)
                    .setAutocomplete(true)));
    },

    async autocomplete(client, interaction) {
        const guildId = interaction.guildId;
        const instance = client.getInstance(guildId);
        const focused = interaction.options.getFocused(true);

        try {
            if (focused.name === 'tracker') {
                await interaction.respond(trackerChoicesFromInstance(instance, focused.value));
                return;
            }
            if (focused.name === 'player') {
                const sub = interaction.options.getSubcommand();
                const trackerId = interaction.options.getString('tracker');
                const tracker = trackerId ? instance.trackers[trackerId] : null;

                if (sub === 'remove') {
                    /* Only suggest players already on the tracker. */
                    const choices = tracker ? existingPlayerChoices(tracker, focused.value) : [];
                    await interaction.respond(choices);
                    return;
                }

                /* add: search BM via the tracker's server. */
                if (!tracker) {
                    await interaction.respond([]);
                    return;
                }
                const bmInstance = client.battlemetricsInstances[tracker.battlemetricsId];
                const results = await PlayerSearch.search(bmInstance, tracker.battlemetricsId, focused.value);
                const choices = results.map(r => ({
                    name: `${r.isOnline ? '🟢 ' : ''}${r.name}`.slice(0, 100),
                    value: r.id,
                })).slice(0, MAX_CHOICES);
                await interaction.respond(choices);
                return;
            }
            await interaction.respond([]);
        }
        catch (e) {
            /* Never let autocomplete throw — Discord will show a UI error. */
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

        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
            const trackerId = interaction.options.getString('tracker');
            if (trackerId) {
                const tracker = instance.trackers[trackerId];
                if (!tracker) {
                    await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1,
                        client.intlGet(guildId, 'trackerNotFound', { id: trackerId })));
                    return;
                }
                const lines = (tracker.players || []).map(p =>
                    `• ${p.name || '-'} — BM:${p.playerId || '-'} Steam:${p.steamId || '-'}`);
                const body = lines.length ? lines.join('\n') : client.intlGet(guildId, 'empty');
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0,
                    `**${tracker.name}**\n${body}`));
                return;
            }
            const entries = Object.entries(instance.trackers || {});
            const lines = entries.map(([id, t]) =>
                `• \`#${id}\` ${t.name} — ${(t.players || []).length} players`);
            const body = lines.length ? lines.join('\n') : client.intlGet(guildId, 'empty');
            await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0, body));
            return;
        }

        const trackerId = interaction.options.getString('tracker');
        const tracker = instance.trackers[trackerId];
        if (!tracker) {
            await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1,
                client.intlGet(guildId, 'trackerNotFound', { id: trackerId })));
            return;
        }

        const playerKey = interaction.options.getString('player');

        if (sub === 'add') {
            const bmInstance = client.battlemetricsInstances[tracker.battlemetricsId];
            const bmPlayer = bmInstance ? bmInstance.players[playerKey] : null;

            /* Already on this tracker? */
            if (tracker.players.some(p => p.playerId === playerKey)) {
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1,
                    client.intlGet(guildId, 'trackerPlayerAlreadyAdded')));
                return;
            }

            let name = bmPlayer ? bmPlayer.name : null;
            let steamId = null;
            const playerId = playerKey;

            /* Player wasn't in the live online cache — try the autocomplete
               cache and finally a direct BM /players/{id} lookup so offline
               players show with their real name instead of just their BM id. */
            if (!name) {
                name = await PlayerSearch.resolveNameById(bmInstance, playerId);
            }

            if (!name) name = playerKey;
            if (tracker.clanTag) name = `${tracker.clanTag} ${name}`;

            tracker.players.push({ name, steamId, playerId });
            client.setInstance(guildId, instance);

            client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                id: `${verifyId}`,
                value: `tracker add ${trackerId} ${playerId}`,
            }));

            await DiscordMessages.sendTrackerMessage(guildId, trackerId);
            await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0,
                client.intlGet(guildId, 'trackerPlayerAdded', { name, tracker: tracker.name })));
            return;
        }

        if (sub === 'remove') {
            const before = tracker.players.length;
            tracker.players = tracker.players.filter(p =>
                p.playerId !== playerKey && p.steamId !== playerKey);
            if (tracker.players.length === before) {
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1,
                    client.intlGet(guildId, 'trackerPlayerNotOnTracker')));
                return;
            }
            client.setInstance(guildId, instance);

            client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
                id: `${verifyId}`,
                value: `tracker remove ${trackerId} ${playerKey}`,
            }));

            await DiscordMessages.sendTrackerMessage(guildId, trackerId);
            await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(0,
                client.intlGet(guildId, 'trackerPlayerRemoved', { tracker: tracker.name })));
            return;
        }
    },
};

// Silence unused-import lint in environments that flag it.
void Scrape;
