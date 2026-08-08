const test = require('node:test');
const assert = require('node:assert');

const Scrape = require('./scrape');
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

test('the avatar path reports failures and markup changes too', async () => {
    await withScrape({ status: 429, headers: {} }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfilePicture(client, VALID_ID), null);
        assert.match(client.logs[0].text, /profile picture/);
        assert.match(client.logs[0].text, /HTTP 429/);
    });

    await withScrape({ status: 200, data: '<html>no avatar</html>' }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfilePicture(client, VALID_ID), null);
        assert.match(client.logs[0].text, /found no avatar/);
    });

    const html = '<img src="https://avatars.example/abc_full.jpg" alt="x">';
    await withScrape({ status: 200, data: html }, async () => {
        const client = makeClient();
        assert.strictEqual(await Scrape.scrapeSteamProfilePicture(client, VALID_ID),
            'https://avatars.example/abc_full.jpg');
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
    });
});
