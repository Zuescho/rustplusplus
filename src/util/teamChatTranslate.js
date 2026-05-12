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

const _cache = new Map(); /* text -> { at, result } */

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
        /* Drop the oldest entry. Map preserves insertion order. */
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

    /* The free Google web endpoint occasionally returns the source string
       unchanged (rate-limit, malformed HTML, etc). Franc already decided
       this isn't English/German, so post the message anyway — but mark it
       as unchanged so the reader knows the translator didn't do anything. */
    const unchanged = translatedText
        && translatedText.trim().toLowerCase() === text.trim().toLowerCase();

    const result = {
        shouldPost: true,
        translatedText: translatedText || text,
        detected,
        unchanged,
        provider,
    };
    _cacheSet(clean, result);
    return result;
}

module.exports = { detectAndTranslate };
