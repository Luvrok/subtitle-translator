# Subtitle Translator

A page for translating `.srt` subtitle files: add up to 10 files, pick the languages, and they are
translated one by one; each file can be downloaded as soon as it is done. Dark and light gruvbox themes.

Translation engines:

- **Google Translate** (default): Google's free endpoint, called straight from the visitor's browser,
  so there is nothing to set up and the site's server does no work. If the browser can't reach Google,
  the page asks it through `/api/google` on the site's server.
- **LibreTranslate on your own address**: also called from the browser, so a server on your
  `localhost` works too. LibreTranslate allows that (CORS) out of the box.
- **LibreTranslate of this site**: leave the address empty. Goes through the site's backend, which
  queues files for its CPU; needs an API key from the site's owner.

## How it works

All engines share [`lib/srt.mjs`](lib/srt.mjs), which decides what goes to the translator and puts the
translation back around the timecodes. The backend, [`server/server.mjs`](server/server.mjs) (Node, no
dependencies), runs next to the site's LibreTranslate. It:

- serves the built page and proxies LibreTranslate, so the browser never needs CORS or a public LibreTranslate;
- translates only the cue text, so numbering and timecodes stay untouched; formatting tags are
  kept out of the model and put back, dialogue lines are translated one by one;
- sends every repeated line once and caches translations, so a restarted file or the next episode is faster;
- keeps one queue for all visitors, so the CPU works on one file at a time;
- streams progress back as NDJSON: `{"queue":2}`, `{"progress":3,"total":16}`, then `{"translatedText":…}` or `{"error":…}`.

Settings are environment variables at the top of `server/server.mjs` (`LT_URL`, `BASE_PATH`, `PARALLEL_BATCHES`, …).
Every visitor enters their own LibreTranslate API key; it is stored only in their browser.

Files that are not UTF-8 or UTF-16 are decoded with the Windows code page of the chosen source
language (cp1251 for Russian, cp1252 for Western European languages and so on). With auto-detect,
cp1251 is picked when the file looks Cyrillic and cp1252 otherwise.

## Development

```bash
npm install
LT_URL=http://127.0.0.1:5000 npm run serve   # backend on :5390
npm run dev                                   # page with hot reload, /api goes to the backend
PUBLIC_URL=/subtitle-translator npm run build # production build into build/, for a sub-path
STATIC_DIR=build BASE_PATH=/subtitle-translator npm run serve
```
