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

const DiscordMessages = require('../discordTools/discordMessages.js');
const TeamChatHandler = require('./teamChatHandler.js');

function makeClient(mutedTeammates) {
    return {
        intlGet: (guildId, id) => id,
        getInstance: () => ({ mutedTeammates: mutedTeammates }),
        log: () => { }
    };
}

const rustplus = { guildId: 'guild', generalSettings: { teamChatTranslateEnabled: false } };

async function relay(client, message) {
    const relayed = [];
    const original = DiscordMessages.sendTeamChatMessage;
    DiscordMessages.sendTeamChatMessage = async (guildId, msg) => { relayed.push(msg); };
    try {
        await TeamChatHandler(rustplus, client, message);
    }
    finally {
        DiscordMessages.sendTeamChatMessage = original;
    }
    return relayed;
}

test('messages from a muted teammate are not relayed to Discord', async () => {
    const client = makeClient({ '76561198000000001': { name: 'SpammyBot' } });
    const relayed = await relay(client, {
        steamId: '76561198000000001', name: 'SpammyBot', message: 'cargo located at F12'
    });
    assert.deepStrictEqual(relayed, []);
});

test('messages from everyone else are still relayed', async () => {
    const client = makeClient({ '76561198000000001': { name: 'SpammyBot' } });
    const relayed = await relay(client, {
        steamId: '76561198000000002', name: 'Human', message: 'hello'
    });
    assert.strictEqual(relayed.length, 1);
    assert.strictEqual(relayed[0].message, 'hello');
});

test('a numeric or Long steamId still matches the muted list', async () => {
    const client = makeClient({ '76561198000000001': { name: 'SpammyBot' } });

    /* The Rust+ protobuf hands steamId over as a Long-like object. */
    const longLike = { toString: () => '76561198000000001' };
    assert.deepStrictEqual(await relay(client, { steamId: longLike, name: 'SpammyBot', message: 'x' }), []);
});

test('an instance without a muted list relays everything', async () => {
    const relayed = await relay(makeClient(undefined), {
        steamId: '76561198000000003', name: 'Human', message: 'hi'
    });
    assert.strictEqual(relayed.length, 1);
});
