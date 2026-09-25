// subtitle-translator backend: serves the page and translates .srt files with this
// site's LibreTranslate, cue by cue so timecodes stay intact. Every request carries the
// user's own LibreTranslate API key; jobs go through one global queue so the CPU
// only ever works on MAX_ACTIVE files at a time. Google and other LibreTranslate
// servers are called by the page itself; /api/google only helps browsers that can't.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSrt, translateCues, lruCache } from '../lib/srt.mjs';

const env = (name, def) => Number(process.env[name] ?? def);

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = env('PORT', 5390);
const BASE = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? './build');
const LT_URL = (process.env.LT_URL ?? 'http://127.0.0.1:5389').replace(/\/+$/, '');
const BATCH_CHARS = env('BATCH_CHARS', 4000); // text per LibreTranslate call: bigger batches translate faster, smaller report progress more often
const PARALLEL_BATCHES = env('PARALLEL_BATCHES', 1); // LibreTranslate calls in flight per file, match ARGOS_INTER_THREADS
const MAX_ACTIVE = env('MAX_ACTIVE', 1); // files translated at the same time
const MAX_QUEUE = env('MAX_QUEUE', 20); // files allowed to wait for a slot
const MAX_CHARS = env('MAX_CHARS', 400000); // per .srt file, a 3h film is ~150k
const BATCH_TIMEOUT_MS = env('BATCH_TIMEOUT_S', 300) * 1000; // one LibreTranslate call
const JOB_TIMEOUT_MS = env('JOB_TIMEOUT_S', 1800) * 1000; // one file, queue wait excluded
const CACHE_LINES = env('CACHE_LINES', 50000); // translated lines kept in memory (~20 MB), 0 turns the cache off
const LINE_WIDTH = env('LINE_WIDTH', 42); // two-line cues are re-wrapped when the translation is longer than this
const MAX_BODY = 5 * 1024 * 1024;
const HEARTBEAT_MS = 15 * 1000; // below xray connIdle (300s) and nginx stream proxy_timeout (10m)
const RETRY_DELAYS_MS = [2000, 10000]; // LibreTranslate restarting or momentarily unreachable
const LANGUAGES_TTL_MS = 10 * 60 * 1000;
const GOOGLE_URL = process.env.GOOGLE_URL ?? 'https://translate.googleapis.com/translate_a/single';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.map': 'application/json',
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(fail(413, `file too large (over ${MAX_BODY / 1024 / 1024} MB)`)); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
  req.on('close', () => { if (!req.complete) reject(fail(400, 'upload interrupted')); });
});

const parseForm = async (req) => {
  const raw = await readBody(req);
  if (!(req.headers['content-type'] ?? '').includes('application/json')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw || '{}'); } catch { throw fail(400, 'request body is not valid JSON'); }
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

// Errors LibreTranslate itself answered carry its HTTP status as `upstream`
// (0 = not reachable), so callers can tell a bad request from a server that is down.
async function lt(pathname, init = {}) {
  let r;
  try {
    r = await fetch(LT_URL + pathname, init);
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    throw Object.assign(fail(502, `LibreTranslate unreachable: ${e.cause?.code ?? e.message}`), { upstream: 0 });
  }
  const body = await r.text();
  if (!r.ok) {
    let msg = body;
    try { msg = JSON.parse(body).error ?? body; } catch {}
    if (r.status === 403 && /api key/i.test(msg)) throw fail(401, 'LibreTranslate rejected the API key', 'bad_key');
    if (r.status === 429) throw fail(429, `LibreTranslate rate limit for this key: ${msg}`, 'rate_limit');
    throw Object.assign(fail(502, `LibreTranslate ${r.status}: ${msg}`), { upstream: r.status });
  }
  return JSON.parse(body);
}

const timeoutAs504 = (e) => {
  throw e.name === 'TimeoutError' ? fail(504, 'LibreTranslate did not answer in time') : e;
};

// Cheap key check before a file waits in the queue: LibreTranslate validates the
// key before the request body, so an empty q answers 403 (bad key) or 400 (key ok).
async function checkKey(apiKey) {
  try {
    await lt('/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '', source: 'en', target: 'en', api_key: apiKey }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    if (e.upstream !== 400) timeoutAs504(e);
  }
}

// The list only changes when LibreTranslate is reconfigured; caching it keeps the
// page loading fast while LibreTranslate's request threads are busy translating.
let languages = null;
async function getLanguages() {
  if (languages && Date.now() - languages.at < LANGUAGES_TTL_MS) return languages.list;
  try {
    languages = { at: Date.now(), list: await lt('/languages', { signal: AbortSignal.timeout(10000) }) };
  } catch (e) {
    if (!languages) timeoutAs504(e);
    console.log(`languages: ${e.message}, serving the cached list`);
    languages.at = Date.now() - LANGUAGES_TTL_MS + 60 * 1000; // ask LibreTranslate again in a minute, not on every page load
  }
  return languages.list;
}

// ── global queue ──
let active = 0;
const waiting = []; // { start, onPosition }
const renumber = () => waiting.forEach((w, i) => w.onPosition(i + 1));

function acquire(signal, onPosition) {
  signal.throwIfAborted();
  if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
  if (waiting.length >= MAX_QUEUE) return Promise.reject(fail(503, 'server is busy, try again later', 'busy'));
  return new Promise((resolve, reject) => {
    const w = { start: () => { active++; resolve(); }, onPosition };
    waiting.push(w);
    onPosition(waiting.length);
    signal.addEventListener('abort', () => {
      const i = waiting.indexOf(w);
      if (i === -1) return;
      waiting.splice(i, 1);
      renumber();
      reject(signal.reason);
    }, { once: true });
  });
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) { next.start(); renumber(); }
}

// Least recently used lines across all jobs: a file restarted after an error or a
// timeout, or the next episode of a series, skips what LibreTranslate already did.
const cache = lruCache(CACHE_LINES);

async function translateBatch(q, { source, target, apiKey, signal, log }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { translatedText: tr } = await lt('/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, source, target, format: 'text', api_key: apiKey }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(BATCH_TIMEOUT_MS)]),
      });
      return tr;
    } catch (e) {
      const down = e.upstream === 0 || e.upstream >= 502;
      if (!down || attempt >= RETRY_DELAYS_MS.length) throw e;
      log(`${e.message}, retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
      await sleep(RETRY_DELAYS_MS[attempt], undefined, { signal });
    }
  }
}

async function translateSrt(cues, { source, target, apiKey, signal, log, emit }) {
  const key = (text) => `${source}\n${target}\n${text}`;
  const { text, warning } = await translateCues(cues, {
    translate: (q, sig) => translateBatch(q, { source, target, apiKey, signal: sig, log }),
    batch: { maxChars: BATCH_CHARS },
    parallel: PARALLEL_BATCHES,
    signal,
    lineWidth: LINE_WIDTH,
    cache: { get: (t) => cache.get(key(t)), set: (t, v) => cache.set(key(t), v) },
    onStart: (st) => {
      log(`${st.cues} cues, ${st.lines} lines: ${st.todo} to translate, ${st.cached} cached, ${st.repeats} repeats; `
        + `${st.chars} chars in ${st.batches} batches`);
      emit({ progress: 0, total: st.batches });
    },
    onBatch: ({ n, total, done, ms }) => {
      log(`batch ${n}/${total} done in ${(ms / 1000).toFixed(1)}s`);
      emit({ progress: done, total });
    },
  });
  if (warning) log(`WARNING: ${warning} (or LibreTranslate itself fails, see its log)`);
  return { translatedText: text, ...(warning && { warning }) };
}

// GET /api/google?sl=en&tl=ru&q=… answers what Google's free endpoint does. The page
// calls Google itself; it only falls back to this when the browser can't (CORS, blocked).
async function handleGoogle(url, res) {
  const { sl, tl, q } = Object.fromEntries(url.searchParams);
  if (!/^[a-zA-Z-]{2,12}$/.test(sl ?? '') || !/^[a-zA-Z-]{2,12}$/.test(tl ?? '') || !q || q.length > 5000) {
    throw fail(400, 'sl, tl and q (up to 5000 chars) required');
  }
  let r;
  try {
    r = await fetch(`${GOOGLE_URL}?${new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q })}`, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw fail(502, `Google unreachable: ${e.cause?.code ?? e.message}`);
  }
  const body = await r.text();
  if (r.status === 429) throw fail(429, 'Google rate limit for this server, try again later', 'rate_limit');
  if (!r.ok) throw fail(502, `Google ${r.status}`);
  send(res, 200, body);
}

async function serveStatic(res, rel) {
  let file;
  try { file = path.resolve(STATIC_DIR, '.' + decodeURIComponent(rel)); } catch { return send(res, 400, { error: 'bad path' }); }
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch { file = path.join(STATIC_DIR, 'index.html'); }
  try {
    const data = await fs.readFile(file);
    const cacheControl = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cacheControl });
  } catch { send(res, 404, { error: 'not found' }); }
}

// POST /api/translate {q, source, target, api_key}
// Validation errors come back as plain JSON with an HTTP error status. Once the
// file is accepted the answer is 200 NDJSON, one event per line:
//   {"queue":2}  {"progress":3,"total":16}  then {"translatedText":…} or {"error":…}
// Blank lines are heartbeats that keep idle timeouts on xray/nginx from firing.
// (GET /api/languages and GET /api/google are plain JSON.)
let jobs = 0;

async function handleTranslate(req, res) {
  const client = new AbortController();
  res.on('close', () => client.abort()); // client left: stop feeding LibreTranslate

  const { q, source, target, api_key: key } = await parseForm(req);
  const apiKey = typeof key === 'string' ? key.trim() : '';
  if (!apiKey) throw fail(401, 'LibreTranslate API key required', 'bad_key');
  if (!source || !target || typeof source !== 'string' || typeof target !== 'string') throw fail(400, 'source and target required');
  if (typeof q !== 'string') throw fail(400, 'q must be the text of an .srt file');
  if (q.length > MAX_CHARS) throw fail(413, `file too large: ${q.length} chars, limit ${MAX_CHARS}`);
  const cues = parseSrt(q);
  if (!cues.length) {
    const preview = JSON.stringify(q.slice(0, 40));
    console.log(`rejected ${q.length} chars without timecodes: ${preview}`);
    throw fail(400, `not an .srt file: no timecodes found (${q.length} chars: ${preview})`);
  }
  await checkKey(apiKey);
  if (client.signal.aborted) return;

  const id = ++jobs;
  const log = (msg) => console.log(`[job ${id}] ${msg}`);
  const t0 = Date.now();
  log(`${source} -> ${target}, ${q.length} chars`);

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (ev) => res.write(JSON.stringify(ev) + '\n');
  const beat = setInterval(() => res.write('\n'), HEARTBEAT_MS);

  let slot = false;
  try {
    await acquire(client.signal, (n) => { emit({ queue: n }); log(`queued, position ${n}`); });
    slot = true;
    if (Date.now() - t0 > 1000) log(`started after ${secs(t0)}s in queue`);

    const deadline = AbortSignal.timeout(JOB_TIMEOUT_MS);
    const signal = AbortSignal.any([client.signal, deadline]);
    try {
      emit(await translateSrt(cues, { source, target, apiKey, signal, log, emit }));
    } catch (e) {
      if (deadline.aborted) throw fail(504, `translation took longer than ${JOB_TIMEOUT_MS / 60000} min, stopped`);
      if (e.name === 'TimeoutError') throw fail(504, `LibreTranslate did not answer within ${BATCH_TIMEOUT_MS / 1000}s`);
      throw e;
    }
    log(`done in ${secs(t0)}s`);
  } catch (e) {
    if (client.signal.aborted) log(`client disconnected after ${secs(t0)}s, stopped`);
    else if (e.status) log(`failed after ${secs(t0)}s: ${e.message}`);
    else console.error(`[job ${id}] failed after ${secs(t0)}s:`, e);
    if (!client.signal.aborted) emit({ error: e.message, ...(e.code && { code: e.code }) });
  } finally {
    clearInterval(beat);
    if (slot) release();
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    let { pathname } = new URL(req.url, 'http://x');
    if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';

    if (pathname === '/api/languages' && req.method === 'GET') return send(res, 200, await getLanguages());
    if (pathname === '/api/translate' && req.method === 'POST') return await handleTranslate(req, res);
    if (pathname === '/api/google' && req.method === 'GET') return await handleGoogle(new URL(req.url, 'http://x'), res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, pathname);
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (!e.status) console.error(`${req.method} ${req.url}:`, e);
    else console.log(`${req.method} ${req.url}: ${e.status} ${e.message}`); // bad keys, bad files
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.message, ...(e.code && { code: e.code }) });
  }
});

server.requestTimeout = 0; // long subtitle files take minutes on CPU
server.listen(PORT, HOST, () => console.log(
  `listening on ${HOST}:${PORT}${BASE}, LibreTranslate at ${LT_URL}, ${MAX_ACTIVE} active / ${MAX_QUEUE} queued max, `
  + `${PARALLEL_BATCHES} parallel batches, cache ${CACHE_LINES} lines`,
));
