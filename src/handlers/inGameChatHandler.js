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

const Constants = require("../util/constants");

module.exports = {
    inGameChatHandler: async function (rustplus, client, message = null, force = false) {
        const guildId = rustplus.guildId;
        const generalSettings = rustplus.generalSettings;
        const commandDelayMs = parseInt(generalSettings.commandDelay) * 1000;
        const trademark = generalSettings.trademark;
        const trademarkString = (trademark === 'NOT SHOWING') ? '' : `${trademark} | `;
        const messageMaxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - trademarkString.length;

        /* Time to write a message from the queue. If message === null, that means that its a timer call. */
        if (message === null) {
            if (rustplus.inGameChatQueue.length !== 0) {
                clearTimeout(rustplus.inGameChatTimeout);
                rustplus.inGameChatTimeout = null;

                const messageFromQueue = rustplus.inGameChatQueue[0];
                rustplus.inGameChatQueue = rustplus.inGameChatQueue.slice(1);

                rustplus.updateBotMessages(messageFromQueue);

                /* sendTeamMessageAsync never rejects: it returns
                   {error: 'tokensDidNotReplenish'} when the token bucket is
                   empty, and its own .catch turns a timeout or an AppError into
                   a resolved value. This is its only call site in the repo, so
                   nothing else validates it — the result used to be discarded
                   and the line below logged the message as sent regardless.
                   Command replies, alarm notifications and raid alerts could
                   vanish while the log positively asserted delivery.

                   Deliberately not awaited: this runs on the chat queue timer,
                   and awaiting would stall the next queued message for the full
                   10 s request timeout. Deliberately not routed through
                   rustplus.isResponseValid() either — its empty-response branch
                   calls clearInterval(this.pollingTaskId), which would kill the
                   poll loop over a failed chat line. */
                rustplus.sendTeamMessageAsync(messageFromQueue).then((response) => {
                    const failed = !response || response.error !== undefined ||
                        response instanceof Error;
                    if (failed) {
                        /* One line per outage, not one per queued message: a
                           dead socket drains the whole queue at once. */
                        if (!rustplus.inGameSendFailing) {
                            rustplus.inGameSendFailing = true;
                            rustplus.log(client.intlGet(null, 'errorCap'),
                                client.intlGet(null, 'inGameMessageSendFailed', {
                                    error: (response && response.error) ? response.error : `${response}`,
                                    message: messageFromQueue
                                }), 'error');
                        }
                        return;
                    }

                    if (rustplus.inGameSendFailing) {
                        rustplus.inGameSendFailing = false;
                        rustplus.log(client.intlGet(null, 'infoCap'),
                            client.intlGet(null, 'inGameMessageSendRecovered'));
                    }
                    rustplus.log(client.intlGet(guildId, 'messageCap'), messageFromQueue);
                });
            }
            else {
                clearTimeout(rustplus.inGameChatTimeout);
                rustplus.inGameChatTimeout = null;
            }
        }

        /* if there is a new message, add message to queue. */
        if (message !== null) {
            if (rustplus.team === null || rustplus.team.allOffline ||
                (!force && rustplus.generalSettings.muteInGameBotMessages)) {
                return;
            }

            if (Array.isArray(message)) {
                for (const msg of message) {
                    handleMessage(rustplus, msg, trademarkString, messageMaxLength)
                }
            }
            else if (typeof message === 'string') {
                handleMessage(rustplus, message, trademarkString, messageMaxLength)
            }
        }

        /* Start new timer? */
        if (rustplus.inGameChatQueue.length !== 0 && rustplus.inGameChatTimeout === null) {
            rustplus.inGameChatTimeout = setTimeout(module.exports.inGameChatHandler, commandDelayMs, rustplus, client);
        }
    },
};

function handleMessage(rustplus, message, trademarkString, maxLength) {
    if (typeof message !== 'string') return;

    /* `.match()` with a global regex returns null when the input has no
       matches — e.g. an empty string. Without the guard the for-of below
       throws TypeError. */
    const strings = message.match(new RegExp(`.{1,${maxLength}}(\\s|$)`, 'g'));
    if (!strings) return;

    for (const str of strings) {
        rustplus.inGameChatQueue.push(`${trademarkString}${str}`);
    }
}
