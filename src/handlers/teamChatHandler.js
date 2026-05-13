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

const DiscordMessages = require('../discordTools/discordMessages.js');
const TeamChatTranslate = require('../util/teamChatTranslate.js');

module.exports = async function (rustplus, client, message) {
    await DiscordMessages.sendTeamChatMessage(rustplus.guildId, message);

    /* Optional: if the message isn't English or German, post an English
       translation to the dedicated translated-teamchat channel. Failures
       here must never block the main team-chat handling. */
    if (rustplus.generalSettings && rustplus.generalSettings.teamChatTranslateEnabled) {
        try {
            const result = await TeamChatTranslate.detectAndTranslate(message.message);
            if (result.shouldPost) {
                await DiscordMessages.sendTeamChatTranslatedMessage(
                    rustplus.guildId, message, result.translatedText, result.detected);
            }
            else {
                /* Log why we skipped so it's diagnosable from the bot log
                   without needing extra Discord noise. */
                const reason = result.error ? `error=${result.error}`
                    : result.reason ? `reason=${result.reason}`
                        : `detected=${result.detected || 'n/a'}`;
                client.log(client.intlGet(null, 'infoCap'),
                    `teamChatTranslate skip: ${reason} text="${message.message}"`);
            }
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'),
                `teamChatTranslate failed: ${e.message}`, 'error');
        }
    }
}
