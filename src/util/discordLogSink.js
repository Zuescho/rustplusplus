/*
    Mirrors the bot's log output into a Discord channel so operators can see
    what the bot is doing (and what is going wrong) without shelling into the
    host and tailing logs/*.log.

    Design notes:

    - Batched. Discord rate limits messages per channel, and the bot can emit
      several log lines per poll cycle. Lines are buffered and flushed once per
      FLUSH_INTERVAL_MS as a single code block, which also keeps the channel
      readable.

    - Bounded. If Discord is slow or unreachable the buffer would otherwise
      grow without limit; it is capped at MAX_BUFFERED_LINES and the oldest
      lines are dropped with an explicit "… N lines dropped" marker so the gap
      is visible rather than silent.

    - Non-recursive. Sending to Discord can itself fail, and logging that
      failure would enqueue another line, and so on. Nothing on the flush path
      goes through the logger — failures land on the console, and the channel
      is looked up straight off the guild cache rather than through
      DiscordTools (which logs). Flushes are only ever started by a timer, so
      capturing a line can never trigger a send synchronously.

    - Untrusted content. Log lines quote in-game chat and player names
      verbatim, so a player controls part of what gets posted. A line
      containing a triple backtick would close the code fence and let the rest
      render as markdown — including a live @everyone. Backtick runs are broken
      up on capture, and the send suppresses every mention type outright.

    - Guild scoped. Per-guild loggers (one per Rust+ connection) mirror into
      that guild's channel. The bot-wide logger has no guild, so its lines are
      only mirrored when the bot serves a single guild — in a multi-guild
      deployment they would leak one guild's activity into another guild's
      private channel. They remain in logs/discordBot.log either way.
*/

const Discord = require('discord.js');

const Client = require('../../index.ts');

const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFERED_LINES = 200;
/* Discord's hard limit is 2000 characters; leave room for the code fence and
   the dropped-lines marker. */
const MAX_MESSAGE_LENGTH = 1900;
const MAX_LINE_LENGTH = 500;

/* guildId -> { lines: string[], dropped: number, timer: Timeout|null,
                sending: boolean } */
const buffers = new Map();

function getClient() {
    return Client.client;
}

/**
 *  Resolve the guild's log channel without going through DiscordTools, whose
 *  failure path logs — which is exactly what must not happen while draining
 *  the log buffer.
 *  @param {object} client The Discord bot client.
 *  @param {string} guildId The guild id.
 *  @param {string} channelId The configured log channel id.
 *  @return {object|null} The text channel, or null.
 */
function getLogChannel(client, guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== Discord.ChannelType.GuildText) return null;
    return channel;
}

function isEnabledForGuild(client, guildId) {
    const instance = client.getInstance(guildId);
    if (!instance) return false;
    if (!instance.channelId || !instance.channelId.logs) return false;
    if (!instance.generalSettings) return false;
    return instance.generalSettings.logChannelEnabled !== false;
}

function targetGuildIds(client, guildId) {
    if (guildId !== null && guildId !== undefined) {
        return isEnabledForGuild(client, guildId) ? [`${guildId}`] : [];
    }

    /* Bot-wide line: only safe to mirror when there is exactly one guild.
       This runs for every log line, so avoid materialising the key list. */
    const cache = client.guilds.cache;
    if (cache.size !== 1) return [];
    const onlyGuildId = cache.keys().next().value;
    return isEnabledForGuild(client, onlyGuildId) ? [onlyGuildId] : [];
}

/**
 *  Make a log line safe to drop inside a ``` code fence. Log lines quote
 *  in-game chat and player names verbatim, so a player can put arbitrary text
 *  here; a triple backtick would end the fence early and everything after it
 *  would render as markdown in the log channel. A zero-width space between
 *  backticks keeps the text readable while making the run inert.
 *  @param {string} line The formatted log line.
 *  @return {string} The escaped line.
 */
function sanitize(line) {
    return line.replace(/`/g, '`​');
}

function enqueue(guildId, line) {
    let buffer = buffers.get(guildId);
    if (!buffer) {
        buffer = { lines: [], dropped: 0, timer: null, sending: false };
        buffers.set(guildId, buffer);
    }

    buffer.lines.push(line);
    while (buffer.lines.length > MAX_BUFFERED_LINES) {
        buffer.lines.shift();
        buffer.dropped += 1;
    }

    if (buffer.timer === null) {
        buffer.timer = setTimeout(() => flush(guildId), FLUSH_INTERVAL_MS);
        if (buffer.timer.unref) buffer.timer.unref();
    }
}

/**
 *  Pull as many buffered lines as fit into one Discord message.
 *  @param {object} buffer The guild's buffer.
 *  @return {string} The message body (without the code fence), '' if nothing.
 */
function takeChunk(buffer) {
    const parts = [];
    let length = 0;

    if (buffer.dropped > 0) {
        parts.push(`... ${buffer.dropped} log lines dropped (buffer full)`);
        length += parts[0].length + 1;
        buffer.dropped = 0;
    }

    while (buffer.lines.length > 0) {
        const line = buffer.lines[0];
        if (length + line.length + 1 > MAX_MESSAGE_LENGTH && parts.length > 0) break;
        buffer.lines.shift();
        parts.push(line);
        length += line.length + 1;
    }

    return parts.join('\n');
}

async function flush(guildId) {
    const buffer = buffers.get(guildId);
    if (!buffer) return;

    buffer.timer = null;
    /* A previous flush is still awaiting Discord; it reschedules itself. */
    if (buffer.sending) return;
    if (buffer.lines.length === 0 && buffer.dropped === 0) return;

    const client = getClient();
    if (!client) return;

    const body = takeChunk(buffer);
    if (body === '') return;

    buffer.sending = true;
    try {
        const instance = client.getInstance(guildId);
        const channelId = instance?.channelId?.logs ?? null;
        if (channelId) {
            const channel = getLogChannel(client, guildId, channelId);
            /* Deliberately channel.send and not client.messageSend: the latter
               logs failures through the very logger we are draining. */
            if (channel) {
                await channel.send({
                    content: `\`\`\`\n${body}\n\`\`\``,
                    /* Belt and braces alongside the backtick escaping: even if
                       something did break out of the fence, nothing in a log
                       line may ping anyone. */
                    allowedMentions: { parse: [] }
                });
            }
        }
    }
    catch (e) {
        /* Console only — routing this through the logger would re-enter.
           The chunk is already out of the buffer, so a failed send loses those
           lines from Discord; they are still in logs/*.log. */
        console.error(`Failed to mirror logs to the Discord log channel: ${e.message}`);
    }
    finally {
        buffer.sending = false;
    }

    /* More waiting? Schedule the next flush instead of sending back-to-back. */
    if ((buffer.lines.length > 0 || buffer.dropped > 0) && buffer.timer === null) {
        buffer.timer = setTimeout(() => flush(guildId), FLUSH_INTERVAL_MS);
        if (buffer.timer.unref) buffer.timer.unref();
    }
}

module.exports = {
    /**
     *  Queue a formatted log line for the Discord log channel.
     *  @param {string|null} guildId The guild the line belongs to, or null for
     *                               bot-wide lines.
     *  @param {string} line The already formatted line (time, title, text).
     */
    capture: function (guildId, line) {
        const client = getClient();
        /* Before login there is no guild cache and no instances to read. */
        if (!client || !client.isReady?.()) return;

        let targets;
        try {
            targets = targetGuildIds(client, guildId);
        }
        catch (e) {
            return;
        }
        if (targets.length === 0) return;

        const trimmed = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
        for (const id of targets) enqueue(id, sanitize(trimmed));
    },

    /**
     *  Send everything that is currently buffered without waiting for the next
     *  scheduled flush.
     */
    flushAll: async function () {
        for (const guildId of [...buffers.keys()]) {
            const buffer = buffers.get(guildId);
            if (!buffer) continue;

            /* A flush only drains one message worth of lines, so loop — but
               only over what is buffered right now. Lines produced *by* the
               flush (a failing send logging the failure, say) wait for the
               next scheduled flush instead, so this can't spin. */
            let remaining = buffer.lines.length;
            while (remaining > 0) {
                const before = buffer.lines.length;
                if (buffer.timer !== null) {
                    clearTimeout(buffer.timer);
                    buffer.timer = null;
                }
                await flush(guildId);

                const consumed = before - buffer.lines.length;
                if (consumed <= 0) break; /* No progress — don't loop forever. */
                remaining -= consumed;
            }
        }
    }
};
