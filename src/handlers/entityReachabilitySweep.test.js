const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');

/* RustPlus reads the bot singleton through `require('../../index.ts')`, which
   boots the whole bot on import. Seed the module cache with a stub, the same
   way teamChatHandler.test.js does. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    path: Path.dirname(indexPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
        client: {
            intlGet: (guildId, id, vars = {}) => {
                if (id === 'responseContainError') return `error:${vars.error}`;
                return id;
            }
        }
    }
};

const RustPlus = require('../structures/RustPlus.js');

/* The sweeps post Discord cards through these; the test only cares about the
   log lines, so the senders are stubbed out. */
const DiscordMessages = require('../discordTools/discordMessages.js');
const STUBS = {
    sendSmartAlarmNotFoundMessage: async () => { },
    sendSmartAlarmMessage: async () => { },
    sendSmartSwitchNotFoundMessage: async () => { },
    sendSmartSwitchMessage: async () => { },
    sendStorageMonitorNotFoundMessage: async () => { },
    sendStorageMonitorMessage: async () => { },
};
const originals = {};
for (const key of Object.keys(STUBS)) {
    originals[key] = DiscordMessages[key];
    DiscordMessages[key] = STUBS[key];
}
test.after(() => {
    for (const key of Object.keys(originals)) DiscordMessages[key] = originals[key];
});

const SmartAlarmHandler = require('./smartAlarmHandler.js');
const SmartSwitchHandler = require('./smartSwitchHandler.js');
const StorageMonitorHandler = require('./storageMonitorHandler.js');

/* Entity '1' starts reachable (transition must be reported once), entity '2'
   is already known gone (must stay silent). */
function makeServerList(entityKey) {
    return {
        switchGroups: {},
        [entityKey]: {
            '1': { reachable: true, active: false, autoDayNightOnOff: 0, command: 'a', name: 'A' },
            '2': { reachable: false, active: false, autoDayNightOnOff: 0, command: 'b', name: 'B' },
        }
    };
}

function makeRustPlus(counterKey) {
    const rp = {
        guildId: 'g', serverId: 's', logs: [],
        time: {
            timeTillActive: false,
            isTurnedDay: () => false,
            isTurnedNight: () => false,
            isDay: () => false,
            isNight: () => false,
        },
        log(title, text) { rp.logs.push(text); },
        async getEntityInfoAsync() { return { error: 'not_found' }; },
        isResponseValid: RustPlus.prototype.isResponseValid,
    };
    rp[counterKey] = 29; /* the next handler call resets to 0 and sweeps */
    return rp;
}

async function runSweep(handler, counterKey, entityKey) {
    const instance = { serverList: { s: makeServerList(entityKey) } };
    const client = { getInstance: () => instance, setInstance: () => { } };
    const rp = makeRustPlus(counterKey);

    await handler.handler(rp, client, 0);
    assert.strictEqual(rp.logs.length, 1,
        `${entityKey}: the transition into unreachable logs exactly once, got ${rp.logs.length}`);

    rp[counterKey] = 29;
    await handler.handler(rp, client, 0);
    assert.strictEqual(rp.logs.length, 1,
        `${entityKey}: an entity already known gone is probed silently, got ${rp.logs.length}`);
}

test('a smart alarm that stops answering is logged on the transition only', async () => {
    await runSweep(SmartAlarmHandler, 'smartAlarmIntervalCounter', 'alarms');
});

test('a smart switch that stops answering is logged on the transition only', async () => {
    await runSweep(SmartSwitchHandler, 'smartSwitchIntervalCounter', 'switches');
});

test('a storage monitor that stops answering is logged on the transition only', async () => {
    await runSweep(StorageMonitorHandler, 'storageMonitorIntervalCounter', 'storageMonitors');
});

test('isResponseValid reports the AppError string for both response shapes', async () => {
    const rp = makeRustPlus('smartAlarmIntervalCounter');
    assert.strictEqual(await rp.isResponseValid({ error: 'not_found' }), false);
    assert.strictEqual(await rp.isResponseValid({ error: { error: 'not_found' } }), false);
    assert.deepStrictEqual(rp.logs, ['error:not_found', 'error:not_found']);
});

test('isResponseValid can suppress the log without changing the verdict', async () => {
    const rp = makeRustPlus('smartAlarmIntervalCounter');
    assert.strictEqual(await rp.isResponseValid({ error: 'not_found' }, false), false);
    assert.deepStrictEqual(rp.logs, []);
});

test('an unreachable auto-on switch is not turned every poll', async () => {
    const instance = {
        serverList: {
            s: {
                switchGroups: {},
                switches: {
                    '1': { reachable: false, active: false, autoDayNightOnOff: 3, command: 'a', name: 'A' },
                }
            }
        }
    };
    const rp = makeRustPlus('smartSwitchIntervalCounter');
    rp.smartSwitchIntervalCounter = 1;
    rp.interactionSwitches = [];
    let turns = 0;
    rp.turnSmartSwitchOnAsync = async () => { turns += 1; return { error: 'not_found' }; };
    const client = { getInstance: () => instance, setInstance: () => { } };

    await SmartSwitchHandler.handler(rp, client, 0);
    assert.strictEqual(turns, 0);
    assert.deepStrictEqual(rp.logs, []);
});
