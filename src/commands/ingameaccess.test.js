const ingameaccess = require('./ingameaccess.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');

describe('ensureGeneralSettings', () => {
	it('should create generalSettings and default mode to blacklist if not present', () => {
		const instance = {};
		ingameaccess.ensureGeneralSettings(instance);
		expect(instance.generalSettings).toBeDefined();
		expect(instance.generalSettings.inGameCommandAccessMode).toBe('blacklist');
	});

	it('should keep whitelist mode if generalSettings already has it', () => {
		const instance = { generalSettings: { inGameCommandAccessMode: 'whitelist' } };
		ingameaccess.ensureGeneralSettings(instance);
		expect(instance.generalSettings).toBeDefined();
		expect(instance.generalSettings.inGameCommandAccessMode).toBe('whitelist');
	});

	it('should normalize invalid modes to blacklist', () => {
		const instance = { generalSettings: { inGameCommandAccessMode: 'invalid' } };
		ingameaccess.ensureGeneralSettings(instance);
		expect(instance.generalSettings).toBeDefined();
		expect(instance.generalSettings.inGameCommandAccessMode).toBe('blacklist');
	});
});

describe('normalizeAccessMode', () => {
	it('should normalize to blacklist as default', () => {
		expect(ingameaccess.normalizeAccessMode(null)).toBe('blacklist');
		expect(ingameaccess.normalizeAccessMode(undefined)).toBe('blacklist');
		expect(ingameaccess.normalizeAccessMode('')).toBe('blacklist');
		expect(ingameaccess.normalizeAccessMode('invalid')).toBe('blacklist');
	});

	it('should normalize whitelist to whitelist', () => {
		expect(ingameaccess.normalizeAccessMode('whitelist')).toBe('whitelist');
		expect(ingameaccess.normalizeAccessMode('WHITELIST')).toBe('whitelist');
	});

	it('should normalize blacklist to blacklist', () => {
		expect(ingameaccess.normalizeAccessMode('blacklist')).toBe('blacklist');
		expect(ingameaccess.normalizeAccessMode('BLACKLIST')).toBe('blacklist');
	});
});

describe('getListCount', () => {
	it('should return 0 if listType not present', () => {
		expect(ingameaccess.getListCount({}, 'whitelist')).toBe(0);
	});

	it('should return 0 if listType has no steamIds', () => {
		expect(ingameaccess.getListCount({ whitelist: {} }, 'whitelist')).toBe(0);
	});

	it('should return 0 if steamIds is not an array', () => {
		expect(ingameaccess.getListCount({ whitelist: { steamIds: 'invalid' } }, 'whitelist')).toBe(0);
	});

	it('should return correct count if steamIds is an array', () => {
		expect(ingameaccess.getListCount({ whitelist: { steamIds: ['id1', 'id2'] } }, 'whitelist')).toBe(2);
	});
});

describe('execute', () => {
	let client, interaction;

	beforeEach(() => {
		client = {
			getInstance: jest.fn().mockReturnValue({}),
			setInstance: jest.fn(),
			rustplusInstances: {},
			logInteraction: jest.fn(),
			validatePermissions: jest.fn().mockResolvedValue(true),
			isAdministrator: jest.fn().mockReturnValue(true),
			intlGet: jest.fn().mockImplementation((guildId, key) => key),
			interactionReply: jest.fn(),
			interactionEditReply: jest.fn(),
			log: jest.fn()
		};

		interaction = {
			guildId: 'guild-123',
			deferReply: jest.fn(),
			options: {
				getSubcommand: jest.fn(),
				getString: jest.fn()
			}
		};
	});

	it('should return if validatePermissions returns false', async () => {
		client.validatePermissions.mockResolvedValue(false);
		await ingameaccess.execute(client, interaction);
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it('should handle non-administrator access', async () => {
		client.isAdministrator.mockReturnValue(false);
		await ingameaccess.execute(client, interaction);
		expect(client.interactionReply).toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it('should set mode and update instance for mode subcommand', async () => {
		interaction.options.getSubcommand.mockReturnValue('mode');
		interaction.options.getString.mockReturnValue('whitelist');
		const mockInstance = {};
		client.getInstance.mockReturnValue(mockInstance);

		await ingameaccess.execute(client, interaction);

		expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
		expect(client.setInstance).toHaveBeenCalledWith('guild-123', expect.objectContaining({
			generalSettings: { inGameCommandAccessMode: 'whitelist' }
		}));
		expect(client.interactionEditReply).toHaveBeenCalled();
	});

	it('should show current access for show subcommand', async () => {
		interaction.options.getSubcommand.mockReturnValue('show');
		const mockInstance = {
			generalSettings: { inGameCommandAccessMode: 'whitelist' },
			whitelist: { steamIds: ['123'] },
			blacklist: { steamIds: ['456', '789'] }
		};
		client.getInstance.mockReturnValue(mockInstance);

		await ingameaccess.execute(client, interaction);

		expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
		expect(client.interactionEditReply).toHaveBeenCalledWith(interaction, expect.objectContaining({
			ephemeral: true,
			embeds: expect.any(Array)
		}));
	});
});
