const reset = require('../reset.js');
const DiscordTools = require('../../discordTools/discordTools.js');
const PermissionHandler = require('../../handlers/permissionHandler.js');

jest.mock('../../discordTools/discordTools.js');
jest.mock('../../handlers/permissionHandler.js');
jest.mock('../../discordTools/RemoveGuildChannels', () => jest.fn());
jest.mock('../../discordTools/SetupGuildCategory', () => jest.fn());
jest.mock('../../discordTools/SetupGuildChannels', () => jest.fn());
jest.mock('../../discordTools/SetupServerList', () => jest.fn());
jest.mock('../../discordTools/SetupSettingsMenu', () => jest.fn());
jest.mock('../../discordTools/SetupSwitches', () => jest.fn());
jest.mock('../../discordTools/SetupSwitchGroups', () => jest.fn());
jest.mock('../../discordTools/SetupAlarms', () => jest.fn());
jest.mock('../../discordTools/SetupStorageMonitors', () => jest.fn());
jest.mock('../../discordTools/SetupTrackers', () => jest.fn());

describe('reset command', () => {
    let mockClient;
    let mockInteraction;
    let mockCategory;
    let mockGuild;

    beforeEach(() => {
        jest.clearAllMocks();

        mockCategory = {
            permissionOverwrites: {
                set: jest.fn()
            }
        };

        const SetupGuildCategory = require('../../discordTools/SetupGuildCategory');
        SetupGuildCategory.mockResolvedValue(mockCategory);

        DiscordTools.getGuild.mockReturnValue({ id: 'guild-id' });
        PermissionHandler.getPermissionsRemoved.mockReturnValue([]);

        mockClient = {
            getInstance: jest.fn().mockReturnValue({
                channelId: {
                    information: 'info-id',
                    switches: 'switches-id',
                    switchGroups: 'groups-id',
                    storageMonitors: 'monitors-id',
                    category: 'cat-id'
                }
            }),
            logInteraction: jest.fn(),
            validatePermissions: jest.fn().mockResolvedValue(true),
            isAdministrator: jest.fn().mockReturnValue(true),
            interactionReply: jest.fn(),
            interactionEditReply: jest.fn(),
            log: jest.fn(),
            intlGet: jest.fn().mockReturnValue('mocked-string'),
            rustplusInstances: {}
        };

        mockInteraction = {
            guildId: 'guild-id',
            options: {
                getSubcommand: jest.fn().mockReturnValue('discord')
            },
            deferReply: jest.fn().mockResolvedValue(true)
        };
    });

    it('should ignore error when category.permissionOverwrites.set fails', async () => {
        // Arrange
        mockCategory.permissionOverwrites.set.mockRejectedValue(new Error('Permission set failed'));

        // Act
        await reset.execute(mockClient, mockInteraction);

        // Assert
        expect(mockCategory.permissionOverwrites.set).toHaveBeenCalled();
        expect(mockClient.log).toHaveBeenCalledWith('mocked-string', 'mocked-string');
    });
});
