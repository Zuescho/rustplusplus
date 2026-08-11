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

const BattlemetricsHandler = require('./battlemetricsHandler.js');
const PlayerSearch = require('../util/battlemetricsPlayerSearch.js');
const Scrape = require('../util/scrape.js');

const VALID_ID = '76561198996560458';
const OTHER_ID = '76561198996560459';

function makeClient(guilds) {
    const instances = {};
    const setInstanceCalls = [];
    const logs = [];
    const battlemetricsInstances = {};

    for (const [guildId, guild] of Object.entries(guilds)) {
        instances[guildId] = guild.instance;
        for (const [bmId, bmInstance] of Object.entries(guild.battlemetricsInstances || {})) {
            battlemetricsInstances[bmId] = bmInstance;
        }
    }

    return {
        instances,
        setInstanceCalls,
        logs,
        battlemetricsInstances,
        guilds: { cache: Object.keys(guilds).map(guildId => [guildId, {}]) },
        getInstance: (guildId) => instances[guildId],
        setInstance: (guildId, instance) => setInstanceCalls.push({ guildId, instance }),
        intlGet: (guildId, id) => id,
        log: (title, text, level) => logs.push({ title, text, level })
    };
}

/* One guild, one tracker, whatever players the test needs. */
function makeSingleTrackerClient(players, { clanTag = '', roster = {}, tracker = {} } = {}) {
    const trackerObj = Object.assign({
        name: 'Tracker',
        clanTag: clanTag,
        battlemetricsId: 'bm-server',
        players: players
    }, tracker);

    return makeClient({
        guild: {
            instance: { trackers: { '0': trackerObj } },
            battlemetricsInstances: {
                'bm-server': { players: roster, lastUpdateSuccessful: true }
            }
        }
    });
}

/* Monkey-patch collaborator exports, restore in finally. The Steam gate is
   process-wide, so it has to be placed deliberately or it leaks between
   tests: open unless the test asked for it closed. */
async function withStubs(stubs, fn, { steamGateOpen = true } = {}) {
    BattlemetricsHandler._setBackgroundSteamAt(steamGateOpen ? 0 : Date.now());
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

function throwingScrape() {
    return [Scrape, 'scrapeSteamProfileName', async () => {
        throw new Error('Steam must not be contacted here');
    }];
}

function throwingResolve() {
    return [PlayerSearch, 'resolveIdByName', async () => {
        throw new Error('Battlemetrics must not be contacted here');
    }];
}

test('syncTrackerPlayerNames adopts the roster name with the clanTag applied', () => {
    const player = { name: '[XY] OldName', steamId: VALID_ID, playerId: '42' };
    const tracker = { clanTag: '[XY]', players: [player] };

    const changed = BattlemetricsHandler.syncTrackerPlayerNames(
        tracker, { players: { '42': { name: 'NewName' } } });

    assert.strictEqual(changed, true);
    assert.strictEqual(player.name, '[XY] NewName');
});

test('syncTrackerPlayerNames changes nothing when the stored name already agrees', () => {
    const player = { name: '[XY] Pablo', steamId: VALID_ID, playerId: '42' };
    const tracker = { clanTag: '[XY]', players: [player] };

    assert.strictEqual(BattlemetricsHandler.syncTrackerPlayerNames(
        tracker, { players: { '42': { name: 'Pablo' } } }), false);
    assert.strictEqual(player.name, '[XY] Pablo');
});

/* The placeholder heal this replaced is a strict subset of the sync. */
test('syncTrackerPlayerNames still heals every placeholder form', () => {
    const players = [
        { name: '', steamId: null, playerId: '1' },
        { name: '-', steamId: null, playerId: '2' },
        { name: '3', steamId: null, playerId: '3' }
    ];
    const tracker = { clanTag: '', players: players };

    assert.strictEqual(BattlemetricsHandler.syncTrackerPlayerNames(tracker, {
        players: { '1': { name: 'One' }, '2': { name: 'Two' }, '3': { name: 'Three' } }
    }), true);
    assert.deepStrictEqual(players.map(p => p.name), ['One', 'Two', 'Three']);
});

test('syncTrackerPlayerNames leaves unresolved and off-roster players alone', () => {
    const unresolved = { name: 'Typed', steamId: VALID_ID, playerId: null };
    const offRoster = { name: 'Away', steamId: null, playerId: '99' };
    const tracker = { clanTag: '', players: [unresolved, offRoster] };

    assert.strictEqual(BattlemetricsHandler.syncTrackerPlayerNames(
        tracker, { players: { '42': { name: 'Someone' } } }), false);
    assert.strictEqual(unresolved.name, 'Typed');
    assert.strictEqual(offRoster.name, 'Away');
});

test('retagTrackerPlayerNames rewrites every real name and no placeholder', () => {
    const players = [
        { name: '[OLD] Pablo', steamId: null, playerId: '1' },
        { name: 'Untagged', steamId: null, playerId: '2' },
        { name: '-', steamId: null, playerId: '3' }
    ];
    const tracker = { clanTag: '[NEW]', players: players };

    assert.strictEqual(BattlemetricsHandler.retagTrackerPlayerNames(tracker, '[OLD]', '[NEW]'), true);
    assert.deepStrictEqual(players.map(p => p.name), ['[NEW] Pablo', '[NEW] Untagged', '-']);

    assert.strictEqual(BattlemetricsHandler.retagTrackerPlayerNames(tracker, '[NEW]', ''), true);
    assert.deepStrictEqual(players.map(p => p.name), ['Pablo', 'Untagged', '-']);
});

test('collectResolutionCandidates skips everything that cannot or should not be resolved', () => {
    const client = makeClient({
        guild: {
            instance: {
                trackers: {
                    'ok': {
                        battlemetricsId: 'bm-server', clanTag: '', players: [
                            { name: 'Resolved', steamId: VALID_ID, playerId: '1' },
                            { name: 'NoSteamId', steamId: null, playerId: null },
                            { name: 'Malformed', steamId: 'nonsense', playerId: null },
                            { name: 'BackingOff', steamId: VALID_ID, playerId: null,
                                resolveNextAttemptAt: Date.now() + 60_000 },
                            { name: 'Eligible', steamId: OTHER_ID, playerId: null }
                        ]
                    },
                    'paused': {
                        battlemetricsId: 'bm-server', clanTag: '', active: false,
                        players: [{ name: 'Paused', steamId: VALID_ID, playerId: null }]
                    },
                    'noServer': {
                        battlemetricsId: null, clanTag: '',
                        players: [{ name: 'NoServer', steamId: VALID_ID, playerId: null }]
                    }
                }
            }
        }
    });

    const candidates = BattlemetricsHandler.collectResolutionCandidates(client);
    /* A player in backoff is still collected — the free roster match costs
       nothing and must keep running for them — but flagged so no request is
       ever spent on them, and sorted behind everyone who may spend one. */
    assert.deepStrictEqual(candidates.map(c => c.player.name), ['Eligible', 'BackingOff']);
    assert.deepStrictEqual(candidates.map(c => c.eligible), [true, false]);
});

/* The backoff rate-limits requests, not comparisons. A player who joins the
   server becomes matchable against the roster at zero cost, and used to stay
   untracked for up to 24 hours because they were dropped before that ran. */
test('a player in backoff is still linked by the free roster match', async () => {
    const player = {
        name: 'Pablo', steamId: VALID_ID, playerId: null,
        resolveAttempts: 6, resolveNextAttemptAt: Date.now() + 24 * 60 * 60 * 1000
    };
    const client = makeSingleTrackerClient([player], { roster: { '42': { name: 'Pablo' } } });

    await withStubs([throwingScrape(), throwingResolve()],
        () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(player.playerId, '42');
    assert.strictEqual(player.resolveAttempts, 0);
    assert.strictEqual(player.resolveNextAttemptAt, 0);
});

test('a player in backoff never spends a Steam or Battlemetrics request', async () => {
    const player = {
        name: '-', steamId: VALID_ID, playerId: null,
        resolveAttempts: 2, resolveNextAttemptAt: Date.now() + 60 * 60 * 1000
    };
    const client = makeSingleTrackerClient([player]);

    await withStubs([throwingScrape(), throwingResolve()],
        () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(player.playerId, null);
    assert.strictEqual(player.resolveAttempts, 2, 'no attempt should have been charged');
});

/* R2: Steam resolves a player, it does not re-supply names we already hold. */
test('a candidate with a stored name goes straight to Battlemetrics', async () => {
    const player = { name: '[XY] Pablo', steamId: VALID_ID, playerId: null };
    const client = makeSingleTrackerClient([player], { clanTag: '[XY]' });

    let searched = null;
    await withStubs([
        throwingScrape(),
        [PlayerSearch, 'resolveIdByName', async (bm, serverId, name) => {
            searched = name;
            return { id: '42', apiFailed: false };
        }]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(searched, 'Pablo', 'the stored name, not a re-scraped one');
    assert.strictEqual(player.playerId, '42');
});

/* The one scheduled Steam slot has to go to the player who has no name at all,
   not to the named row that merely sorts first. */
test('the Steam slot goes to the candidate that has no name', async () => {
    const named = { name: 'Pablo', steamId: VALID_ID, playerId: null };
    const nameless = { name: '-', steamId: OTHER_ID, playerId: null };
    const client = makeSingleTrackerClient([named, nameless]);

    const scraped = [];
    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async (c, steamId) => { scraped.push(steamId); return 'Bob'; }],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.deepStrictEqual(scraped, [OTHER_ID]);
});

/* A cache read is not traffic, so it must not close the process-wide gate. */
test('a name served from the cache leaves the Steam slot for someone else', async () => {
    const first = { name: '-', steamId: VALID_ID, playerId: null };
    const second = { name: '-', steamId: OTHER_ID, playerId: null };
    const client = makeSingleTrackerClient([first, second]);

    const scraped = [];
    await withStubs([
        [Scrape, 'getCachedSteamProfileName', (steamId) => steamId === VALID_ID ? 'Cached' : undefined],
        [Scrape, 'scrapeSteamProfileName', async (c, steamId) => { scraped.push(steamId); return 'Fresh'; }],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.deepStrictEqual(scraped, [OTHER_ID], 'the cache hit should not have spent the slot');
});

/* Battlemetrics being unavailable is not the player's fault, whatever Steam
   did in the same iteration. */
test('a Battlemetrics outage after a successful scrape burns no attempt', async () => {
    const player = { name: '-', steamId: VALID_ID, playerId: null };
    const client = makeSingleTrackerClient([player]);

    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async () => 'Pablo'],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: true })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(player.resolveAttempts, undefined);
    assert.strictEqual(player.resolveNextAttemptAt, undefined);
});

/* Two rows pointing at one Battlemetrics player double every notification and
   every activity sample, which also skews the off-hours raid alarm. */
test('runResolutionPass refuses to link a player the tracker already tracks', async () => {
    const existing = { name: 'Pablo', steamId: null, playerId: '42' };
    const duplicate = { name: 'Pablo', steamId: VALID_ID, playerId: null };
    const client = makeSingleTrackerClient([existing, duplicate], {
        roster: { '42': { name: 'Pablo' } }
    });

    await withStubs([throwingScrape(), throwingResolve()],
        () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(duplicate.playerId, null);
    assert.strictEqual(client.setInstanceCalls.length, 0);
    assert.ok(client.logs.some(l => /already tracks/.test(l.text)));
});

/* Instance files written before the backoff fields existed must not be
   quietly excluded from resolution forever. */
test('collectResolutionCandidates treats absent backoff fields as eligible now', () => {
    const client = makeSingleTrackerClient([{ name: 'Old', steamId: VALID_ID, playerId: null }]);
    assert.strictEqual(BattlemetricsHandler.collectResolutionCandidates(client).length, 1);
});

test('collectResolutionCandidates puts a never-attempted player ahead of a retried one', () => {
    const client = makeSingleTrackerClient([
        { name: 'Retried', steamId: VALID_ID, playerId: null, resolveAttempts: 3, resolveNextAttemptAt: 0 },
        { name: 'Fresh', steamId: OTHER_ID, playerId: null }
    ]);

    const candidates = BattlemetricsHandler.collectResolutionCandidates(client);
    assert.deepStrictEqual(candidates.map(c => c.player.name), ['Fresh', 'Retried']);
});

test('runResolutionPass links a roster match without contacting Steam', async () => {
    const player = { name: 'Pablo', steamId: VALID_ID, playerId: null };
    const client = makeSingleTrackerClient([player], {
        clanTag: '[XY]',
        roster: { '42': { name: 'Pablo' } }
    });

    await withStubs([throwingScrape()], () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(player.playerId, '42');
    assert.strictEqual(player.name, '[XY] Pablo');
    assert.strictEqual(player.resolveAttempts, 0);
    assert.strictEqual(player.resolveNextAttemptAt, 0);
    assert.strictEqual(player.steamNameLastScrapedAt, undefined,
        'nothing was scraped, so nothing should be stamped');
    assert.strictEqual(client.setInstanceCalls.length, 1);
    assert.strictEqual(client.setInstanceCalls[0].guildId, 'guild');
});

/* The whole point of the rework: a player who already has a Battlemetrics id
   is never looked up anywhere again. */
test('runResolutionPass never examines a player that already has a playerId', async () => {
    const client = makeSingleTrackerClient([
        { name: 'Pablo', steamId: VALID_ID, playerId: '42' }
    ], { roster: { '42': { name: 'Pablo' } } });

    await withStubs([throwingScrape(), throwingResolve()],
        () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(client.setInstanceCalls.length, 0);
});

test('two back-to-back passes make at most one Steam request', async () => {
    const client = makeSingleTrackerClient([
        { name: '-', steamId: VALID_ID, playerId: null }
    ]);

    let scrapes = 0;
    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async () => { scrapes += 1; return null; }],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ], async () => {
        await BattlemetricsHandler.runResolutionPass(client);
        await BattlemetricsHandler.runResolutionPass(client);
    });

    assert.strictEqual(scrapes, 1, 'the 5-minute global gate should have blocked the second');
});

test('two players sharing one steamId cost one Steam request in a pass', async () => {
    const client = makeClient({
        guild: {
            instance: {
                trackers: {
                    'a': {
                        battlemetricsId: 'bm-a', clanTag: '',
                        players: [{ name: '-', steamId: VALID_ID, playerId: null }]
                    },
                    'b': {
                        battlemetricsId: 'bm-b', clanTag: '',
                        players: [{ name: '-', steamId: VALID_ID, playerId: null }]
                    }
                }
            }
        }
    });

    let scrapes = 0;
    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async () => { scrapes += 1; return 'Pablo'; }],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(scrapes, 1);
});

test('a genuine miss backs off exponentially up to the 24 hour ceiling', async () => {
    const player = { name: 'Pablo', steamId: VALID_ID, playerId: null };
    const client = makeSingleTrackerClient([player]);

    const stubs = [
        [Scrape, 'scrapeSteamProfileName', async () => 'Pablo'],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ];

    await withStubs(stubs, () => BattlemetricsHandler.runResolutionPass(client));
    assert.strictEqual(player.resolveAttempts, 1);
    let waitMin = (player.resolveNextAttemptAt - Date.now()) / 60000;
    assert.ok(waitMin > 26 && waitMin < 34, `expected ~30 min, got ${waitMin}`);

    /* Re-arm and go round again: the Battlemetrics lookup alone is enough to
       count as an attempt, so the Steam gate does not get in the way. */
    player.resolveNextAttemptAt = 0;
    await withStubs(stubs, () => BattlemetricsHandler.runResolutionPass(client));
    assert.strictEqual(player.resolveAttempts, 2);
    waitMin = (player.resolveNextAttemptAt - Date.now()) / 60000;
    assert.ok(waitMin > 53 && waitMin < 67, `expected ~60 min, got ${waitMin}`);

    player.resolveAttempts = 6;
    player.resolveNextAttemptAt = 0;
    await withStubs(stubs, () => BattlemetricsHandler.runResolutionPass(client));
    assert.strictEqual(player.resolveAttempts, 7);
    const waitHours = (player.resolveNextAttemptAt - Date.now()) / 3600000;
    assert.ok(waitHours > 21 && waitHours <= 24, `expected the 24 h cap, got ${waitHours}`);
});

/* Battlemetrics being down is not the player's fault. The Steam gate is held
   shut so this is a pure Battlemetrics-only attempt. */
test('an API outage does not burn a resolution attempt', async () => {
    const player = { name: 'Pablo', steamId: VALID_ID, playerId: null, resolveAttempts: 2 };
    const client = makeSingleTrackerClient([player]);

    await withStubs([
        throwingScrape(),
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: true })]
    ], () => BattlemetricsHandler.runResolutionPass(client), { steamGateOpen: false });

    assert.strictEqual(player.resolveAttempts, 2);
});

test('a candidate deferred for lack of budget keeps its attempt count', async () => {
    const players = [
        { name: 'A', steamId: VALID_ID, playerId: null },
        { name: 'B', steamId: OTHER_ID, playerId: null },
        { name: 'C', steamId: '76561198996560460', playerId: null },
        { name: 'D', steamId: '76561198996560461', playerId: null }
    ];
    const client = makeSingleTrackerClient(players);

    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async () => 'Whoever'],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: null, apiFailed: false })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    /* Three per cycle, and only two Battlemetrics lookups within those. */
    assert.strictEqual(players[3].resolveAttempts, undefined, 'the 4th was never examined');
    assert.strictEqual(players[2].resolveAttempts, undefined, 'the 3rd had no lookup budget left');
    assert.strictEqual(players[0].resolveAttempts, 1);
    assert.strictEqual(players[1].resolveAttempts, 1);
});

test('a scrape-driven resolution stamps the scrape time and clears the counters', async () => {
    const player = { name: '-', steamId: VALID_ID, playerId: null, resolveAttempts: 4 };
    const client = makeSingleTrackerClient([player], {
        clanTag: '[XY]',
        roster: { '42': { name: 'Pablo' } }
    });

    const before = Date.now();
    await withStubs([
        [Scrape, 'scrapeSteamProfileName', async () => 'Pablo'],
        [PlayerSearch, 'resolveIdByName', async () => ({ id: '42', apiFailed: false })]
    ], () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(player.playerId, '42');
    assert.strictEqual(player.name, '[XY] Pablo');
    assert.strictEqual(player.resolveAttempts, 0);
    assert.strictEqual(player.resolveNextAttemptAt, 0);
    assert.ok(player.steamNameLastScrapedAt >= before);
    assert.strictEqual(client.setInstanceCalls.length, 1);
});

test('runResolutionPass with nothing to do makes no calls at all', async () => {
    const client = makeSingleTrackerClient([]);

    await withStubs([throwingScrape(), throwingResolve()],
        () => BattlemetricsHandler.runResolutionPass(client));

    assert.strictEqual(client.setInstanceCalls.length, 0);
});

/* The UPDATE button acks immediately, so the click can be repeated; each
   placeholder costs one rate-limited Battlemetrics request, and the whole set
   used to be re-issued every time. */
test('deepHealTrackerPlayerNames caps its lookups and does not re-ask for a miss', async () => {
    const players = Array.from({ length: 25 }, (_, i) => ({
        name: `${i}`, steamId: null, playerId: `${i}`
    }));
    const tracker = { clanTag: '', players: players };

    let lookups = 0;
    await withStubs([
        [PlayerSearch, 'resolveNameById', async () => { lookups += 1; return null; }]
    ], async () => {
        await BattlemetricsHandler.deepHealTrackerPlayerNames(tracker, { players: {} });
        assert.strictEqual(lookups, 10, 'the per-click cap');

        /* Everything asked about last time came back empty and is now
           negative-cached, so a second click moves on to the untried rest. */
        await BattlemetricsHandler.deepHealTrackerPlayerNames(tracker, { players: {} });
        assert.strictEqual(lookups, 20);
    });
});

/* A distinct id from the test above: the negative cache is module-level, by
   design — that is what stops a repeated click re-issuing the whole set. */
test('deepHealTrackerPlayerNames spends one lookup on rows sharing an id', async () => {
    const players = [
        { name: '907', steamId: null, playerId: '907' },
        { name: '-', steamId: null, playerId: '907' }
    ];
    const tracker = { clanTag: '[XY]', players: players };

    let lookups = 0;
    await withStubs([
        [PlayerSearch, 'resolveNameById', async () => { lookups += 1; return 'Pablo'; }]
    ], async () => {
        assert.strictEqual(
            await BattlemetricsHandler.deepHealTrackerPlayerNames(tracker, { players: {} }), true);
    });

    assert.strictEqual(lookups, 1);
    assert.deepStrictEqual(players.map(p => p.name), ['[XY] Pablo', '[XY] Pablo']);
});

/* Un-pausing a tracker drops and re-creates its Battlemetrics instance, whose
   first evaluation calls the whole online population "new". The suppression
   mark exists to swallow exactly that one cycle. */
test('a fresh instance has its suppression consumed once a poll succeeds', () => {
    const bmInstance = { suppressNotifications: true, lastUpdateSuccessful: true };
    const client = { battlemetricsInstances: { 'bm-server': bmInstance } };

    const first = BattlemetricsHandler.consumeSuppressionFlags(client);
    assert.deepStrictEqual([...first], ['bm-server']);
    assert.strictEqual(bmInstance.suppressNotifications, false);

    /* Exactly one cycle: the next one notifies normally. */
    assert.strictEqual(BattlemetricsHandler.consumeSuppressionFlags(client).size, 0);
});

/* The mark must survive a failed poll. Spending it on a cycle that produced no
   roster leaves the first SUCCESSFUL evaluation free to fire the phantom-login
   burst the mark exists to stop. */
test('a failed poll does not consume the suppression mark', () => {
    const bmInstance = { suppressNotifications: true, lastUpdateSuccessful: false };
    const client = { battlemetricsInstances: { 'bm-server': bmInstance } };

    assert.strictEqual(BattlemetricsHandler.consumeSuppressionFlags(client).size, 0);
    assert.strictEqual(bmInstance.suppressNotifications, true, 'the mark must still be held');

    bmInstance.lastUpdateSuccessful = true;
    assert.deepStrictEqual([...BattlemetricsHandler.consumeSuppressionFlags(client)], ['bm-server'],
        'the first successful poll is the one that gets suppressed');
    assert.strictEqual(bmInstance.suppressNotifications, false);
});

test('consumeSuppressionFlags tolerates a missing instance', () => {
    const client = { battlemetricsInstances: { 'gone': undefined, 'quiet': { lastUpdateSuccessful: true } } };
    assert.strictEqual(BattlemetricsHandler.consumeSuppressionFlags(client).size, 0);
});

/* --------------------------------------------------------------------------
   Lifetime Rust hours
   -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/* A tracker whose Battlemetrics instance answers playtime lookups from a map,
   recording which ids were actually asked about. */
function makePlaytimeClient(players, { hours = {}, guildId = 'guild' } = {}) {
    const asked = [];
    const bmInstance = {
        players: {},
        lastUpdateSuccessful: true,
        getRustLifetimeHours: async (playerId) => {
            asked.push(playerId);
            const value = hours[playerId];
            return value === undefined ? null : value;
        }
    };

    const client = makeClient({
        [guildId]: {
            instance: { trackers: { '0': { name: 'Tracker', battlemetricsId: 'bm-server', players: players } } },
            battlemetricsInstances: { 'bm-server': bmInstance }
        }
    });
    client.asked = asked;
    return client;
}

test('runPlaytimePass fills in the stalest player first and stamps the attempt', async () => {
    const now = Date.now();
    const fresh = { name: 'Fresh', playerId: '1', rustHours: 10, rustHoursUpdatedAt: now };
    const stale = { name: 'Stale', playerId: '2', rustHours: 20, rustHoursUpdatedAt: now - 2 * DAY_MS };
    const never = { name: 'Never', playerId: '3', rustHours: null, rustHoursUpdatedAt: 0 };

    const client = makePlaytimeClient([fresh, stale, never], { hours: { '2': 1234, '3': 42 } });

    await BattlemetricsHandler.runPlaytimePass(client);

    /* One request per cycle by default, spent on the row that has never been
       filled in rather than on a refresh. */
    assert.deepStrictEqual(client.asked, ['3']);
    assert.strictEqual(never.rustHours, 42);
    assert.ok(never.rustHoursUpdatedAt >= now);

    /* Untouched this cycle — they get their turn on the following ones. */
    assert.strictEqual(stale.rustHours, 20);
    assert.strictEqual(stale.rustHoursUpdatedAt, now - 2 * DAY_MS);
    assert.strictEqual(fresh.rustHours, 10);

    await BattlemetricsHandler.runPlaytimePass(client);
    assert.deepStrictEqual(client.asked, ['3', '2']);
    assert.strictEqual(stale.rustHours, 1234);
});

test('runPlaytimePass leaves a fresh roster alone entirely', async () => {
    const now = Date.now();
    const players = [
        { name: 'A', playerId: '1', rustHours: 10, rustHoursUpdatedAt: now },
        { name: 'B', playerId: '2', rustHours: 20, rustHoursUpdatedAt: now - 60000 }
    ];
    const client = makePlaytimeClient(players, { hours: { '1': 999, '2': 999 } });

    await BattlemetricsHandler.runPlaytimePass(client);

    assert.deepStrictEqual(client.asked, [], 'nothing was stale enough to be worth a request');
    assert.strictEqual(client.setInstanceCalls.length, 0);
});

/* The figure belongs to the human, not to the tracker they appear on. */
test('runPlaytimePass spends one request on a player tracked in two guilds', async () => {
    const rowA = { name: 'Pablo', playerId: '7', rustHours: null, rustHoursUpdatedAt: 0 };
    const rowB = { name: 'Pablo', playerId: '7', rustHours: null, rustHoursUpdatedAt: 0 };

    const asked = [];
    const bmInstance = {
        players: {},
        lastUpdateSuccessful: true,
        getRustLifetimeHours: async (playerId) => {
            asked.push(playerId);
            return 3000;
        }
    };
    const client = makeClient({
        guildA: {
            instance: { trackers: { '0': { battlemetricsId: 'bm-server', players: [rowA] } } },
            battlemetricsInstances: { 'bm-server': bmInstance }
        },
        guildB: {
            instance: { trackers: { '0': { battlemetricsId: 'bm-server', players: [rowB] } } },
            battlemetricsInstances: {}
        }
    });

    await BattlemetricsHandler.runPlaytimePass(client);

    assert.deepStrictEqual(asked, ['7'], 'one lookup answers for every row that shares the id');
    assert.strictEqual(rowA.rustHours, 3000);
    assert.strictEqual(rowB.rustHours, 3000, 'the other guild must get the answer too');
    assert.deepStrictEqual(client.setInstanceCalls.map(e => e.guildId).sort(), ['guildA', 'guildB']);
});

/* A private profile answers with nothing forever. Re-asking every cycle would
   spend the whole budget on it and starve everyone else. */
test('runPlaytimePass stamps a failed lookup and keeps the previous figure', async () => {
    const player = { name: 'Private', playerId: '9', rustHours: 500, rustHoursUpdatedAt: 0 };
    const client = makePlaytimeClient([player], { hours: {} });

    await BattlemetricsHandler.runPlaytimePass(client);

    assert.deepStrictEqual(client.asked, ['9']);
    assert.strictEqual(player.rustHours, 500, 'a failed refresh must not blank the card');
    assert.ok(player.rustHoursUpdatedAt > 0, 'the attempt is recorded so it backs off to one a day');

    await BattlemetricsHandler.runPlaytimePass(client);
    assert.deepStrictEqual(client.asked, ['9'], 'not re-asked on the very next cycle');
});

test('runPlaytimePass survives a lookup that throws', async () => {
    const player = { name: 'Boom', playerId: '9', rustHours: null, rustHoursUpdatedAt: 0 };
    const client = makePlaytimeClient([player]);
    client.battlemetricsInstances['bm-server'].getRustLifetimeHours = async () => {
        throw new Error('502 Bad Gateway');
    };

    await BattlemetricsHandler.runPlaytimePass(client);

    assert.strictEqual(player.rustHours, null);
    assert.ok(player.rustHoursUpdatedAt > 0);
    assert.strictEqual(client.logs.length, 1);
});

test('collectPlaytimeCandidates skips paused trackers, failing servers and unlinked rows', () => {
    const linked = { name: 'Linked', playerId: '1', rustHoursUpdatedAt: 0 };
    const unlinked = { name: 'Unlinked', playerId: null, steamId: VALID_ID, rustHoursUpdatedAt: 0 };
    const paused = { name: 'Paused', playerId: '2', rustHoursUpdatedAt: 0 };
    const broken = { name: 'Broken', playerId: '3', rustHoursUpdatedAt: 0 };

    const client = makeClient({
        guild: {
            instance: {
                trackers: {
                    '0': { battlemetricsId: 'bm-server', players: [linked, unlinked] },
                    '1': { battlemetricsId: 'bm-server', active: false, players: [paused] },
                    '2': { battlemetricsId: 'bm-broken', players: [broken] }
                }
            },
            battlemetricsInstances: {
                'bm-server': { players: {}, lastUpdateSuccessful: true },
                'bm-broken': { players: {}, lastUpdateSuccessful: false }
            }
        }
    });

    const candidates = BattlemetricsHandler.collectPlaytimeCandidates(client);

    assert.deepStrictEqual(candidates.map(e => e.playerId), ['1']);
});

/* A private profile answers 200-with-no-playtime, which is ordinary and must
   never log. "Every request, forever, and not one success" is a broken endpoint
   or a changed response shape, and used to be entirely invisible: a non-200 is
   logged by Battlemetrics itself and a throw is logged by the pass, but this
   path is neither. */
test('runPlaytimePass reports a playtime endpoint that never once succeeds', async () => {
    BattlemetricsHandler._resetPlaytimeHealth();

    /* Enough distinct players to cross the threshold one cycle at a time. */
    const players = Array.from({ length: 14 }, (_, i) =>
        ({ name: `P${i}`, playerId: `${i}`, rustHours: null, rustHoursUpdatedAt: 0 }));
    const client = makePlaytimeClient(players, { hours: {} });

    for (let i = 0; i < 9; i++) await BattlemetricsHandler.runPlaytimePass(client);
    assert.strictEqual(client.logs.length, 0, 'nine empty answers are still just private profiles');

    await BattlemetricsHandler.runPlaytimePass(client);
    assert.strictEqual(client.logs.length, 1, 'the tenth crosses the threshold');
    assert.strictEqual(client.logs[0].level, 'warning');
    assert.match(client.logs[0].text, /battlemetricsPlaytimeUnavailable/);

    /* Once said, not repeated for the life of the process. */
    for (let i = 0; i < 4; i++) await BattlemetricsHandler.runPlaytimePass(client);
    assert.strictEqual(client.logs.length, 1, 'the warning must not repeat every cycle');

    BattlemetricsHandler._resetPlaytimeHealth();
});

test('runPlaytimePass stays silent when playtime is merely sometimes empty', async () => {
    BattlemetricsHandler._resetPlaytimeHealth();

    const players = Array.from({ length: 14 }, (_, i) =>
        ({ name: `P${i}`, playerId: `${i}`, rustHours: null, rustHoursUpdatedAt: 0 }));
    /* One player in the middle has real hours — the rest are private. */
    const client = makePlaytimeClient(players, { hours: { '5': 120 } });

    for (let i = 0; i < 14; i++) await BattlemetricsHandler.runPlaytimePass(client);

    assert.strictEqual(client.logs.length, 0,
        'a single success proves the endpoint works; the rest are private profiles');

    BattlemetricsHandler._resetPlaytimeHealth();
});
