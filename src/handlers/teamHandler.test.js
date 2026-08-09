const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* The Discord message helpers reach the client through `require('../../index.ts')`,
   which boots the whole bot on import. Seed the module cache with a stub. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: { client: { intlGet: (guildId, id) => id, getInstance: () => ({}) } }
};

const Config = require('../../config');
const DiscordMessages = require('../discordTools/discordMessages.js');
const Scrape = require('../util/scrape.js');
const TeamHandler = require('./teamHandler.js');

const AVATAR_HTML = '<img src="https://avatars.example/abc_full.jpg" alt="x">';
const IDS = ['76561198996560458', '76561198996560459', '76561198996560460'];

/* Stub the HTTP layer rather than the scraper, so the real avatar cache does
   its real work — the whole point of these tests is what it stops. */
async function withScrape(stub, fn) {
    const original = Scrape.scrape;
    const calls = [];
    Scrape.scrape = async (url) => {
        calls.push(url);
        return typeof stub === 'function' ? stub(url) : stub;
    };
    try {
        return await fn(calls);
    }
    finally {
        Scrape.scrape = original;
    }
}

async function withNotifications(fn) {
    const original = DiscordMessages.sendActivityNotificationMessage;
    const sent = [];
    DiscordMessages.sendActivityNotificationMessage =
        async (guildId, serverId, color, text, steamId) => { sent.push({ text, steamId }); };
    try {
        await fn(sent);
    }
    finally {
        DiscordMessages.sendActivityNotificationMessage = original;
    }
    return sent;
}

function makeClient() {
    return {
        intlGet: (guildId, id) => id,
        getInstance: () => ({
            serverList: { 'srv': { title: 'Server' } },
            generalSettings: { connectionNotify: false, deathNotify: false, afkNotify: false }
        }),
        log: () => { }
    };
}

/* The Rust+ protobuf hands steamId over as a Long-like object. */
function member(steamId, name) {
    return { steamId: { toString: () => steamId }, name: name };
}

function deadPlayer(steamId, name) {
    return {
        steamId: steamId,
        name: name,
        pos: null,
        isGoneDead: () => true,
        isGoneAfk: () => false,
        isAfk: () => false,
        isMoved: () => false,
        isGoneOnline: () => false,
        isGoneOffline: () => false
    };
}

function makeRustplus({ newPlayers = [], leftPlayers = [], players = [] } = {}) {
    return {
        guildId: 'guild',
        serverId: 'srv',
        team: {
            isLeaderSteamIdChanged: () => false,
            getNewPlayers: () => newPlayers,
            getLeftPlayers: () => leftPlayers,
            getPlayer: () => ({ name: 'Gone' }),
            players: players
        },
        sendInGameMessage: async () => { },
        log: () => { },
        updateConnections: () => { },
        updateDeaths: () => { }
    };
}

/* Every test starts from a known cache and an open pacing gate. */
function reset(delayMs = 0) {
    Scrape.clearAvatarCache();
    Config.battlemetrics.steamScrapeDelayMs = delayMs;
}

const ORIGINAL_DELAY = Config.battlemetrics.steamScrapeDelayMs;
test.after(() => {
    Config.battlemetrics.steamScrapeDelayMs = ORIGINAL_DELAY;
    Scrape.clearAvatarCache();
});

/* One scrape per death is what got the host throttled in the first place. */
test('a death notification makes no Steam request against a warm cache', async () => {
    reset();
    const teamInfo = { members: [member(IDS[0], 'Pablo')] };
    const rustplus = makeRustplus({ players: [deadPlayer(IDS[0], 'Pablo')] });

    /* Warm the cache the way the priming step would. */
    await withScrape({ status: 200, data: AVATAR_HTML }, async () => {
        await Scrape.scrapeSteamProfilePicture(makeClient(), IDS[0]);
    });

    await withScrape(() => { throw new Error('Steam must not be contacted here'); }, async (calls) => {
        const sent = await withNotifications(() => TeamHandler.checkChanges(rustplus, makeClient(), teamInfo));
        assert.strictEqual(calls.length, 0);
        assert.deepStrictEqual(sent.map(s => s.text), ['playerJustDied']);
    });

    assert.strictEqual(Scrape.getCachedSteamProfilePicture(IDS[0]), 'https://avatars.example/abc_full.jpg');
});

test('a new joiner is fetched once, and not again on the next cycle', async () => {
    reset();
    const teamInfo = { members: [member(IDS[0], 'Pablo')] };
    const client = makeClient();

    await withScrape({ status: 200, data: AVATAR_HTML }, async (calls) => {
        await withNotifications(async () => {
            await TeamHandler.checkChanges(
                makeRustplus({ newPlayers: [IDS[0]] }), client, teamInfo);
            assert.strictEqual(calls.length, 1, 'the joiner should be fetched');

            await TeamHandler.checkChanges(makeRustplus(), client, teamInfo);
            assert.strictEqual(calls.length, 1, 'the cached face should not be re-fetched');
        });
    });
});

/* A cold cache after a restart must not become a burst at Steam. */
test('the backfill takes one member per invocation and respects the pacing gate', async () => {
    reset(60_000);
    const teamInfo = { members: [member(IDS[0], 'A'), member(IDS[1], 'B'), member(IDS[2], 'C')] };
    const client = makeClient();

    await withScrape({ status: 200, data: AVATAR_HTML }, async (calls) => {
        await TeamHandler.primeTeamAvatars(client, teamInfo, []);
        assert.strictEqual(calls.length, 1, 'only one member should be backfilled per invocation');

        await TeamHandler.primeTeamAvatars(client, teamInfo, []);
        assert.strictEqual(calls.length, 1, 'the pacing gate should block an immediate second');
    });
});

test('a Steam failure while priming does not stop the notifications', async () => {
    reset();
    const teamInfo = { members: [member(IDS[0], 'Pablo')] };
    const rustplus = makeRustplus({ players: [deadPlayer(IDS[0], 'Pablo')] });

    await withScrape(() => { throw new Error('Steam is down'); }, async () => {
        const sent = await withNotifications(() => TeamHandler.checkChanges(rustplus, makeClient(), teamInfo));
        assert.deepStrictEqual(sent.map(s => s.text), ['playerJustDied']);
    });
});

/* The failure counter is process-wide, so a test that wants a clean slate has
   to walk it back to zero with a success. */
async function resetAvatarFailures() {
    Scrape.clearAvatarCache();
    await withScrape({ status: 200, data: AVATAR_HTML }, async () => {
        await TeamHandler.primeTeamAvatars(makeClient(), { members: [member(IDS[0], 'Reset')] }, []);
    });
    Scrape.clearAvatarCache();
}

/* checkChanges runs on every 10 s poll whether or not anything changed, and a
   failed avatar is only cached for five minutes. Without a backoff that is a
   permanent retry stream against a Steam that is already refusing us — where
   an idle team used to make no requests at all. */
test('the backfill backs off once Steam starts failing', async () => {
    await resetAvatarFailures();
    Config.battlemetrics.steamScrapeDelayMs = 0;
    const teamInfo = { members: [member(IDS[0], 'A'), member(IDS[1], 'B')] };
    const client = makeClient();

    await withScrape({ status: 403 }, async (calls) => {
        await TeamHandler.primeTeamAvatars(client, teamInfo, []);
        assert.strictEqual(calls.length, 1);

        /* The pacing gate is 0 ms, so only the failure backoff can stop this. */
        await TeamHandler.primeTeamAvatars(client, teamInfo, []);
        assert.strictEqual(calls.length, 1, 'a failure should have opened a backoff');
    });

    await resetAvatarFailures();
    Config.battlemetrics.steamScrapeDelayMs = 0;
});

/* Setting the documented "disable the cache" value must not produce strictly
   more Steam traffic than the per-event scraping it replaced. */
test('a disabled avatar cache primes nothing at all', async () => {
    await resetAvatarFailures();
    const originalTtl = Config.battlemetrics.steamAvatarCacheMs;
    Config.battlemetrics.steamAvatarCacheMs = 0;
    Config.battlemetrics.steamScrapeDelayMs = 0;

    try {
        await withScrape({ status: 200, data: AVATAR_HTML }, async (calls) => {
            await TeamHandler.primeTeamAvatars(makeClient(),
                { members: [member(IDS[0], 'A'), member(IDS[1], 'B')] }, [IDS[0]]);
            assert.strictEqual(calls.length, 0);
        });
    }
    finally {
        Config.battlemetrics.steamAvatarCacheMs = originalTtl;
    }
});

/* R5 named joining *and leaving* as the moments a face is needed, and a leaver
   is by definition no longer in the roster. */
test('a leaver is primed even though they are gone from the members list', async () => {
    await resetAvatarFailures();
    Config.battlemetrics.steamScrapeDelayMs = 0;

    await withScrape({ status: 200, data: AVATAR_HTML }, async (calls) => {
        await TeamHandler.primeTeamAvatars(makeClient(),
            { members: [member(IDS[1], 'Still here')] }, [], [IDS[0]]);
        assert.strictEqual(calls.length, 2, 'the leaver plus one backfill');
    });

    assert.strictEqual(Scrape.getCachedSteamProfilePicture(IDS[0]),
        'https://avatars.example/abc_full.jpg');
});
