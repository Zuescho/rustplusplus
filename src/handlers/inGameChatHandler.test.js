const test = require('node:test');
const assert = require('node:assert');
const Protobuf = require('protobufjs');
const Path = require('path');

const InGameChatHandler = require('./inGameChatHandler.js');

/* The real wire shape matters here. A successful reply is a decoded protobuf
   AppResponse, and `error` is an optional field — protobufjs puts `error: null`
   on the PROTOTYPE rather than as an own property. A success check written as
   `response.error !== undefined` is therefore true on success, which reported
   every delivered message as dropped. These tests decode genuine frames rather
   than hand-rolled object literals, because a literal cannot reproduce that. */
const root = Protobuf.loadSync(Path.join(__dirname, '..', 'rustplus', 'rustplus.proto'));
const AppResponse = root.lookupType('rustplus.AppResponse');

function decoded(obj) {
    return AppResponse.decode(AppResponse.encode(AppResponse.fromObject(obj)).finish());
}

const SUCCESS = decoded({ seq: 1, success: {} });
const FAILURE = decoded({ seq: 1, error: { error: 'not_found' } });

function makeClient() {
    return { intlGet: (guildId, id) => id };
}

/* Minimal stand-in for the parts of RustPlus the queue path touches. */
function makeRustPlus(sendResult) {
    const logs = [];
    return {
        logs,
        sent: [],
        guildId: 'guild',
        generalSettings: { commandDelay: '0', trademark: 'NOT SHOWING' },
        inGameChatQueue: ['hello'],
        inGameChatTimeout: setTimeout(() => { }, 0),
        inGameSendFailing: false,
        updateBotMessages: () => { },
        log: (title, text, level) => logs.push({ title, text, level }),
        sendTeamMessageAsync: async function (msg) {
            this.sent.push(msg);
            return typeof sendResult === 'function' ? sendResult() : sendResult;
        }
    };
}

/* The handler fires the send without awaiting it — deliberately, so a slow
   request cannot stall the queue timer — so the assertions have to let the
   microtask queue drain first. */
const settle = () => new Promise(r => setImmediate(r));

test('a delivered message is logged as sent, not as dropped', async () => {
    const rustplus = makeRustPlus(SUCCESS);
    await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
    await settle();

    assert.deepStrictEqual(rustplus.sent, ['hello']);
    assert.strictEqual(rustplus.inGameSendFailing, false, 'a success must not latch the failure flag');
    assert.strictEqual(rustplus.logs.length, 1);
    assert.strictEqual(rustplus.logs[0].title, 'messageCap');
    assert.strictEqual(rustplus.logs[0].text, 'hello');
});

test('a refused message is reported once and stops claiming delivery', async () => {
    const rustplus = makeRustPlus(FAILURE);
    await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
    await settle();

    assert.strictEqual(rustplus.inGameSendFailing, true);
    assert.strictEqual(rustplus.logs.length, 1);
    assert.strictEqual(rustplus.logs[0].level, 'error');
    assert.strictEqual(rustplus.logs[0].text, 'inGameMessageSendFailed');

    /* A drained queue against a dead socket must not emit one line per message. */
    rustplus.inGameChatQueue = ['second'];
    rustplus.inGameChatTimeout = setTimeout(() => { }, 0);
    await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
    await settle();
    assert.strictEqual(rustplus.logs.length, 1, 'an ongoing outage must report once, not per message');
});

test('the other failure shapes are recognised too', async () => {
    for (const [label, result] of [
        ['token exhaustion', { error: 'tokensDidNotReplenish' }],
        ['request timeout', new Error('Timeout reached while waiting for response')]
    ]) {
        const rustplus = makeRustPlus(result);
        await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
        await settle();
        assert.strictEqual(rustplus.inGameSendFailing, true, label);
        assert.strictEqual(rustplus.logs[0].text, 'inGameMessageSendFailed', label);
    }
});

test('recovery is announced once and delivery logging resumes', async () => {
    let result = FAILURE;
    const rustplus = makeRustPlus(() => result);

    await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
    await settle();
    assert.strictEqual(rustplus.inGameSendFailing, true);

    result = SUCCESS;
    rustplus.inGameChatQueue = ['back'];
    rustplus.inGameChatTimeout = setTimeout(() => { }, 0);
    await InGameChatHandler.inGameChatHandler(rustplus, makeClient(), null);
    await settle();

    assert.strictEqual(rustplus.inGameSendFailing, false);
    assert.deepStrictEqual(rustplus.logs.map(l => l.text),
        ['inGameMessageSendFailed', 'inGameMessageSendRecovered', 'back']);
});
