const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* discordEmbeds reaches the client through `require('../../index.ts')`, which
   boots the whole bot on import. Seed the module cache with a stub whose
   instance the tests rewrite per case. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
const instance = { trackers: {} };
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
            battlemetricsInstances: {}
        }
    }
};

const Client = require(indexPath);
const DiscordEmbeds = require('./discordEmbeds.js');
const ActivityDb = require('../util/activityDb.js');

/* The group hint is a SQLite read and has nothing to do with what these tests
   assert; silence it so no database is opened. */
const originalGroupHint = ActivityDb.getGroupActiveHint;
test.before(() => { ActivityDb.getGroupActiveHint = () => null; });
test.after(() => { ActivityDb.getGroupActiveHint = originalGroupHint; });

/* Build one tracker with the given players and a roster that reports each of
   them online, then return the rendered status column. */
function renderStatusColumn(players, { roster = null } = {}) {
    instance.trackers = {
        '0': {
            name: 'Tracker',
            title: 'Title',
            img: '',
            serverId: 'srv',
            battlemetricsId: 'bm-server',
            players: players
        }
    };

    const bmPlayers = roster ?? Object.fromEntries(players
        .filter(p => p.playerId)
        .map(p => [p.playerId, { status: true, updatedAt: new Date().toISOString() }]));

    Client.client.battlemetricsInstances = {
        'bm-server': {
            lastUpdateSuccessful: true,
            streamerMode: false,
            players: bmPlayers,
            getOnlineTime: () => [0, '00:00'],
            getOfflineTime: () => [0, '01:00']
        }
    };

    const embed = DiscordEmbeds.getTrackerEmbed('guild', '0');
    /* Fields are laid out as name/status/spacer triplets, page by page. */
    return embed.data.fields[1].value;
}

test('the tracker card appends lifetime Rust hours to the status column', () => {
    const status = renderStatusColumn([
        { name: 'Veteran', playerId: '1', steamId: null, rustHours: 12400 },
        { name: 'Rookie', playerId: '2', steamId: null, rustHours: 42 }
    ]);

    const lines = status.trim().split('\n');
    assert.ok(lines[0].endsWith(' · 12.4k h'), `unexpected line: ${lines[0]}`);
    assert.ok(lines[1].endsWith(' · 42 h'), `unexpected line: ${lines[1]}`);
    /* The status the row already carried must survive alongside it. */
    assert.ok(lines[0].includes('[00:00]'));
});

test('a player with no known hours renders exactly as before', () => {
    const status = renderStatusColumn([
        { name: 'Unknown', playerId: '1', steamId: null, rustHours: null },
        { name: 'Legacy', playerId: '2', steamId: null }
    ]);

    for (const line of status.trim().split('\n')) {
        assert.ok(!line.includes('·'), `no separator should be rendered: ${line}`);
        assert.ok(line.includes('[00:00]'));
    }
});

/* A cached figure outlives the roster: a player the current poll has never
   seen still shows the hours we already learnt. */
test('hours are shown for a player missing from the roster', () => {
    const status = renderStatusColumn(
        [{ name: 'Ghost', playerId: '9', steamId: null, rustHours: 300 }],
        { roster: {} });

    assert.ok(status.trim().endsWith(' · 300 h'), `unexpected column: ${status}`);
});
