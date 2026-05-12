/*
    Global request limiter for the Battlemetrics API.

    Why: the bot polls every 60s and, in a single tick, fires one request per
    unique BM server instance. With several active servers/trackers this turns
    into a synchronous burst that can briefly exceed BM's short-window
    rate limits (a single 429 from BM forces a backoff that ripples through the
    handler). Spacing the calls a little flattens the burst without slowing
    the overall poll cycle meaningfully.

    Single global serial queue: each enqueued request waits MIN_SPACING_MS
    after the previous one started. Jitter prevents two bot instances behind
    the same NAT from synchronizing.
*/

const Axios = require('axios');

const MIN_SPACING_MS = 1500;
const JITTER_MS = 400;

let lastRequestAt = 0;
let queueTail = Promise.resolve();

async function scheduleGet(url, options = {}) {
    const myTurn = queueTail.then(async () => {
        const now = Date.now();
        const elapsed = now - lastRequestAt;
        const jitter = Math.floor(Math.random() * JITTER_MS);
        const wait = Math.max(0, MIN_SPACING_MS - elapsed) + jitter;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastRequestAt = Date.now();
        return Axios.get(url, options);
    });
    queueTail = myTurn.catch(() => { /* keep the chain alive on error */ });
    return myTurn;
}

module.exports = {
    scheduleGet,
    MIN_SPACING_MS,
};
