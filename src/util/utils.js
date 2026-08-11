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

const Fs = require('fs');
const Path = require('path');

/* Static lookup table, loaded once at module load instead of on every
   decodeHtml() call (which runs on a hot path during profile scraping). */
const HTML_RESERVED_SYMBOLS = JSON.parse(Fs.readFileSync(
    Path.join(__dirname, '..', 'staticFiles', 'htmlReservedSymbols.json'), 'utf8'));

module.exports = {
    parseArgs: function (str) {
        return str.trim().split(/[ ]+/);
    },

    getArgs: function (str, n = 0) {
        const args = this.parseArgs(str);
        if (isNaN(n)) n = 0;
        if (n < 1) return args;
        const newArgs = [];

        let remain = str;
        let counter = 1;
        for (const arg of args) {
            if (counter === n) {
                newArgs.push(remain);
                break;
            }
            remain = remain.slice(arg.length).trim();
            newArgs.push(arg);
            counter += 1;
        }

        return newArgs;
    },

    decodeHtml: function (str) {
        if (!str) return str;

        const htmlReservedSymbols = HTML_RESERVED_SYMBOLS;

        for (const [key, value] of Object.entries(htmlReservedSymbols)) {
            str = str.replaceAll(key, value);
        }

        return str;
    },

    removeInvisibleCharacters: function (str) {
        str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
        return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    },

    /* Names have to be compared the same way on both sides of a match. The
       Battlemetrics roster is stripped of invisible characters on ingest while
       a scraped Steam persona is not, so a single zero-width character in a
       name made every exact match fail and left the player unlinked forever. */
    normalizePlayerName: function (str) {
        return module.exports.removeInvisibleCharacters(`${str ?? ''}`).trim();
    },

    /* Playtime as it appears on a tracker card, where it shares a narrow column
       with an emoji and a timer. Thousands are abbreviated because a five
       figure Rust veteran is common and "12.4k h" costs half of what the exact
       number would; below 1000 the hour is exact, since the difference between
       40 h and 400 h is the whole point of showing it. Returns null for
       anything that isn't a usable number, so callers can simply omit it. */
    formatPlaytimeHours: function (hours) {
        if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) return null;
        if (hours < 1000) return `${Math.round(hours)} h`;
        return `${(hours / 1000).toFixed(1)}k h`;
    },

    /* Map with a fixed number of workers, preserving input order. Used where a
       list command would otherwise choose between an N-wide burst that gets the
       host 403'd by Steam and a serial loop that can outlive the interaction. */
    mapWithConcurrency: async function (items, limit, fn) {
        const results = new Array(items.length);
        let next = 0;

        const worker = async () => {
            while (true) {
                const index = next;
                next += 1;
                if (index >= items.length) return;
                results[index] = await fn(items[index], index);
            }
        };

        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    },

    findClosestString: function (string, array, threshold = 2) {
        let minDistance = Infinity;
        let closestString = null;

        for (let i = 0; i < array.length; i++) {
            const currentString = array[i];
            const distance = levenshteinDistance(string, currentString);

            if (distance < minDistance) {
                minDistance = distance;
                closestString = currentString;
            }

            if (minDistance === 0) break;
        }

        return minDistance > threshold ? null : closestString;
    },
}

/* Function to calculate Levenshtein distance between two strings */
function levenshteinDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();

    const m = s1.length;
    const n = s2.length;
    const dp = [];

    for (let i = 0; i <= m; i++) {
        dp[i] = [i];
    }
    for (let j = 0; j <= n; j++) {
        dp[0][j] = j;
    }

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            }
            else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],
                    dp[i][j - 1],
                    dp[i - 1][j - 1]
                );
            }
        }
    }

    return dp[m][n];
}