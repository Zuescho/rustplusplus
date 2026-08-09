const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* These helpers reach the client through `require('../../index.ts')`, which
   boots the whole bot on import. Seed the module cache with a stub. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
const instance = {
    trackers: { '0': { name: 'Tracker', messageId: 'msg-1' } },
    channelId: { trackers: 'chan-1', activity: 'chan-2' },
    generalSettings: { mentionUserIds: [] }
};
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
        client: {
            intlGet: (guildId, id) => id,
            getInstance: () => instance,
            setInstance: () => { },
            log: () => { }
        }
    }
};

const Config = require('../../config');
const DiscordButtons = require('./discordButtons.js');
const DiscordEmbeds = require('./discordEmbeds.js');
const DiscordMessages = require('./discordMessages.js');
const DiscordTools = require('./discordTools.js');
const Scrape = require('../util/scrape.js');

const VALID_ID = '76561198996560458';
const AVATAR_HTML = '<img src="https://avatars.example/abc_full.jpg" alt="x">';

/* Monkey-patch collaborator exports, restore in finally. */
async function withStubs(stubs, fn) {
    const originals = [];
    for (const [target, key, value] of stubs) {
        originals.push([target, key, target[key]]);
        target[key] = value;
    }
    try {
        return await fn();
    }
    finally {
        for (const [target, key, value] of originals) target[key] = value;
    }
}

/* messageEdit returns undefined when the edit failed, and sendMessage passes
   that straight back. Reading `.id` off it threw a TypeError out of the poll
   cycle and took every remaining tracker down with it. */
test('sendTrackerMessage survives a send that returns nothing', async () => {
    instance.trackers['0'].messageId = 'msg-1';

    await withStubs([
        [DiscordEmbeds, 'getTrackerEmbed', () => ({})],
        [DiscordButtons, 'getTrackerButtons', () => []],
        [DiscordMessages, 'sendMessage', async () => undefined]
    ], async () => {
        await DiscordMessages.sendTrackerMessage('guild', '0');
    });

    assert.strictEqual(instance.trackers['0'].messageId, 'msg-1', 'the old id should be left alone');
});

test('an activity notification reads the avatar cache instead of scraping', async () => {
    Scrape.clearAvatarCache();
    const seen = [];

    await withStubs([
        [Scrape, 'scrapeSteamProfilePicture', async () => {
            throw new Error('Steam must not be contacted here');
        }],
        [DiscordEmbeds, 'getActivityNotificationEmbed',
            (guildId, serverId, color, text, steamId, png) => { seen.push(png); return {}; }],
        [DiscordMessages, 'sendMessage', async () => undefined]
    ], async () => {
        await DiscordMessages.sendActivityNotificationMessage(
            'guild', 'srv', 0, 'text', VALID_ID);
    });

    assert.deepStrictEqual(seen, [null]);
});

test('an activity notification fetches when the caller explicitly allows it', async () => {
    Scrape.clearAvatarCache();
    const seen = [];
    const original = Scrape.scrape;
    Scrape.scrape = async () => ({ status: 200, data: AVATAR_HTML });

    try {
        await withStubs([
            [DiscordEmbeds, 'getActivityNotificationEmbed',
                (guildId, serverId, color, text, steamId, png) => { seen.push(png); return {}; }],
            [DiscordMessages, 'sendMessage', async () => undefined]
        ], async () => {
            await DiscordMessages.sendActivityNotificationMessage(
                'guild', 'srv', 0, 'text', VALID_ID, null, false, { allowAvatarFetch: true });
        });
    }
    finally {
        Scrape.scrape = original;
        Scrape.clearAvatarCache();
    }

    assert.deepStrictEqual(seen, ['https://avatars.example/abc_full.jpg']);
});

/* With the cache switched off there is no store to prime, so the legacy
   per-event fetch has to come back or every avatar would be missing. */
test('a disabled avatar cache falls back to fetching per event', async () => {
    const originalTtl = Config.battlemetrics.steamAvatarCacheMs;
    Config.battlemetrics.steamAvatarCacheMs = 0;
    Scrape.clearAvatarCache();
    const seen = [];

    try {
        await withStubs([
            [Scrape, 'scrapeSteamProfilePicture', async () => 'https://avatars.example/live_full.jpg'],
            [DiscordEmbeds, 'getActivityNotificationEmbed',
                (guildId, serverId, color, text, steamId, png) => { seen.push(png); return {}; }],
            [DiscordMessages, 'sendMessage', async () => undefined]
        ], async () => {
            await DiscordMessages.sendActivityNotificationMessage(
                'guild', 'srv', 0, 'text', VALID_ID);
        });
    }
    finally {
        Config.battlemetrics.steamAvatarCacheMs = originalTtl;
    }

    assert.deepStrictEqual(seen, ['https://avatars.example/live_full.jpg']);
});

/* A blip on the fetch is not evidence the card is gone. Posting a replacement
   orphans the old one and repoints messageId — once per tracker per cycle for
   as long as the outage lasts. */
test('sendMessage does not repost when the fetch failed transiently', async () => {
    let sent = 0;
    await withStubs([
        [DiscordTools, 'fetchMessageById', async () => ({ message: undefined, transient: true })],
        [DiscordTools, 'getTextChannelById', () => ({})]
    ], async () => {
        const Client = require('../../index.ts');
        Client.client.messageSend = async () => { sent += 1; return { id: 'new' }; };
        const result = await DiscordMessages.sendMessage('guild', {}, 'msg-1', 'chan-1');
        assert.strictEqual(result, undefined);
    });

    assert.strictEqual(sent, 0, 'nothing should have been posted');
});

test('sendMessage does repost when the message is really gone', async () => {
    let sent = 0;
    await withStubs([
        [DiscordTools, 'fetchMessageById', async () => ({ message: undefined, transient: false })],
        [DiscordTools, 'getTextChannelById', () => ({})]
    ], async () => {
        const Client = require('../../index.ts');
        Client.client.messageSend = async () => { sent += 1; return { id: 'new' }; };
        await DiscordMessages.sendMessage('guild', {}, 'msg-1', 'chan-1');
    });

    assert.strictEqual(sent, 1);
});
