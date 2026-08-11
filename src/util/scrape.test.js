const test = require('node:test');
const assert = require('node:assert');

const Scrape = require('./scrape');
const Config = require('../../config');
const messages = require('../languages/en.json');

/* Formats against the real en.json so a message key that was never added
   fails the test instead of silently logging "undefined". */
function makeClient() {
    const logs = [];
    return {
        logs,
        log: (title, text, level) => logs.push({ title, text, level }),
        intlGet: (guildId, id, vars = {}) => {
            const template = messages[id];
            if (template === undefined) throw new Error(`missing message key: ${id}`);
            return template.replace(/\{(\w+)\}/g, (_, key) => `${vars[key]}`);
        }
    };
}

/* Swap the network call for a canned result, run fn, always restore. */
async function withScrape(stub, fn) {
    const original = Scrape.scrape;
    const calls = [];
    Scrape.scrape = async (url) => {
        calls.push(url);
        return typeof stub === 'function' ? stub(url) : stub;
    };
    try {
        return await fn(calls);
    }
    finally {
        Scrape.scrape = original;
    }
}

const VALID_ID = '76561198996560458';

test('a malformed SteamID64 is rejected without making a request', async () => {
    for (const bad of ['', '   ', '123', 'notanid', '7656119899656045x']) {
        await withScrape({ status: 200, data: '' }, async (calls) => {
            const client = makeClient();
            assert.strictEqual(await Scrape.scrapeSteamProfileName(client, bad), null);
            assert.strictEqual(calls.length, 0, `should not request for ${JSON.stringify(bad)}`);
            assert.match(client.logs[0].text, /malformed SteamID64/);
        });
    }
});

test('an empty SteamID64 is reported as (empty) rather than a bare URL', async () => {
    await withScrape({ status: 200, data: '' }, async () => {
        const client = makeClient();
        await Scrape.scrapeSteamProfileName(client, '');
        assert.match(client.logs[0].text, /\(empty\)/);
    });
});

test('a rate limit is reported as 429 and carries Retry-After', async () => {
    await withScrape({ status: 429, headers: { 'retry-after': '120' } }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), null);
        assert.match(client.logs[0].text, /HTTP 429/);
        assert.match(client.logs[0].text, /rate limited by Steam/);
        assert.match(client.logs[0].text, /retry-after 120s/);
    });
});

test('a rate limit without Retry-After still reports 429', async () => {
    await withScrape({ status: 429, headers: {} }, async () => {
        const client = makeClient();
        await Scrape.scrapeSteamProfileName(client, VALID_ID);
        assert.match(client.logs[0].text, /HTTP 429/);
        assert.doesNotMatch(client.logs[0].text, /retry-after/);
    });
});

test('a blocked host is distinguishable from a rate limit', async () => {
    await withScrape({ status: 403 }, async () => {
        const client = makeClient();
        await Scrape.scrapeSteamProfileName(client, VALID_ID);
        assert.match(client.logs[0].text, /HTTP 403/);
        assert.match(client.logs[0].text, /may be blocked/);
    });
});

test('a transport failure reports its error code instead of a bare status', async () => {
    await withScrape({ status: undefined, scrapeErrorCode: 'ETIMEDOUT' }, async () => {
        const client = makeClient();
        await Scrape.scrapeSteamProfileName(client, VALID_ID);
        assert.match(client.logs[0].text, /ETIMEDOUT/);
        assert.match(client.logs[0].text, /no HTTP response/);
    });
});

test('the failing URL is logged without a trailing period', async () => {
    await withScrape({ status: 403 }, async () => {
        const client = makeClient();
        await Scrape.scrapeSteamProfileName(client, VALID_ID);
        assert.ok(client.logs[0].text.endsWith(`/profiles/${VALID_ID}`),
            `expected the line to end at the URL, got: ${client.logs[0].text}`);
    });
});

test('a persona name is extracted and HTML-decoded', async () => {
    const html = '<span class="actual_persona_name">Rob &amp; Sons</span>';
    await withScrape({ status: 200, data: html }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), 'Rob & Sons');
        assert.strictEqual(client.logs.length, 0);
    });
});

test('back-to-back lookups both match (no leaked regex lastIndex)', async () => {
    const html = '<span class="actual_persona_name">Pablo</span>';
    await withScrape({ status: 200, data: html }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), 'Pablo');
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), 'Pablo');
    });
});

test('a page that loads but does not parse is reported as a markup change', async () => {
    await withScrape({ status: 200, data: '<html>no persona here</html>' }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), null);
        assert.match(client.logs[0].text, /found no persona name/);
    });
});

test('the vanity lookup reports why it failed', async () => {
    await withScrape({ status: 403 }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamIdFromVanity(client, 'somebody'), null);
        assert.match(client.logs[0].text, /HTTP 403/);
        assert.match(client.logs[0].text, /\/id\/somebody/);
    });
});

test('the vanity lookup resolves a SteamID64 from the XML payload', async () => {
    await withScrape({ status: 200, data: `<steamID64>${VALID_ID}</steamID64>` }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamIdFromVanity(client, 'somebody'), VALID_ID);
        assert.strictEqual(client.logs.length, 0);
    });
});

/* Steam answers an unknown vanity with 200 and an <error> body, so this case
   never reaches the status check above -- it has to be caught after parsing or
   it stays silent. */
test('an unknown vanity is reported with Steam own wording, not silence', async () => {
    const xml = '<response><error>The specified profile could not be found.</error></response>';
    await withScrape({ status: 200, data: xml }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamIdFromVanity(client, 'nosuchhandle'), null);
        assert.strictEqual(client.logs.length, 1);
        assert.match(client.logs[0].text, /does not know that vanity handle/);
        assert.match(client.logs[0].text, /could not be found/);
        assert.match(client.logs[0].text, /\/id\/nosuchhandle/);
    });
});

test('a vanity page that parses to nothing is reported as a markup change', async () => {
    await withScrape({ status: 200, data: '<response></response>' }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamIdFromVanity(client, 'somebody'), null);
        assert.match(client.logs[0].text, /found no SteamID64/);
    });
});

/* The name cache is opt-in: a user typing a player into the add-player modal
   wants the name Steam has right now, background callers do not. */
test('the persona-name cache is only used when the caller asks for it', async () => {
    const html = '<span class="actual_persona_name">Pablo</span>';

    await withScrape({ status: 200, data: html }, async (calls) => {
        Scrape.clearNameCache();
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), 'Pablo');
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), 'Pablo');
        assert.strictEqual(calls.length, 1, 'the second cached lookup should not hit Steam');
    });

    await withScrape({ status: 200, data: html }, async (calls) => {
        Scrape.clearNameCache();
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), 'Pablo');
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID), 'Pablo');
        assert.strictEqual(calls.length, 2, 'an uncached caller should always ask Steam');
    });
});

test('a cached name failure is not retried or re-logged immediately', async () => {
    await withScrape({ status: 403 }, async (calls) => {
        Scrape.clearNameCache();
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), null);
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), null);
        assert.strictEqual(calls.length, 1, 'the second lookup should not hit Steam');
        assert.strictEqual(client.logs.length, 1, 'the failure should be logged once');
    });
});

test('a name cache TTL of zero stores nothing', async () => {
    const html = '<span class="actual_persona_name">Pablo</span>';
    const original = Config.battlemetrics.steamNameCacheMs;
    Config.battlemetrics.steamNameCacheMs = 0;
    try {
        await withScrape({ status: 200, data: html }, async (calls) => {
            Scrape.clearNameCache();
            const client = makeClient();
            await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true });
            await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true });
            assert.strictEqual(calls.length, 2);
        });
    }
    finally {
        Config.battlemetrics.steamNameCacheMs = original;
    }
});

/* "Disabled" has to mean disabled for failures too. Caching those anyway left a
   TTL of 0 still short-circuiting hours of lookups after one transient error,
   which is not the per-event scraping the setting documents. */
test('a cache TTL of zero does not store failures either', async () => {
    const original = Config.battlemetrics.steamNameCacheMs;
    Config.battlemetrics.steamNameCacheMs = 0;
    try {
        await withScrape({ status: 429, headers: {} }, async (calls) => {
            Scrape.clearNameCache();
            const client = makeClient();
            await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true });
            await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true });
            assert.strictEqual(calls.length, 2, 'a disabled cache must not suppress the second attempt');
            assert.strictEqual(Scrape.getCachedSteamProfileName(VALID_ID), undefined);
        });
    }
    finally {
        Config.battlemetrics.steamNameCacheMs = original;
    }
});

/* The resolver asks for a refresh precisely when it suspects the name it holds
   is why its searches keep missing — serving that same name back from the cache
   made the refresh a no-op until the TTL expired hours later. */
test('a refresh bypasses the name cache but still writes to it', async () => {
    let body = '<span class="actual_persona_name">OldName</span>';
    await withScrape(() => ({ status: 200, data: body }), async (calls) => {
        Scrape.clearNameCache();
        const client = makeClient();

        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), 'OldName');
        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), 'OldName');
        assert.strictEqual(calls.length, 1, 'the plain cached lookup should not hit Steam');

        body = '<span class="actual_persona_name">NewName</span>';
        assert.strictEqual(
            await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true, refresh: true }), 'NewName');
        assert.strictEqual(calls.length, 2, 'a refresh must reach Steam');

        assert.strictEqual(await Scrape.scrapeSteamProfileName(client, VALID_ID, { cache: true }), 'NewName',
            'the refreshed name should have replaced the cached one');
        assert.strictEqual(calls.length, 2);
    });
});

test('isValidSteamId accepts a 17-digit string and nothing else', () => {
    assert.strictEqual(Scrape.isValidSteamId(VALID_ID), true);
    for (const bad of ['', '123', 'notanid', Number(VALID_ID), null, undefined]) {
        assert.strictEqual(Scrape.isValidSteamId(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
});
