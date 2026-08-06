const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* MapMarkers reaches the Discord client through `require('../../index.ts')`,
   which boots the whole bot on import. Seed the module cache with a stub so
   these tests exercise the marker logic in isolation. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
const clientStub = {
    client: {
        intlGet: (guildId, id) => id,
        getInstance: () => ({
            serverList: {
                'test-server': {
                    cargoShipEgressTimeMs: 50 * 60 * 1000,
                    oilRigLockedCrateUnlockTimeMs: 15 * 60 * 1000
                }
            }
        })
    }
};
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: clientStub
};

const MapMarkers = require('./MapMarkers.js');

const TYPE_VENDING_MACHINE = 3;
const TYPE_CH47 = 4;
const TYPE_CARGO_SHIP = 5;

const MAP_SIZE = 4000;

function makeRustPlus() {
    return {
        guildId: 'guild',
        serverId: 'test-server',
        isFirstPoll: false,
        info: { correctedMapSize: MAP_SIZE },
        map: { monuments: [{ token: 'oil_rig_small', x: 3000, y: 3000 }] },
        notificationSettings: new Proxy({}, {
            get: () => ({ discord: false, inGame: false, image: 'x.png' })
        }),
        cargoShipTracers: {},
        patrolHelicopterTracers: {},
        events: [],
        logs: [],
        sendEvent(setting, text) { this.events.push(text); },
        log(title, text) { this.logs.push(text); }
    };
}

function markers(list) {
    return { markers: list };
}

function vendingMachines(count) {
    /* Well inside the grid system so they don't trip deep sea detection. */
    return Array.from({ length: count }, (_, i) => ({
        id: 1000 + i, type: TYPE_VENDING_MACHINE, x: 1000 + i * 50, y: 1000, sellOrders: []
    }));
}

function newMapMarkers(rustplus, initialMarkers) {
    return new MapMarkers(markers(initialMarkers), rustplus, clientStub.client);
}

test('event marker feed is considered available while vending machines arrive', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    assert.strictEqual(mm.isEventMarkerFeedAvailable(), true);
    assert.strictEqual(mm.vendingMachines.length, 6);
});

test('a mid-session marker feed removal is not reported as events leaving the map', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    /* A cargo ship shows up and starts its timers. */
    mm.updateMapMarkers(markers([
        ...vendingMachines(6),
        { id: 55, type: TYPE_CARGO_SHIP, x: 100, y: 100 }
    ]));
    assert.strictEqual(mm.cargoShips.length, 1);
    assert.ok(Object.keys(mm.cargoShipEgressTimers).length > 0, 'expected a cargo egress timer');

    rustplus.events = [];

    /* The API change lands: every affected marker disappears at once. It takes
       a run of empty polls to be sure, and none of them may notify. */
    for (let i = 0; i < 12; i++) mm.updateMapMarkers(markers([]));

    assert.strictEqual(mm.isEventMarkerFeedAvailable(), false);
    assert.deepStrictEqual(rustplus.events, [], 'no "left the map" notifications should be emitted');
    assert.ok(rustplus.logs.includes('eventMarkerFeedUnavailable'), 'the removal should be logged once');

    /* Derived state and timers are dropped rather than left dangling. */
    assert.deepStrictEqual(mm.cargoShips, []);
    assert.deepStrictEqual(mm.vendingMachines, []);
    assert.deepStrictEqual(mm.patrolHelicopters, []);
    assert.deepStrictEqual(mm.travelingVendors, []);
    assert.deepStrictEqual(mm.deepSeas, []);
    assert.strictEqual(mm.isDeepSeaActive, false);
    assert.deepStrictEqual(Object.keys(mm.cargoShipEgressTimers), []);
    assert.deepStrictEqual(Object.keys(mm.cargoShipLockedCrateSpawnIntervals), []);
    assert.deepStrictEqual(Object.keys(mm.cargoShipMetaData), []);
    assert.deepStrictEqual(Object.keys(rustplus.cargoShipTracers), []);

    /* Further empty polls stay quiet. */
    rustplus.logs = [];
    mm.updateMapMarkers(markers([]));
    assert.deepStrictEqual(rustplus.events, []);
    assert.deepStrictEqual(rustplus.logs, []);
});

test('a single empty poll neither notifies nor destroys tracked state', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    mm.updateMapMarkers(markers([
        ...vendingMachines(6),
        { id: 55, type: TYPE_CARGO_SHIP, x: 100, y: 100 }
    ]));
    rustplus.events = [];

    /* One bad poll — a server saving behind a still-open websocket. */
    mm.updateMapMarkers(markers([]));

    assert.strictEqual(mm.isEventMarkerFeedAvailable(), true, 'one empty poll is not enough evidence');
    assert.deepStrictEqual(rustplus.events, [], 'nothing may be announced as having left');
    assert.strictEqual(mm.cargoShips.length, 1, 'tracked state must survive a blip');
    assert.ok(Object.keys(mm.cargoShipEgressTimers).length > 0, 'the egress timer must survive a blip');

    /* Markers come back: tracking continues, without re-announcing the ship
       or re-arming its timer from the wrong moment. */
    const timerBefore = mm.cargoShipEgressTimers[55];
    mm.updateMapMarkers(markers([
        ...vendingMachines(6),
        { id: 55, type: TYPE_CARGO_SHIP, x: 120, y: 120 }
    ]));

    assert.deepStrictEqual(rustplus.events, [], 'resuming must not replay the cargo ship arrival');
    assert.strictEqual(mm.cargoShips.length, 1);
    assert.strictEqual(mm.cargoShipEgressTimers[55], timerBefore, 'the original egress timer must be kept');

    mm.reset();
});

test('oil rig events keep working after the event marker feed is gone', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    for (let i = 0; i < 12; i++) mm.updateMapMarkers(markers([]));
    assert.strictEqual(mm.isEventMarkerFeedAvailable(), false);

    rustplus.events = [];

    /* CH47 markers are not part of the removal — a chinook landing on the
       small oil rig must still raise the heavy scientist event. */
    mm.updateMapMarkers(markers([{ id: 77, type: TYPE_CH47, x: 3000, y: 3000 }]));

    assert.strictEqual(mm.ch47s.length, 1);
    assert.ok(rustplus.events.includes('heavyScientistsCalledSmall'),
        `expected the oil rig event, got ${JSON.stringify(rustplus.events)}`);
    assert.ok(mm.crateSmallOilRigTimer, 'expected the locked crate timer to be armed');

    mm.reset();
});

test('a connection that never receives vending machines flags the feed after a grace period', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, []);

    /* The constructor already counted one poll. */
    for (let i = 0; i < 20; i++) {
        mm.updateMapMarkers(markers([]));
    }

    assert.strictEqual(mm.isEventMarkerFeedAvailable(), false);
    assert.strictEqual(rustplus.logs.filter(e => e === 'eventMarkerFeedUnavailable').length, 1,
        'the removal should only be logged once');
});

test('the feed is picked back up if vending machine markers return', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    for (let i = 0; i < 12; i++) mm.updateMapMarkers(markers([]));
    assert.strictEqual(mm.isEventMarkerFeedAvailable(), false);

    rustplus.events = [];
    mm.updateMapMarkers(markers([
        ...vendingMachines(6),
        { id: 55, type: TYPE_CARGO_SHIP, x: 100, y: 100 }
    ]));

    assert.strictEqual(mm.isEventMarkerFeedAvailable(), true);
    assert.ok(rustplus.logs.includes('eventMarkerFeedRestored'));
    assert.strictEqual(mm.vendingMachines.length, 6);
    assert.deepStrictEqual(rustplus.events, [],
        'a restored feed must not replay the whole map as newly arrived events');

    /* The ship is adopted as already-present: tracked, but with no egress
       timer, because we have no idea when it actually spawned. */
    assert.strictEqual(mm.cargoShips.length, 1);
    assert.deepStrictEqual(Object.keys(mm.cargoShipEgressTimers), [],
        'no timer may be armed from a moment we cannot know');

    /* Diffing resumes normally from that baseline. */
    mm.updateMapMarkers(markers(vendingMachines(6)));
    assert.ok(rustplus.events.includes('cargoShipLeftMap'),
        `expected the ship leaving to be reported, got ${JSON.stringify(rustplus.events)}`);

    mm.reset();
});

test('reset clears the feed verdict so a reconnect re-evaluates it', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    for (let i = 0; i < 12; i++) mm.updateMapMarkers(markers([]));
    assert.strictEqual(mm.isEventMarkerFeedAvailable(), false);

    mm.reset();
    assert.strictEqual(mm.isEventMarkerFeedAvailable(), true);
    assert.strictEqual(mm.vendingMachineEverSeen, false);
});

test('deep sea detection still fires while the feed is alive', () => {
    const rustplus = makeRustPlus();
    const mm = newMapMarkers(rustplus, vendingMachines(6));

    rustplus.events = [];

    /* A vending machine far outside the grid system is how the deep sea
       merchant is detected. */
    mm.updateMapMarkers(markers([
        ...vendingMachines(6),
        { id: 9001, type: TYPE_VENDING_MACHINE, x: -2000, y: -2000, sellOrders: [] }
    ]));

    assert.strictEqual(mm.isDeepSeaActive, true);
    assert.ok(rustplus.events.includes('deepSeaDetected'));
});
