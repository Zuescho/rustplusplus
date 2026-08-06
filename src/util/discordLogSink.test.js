const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');
const Discord = require('discord.js');

/* Stub the client module so nothing boots the real bot. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');

const sent = [];
let channel = { type: Discord.ChannelType.GuildText, send: async (content) => { sent.push(content); } };

const state = {
    guilds: ['guild-a'],
    instances: {
        'guild-a': { channelId: { logs: 'chan-a' }, generalSettings: { logChannelEnabled: true } },
        'guild-b': { channelId: { logs: 'chan-b' }, generalSettings: { logChannelEnabled: true } }
    }
};

const guildStub = { channels: { cache: { get: () => channel } } };

const clientStub = {
    client: {
        isReady: () => true,
        get guilds() { return { cache: new Map(state.guilds.map(g => [g, guildStub])) }; },
        getInstance: (guildId) => state.instances[guildId]
    }
};

require.cache[indexPath] = {
    id: indexPath, filename: indexPath, path: Path.dirname(indexPath),
    loaded: true, children: [], paths: [], exports: clientStub
};

const Sink = require('./discordLogSink.js');

test.beforeEach(() => {
    sent.length = 0;
    state.guilds = ['guild-a'];
    state.instances['guild-a'].generalSettings.logChannelEnabled = true;
    channel = { type: Discord.ChannelType.GuildText, send: async (content) => { sent.push(content); } };
});

test('guild scoped lines are batched into a single code block', async () => {
    Sink.capture('guild-a', 'first line');
    Sink.capture('guild-a', 'second line');
    Sink.capture('guild-a', 'third line');

    assert.strictEqual(sent.length, 0, 'lines should be buffered, not sent one by one');

    await Sink.flushAll();

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].content, /^```\n/);
    assert.match(sent[0].content, /first line\nsecond line\nthird line/);
});

test('nothing is mirrored when the guild has the setting disabled', async () => {
    state.instances['guild-a'].generalSettings.logChannelEnabled = false;

    Sink.capture('guild-a', 'should not appear');
    await Sink.flushAll();

    assert.deepStrictEqual(sent, []);
});

test('bot-wide lines are mirrored on a single-guild bot but not a multi-guild one', async () => {
    Sink.capture(null, 'bot wide line');
    await Sink.flushAll();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].content, /bot wide line/);

    sent.length = 0;
    state.guilds = ['guild-a', 'guild-b'];

    Sink.capture(null, 'must not leak across guilds');
    await Sink.flushAll();
    assert.deepStrictEqual(sent, [], 'bot-wide lines must not be posted when several guilds are served');
});

test('an overflowing buffer drops the oldest lines and says so', async () => {
    for (let i = 0; i < 260; i++) Sink.capture('guild-a', `line ${i}`);
    await Sink.flushAll();

    const joined = sent.map(e => e.content).join('');
    assert.match(joined, /log lines dropped \(buffer full\)/);
    assert.ok(!joined.includes('line 0\n'), 'the oldest lines should have been dropped');
    assert.match(joined, /line 259/);
});

test('each flushed message stays within the Discord length limit', async () => {
    for (let i = 0; i < 60; i++) Sink.capture('guild-a', `${i}`.padStart(4, '0') + ' '.repeat(60) + 'x');
    await Sink.flushAll();

    assert.ok(sent.length > 1, 'the batch should have been split over several messages');
    for (const message of sent) {
        assert.ok(message.content.length <= 2000, `message too long: ${message.content.length}`);
    }
});

test('player-controlled text cannot break out of the code fence or ping anyone', async () => {
    /* In-game chat is logged verbatim, so a teammate controls this string. */
    Sink.capture('guild-a', 'INFO: Player said: ``` @everyone raid at F12');
    await Sink.flushAll();

    assert.strictEqual(sent.length, 1);
    const { content } = sent[0];

    /* Exactly two fences: the ones the sink itself wrote. */
    assert.strictEqual(content.split('```').length - 1, 2, 'the payload must not close the code fence');
    assert.ok(content.startsWith('```\n') && content.endsWith('\n```'));
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] }, 'no log line may ping anyone');
});

test('a failing send does not recurse back into the sink', async () => {
    let sendAttempts = 0;
    channel = {
        type: Discord.ChannelType.GuildText,
        send: async () => {
            sendAttempts += 1;
            /* Emulate something on the send path logging, which would come
               straight back into the sink. */
            Sink.capture('guild-a', 'error while sending logs');
            throw new Error('discord is down');
        }
    };

    Sink.capture('guild-a', 'a line');
    await Sink.flushAll();

    assert.strictEqual(sendAttempts, 1, 'a line logged during the flush must not drive another send');
});

test('lines logged while a send is in flight are kept for the next flush', async () => {
    let release;
    const inFlight = new Promise(resolve => { release = resolve; });
    channel = {
        type: Discord.ChannelType.GuildText,
        send: async (content) => { await inFlight; sent.push(content); }
    };

    Sink.capture('guild-a', 'before');
    const flushing = Sink.flushAll();

    /* Arrives while the first send is still awaiting Discord. */
    Sink.capture('guild-a', 'during');
    release();
    await flushing;

    channel = { type: Discord.ChannelType.GuildText, send: async (content) => { sent.push(content); } };
    await Sink.flushAll();

    const joined = sent.map(e => e.content).join('');
    assert.match(joined, /before/);
    assert.match(joined, /during/, 'a line logged during a send must not be dropped');
});
