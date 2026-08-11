const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* Battlemetrics.js reaches the client through `require('../../index.ts')`,
   which boots the whole bot on import. Seed the module cache with a stub. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: { client: { intlGet: (guildId, id) => id, log: () => { } } }
};

const Battlemetrics = require('./Battlemetrics.js');

/* A Battlemetrics instance whose only HTTP surface — `request` — is replaced by
   a canned answer, so the parsing can be exercised without a token. */
function makeInstance(response) {
    const instance = new Battlemetrics('bm-server');
    const calls = [];
    instance.request = async (apiCall) => {
        calls.push(apiCall);
        return response;
    };
    instance.calls = calls;
    return instance;
}

function server(id, gameId, timePlayed) {
    const entity = {
        type: 'server',
        id: id,
        attributes: { name: `server-${id}` },
        relationships: { game: { data: { type: 'game', id: gameId } } }
    };
    if (timePlayed !== undefined) entity.meta = { timePlayed: timePlayed, online: false };
    return entity;
}

test('getRustLifetimeHours sums timePlayed across Rust servers only', async () => {
    const instance = makeInstance({
        data: { type: 'player', id: '42' },
        included: [
            server('1', 'rust', 3600),
            server('2', 'rust', 1800),
            /* A Battlemetrics profile spans every game the site tracks; these
               hours belong to someone's DayZ career, not their Rust one. */
            server('3', 'dayz', 720000),
            server('4', 'ark', 360000)
        ]
    });

    const hours = await instance.getRustLifetimeHours('42');

    assert.strictEqual(hours, 1.5);
    assert.strictEqual(instance.calls.length, 1);
    assert.ok(instance.calls[0].includes('/players/42'));
    assert.ok(instance.calls[0].includes('include=server'));
});

test('getRustLifetimeHours reports zero hours but not missing hours', async () => {
    /* A brand new profile really has played nothing — that is a figure worth
       rendering. */
    const zero = makeInstance({ included: [server('1', 'rust', 0)] });
    assert.strictEqual(await zero.getRustLifetimeHours('42'), 0);

    /* A private profile, or a plan that does not cover the endpoint, answers
       with servers carrying no meta block. Rendering that as "0 h" would state
       something we do not know. */
    const noMeta = makeInstance({ included: [server('1', 'rust', undefined)] });
    assert.strictEqual(await noMeta.getRustLifetimeHours('42'), null);

    const noRust = makeInstance({ included: [server('1', 'dayz', 7200)] });
    assert.strictEqual(await noRust.getRustLifetimeHours('42'), null);

    const noIncluded = makeInstance({ data: { type: 'player', id: '42' } });
    assert.strictEqual(await noIncluded.getRustLifetimeHours('42'), null);

    /* `request` returns null when the call failed or the integration is off. */
    const failed = makeInstance(null);
    assert.strictEqual(await failed.getRustLifetimeHours('42'), null);
});

test('getRustLifetimeHours ignores malformed playtime values', async () => {
    const instance = makeInstance({
        included: [
            server('1', 'rust', 3600),
            server('2', 'rust', -50),
            server('3', 'rust', Number.NaN),
            { type: 'server', id: '4', meta: { timePlayed: 9999 } },       /* no game relationship */
            { type: 'identifier', id: '5', meta: { timePlayed: 9999 } },   /* not a server at all */
            Object.assign(server('6', 'rust'), { meta: { timePlayed: '3600' } })
        ]
    });

    assert.strictEqual(await instance.getRustLifetimeHours('42'), 1);
});
