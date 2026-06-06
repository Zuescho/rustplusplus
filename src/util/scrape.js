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

const Axios = require('axios');

const Constants = require('../util/constants.js');
const Utils = require('../util/utils.js');

module.exports = {
    scrape: async function (url) {
        try {
            return await Axios.get(url);
        }
        catch (e) {
            return {};
        }
    },

    scrapeSteamProfilePicture: async function (client, steamId) {
        const response = await module.exports.scrape(`${Constants.STEAM_PROFILES_URL}${steamId}`);

        if (response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfilePicture', {
                link: `${Constants.STEAM_PROFILES_URL}${steamId}`
            }), 'error');
            return null;
        }

        /* Non-greedy so we stop at the first `_full.jpg` (the avatar, which Steam
           also emits early in og:image) instead of letting `.*` run to the last
           one on the page and capture a corrupted span. */
        let png = response.data.match(/<img src="(.*?_full.jpg)(.*?(?="))/);
        if (png) {
            return png[1];
        }

        return null;
    },

    scrapeSteamIdFromVanity: async function (client, vanity) {
        /* Encode the vanity segment — it comes from user input (a typed handle
           or a pasted profile URL) and could contain URL-significant chars. */
        const safeVanity = encodeURIComponent(vanity);
        const response = await module.exports.scrape(
            `https://steamcommunity.com/id/${safeVanity}?xml=1`);

        if (response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfileName', {
                link: `https://steamcommunity.com/id/${safeVanity}`
            }), 'error');
            return null;
        }

        let match = response.data.match(/<steamID64>(\d{17})<\/steamID64>/);
        if (match) {
            return match[1];
        }

        match = response.data.match(/steamcommunity\.com\/profiles\/(\d{17})/);
        if (match) {
            return match[1];
        }

        return null;
    },

    scrapeSteamProfileName: async function (client, steamId) {
        const response = await module.exports.scrape(`${Constants.STEAM_PROFILES_URL}${steamId}`);

        if (response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfileName', {
                link: `${Constants.STEAM_PROFILES_URL}${steamId}`
            }), 'error');
            return null;
        }

        let regex = new RegExp(`class="actual_persona_name">(.+?)</span>`, 'gm');
        let data = regex.exec(response.data);
        if (data) {
            return Utils.decodeHtml(data[1]);
        }

        return null;
    },
}