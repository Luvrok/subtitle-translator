// Translation engines. Google and a user's own LibreTranslate are called from the
// browser (no load on this server, and a LibreTranslate on the user's localhost works);
// this site's LibreTranslate goes through server/server.mjs, which queues files so its
// CPU translates one at a time.
import { parseSrt, translateCues, lruCache } from '../lib/srt.mjs';

const API = import.meta.env.BASE_URL + 'api';
const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';

export const errorOf = (message, code) => Object.assign(new Error(message), { code });
const withTimeout = (signal, ms) => (AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal);

// Languages of Google's free endpoint (its codes: iw = Hebrew, jw = Javanese)
export const GOOGLE_LANGUAGES = [
  ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'], ['hy', 'Armenian'],
  ['as', 'Assamese'], ['ay', 'Aymara'], ['az', 'Azerbaijani'], ['bm', 'Bambara'], ['eu', 'Basque'],
  ['be', 'Belarusian'], ['bn', 'Bengali'], ['bho', 'Bhojpuri'], ['bs', 'Bosnian'], ['bg', 'Bulgarian'],
  ['ca', 'Catalan'], ['ceb', 'Cebuano'], ['ny', 'Chichewa'], ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'], ['co', 'Corsican'], ['hr', 'Croatian'], ['cs', 'Czech'],
  ['da', 'Danish'], ['dv', 'Dhivehi'], ['doi', 'Dogri'], ['nl', 'Dutch'], ['en', 'English'],
  ['eo', 'Esperanto'], ['et', 'Estonian'], ['ee', 'Ewe'], ['tl', 'Filipino'], ['fi', 'Finnish'],
  ['fr', 'French'], ['fy', 'Frisian'], ['gl', 'Galician'], ['ka', 'Georgian'], ['de', 'German'],
  ['el', 'Greek'], ['gn', 'Guarani'], ['gu', 'Gujarati'], ['ht', 'Haitian Creole'], ['ha', 'Hausa'],
  ['haw', 'Hawaiian'], ['iw', 'Hebrew'], ['hi', 'Hindi'], ['hmn', 'Hmong'], ['hu', 'Hungarian'],
  ['is', 'Icelandic'], ['ig', 'Igbo'], ['ilo', 'Ilocano'], ['id', 'Indonesian'], ['ga', 'Irish'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['jw', 'Javanese'], ['kn', 'Kannada'], ['kk', 'Kazakh'],
  ['km', 'Khmer'], ['rw', 'Kinyarwanda'], ['gom', 'Konkani'], ['ko', 'Korean'], ['kri', 'Krio'],
  ['ku', 'Kurdish (Kurmanji)'], ['ckb', 'Kurdish (Sorani)'], ['ky', 'Kyrgyz'], ['lo', 'Lao'],
  ['la', 'Latin'], ['lv', 'Latvian'], ['ln', 'Lingala'], ['lt', 'Lithuanian'], ['lg', 'Luganda'],
  ['lb', 'Luxembourgish'], ['mk', 'Macedonian'], ['mai', 'Maithili'], ['mg', 'Malagasy'], ['ms', 'Malay'],
  ['ml', 'Malayalam'], ['mt', 'Maltese'], ['mi', 'Maori'], ['mr', 'Marathi'], ['mni-Mtei', 'Meiteilon (Manipuri)'],
  ['lus', 'Mizo'], ['mn', 'Mongolian'], ['my', 'Myanmar (Burmese)'], ['ne', 'Nepali'], ['no', 'Norwegian'],
  ['or', 'Odia (Oriya)'], ['om', 'Oromo'], ['ps', 'Pashto'], ['fa', 'Persian'], ['pl', 'Polish'],
  ['pt', 'Portuguese'], ['pa', 'Punjabi'], ['qu', 'Quechua'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sm', 'Samoan'], ['sa', 'Sanskrit'], ['gd', 'Scots Gaelic'], ['nso', 'Sepedi'], ['sr', 'Serbian'],
  ['st', 'Sesotho'], ['sn', 'Shona'], ['sd', 'Sindhi'], ['si', 'Sinhala'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['so', 'Somali'], ['es', 'Spanish'], ['su', 'Sundanese'], ['sw', 'Swahili'],
  ['sv', 'Swedish'], ['tg', 'Tajik'], ['ta', 'Tamil'], ['tt', 'Tatar'], ['te', 'Telugu'], ['th', 'Thai'],
  ['ti', 'Tigrinya'], ['ts', 'Tsonga'], ['tr', 'Turkish'], ['tk', 'Turkmen'], ['ak', 'Twi'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['ug', 'Uyghur'], ['uz', 'Uzbek'], ['vi', 'Vietnamese'],
  ['cy', 'Welsh'], ['xh', 'Xhosa'], ['yi', 'Yiddish'], ['yo', 'Yoruba'], ['zu', 'Zulu'],
].map(([code, name]) => ({ code, name }));

// ── Google ──
// The free endpoint takes one text per request, so lines go joined by newlines, which
// it keeps. Should it merge or split lines anyway, the halves are asked separately.
let googleDirect = true; // becomes false once the browser can't reach Google itself

async function googleRequest(text, source, target, signal) {
  const query = new URLSearchParams({ client: 'gtx', sl: source, tl: target, dt: 't', q: text });
  let res;
  if (googleDirect) {
    try {
      res = await fetch(`${GOOGLE_URL}?${query}`, { signal: withTimeout(signal, 30000) });
    } catch (e) {
      if (signal.aborted) throw e;
      googleDirect = false; // CORS or blocked: this site's server asks Google instead
    }
  }
  if (!res) {
    try {
      res = await fetch(`${API}/google?${query}`, { signal: withTimeout(signal, 30000) });
    } catch (e) {
      if (signal.aborted) throw e;
      throw errorOf('Google is not reachable from here', 'unreachable');
    }
  }
  if (res.status === 429) throw errorOf('Google asks to slow down, try again in a while or use LibreTranslate', 'rate_limit');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw errorOf(data.error || `Google answered ${res.status}`);
  }
  const data = await res.json();
  return (data[0] ?? []).map((segment) => segment[0] ?? '').join('');
}

async function googleTranslate(lines, { source, target, signal }) {
  const out = await googleRequest(lines.join('\n'), source, target, signal);
  const parts = out.split('\n').map((s) => s.trim());
  if (parts.length === lines.length) return parts;
  if (lines.length === 1) return [out.replace(/\s+/g, ' ').trim()];
  const half = Math.ceil(lines.length / 2);
  return [
    ...await googleTranslate(lines.slice(0, half), { source, target, signal }),
    ...await googleTranslate(lines.slice(half), { source, target, signal }),
  ];
}

export const googleEngine = {
  key: 'google',
  // the text travels in the URL: keep it well under Google's URL limit
  batch: { maxChars: 6000, size: (s) => encodeURIComponent(s).length + 3 },
  parallel: 3,
  translate: googleTranslate,
};

// ── LibreTranslate on the user's own address ──
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
const PRIVATE_HOST = /^(10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[^.]+\.local|[^.]+)$/i;

// "lt.example.com" -> https://lt.example.com, "localhost:5000" -> http://localhost:5000
export function normalizeLtUrl(input) {
  let s = input.trim().replace(/\/+$/, '').replace(/\/(translate|languages)$/, '');
  if (!s) return { url: '' };
  if (!/^https?:\/\//i.test(s)) {
    const host = s.split(/[/:]/)[0];
    s = `${LOCAL_HOST.test(host) || PRIVATE_HOST.test(host) ? 'http' : 'https'}://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return { error: 'This does not look like a server address' }; }
  if (window.location.protocol === 'https:' && u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname)) {
    return { error: 'Browsers block http:// servers on an https page: use https:// or localhost' };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

async function ltFetch(url, path, init) {
  try {
    return await fetch(url + path, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw errorOf(`Can't reach ${url}: check the address and that the server is up`, 'unreachable');
  }
}

export async function fetchLtLanguages(url, signal) {
  const res = await ltFetch(url, '/languages', { signal: withTimeout(signal, 15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) throw errorOf(`${url} does not answer like LibreTranslate`);
  return data.map(({ code, name }) => ({ code, name }));
}

export function ltEngine(url, apiKey) {
  return {
    key: `lt ${url}`,
    // other people's servers may limit batch size, keep requests modest
    batch: { maxChars: 2000, maxLines: 50 },
    parallel: 2,
    async translate(q, { source, target, signal }) {
      const res = await ltFetch(url, '/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, source, target, format: 'text', ...(apiKey && { api_key: apiKey }) }),
        signal: withTimeout(signal, 300000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `LibreTranslate answered ${res.status}`;
        if (/api key/i.test(msg)) throw errorOf(`${url}: ${msg}`, 'bad_key');
        if (res.status === 429) throw errorOf(`${url}: ${msg}`, 'rate_limit');
        throw errorOf(`${url}: ${msg}`);
      }
      return data.translatedText;
    },
  };
}

// ── this site's LibreTranslate, through server/server.mjs ──
export async function fetchServerLanguages() {
  const res = await fetch(API + '/languages');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server answered ${res.status}`);
  return data.map(({ code, name }) => ({ code, name }));
}

// POST one file and follow the server's NDJSON event stream until the result arrives.
async function translateOnServer(body, signal, onEvent) {
  const res = await fetch(API + '/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw errorOf(data.error || `server answered ${res.status}`, data.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue; // heartbeat
      const ev = JSON.parse(line);
      if (ev.error) throw errorOf(ev.error, ev.code);
      if (typeof ev.translatedText === 'string') return ev;
      onEvent(ev);
    }
  }
  throw new Error('connection closed before the translation finished');
}

const browserCache = lruCache(20000); // lines translated in this tab, across files

// Translates one .srt text; engine is googleEngine, ltEngine(…) or 'server' (+ apiKey).
// onEvent gets {queue} (server only) and {progress, total}.
export async function translateSubtitles(text, { engine, apiKey, source, target, signal, onEvent }) {
  if (engine === 'server') return translateOnServer({ q: text, source, target, api_key: apiKey }, signal, onEvent);
  const cues = parseSrt(text);
  if (!cues.length) throw errorOf('Not an .srt file: no timecodes inside');
  const key = (t) => `${engine.key}\n${source}\n${target}\n${t}`;
  const { text: translatedText, warning } = await translateCues(cues, {
    translate: (q, sig) => engine.translate(q, { source, target, signal: sig }),
    batch: engine.batch,
    parallel: engine.parallel,
    signal,
    cache: { get: (t) => browserCache.get(key(t)), set: (t, v) => browserCache.set(key(t), v) },
    onStart: ({ batches }) => onEvent({ progress: 0, total: batches }),
    onBatch: ({ done, total }) => onEvent({ progress: done, total }),
  });
  return { translatedText, ...(warning && { warning }) };
}
