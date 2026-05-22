const { SlashCommandBuilder } = require('discord.js');

// Mock external dependencies
jest.mock('../../handlers/permissionHandler.js', () => ({
  getPermissionsRemoved: jest.fn().mockReturnValue('mock-perms'),
  resetPermissionsAllChannels: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../discordTools/discordTools.js', () => ({
  getGuild: jest.fn().mockReturnValue({ id: 'guild-123' }),
  getCategoryById: jest.fn(),
  clearTextChannel: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../discordTools/SetupSettingsMenu', () => jest.fn().mockResolvedValue(true));

// Mock Config and DiscordEmbeds correctly
jest.mock('../../structures/Config', () => ({
  discord: {
    needAdminPrivileges: true
  }
}), { virtual: true });

jest.mock('../../structures/DiscordEmbeds', () => ({
  getActionInfoEmbed: jest.fn().mockReturnValue('embed-data')
}), { virtual: true });

const PermissionHandler = require('../../handlers/permissionHandler.js');
const DiscordTools = require('../../discordTools/discordTools.js');
const SetupSettingsMenu = require('../../discordTools/SetupSettingsMenu');

const resetCommand = require('../reset');

describe('reset command', () => {
  let client;
  let interaction;

  beforeEach(() => {
    client = {
      validatePermissions: jest.fn().mockResolvedValue(true),
      isAdministrator: jest.fn().mockReturnValue(true),
      intlGet: jest.fn().mockReturnValue('mock-string'),
      log: jest.fn(),
      interactionEditReply: jest.fn().mockResolvedValue(true),
      getInstance: jest.fn().mockReturnValue({
        channelId: {
          category: 'category-123'
        }
      }),
      logInteraction: jest.fn()
    };

    interaction = {
      guildId: 'guild-123',
      deferReply: jest.fn().mockResolvedValue(true),
      options: {
        getSubcommand: jest.fn()
      }
    };

    jest.clearAllMocks();
  });

  describe('settings subcommand', () => {
    it('should handle entity deletion error path (ignore error)', async () => {
      interaction.options.getSubcommand.mockReturnValue('settings');

      const mockCategory = {
        permissionOverwrites: {
          set: jest.fn().mockRejectedValue(new Error('Entity deletion error'))
        }
      };
      DiscordTools.getCategoryById.mockResolvedValue(mockCategory);

      // Execute the command handler
      await resetCommand.execute(client, interaction);

      // Verification steps
      expect(DiscordTools.getCategoryById).toHaveBeenCalledWith('guild-123', 'category-123');
      expect(mockCategory.permissionOverwrites.set).toHaveBeenCalledWith('mock-perms');

      // The function should not throw, meaning it ignored the error and continued execution
      expect(SetupSettingsMenu).toHaveBeenCalledWith(client, { id: 'guild-123' }, true);
      expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(client, { id: 'guild-123' });
      expect(client.interactionEditReply).toHaveBeenCalled();
    });

    it('should successfully set permissions when no error occurs', async () => {
      interaction.options.getSubcommand.mockReturnValue('settings');

      const mockCategory = {
        permissionOverwrites: {
          set: jest.fn().mockResolvedValue(true)
        }
      };
      DiscordTools.getCategoryById.mockResolvedValue(mockCategory);

      // Execute the command handler
      await resetCommand.execute(client, interaction);

      // Verification steps
      expect(DiscordTools.getCategoryById).toHaveBeenCalledWith('guild-123', 'category-123');
      expect(mockCategory.permissionOverwrites.set).toHaveBeenCalledWith('mock-perms');

      // Continued execution
      expect(SetupSettingsMenu).toHaveBeenCalledWith(client, { id: 'guild-123' }, true);
      expect(PermissionHandler.resetPermissionsAllChannels).toHaveBeenCalledWith(client, { id: 'guild-123' });
      expect(client.interactionEditReply).toHaveBeenCalled();
    });
  });
});
