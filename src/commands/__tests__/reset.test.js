const DiscordTools = require('../../discordTools/discordTools.js');
const PermissionHandler = require('../../handlers/permissionHandler.js');

jest.mock('../../discordTools/discordTools.js');
jest.mock('../../handlers/permissionHandler.js');
jest.mock('../../discordTools/SetupStorageMonitors.js', () => jest.fn());
jest.mock('../../discordTools/discordEmbeds.js', () => ({
    getActionInfoEmbed: jest.fn().mockReturnValue({})
}));
jest.mock('../../discordTools/discordMessages.js', () => ({}));
jest.mock('../../structures/DiscordBot.js', () => jest.fn());
jest.mock('../../../index.ts', () => ({}));
jest.mock('../../discordTools/RemoveGuildChannels.js', () => jest.fn());
jest.mock('../../discordTools/SetupGuildCategory.js', () => jest.fn());
jest.mock('../../discordTools/SetupGuildChannels.js', () => jest.fn());
jest.mock('../../discordTools/SetupServerList.js', () => jest.fn());
jest.mock('../../discordTools/SetupSettingsMenu.js', () => jest.fn());
jest.mock('../../discordTools/SetupSwitches.js', () => jest.fn());
jest.mock('../../discordTools/SetupSwitchGroups.js', () => jest.fn());
jest.mock('../../discordTools/SetupAlarms.js', () => jest.fn());
jest.mock('../../discordTools/SetupTrackers.js', () => jest.fn());
jest.mock('../../../config', () => ({
    discord: { needAdminPrivileges: false },
    rustplus: { language: 'en' },
    general: { pollingIntervalMs: 1000 }
}), { virtual: true });

const resetCommand = require('../reset.js');

describe('reset command', () => {
    let client, interaction;

    beforeEach(() => {
        client = {
            getInstance: jest.fn().mockReturnValue({
                channelId: {
                    category: 'cat_id',
                    storageMonitors: 'sm_id'
                }
            }),
            validatePermissions: jest.fn().mockResolvedValue(true),
            isAdministrator: jest.fn().mockReturnValue(true),
            intlGet: jest.fn().mockReturnValue('mocked_string'),
            logInteraction: jest.fn(),
            log: jest.fn(),
            interactionEditReply: jest.fn(),
            rustplusInstances: {
                'guild_id': {
                    isOperational: true
                }
            }
        };

        interaction = {
            guildId: 'guild_id',
            options: {
                getSubcommand: jest.fn().mockReturnValue('storagemonitors')
            },
            deferReply: jest.fn().mockResolvedValue()
        };

        DiscordTools.getGuild.mockReturnValue({ id: 'guild_id' });
        PermissionHandler.getPermissionsRemoved.mockReturnValue([]);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('storagemonitors reset - success path', async () => {
        const categoryMock = {
            permissionOverwrites: {
                set: jest.fn().mockResolvedValue()
            }
        };
        DiscordTools.getCategoryById.mockResolvedValue(categoryMock);

        await resetCommand.execute(client, interaction);

        expect(DiscordTools.clearTextChannel).toHaveBeenCalledWith('guild_id', 'sm_id', 100);
        expect(categoryMock.permissionOverwrites.set).toHaveBeenCalled();
        expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalled();
        expect(client.log).toHaveBeenCalled();
    });

    test('storagemonitors reset - category set permissions error path', async () => {
        const categoryMock = {
            permissionOverwrites: {
                set: jest.fn().mockRejectedValue(new Error('Discord API Error'))
            }
        };
        DiscordTools.getCategoryById.mockResolvedValue(categoryMock);

        await resetCommand.execute(client, interaction);

        expect(DiscordTools.clearTextChannel).toHaveBeenCalledWith('guild_id', 'sm_id', 100);
        expect(categoryMock.permissionOverwrites.set).toHaveBeenCalled();
        // Since error is caught, the execution should continue to the end
        expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalled();
        expect(client.log).toHaveBeenCalled();
    });
});
