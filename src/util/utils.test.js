const test = require('node:test');
const assert = require('node:assert');
const Utils = require('./utils');

test('decodeHtml should decode HTML entities correctly', () => {
    // 1. Strings without HTML entities.
    assert.strictEqual(Utils.decodeHtml('hello world'), 'hello world');

    // 2. Strings with single HTML entities.
    assert.strictEqual(Utils.decodeHtml('&lt;'), '<');
    assert.strictEqual(Utils.decodeHtml('&gt;'), '>');
    assert.strictEqual(Utils.decodeHtml('&amp;'), '&');

    // 3. Strings with multiple different HTML entities.
    assert.strictEqual(Utils.decodeHtml('&lt;div&gt;hello&amp;world&lt;/div&gt;'), '<div>hello&world</div>');

    // 4. Strings with multiple identical HTML entities.
    assert.strictEqual(Utils.decodeHtml('&lt; &lt;'), '< <');
    assert.strictEqual(Utils.decodeHtml('&amp;&amp;&amp;'), '&&&');

    // 5. Empty strings.
    assert.strictEqual(Utils.decodeHtml(''), '');

    // 6. Real world scenario
    assert.strictEqual(Utils.decodeHtml('Welcome to the &quot;Rust&quot; &amp; &apos;Survive&apos; server!'), 'Welcome to the "Rust" & \'Survive\' server!');
});

test('formatPlaytimeHours renders a compact figure and refuses non-numbers', () => {
    /* Below 1000 the exact hour matters — 40 h and 400 h are different players. */
    assert.strictEqual(Utils.formatPlaytimeHours(0), '0 h');
    assert.strictEqual(Utils.formatPlaytimeHours(41.4), '41 h');
    assert.strictEqual(Utils.formatPlaytimeHours(41.6), '42 h');
    assert.strictEqual(Utils.formatPlaytimeHours(999.4), '999 h');

    /* At and above 1000 the column is too narrow for the exact number. */
    assert.strictEqual(Utils.formatPlaytimeHours(1000), '1.0k h');
    assert.strictEqual(Utils.formatPlaytimeHours(1449), '1.4k h');
    assert.strictEqual(Utils.formatPlaytimeHours(12400), '12.4k h');

    /* "Not known" has to be distinguishable from "zero" by the caller, so
       anything unusable comes back as null rather than a rendered string. */
    assert.strictEqual(Utils.formatPlaytimeHours(null), null);
    assert.strictEqual(Utils.formatPlaytimeHours(undefined), null);
    assert.strictEqual(Utils.formatPlaytimeHours('1200'), null);
    assert.strictEqual(Utils.formatPlaytimeHours(NaN), null);
    assert.strictEqual(Utils.formatPlaytimeHours(Infinity), null);
    assert.strictEqual(Utils.formatPlaytimeHours(-5), null);
});
