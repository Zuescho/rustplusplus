const reset = require('../src/commands/reset.js');
const DiscordTools = require('../src/discordTools/discordTools.js');
const PermissionHandler = require('../src/handlers/permissionHandler.js');

jest.mock('../src/discordTools/discordTools.js', () => ({
	getGuild: jest.fn(),
	getCategoryById: jest.fn(),
	clearTextChannel: jest.fn()
}));
jest.mock('../src/handlers/permissionHandler.js', () => ({
	getPermissionsRemoved: jest.fn().mockReturnValue([]),
	resetPermissionsAllChannels: jest.fn().mockResolvedValue()
}));
jest.mock('../src/discordTools/SetupServerList', () => jest.fn());
jest.mock('../src/discordTools/discordEmbeds.js', () => ({
	getActionInfoEmbed: jest.fn().mockReturnValue({})
}));
jest.mock('../src/discordTools/discordMessages.js', () => ({}));
jest.mock('../config', () => ({ discord: { needAdminPrivileges: false } }));
jest.mock('@discordjs/builders', () => ({
	SlashCommandBuilder: class {
		setName() { return this; }
		setDescription() { return this; }
		addSubcommand() { return this; }
	}
}), { virtual: true });

describe('reset command', () => {
	it('should gracefully handle permission overwrite throw for "servers" command', async () => {
		const client = {
			getInstance: jest.fn().mockReturnValue({ channelId: { category: 'cat-123' } }),
			logInteraction: jest.fn(),
			validatePermissions: jest.fn().mockResolvedValue(true),
			intlGet: jest.fn().mockReturnValue('mocked intl'),
			log: jest.fn(),
			isAdministrator: jest.fn().mockReturnValue(true),
			interactionEditReply: jest.fn().mockResolvedValue()
		};

		const interaction = {
			guildId: 'guild-123',
			deferReply: jest.fn().mockResolvedValue(),
			options: {
				getSubcommand: jest.fn().mockReturnValue('servers'),
			},
		};

		const guild = { id: 'guild-123' };
		DiscordTools.getGuild.mockReturnValue(guild);

		const categoryMock = {
			permissionOverwrites: {
				set: jest.fn().mockRejectedValue(new Error('Mock database error')),
			},
		};
		DiscordTools.getCategoryById.mockReturnValue(categoryMock);

		await expect(reset.execute(client, interaction)).resolves.not.toThrow();

		expect(categoryMock.permissionOverwrites.set).toHaveBeenCalled();
	});
});
