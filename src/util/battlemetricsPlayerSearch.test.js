const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* The search module logs failures through the client, which it reaches via
   `require('../../index.ts')` — and that boots the whole bot on import. Seed
   the module cache with a stub, and keep the emitted lines so the warn-once
   behaviour can be asserted. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
const logs = [];
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
        client: {
            intlGet: (guildId, id, args = {}) => `${id}:${JSON.stringify(args)}`,
            log: (title, text, level) => logs.push({ title, text, level })
        }
    }
};

const BmRateLimiter = require('./battlemetricsRateLimiter.js');
const PlayerSearch = require('./battlemetricsPlayerSearch.js');

/* Swap the rate-limited HTTP call for a canned result, run fn, always restore. */
async function withApi(stub, fn) {
    const original = BmRateLimiter.scheduleGet;
    const calls = [];
    BmRateLimiter.scheduleGet = async (url) => {
        calls.push(url);
        return typeof stub === 'function' ? stub(url) : stub;
    };
    try {
        return await fn(calls);
    }
    finally {
        BmRateLimiter.scheduleGet = original;
    }
}

function roster(players) {
    return { players: players };
}

function apiPlayers(entries) {
    return { data: { data: entries.map(e => ({ id: e.id, attributes: { name: e.name } })) } };
}

/* The search cache is keyed on (serverId, query), so every test that reaches
   the API needs its own server id or it reads a neighbour's answer. */
let _serverCounter = 0;
function freshServerId() {
    _serverCounter += 1;
    return `server-${_serverCounter}`;
}

test('matchRosterName matches across invisible characters and stray whitespace', () => {
    const bmInstance = roster({ '42': { name: 'Pa​blo ' } });
    assert.strictEqual(PlayerSearch.matchRosterName(bmInstance, '  Pablo'), '42');
});

/* Pointing a tracker at the wrong human is worse than an unresolved row. */
test('matchRosterName refuses to guess between two identically named players', () => {
    const bmInstance = roster({ '1': { name: 'Pablo' }, '2': { name: 'Pablo‍' } });
    assert.strictEqual(PlayerSearch.matchRosterName(bmInstance, 'Pablo'), null);
});

test('matchRosterName stays case-sensitive and tolerates a missing roster', () => {
    assert.strictEqual(PlayerSearch.matchRosterName(roster({ '1': { name: 'Bob' } }), 'bob'), null);
    assert.strictEqual(PlayerSearch.matchRosterName(null, 'Bob'), null);
    assert.strictEqual(PlayerSearch.matchRosterName(roster({ '1': { name: 'Bob' } }), ''), null);
});

test('resolveIdByName takes the roster hit without any HTTP call', async () => {
    await withApi(() => { throw new Error('should not reach the API'); }, async () => {
        const result = await PlayerSearch.resolveIdByName(
            roster({ '42': { name: 'Pablo' } }), freshServerId(), 'Pablo');
        assert.deepStrictEqual(result, { id: '42', apiFailed: false });
    });
});

/* The live roster only holds players seen online during this bot run, so an
   offline player can only be found through filter[search]. */
test('resolveIdByName falls back to the search API for an offline player', async () => {
    await withApi(apiPlayers([{ id: 99, name: 'Pablo' }]), async (calls) => {
        const result = await PlayerSearch.resolveIdByName(roster({}), freshServerId(), 'Pablo');
        assert.deepStrictEqual(result, { id: '99', apiFailed: false });
        assert.strictEqual(calls.length, 1);
    });
});

test('resolveIdByName ignores an API result that is only a near miss', async () => {
    await withApi(apiPlayers([{ id: 99, name: 'bobby' }]), async () => {
        const result = await PlayerSearch.resolveIdByName(roster({}), freshServerId(), 'bob');
        assert.deepStrictEqual(result, { id: null, apiFailed: false });
    });
});

/* An outage is not the player's fault — the resolver must be able to tell it
   apart from "no such player" so it doesn't push them into a long backoff. */
test('resolveIdByName reports an API failure instead of an empty answer', async () => {
    const serverId = freshServerId();
    await withApi(() => { throw new Error('502'); }, async () => {
        const result = await PlayerSearch.resolveIdByName(roster({}), serverId, 'Pablo');
        assert.deepStrictEqual(result, { id: null, apiFailed: true });
    });

    /* A failure must not be cached, or the retry is suppressed for the TTL. */
    await withApi(apiPlayers([{ id: 7, name: 'Pablo' }]), async (calls) => {
        const result = await PlayerSearch.resolveIdByName(roster({}), serverId, 'Pablo');
        assert.deepStrictEqual(result, { id: '7', apiFailed: false });
        assert.strictEqual(calls.length, 1, 'the retry should have reached the API');
    });
});

/* filter[search] on a single character returns an arbitrary page of the
   server's population, which would mislink rather than fail. */
test('resolveIdByName refuses a one-character name without any HTTP call', async () => {
    await withApi(() => { throw new Error('should not reach the API'); }, async () => {
        const result = await PlayerSearch.resolveIdByName(roster({}), freshServerId(), 'P');
        assert.deepStrictEqual(result, { id: null, apiFailed: false });
    });
});

/* filter[search] is a substring match, so a short query fills the page with
   near misses and can push a second, genuinely identical name onto page 2 —
   where the "exactly one exact match" guard cannot see it. Linking the tracker
   to the wrong human is worse than leaving the row unresolved. */
test('resolveIdByName refuses a lone exact match on a full page', async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
        ({ id: i, name: i === 0 ? 'Bob' : `bobby${i}` }));

    await withApi(apiPlayers(full), async () => {
        const result = await PlayerSearch.resolveIdByName(roster({}), freshServerId(), 'Bob');
        assert.deepStrictEqual(result, { id: null, apiFailed: false });
    });
});

test('resolveIdByName still takes a lone exact match on a partial page', async () => {
    const partial = Array.from({ length: 99 }, (_, i) =>
        ({ id: i, name: i === 0 ? 'Bob' : `bobby${i}` }));

    await withApi(apiPlayers(partial), async () => {
        const result = await PlayerSearch.resolveIdByName(roster({}), freshServerId(), 'Bob');
        assert.deepStrictEqual(result, { id: '0', apiFailed: false });
    });
});

/* The index is only an optimisation, so it has to answer exactly as the direct
   roster walk does — including refusing to guess between duplicates. */
test('buildRosterIndex answers identically to walking the roster', () => {
    const bmInstance = roster({
        '1': { name: 'Pa​blo ' },
        '2': { name: 'Bob' },
        '3': { name: 'Bob' }
    });
    const index = PlayerSearch.buildRosterIndex(bmInstance);

    for (const name of ['Pablo', 'Bob', 'Nobody', '']) {
        assert.strictEqual(
            PlayerSearch.matchRosterName(bmInstance, name, index),
            PlayerSearch.matchRosterName(bmInstance, name),
            `disagreement on ${JSON.stringify(name)}`);
    }
    assert.strictEqual(PlayerSearch.matchRosterName(bmInstance, 'Pablo', index), '1');
    assert.strictEqual(PlayerSearch.matchRosterName(bmInstance, 'Bob', index), null);
});

/* A search outage used to be completely silent: the rate limiter rethrows
   without logging, and the resolver's apiFailed path deliberately skips the
   backoff, so the row retried every 60 s forever with nothing in the log. */
test('a search outage is reported once and re-armed after it recovers', async () => {
    const serverId = freshServerId();
    const failing = () => { const e = new Error('boom'); e.response = { status: 503 }; throw e; };

    logs.length = 0;

    await withApi(failing, async () => {
        await PlayerSearch.resolveIdByName(null, serverId, 'Pablo');
        await PlayerSearch.resolveIdByName(null, serverId, 'Ruben');
        await PlayerSearch.resolveIdByName(null, serverId, 'Steve');
    });

    assert.strictEqual(logs.length, 1, 'an ongoing outage must not log per lookup');
    assert.match(logs[0].text, /battlemetricsPlayerSearchFailed/);
    assert.match(logs[0].text, /HTTP 503/);
    assert.ok(!logs[0].text.includes('Pablo'), 'the typed query must never be interpolated');

    /* Recovery clears the latch, so the next outage is reported again. */
    await withApi(apiPlayers([{ id: '1', name: 'Pablo' }]), async () => {
        await PlayerSearch.resolveIdByName(null, serverId, 'Pablo');
    });
    assert.strictEqual(logs.length, 1, 'a success is not itself worth a line');

    await withApi(failing, async () => {
        await PlayerSearch.resolveIdByName(null, serverId, 'Ruben');
    });
    assert.strictEqual(logs.length, 2, 'a fresh outage after a recovery must report again');
});

/* A 200 whose body is not the expected shape leaves success false and reaches
   the same silent skip, so the emit cannot live inside the catch. */
test('a malformed search response is reported too', async () => {
    const serverId = freshServerId();
    logs.length = 0;

    await withApi({ data: { notWhatWeExpect: true } }, async () => {
        await PlayerSearch.resolveIdByName(null, serverId, 'Pablo');
    });

    assert.strictEqual(logs.length, 1);
    assert.match(logs[0].text, /malformed response/);
});
