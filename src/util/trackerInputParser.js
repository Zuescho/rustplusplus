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

const Constants = require('./constants.js');

function normalizeInput(input) {
    return input.trim().replace(/^<|>$/g, '');
}

function isSteamId64(input) {
    return /^\d{17}$/.test(input);
}

function isBattlemetricsPlayerId(input) {
    return /^\d+$/.test(input) && input.length < Constants.STEAMID64_LENGTH;
}

function parseSteamProfileUrl(url) {
    const match = url.match(/steamcommunity\.com\/profiles\/(\d{17})/);
    return match ? match[1] : null;
}

function parseSteamVanityUrl(url) {
    const match = url.match(/steamcommunity\.com\/id\/([^\/\s?#]+)/);
    return match ? match[1] : null;
}

function parseBattlemetricsPlayerUrl(url) {
    const match = url.match(/battlemetrics\.com\/players\/(\d+)/);
    return match ? match[1] : null;
}

module.exports = {
    parseTrackerPlayerInput: function (input) {
        const normalized = normalizeInput(input);

        if (!normalized) {
            return { valid: false, value: null, type: null, normalizedInput: normalized };
        }

        if (isSteamId64(normalized)) {
            return { valid: true, value: normalized, type: 'steamId', normalizedInput: normalized };
        }

        if (isBattlemetricsPlayerId(normalized)) {
            return { valid: true, value: normalized, type: 'battlemetricsId', normalizedInput: normalized };
        }

        /* Try URL parsing */
        const steamProfileId = parseSteamProfileUrl(normalized);
        if (steamProfileId) {
            return { valid: true, value: steamProfileId, type: 'steamId', normalizedInput: normalized };
        }

        const steamVanity = parseSteamVanityUrl(normalized);
        if (steamVanity) {
            return { valid: true, value: steamVanity, type: 'steamVanityUrl', normalizedInput: normalized };
        }

        const bmPlayerId = parseBattlemetricsPlayerUrl(normalized);
        if (bmPlayerId) {
            return { valid: true, value: bmPlayerId, type: 'battlemetricsId', normalizedInput: normalized };
        }

        return { valid: false, value: null, type: null, normalizedInput: normalized };
    }
};
