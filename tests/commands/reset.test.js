const reset = require('../../src/commands/reset.js');
const DiscordTools = require('../../src/discordTools/discordTools.js');
const PermissionHandler = require('../../src/handlers/permissionHandler.js');
const DiscordMessages = require('../../src/discordTools/discordMessages.js');

jest.mock('../../src/discordTools/discordTools.js', () => ({
    getGuild: jest.fn(),
    getCategoryById: jest.fn(),
    clearTextChannel: jest.fn()
}));

jest.mock('../../src/handlers/permissionHandler.js', () => ({
    getPermissionsRemoved: jest.fn(),
    resetPermissionsAllChannels: jest.fn()
}));

jest.mock('../../config/index.js', () => ({
    discord: { needAdminPrivileges: false }
}));

jest.mock('../../src/discordTools/discordEmbeds.js', () => ({
    getActionInfoEmbed: jest.fn()
}));

jest.mock('../../src/discordTools/discordMessages.js', () => ({
    sendUpdateMapInformationMessage: jest.fn()
}));

jest.mock('@discordjs/builders', () => ({
    SlashCommandBuilder: jest.fn().mockImplementation(() => ({
        setName: jest.fn().mockReturnThis(),
        setDescription: jest.fn().mockReturnThis(),
        addSubcommand: jest.fn().mockReturnThis(),
    }))
}));

jest.mock('../../src/discordTools/SetupSwitches.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupSwitchGroups.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupAlarms.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupStorageMonitors.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupTrackers.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupServerList.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupSettingsMenu.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupGuildCategory.js', () => jest.fn());
jest.mock('../../src/discordTools/SetupGuildChannels.js', () => jest.fn());
jest.mock('../../src/discordTools/RemoveGuildChannels.js', () => jest.fn());

describe('reset command', () => {
    let mockClient, mockInteraction, mockGuild;

    beforeEach(() => {
        jest.clearAllMocks();

        mockGuild = {
            id: 'guild123',
        };

        mockClient = {
            getInstance: jest.fn().mockReturnValue({
                channelId: {
                    switches: 'switchesId',
                    switchGroups: 'switchGroupsId',
                    category: 'categoryId',
                    information: 'informationId',
                    storageMonitors: 'storageMonitorsId'
                }
            }),
            logInteraction: jest.fn(),
            validatePermissions: jest.fn().mockResolvedValue(true),
            isAdministrator: jest.fn().mockReturnValue(true),
            intlGet: jest.fn().mockImplementation((guildId, key) => key),
            log: jest.fn(),
            rustplusInstances: {
                'guild123': {
                    isOperational: true,
                    map: {
                        writeMap: jest.fn().mockResolvedValue()
                    }
                }
            },
            interactionReply: jest.fn(),
            interactionEditReply: jest.fn(),
        };

        mockInteraction = {
            guildId: mockGuild.id,
            options: {
                getSubcommand: jest.fn().mockReturnValue('switches')
            },
            deferReply: jest.fn().mockResolvedValue()
        };

        DiscordTools.getGuild.mockReturnValue(mockGuild);
        PermissionHandler.getPermissionsRemoved.mockReturnValue(['mockPerms']);
    });

    describe('switches subcommand', () => {
        it('should handle category permission set error path gracefully', async () => {
            const mockCategory = {
                permissionOverwrites: {
                    set: jest.fn().mockRejectedValue(new Error('Simulated failure setting permissions'))
                }
            };
            DiscordTools.getCategoryById.mockResolvedValue(mockCategory);

            await reset.execute(mockClient, mockInteraction);

            expect(DiscordTools.getCategoryById).toHaveBeenCalledWith(mockGuild.id, 'categoryId');
            expect(mockCategory.permissionOverwrites.set).toHaveBeenCalledWith(['mockPerms']);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });

        it('should handle getting category error path gracefully', async () => {
            DiscordTools.getCategoryById.mockRejectedValue(new Error('Simulated failure fetching category'));

            await reset.execute(mockClient, mockInteraction);

            expect(DiscordTools.getCategoryById).toHaveBeenCalledWith(mockGuild.id, 'categoryId');
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });
    });

    describe('other subcommands error paths', () => {
        it('discord subcommand should handle category permission error gracefully', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('discord');
            const mockCategory = {
                permissionOverwrites: {
                    set: jest.fn().mockRejectedValue(new Error('Simulated failure setting perms'))
                }
            };
            require('../../src/discordTools/SetupGuildCategory.js').mockResolvedValue(mockCategory);

            await reset.execute(mockClient, mockInteraction);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });

        it('servers subcommand should handle category permission error gracefully', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('servers');
            DiscordTools.getCategoryById.mockRejectedValue(new Error('Simulated failure fetching category'));

            await reset.execute(mockClient, mockInteraction);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });

        it('settings subcommand should handle category permission error gracefully', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('settings');
            DiscordTools.getCategoryById.mockRejectedValue(new Error('Simulated failure fetching category'));

            await reset.execute(mockClient, mockInteraction);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });

        it('storagemonitors subcommand should handle category permission error gracefully', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('storagemonitors');
            DiscordTools.getCategoryById.mockRejectedValue(new Error('Simulated failure fetching category'));

            await reset.execute(mockClient, mockInteraction);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });

        it('trackers subcommand should handle category permission error gracefully', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('trackers');
            DiscordTools.getCategoryById.mockRejectedValue(new Error('Simulated failure fetching category'));

            await reset.execute(mockClient, mockInteraction);
            expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(mockClient, mockGuild);
        });
    });
});
