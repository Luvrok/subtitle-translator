// .srt handling shared by the page (Google, a user's own LibreTranslate) and
// server/server.mjs (this site's LibreTranslate): what goes to the translator,
// in which batches, and how the translation is put back around the timecodes.

const TIMECODE = /^\s*[\d:.,]+\s*-->\s*[\d:.,]+/;
const TAG = /<\/?[a-z][^>]*>|\{\\[^}]*\}/gi; // <i>, </font>, {\an8}
const LEADING_TAGS = /^(?:\s*(?:<[a-z][^>]*>|\{\\[^}]*\}))+/i;
const TRAILING_TAGS = /(?:<\/[a-z][^>]*>\s*)+$/i;
const DASH = /^[-‐–—]\s*/;

const leadingTags = (s) => s.match(LEADING_TAGS)?.[0] ?? '';

// Formatting tags confuse the model, so only plain text goes to the translator.
// Positions like {\an8} and HTML tags wrapping the whole line (<i>…</i>) are put
// back around the translation, tags inside the line are dropped.
function unit(line, wrap) {
  let s = line.trim();
  const lead = leadingTags(s); s = s.slice(lead.length).trimStart();
  const dash = s.match(DASH)?.[0] ?? ''; s = s.slice(dash.length);
  const open = leadingTags(s); s = s.slice(open.length);
  const close = s.match(TRAILING_TAGS)?.[0] ?? ''; s = s.slice(0, s.length - close.length);
  const text = s.replace(TAG, '').replace(/\s+/g, ' ').trim();
  const html = /</.test(lead + open) && close;
  const keep = (tags) => (html ? tags : tags.replace(/<[^>]*>/g, '')).trim();
  return { pre: keep(lead) + dash + keep(open), text, post: html ? close.trim() : '', wrap, skip: !/\p{L}/u.test(text) };
}

// A cue is one sentence broken over lines, unless a later line starts with a dash:
// then it is a dialogue and every line (speaker) is translated on its own.
function cueUnits(lines) {
  if (lines.length > 1 && lines.slice(1).some((l) => DASH.test(l.replace(TAG, '').trim()))) return lines.map((l) => unit(l, false));
  return lines.length ? [unit(lines.join(' '), lines.length > 1)] : [];
}

// Line-based, so files with a missing blank line between cues still parse:
// a cue starts at its timecode, the cue number is the line right above it.
// Returns [] when there is no timecode at all.
export function parseSrt(srt) {
  const cues = [];
  let above = []; // lines since the previous timecode
  const close = () => {
    const text = above.map((l) => l.trim()).filter(Boolean);
    if (cues.length) cues.at(-1).units = cueUnits(text);
    else if (text.length) cues.push({ head: text, units: [] }); // text before the first cue, kept as is
  };
  let found = false;
  for (const line of srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!TIMECODE.test(line)) { above.push(line); continue; }
    while (above.length && !above.at(-1).trim()) above.pop();
    const num = /^\s*\d+\s*$/.test(above.at(-1) ?? '') ? [above.pop().trim()] : [];
    close();
    cues.push({ head: [...num, line.trim()], units: [] });
    above = [];
    found = true;
  }
  close();
  return found ? cues : [];
}

// Splits a long line into two of similar length at the space closest to the middle.
function rewrap(s, width) {
  if (s.length <= width) return s;
  let best = -1;
  for (let i = s.indexOf(' '); i !== -1; i = s.indexOf(' ', i + 1)) {
    if (best === -1 || Math.abs(i - s.length / 2) < Math.abs(best - s.length / 2)) best = i;
  }
  return best === -1 ? s : `${s.slice(0, best)}\n${s.slice(best + 1)}`;
}

function buildSrt(cues, translated, lineWidth) {
  const line = (u) => {
    const text = u.skip ? u.text : translated.get(u.text);
    return u.pre + (u.wrap ? rewrap(text, lineWidth) : text) + u.post;
  };
  return cues.map((c) => [...c.head, ...c.units.map(line)].join('\n')).join('\n\n') + '\n';
}

// Consecutive texts grouped while they fit under maxChars (as measured by size) and maxLines.
function makeBatches(texts, { maxChars, maxLines = Infinity, size = (s) => s.length }) {
  const batches = [];
  let cur = null;
  let len = 0;
  for (const text of texts) {
    const n = size(text);
    if (!cur || (cur.length && (len + n > maxChars || cur.length >= maxLines))) { batches.push(cur = []); len = 0; }
    cur.push(text);
    len += n;
  }
  return batches;
}

function anySignal(signals) {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

// Translates the text of parsed cues and returns the finished .srt.
// Only unique lines that are not cached yet go to translate(q, signal), a batch at a
// time, `parallel` batches at once; the first failure stops the rest.
export async function translateCues(cues, {
  translate, batch, parallel = 1, signal, cache, lineWidth = 42, onStart, onBatch,
}) {
  const units = cues.flatMap((c) => c.units).filter((u) => !u.skip);
  const translated = new Map();
  const todo = new Set();
  for (const { text } of units) {
    if (translated.has(text) || todo.has(text)) continue;
    const hit = cache?.get(text);
    if (hit === undefined) todo.add(text);
    else translated.set(text, hit);
  }
  const batches = makeBatches(todo, batch);
  onStart?.({
    cues: cues.length,
    lines: units.length,
    todo: todo.size,
    cached: translated.size,
    repeats: units.length - todo.size - translated.size,
    chars: [...todo].reduce((n, t) => n + t.length, 0),
    batches: batches.length,
  });

  let unchanged = 0;
  let next = 0;
  let finished = 0;
  const failed = new AbortController(); // one batch failed: stop the others
  const sig = anySignal(signal ? [signal, failed.signal] : [failed.signal]);
  const worker = async () => {
    while (next < batches.length) {
      const n = next++;
      const q = batches[n];
      sig.throwIfAborted();
      const t0 = Date.now();
      const tr = await translate(q, sig);
      if (!Array.isArray(tr) || tr.length !== q.length) {
        throw Object.assign(new Error('the translator answered with a different number of lines'), { status: 502 });
      }
      q.forEach((text, k) => {
        const value = String(tr[k]).trim();
        if (value === text) unchanged++;
        translated.set(text, value);
        cache?.set(text, value);
      });
      onBatch?.({ n: n + 1, total: batches.length, done: ++finished, ms: Date.now() - t0 });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  } catch (e) {
    failed.abort();
    throw e;
  }

  const warning = todo.size && unchanged / todo.size > 0.5
    ? `${unchanged} of ${todo.size} lines came back unchanged, check the source language`
    : undefined;
  return { text: buildSrt(cues, translated, lineWidth), warning };
}

// A small least-recently-used map: get() refreshes an entry, set() drops the oldest over `max`.
export function lruCache(max) {
  const map = new Map();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key, value) {
      if (!max) return;
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value);
    },
  };
}
