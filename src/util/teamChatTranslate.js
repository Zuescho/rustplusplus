/*
    Detect the language of an incoming team-chat message and, if it isn't
    English or German, translate it to English. Used to feed the dedicated
    "teamchatTranslated" Discord channel.

    Detection uses franc-min (offline trigram model, no network calls).
    Translation reuses the same `translate` package the bot already uses for
    the in-game `!tr` command — auto-detect on Google's side handles whatever
    source language the player actually wrote in (Spanish, Portuguese, etc.),
    so the franc verdict only needs to be confident enough to say "this is NOT
    English or German".

    Results are cached briefly so two players echoing the same phrase don't
    cost two API calls.
*/

const Franc = require('franc-min');
const Translate = require('translate');

/* ISO-639-3 codes for the languages we want to leave alone. */
const PASSTHROUGH_LANGS = new Set(['eng', 'deu']);
const MIN_LENGTH = 12;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

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
    try {
        translatedText = await Translate(text, 'en');
    }
    catch (e) {
        const result = { shouldPost: false, detected, error: e.message };
        _cacheSet(clean, result);
        return result;
    }

    /* If the translation came back essentially unchanged, the source was
       probably already close enough to English — skip to avoid noise. */
    if (translatedText && translatedText.trim().toLowerCase() === text.trim().toLowerCase()) {
        const result = { shouldPost: false, detected };
        _cacheSet(clean, result);
        return result;
    }

    const result = { shouldPost: true, translatedText, detected };
    _cacheSet(clean, result);
    return result;
}

module.exports = { detectAndTranslate };
