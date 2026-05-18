/*
    Detect the language of an incoming team-chat message and, if it isn't
    English or German, translate it to English. Used to feed the dedicated
    "teamchatTranslated" Discord channel.

    Detection uses franc-min (offline trigram model, no network calls).

    Translation: if RPP_LIBRETRANSLATE_URL is set, the bot POSTs to a
    self-hosted LibreTranslate sidecar (recommended — fully local, no
    rate-limits). Otherwise it falls back to the `translate` package's free
    Google web endpoint, which is unreliable and frequently returns the
    source string unchanged.

    Spam filters: messages from companion bots (e.g. "Boton") tend to be
    short English status lines like "team member X is no longer AFK". They
    pollute the translated channel because franc occasionally misdetects
    them as non-English, OR they happen to be Spanish-tinted and pass
    detection. Two layers handle this:
      1) A hard-coded list of common bot-status patterns is skipped outright.
      2) A rolling frequency window: any phrase seen ≥ REPEAT_THRESHOLD times
         within REPEAT_WINDOW_MS is treated as a bot template.

    Results are cached briefly so two players echoing the same phrase don't
    cost two API calls.
*/

const Axios = require('axios');
const Franc = require('franc-min');
const Translate = require('translate');

const Config = require('../../config');

/* ISO-639-3 codes for the languages we want to leave alone. */
const PASSTHROUGH_LANGS = new Set(['eng', 'deu']);
const MIN_LENGTH = 12;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

/* Frequency-based bot detection. A normalized phrase seen this many times
   inside the window is considered a bot template and suppressed. */
const REPEAT_WINDOW_MS = 60 * 60 * 1000; /* 1 hour */
const REPEAT_THRESHOLD = 3;
const REPEAT_CACHE_MAX = 500;

/* Hard-coded bot-status patterns. These match the message body case-insensitively
   after stripping the wildcard player name. Keep tight — false positives here
   silently drop real team chat. */
const BOT_STATUS_PATTERNS = [
    /\bis (no longer|now) afk\b/i,
    /\b(joined|left) the (team|group)\b/i,
    /\bteam member .+ (is|has) /i,
    /\b(just )?connected to the server\b/i,
    /\b(just )?disconnected (from the server)?\b/i,
    /\bwent (online|offline)\b/i,
    /\bcame (online|offline)\b/i,
    /\bis (online|offline) now\b/i,
    /\bestá afk\b/i,
    /\bya no está afk\b/i,
];

/* Franc returns ISO-639-3; LibreTranslate expects ISO-639-1. Only the
   common-on-Rust languages we expect to actually see; anything not in this
   map falls through to LT's `source: "auto"` which does its own detection. */
const FRANC_TO_LT = {
    spa: 'es', por: 'pt', fra: 'fr', ita: 'it', rus: 'ru', ukr: 'uk',
    nld: 'nl', pol: 'pl', ces: 'cs', slk: 'sk', swe: 'sv', dan: 'da',
    nor: 'no', fin: 'fi', tur: 'tr', ron: 'ro', hun: 'hu', ell: 'el',
    bul: 'bg', srp: 'sr', hrv: 'hr', slv: 'sl', cmn: 'zh', jpn: 'ja',
    kor: 'ko', ara: 'ar', heb: 'he', tha: 'th', vie: 'vi', ind: 'id',
};

const _cache = new Map(); /* normalized text -> { at, result } */
const _phraseCounts = new Map(); /* fingerprint -> { hits: [ts, ts...] } */

function _cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > CACHE_TTL_MS) {
        _cache.delete(key);
        return null;
    }
    return e.result;
}

function _cacheSet(key, result) {
    if (_cache.size >= CACHE_MAX) {
        const oldestKey = _cache.keys().next().value;
        _cache.delete(oldestKey);
    }
    _cache.set(key, { at: Date.now(), result });
}

/* Strip URLs and noisy tokens so detection isn't thrown off by links or
   Rust+ commands like `!tr es Hola`. */
function _normalize(text) {
    return text
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<@!?\d+>/g, ' ')
        .replace(/[!@#$%^&*_=+`~]/g, ' ')
        .trim();
}

/* Collapse to a phrase fingerprint: lowercase, remove digits, collapse all
   runs of word-chars that look like names (start with a capital letter in
   original text but here we use a simpler shape: every token of length ≥ 3
   gets stripped to its length bucket). The result is stable across messages
   that differ only in the player-name slot. */
function _fingerprint(text) {
    return text
        .toLowerCase()
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
}

function _matchesBotPattern(text) {
    for (const pat of BOT_STATUS_PATTERNS) {
        if (pat.test(text)) return true;
    }
    return false;
}

/* Returns true if this phrase has been seen often enough recently to be
   considered a bot template. Also records the current sighting. */
function _isRepeatedTemplate(text) {
    const fp = _fingerprint(text);
    const now = Date.now();
    let entry = _phraseCounts.get(fp);
    if (!entry) {
        if (_phraseCounts.size >= REPEAT_CACHE_MAX) {
            const oldestKey = _phraseCounts.keys().next().value;
            _phraseCounts.delete(oldestKey);
        }
        entry = { hits: [] };
        _phraseCounts.set(fp, entry);
    }
    /* Drop stale timestamps before counting. */
    entry.hits = entry.hits.filter(t => (now - t) <= REPEAT_WINDOW_MS);
    entry.hits.push(now);
    return entry.hits.length >= REPEAT_THRESHOLD;
}

async function _libreTranslate(text, detected) {
    const baseUrl = (Config.translate.libretranslateUrl || '').replace(/\/+$/, '');
    const url = `${baseUrl}/translate`;
    const source = FRANC_TO_LT[detected] || 'auto';
    const body = {
        q: text,
        source,
        target: 'en',
        format: 'text',
    };
    if (Config.translate.libretranslateApiKey) body.api_key = Config.translate.libretranslateApiKey;

    const response = await Axios.post(url, body, { timeout: 8000 });
    if (response && response.data && typeof response.data.translatedText === 'string') {
        return response.data.translatedText;
    }
    return null;
}

/**
 * @param {string} text The raw team-chat message body.
 * @returns {Promise<{shouldPost:boolean, translatedText?:string, detected?:string}>}
 */
async function detectAndTranslate(text) {
    if (!text || typeof text !== 'string') return { shouldPost: false };
    const clean = _normalize(text);
    if (clean.length < MIN_LENGTH) return { shouldPost: false };

    const cached = _cacheGet(clean);
    if (cached) return cached;

    /* Hard-pattern filter first — independent of franc, so bot lines we
       recognize get dropped even when detection mis-classifies them. */
    if (_matchesBotPattern(clean)) {
        const result = { shouldPost: false, reason: 'botPattern' };
        _cacheSet(clean, result);
        return result;
    }

    /* Frequency-based bot detection: any sentence repeated ≥3× per hour is
       almost certainly a bot template (player-status announcements, etc.). */
    if (_isRepeatedTemplate(clean)) {
        const result = { shouldPost: false, reason: 'repeated' };
        _cacheSet(clean, result);
        return result;
    }

    const detected = Franc(clean);
    if (detected === 'und') {
        const result = { shouldPost: false, detected };
        _cacheSet(clean, result);
        return result;
    }
    if (PASSTHROUGH_LANGS.has(detected)) {
        const result = { shouldPost: false, detected };
        _cacheSet(clean, result);
        return result;
    }

    let translatedText = null;
    const provider = Config.translate.libretranslateUrl ? 'libre' : 'google';
    try {
        translatedText = provider === 'libre'
            ? await _libreTranslate(text, detected)
            : await Translate(text, 'en');
    }
    catch (e) {
        const result = { shouldPost: false, detected, error: e.message, provider };
        _cacheSet(clean, result);
        return result;
    }

    /* If the translator returned the source string unchanged it did not
       actually translate (rate-limit, no-op, or trivial passthrough). The
       reader gains nothing from seeing the same line echoed back in the
       translated channel, so skip it. */
    const unchanged = !translatedText
        || translatedText.trim().toLowerCase() === text.trim().toLowerCase();

    if (unchanged) {
        const result = { shouldPost: false, detected, reason: 'unchanged', provider };
        _cacheSet(clean, result);
        return result;
    }

    const result = {
        shouldPost: true,
        translatedText,
        detected,
        provider,
    };
    _cacheSet(clean, result);
    return result;
}

module.exports = { detectAndTranslate };
