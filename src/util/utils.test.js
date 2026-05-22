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
