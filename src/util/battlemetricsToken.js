/*
    Runtime store for the Battlemetrics API token.

    Battlemetrics now requires an authenticated token for the endpoints this
    bot uses (server + player data). The token is bot-wide rather than
    per-guild — `client.battlemetricsInstances` is a single shared pool keyed
    by Battlemetrics server id, so a per-guild key would be meaningless the
    moment two guilds track the same server.

    Precedence:
      1. a token set at runtime with the `/battlemetrics set` slash command,
         persisted to `credentials/battlemetrics.json` (that directory is
         already a mounted volume in the Docker setup and is gitignored),
      2. the `RPP_BATTLEMETRICS_TOKEN` environment variable.

    With neither set, the whole Battlemetrics integration switches itself off
    instead of hammering the API with calls that can only ever return 401.
*/

const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');

const TOKEN_FILE = Path.join(__dirname, '..', '..', 'credentials', 'battlemetrics.json');

/* `undefined` means "not read from disk yet", `null` means "read, nothing
   stored". Distinguishing the two keeps us from re-reading the file on every
   single API call. */
let cachedFileToken = undefined;

function readFileToken() {
    if (cachedFileToken !== undefined) return cachedFileToken;

    try {
        const raw = Fs.readFileSync(TOKEN_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
        cachedFileToken = token === '' ? null : token;
    }
    catch (e) {
        /* Missing file is the normal case; a corrupt one shouldn't be fatal
           either — fall back to the environment variable. */
        cachedFileToken = null;
    }

    return cachedFileToken;
}

function envToken() {
    const token = typeof Config.battlemetrics.token === 'string' ? Config.battlemetrics.token.trim() : '';
    return token === '' ? null : token;
}

module.exports = {
    /**
     *  The token that should be used for Battlemetrics API calls.
     *  @return {string|null} The token, or null when the integration is disabled.
     */
    getToken: function () {
        return readFileToken() ?? envToken();
    },

    /**
     *  Whether the Battlemetrics integration should run at all.
     *  @return {boolean}
     */
    isEnabled: function () {
        return module.exports.getToken() !== null;
    },

    /**
     *  Where the active token came from, for status output.
     *  @return {string} 'command', 'env' or 'none'.
     */
    getSource: function () {
        if (readFileToken() !== null) return 'command';
        if (envToken() !== null) return 'env';
        return 'none';
    },

    /**
     *  A masked form of the active token, safe to show in Discord.
     *  @return {string|null} e.g. 'abcd…wxyz', or null when no token is set.
     */
    getMaskedToken: function () {
        const token = module.exports.getToken();
        if (token === null) return null;
        if (token.length <= 8) return '*'.repeat(token.length);
        return `${token.slice(0, 4)}${'*'.repeat(8)}${token.slice(-4)}`;
    },

    /**
     *  Persist a new token. Overrides the environment variable.
     *  @param {string} token The Battlemetrics API token.
     */
    setToken: function (token) {
        const trimmed = `${token}`.trim();
        if (trimmed === '') throw new Error('Battlemetrics token must not be empty');

        Fs.mkdirSync(Path.dirname(TOKEN_FILE), { recursive: true });
        Fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: trimmed }, null, 2), { mode: 0o600 });
        cachedFileToken = trimmed;
    },

    /**
     *  Forget a token set via the slash command. The environment variable (if
     *  any) becomes active again.
     */
    clearToken: function () {
        try {
            Fs.unlinkSync(TOKEN_FILE);
        }
        catch (e) {
            /* A missing file is the success case. Anything else (a read-only
               mount, a Windows lock) means the token is still on disk and
               would come back on the next restart — the caller has to be told
               rather than shown a "cleared" message. */
            if (e.code !== 'ENOENT') throw e;
        }
        cachedFileToken = null;
    },

    /**
     *  Standard request headers for the Battlemetrics API.
     *  @return {object} Headers object, empty when no token is configured.
     */
    getAuthHeaders: function () {
        const token = module.exports.getToken();
        return token === null ? {} : { Authorization: `Bearer ${token}` };
    }
};
