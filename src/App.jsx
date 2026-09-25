import { useEffect, useRef, useState } from 'react';
import './App.css';
import LangPicker from './components/LangPicker';
import {
  CheckIcon, CloseIcon, DownloadIcon, LogoIcon, MoonIcon, StatusIcon, StopIcon, SunIcon, UploadIcon,
} from './components/Icons';
import { decodeLegacy, decodeUnicode } from './encoding';
import {
  GOOGLE_LANGUAGES, fetchLtLanguages, fetchServerLanguages, googleEngine, ltEngine, normalizeLtUrl, translateSubtitles,
} from './engines';

const MAX_FILES = 10;
const KEY_STORAGE = 'libretranslate-api-key';
const ENGINE_STORAGE = 'subtitle-translator-engine';
const LT_URL_STORAGE = 'subtitle-translator-lt-url';
const THEME_STORAGE = 'subtitle-translator-theme';
const langStorage = (engine, side) => `subtitle-translator-${side}-${engine}`;
const LEAVE_MS = 450; // matches the row collapse in App.css
const FATAL = ['bad_key', 'rate_limit', 'busy', 'unreachable']; // the next files would fail the same way

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const since = (t, now) => fmtTime(Math.max(0, Math.round((now - t) / 1000)));

const load = (key) => {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: keep it in memory only */ }
};

const outName = (name, target) => `${name.replace(/\.srt$/i, '') || 'subtitles'}.${target}.srt`;

const saveFile = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

let nextId = 1;

function describe(f, busy, now) {
  switch (f.status) {
    case 'pending': return busy ? 'Waiting for the previous file' : 'Ready';
    case 'queued': return `Server is busy, in queue #${f.queue} · ${since(f.started, now)}`;
    case 'working': return `Translating ${f.total ? `${f.progress}/${f.total}` : '…'} · ${since(f.started, now)}`;
    case 'done': return `Done in ${fmtTime(Math.round(f.took / 1000))}${f.note ? ` · ${f.note}` : ''}`;
    default: return f.note;
  }
}

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    root.classList.add('theme-switching'); // colors fade instead of jumping, only while switching
    root.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#171717' : '#fbf1c7');
    save(THEME_STORAGE, next);
    setTheme(next);
    setTimeout(() => root.classList.remove('theme-switching'), 400);
  };
  return [theme, toggle];
}

// Button that flashes (and shows doneIcon for a moment) on every click, so the click is visible
function FlashButton({ className, onClick, children, doneIcon, ...props }) {
  const ref = useRef(null);
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = (e) => {
    onClick(e);
    const el = ref.current;
    el.classList.remove('is-flashing');
    void el.offsetWidth; // restart the animation on repeated clicks
    el.classList.add('is-flashing');
    if (doneIcon) {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1400);
    }
  };
  return (
    <button type="button" {...props} ref={ref} className={className} onClick={click} onAnimationEnd={(e) => e.target === ref.current && ref.current.classList.remove('is-flashing')}>
      {done ? doneIcon : children}
    </button>
  );
}

function Field({ label, prompt, hint, ...input }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-box">
        <span className="field-prompt" aria-hidden="true">{prompt}</span>
        <input className="field-input" spellCheck="false" autoComplete="off" {...input} />
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function App() {
  const [theme, toggleTheme] = useTheme();
  const [engine, setEngine] = useState(() => (load(ENGINE_STORAGE) === 'libretranslate' ? 'libretranslate' : 'google'));
  const [ltUrl, setLtUrl] = useState(() => load(LT_URL_STORAGE));
  const [apiKey, setApiKey] = useState(() => load(KEY_STORAGE));
  const [languages, setLanguages] = useState([]);
  const [lang1, setLang1] = useState(() => load(langStorage(engine, 'source')));
  const [lang2, setLang2] = useState(() => load(langStorage(engine, 'target')));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [langsFailed, setLangsFailed] = useState(false);
  const run = useRef(null); // AbortController of the running batch

  const lt = normalizeLtUrl(ltUrl);
  const useServer = engine === 'libretranslate' && !lt.url && !lt.error;

  // Languages of the chosen engine; a LibreTranslate address is asked once typing pauses
  useEffect(() => {
    if (engine === 'google') {
      setLanguages(GOOGLE_LANGUAGES);
      return undefined;
    }
    setLanguages([]);
    setLangsFailed(false);
    if (lt.error) return undefined;
    const ac = new AbortController();
    const t = setTimeout(() => {
      (lt.url ? fetchLtLanguages(lt.url, ac.signal) : fetchServerLanguages())
        .then((list) => {
          setLanguages(list);
          setStatus((s) => (s.kind === 'error' && s.text.startsWith('Could not load languages') ? { kind: 'idle', text: '' } : s));
        })
        .catch((err) => {
          if (ac.signal.aborted) return;
          setLangsFailed(true);
          setStatus({ kind: 'error', text: `Could not load languages: ${err.message}` });
        });
    }, lt.url ? 600 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [engine, lt.url, lt.error]);

  // languages remembered from the last visit may be missing on this engine or server
  useEffect(() => {
    if (!languages.length) return;
    const known = (code) => languages.some((l) => l.code === code);
    setLang1((code) => (code === 'auto' || known(code) ? code : ''));
    setLang2((code) => (known(code) ? code : ''));
  }, [languages]);

  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; }; // closing the tab would stop the translation
    window.addEventListener('beforeunload', warn);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', warn);
    };
  }, [busy]);

  // A file dropped anywhere but the upload field (or on it while it is disabled)
  // makes the browser open that file in place of the page, losing all translations.
  useEffect(() => {
    const guard = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  const update = (id, changes) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...changes } : f)));
  const present = files.filter((f) => !f.leaving);

  const chooseEngine = (next) => {
    if (next === engine || busy) return;
    setEngine(next);
    save(ENGINE_STORAGE, next);
    setLang1(load(langStorage(next, 'source')));
    setLang2(load(langStorage(next, 'target')));
    setStatus({ kind: 'idle', text: '' });
  };

  const addFiles = async (e) => {
    setDragging(false);
    const picked = [...e.target.files];
    e.target.value = ''; // let the same file be picked again
    const room = Math.max(0, MAX_FILES - present.length);
    setStatus(picked.length > room
      ? { kind: 'error', text: `Up to ${MAX_FILES} files at once, ${picked.length - room} skipped.` }
      : { kind: 'idle', text: '' });
    const added = await Promise.all(picked.slice(0, room).map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = decodeUnicode(bytes);
      const ok = (text ?? decodeLegacy(bytes, 'en')).includes('-->');
      return {
        id: nextId++,
        name: file.name,
        text,
        bytes: text === null ? bytes : null,
        status: ok ? 'pending' : 'invalid',
        note: ok ? '' : 'Not an .srt file: no timecodes inside',
      };
    }));
    setFiles((fs) => [...fs, ...added]);
  };

  // the row slides out and collapses, the rows below move up into its place
  const removeFile = (id) => {
    update(id, { leaving: true });
    setTimeout(() => setFiles((fs) => fs.filter((f) => f.id !== id)), LEAVE_MS);
  };

  const translate = async (e) => {
    e.preventDefault();
    if (busy) {
      run.current?.abort();
      return;
    }
    const key = apiKey.trim();
    const using = engine === 'google' ? googleEngine : useServer ? 'server' : lt.url ? ltEngine(lt.url, key) : null;
    const pair = `${engine === 'google' ? 'google' : lt.url || 'server'}|${lang1}>${lang2}`;
    const todo = present.filter((f) => f.status !== 'invalid' && !(f.status === 'done' && f.pair === pair));
    if (engine === 'libretranslate' && lt.error) return setStatus({ kind: 'error', text: lt.error });
    if (useServer && !key) return setStatus({ kind: 'error', text: 'This server needs an API key from its owner. Or switch to Google.' });
    if (!present.length) return setStatus({ kind: 'error', text: 'Add at least one .srt file.' });
    if (!lang1 || !lang2) return setStatus({ kind: 'error', text: 'Choose both languages.' });
    if (lang1 === lang2) return setStatus({ kind: 'error', text: 'Source and target languages are the same.' });
    if (!todo.length) return setStatus({ kind: 'done', text: 'Everything is already translated, hit Download.' });

    save(ENGINE_STORAGE, engine);
    save(LT_URL_STORAGE, ltUrl.trim());
    if (key) save(KEY_STORAGE, key);
    save(langStorage(engine, 'source'), lang1);
    save(langStorage(engine, 'target'), lang2);
    const ac = new AbortController();
    run.current = ac;
    setBusy(true);
    setNow(Date.now());
    setStatus({ kind: 'busy', text: `Translating ${todo.length} file${todo.length > 1 ? 's' : ''} one by one. Each can be downloaded as soon as it is done.` });
    todo.forEach((f) => update(f.id, { status: 'pending', note: '' }));

    let done = 0;
    let failed = 0;
    let fatal = null;
    for (const f of todo) {
      if (ac.signal.aborted || fatal) {
        update(f.id, { status: 'stopped', note: fatal ? 'Skipped' : 'Stopped' });
        continue;
      }
      const started = Date.now();
      update(f.id, { status: 'working', started, progress: 0, total: 0 });
      try {
        const res = await translateSubtitles(f.text ?? decodeLegacy(f.bytes, lang1), {
          engine: using,
          apiKey: key,
          source: lang1,
          target: lang2,
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.queue) update(f.id, { status: 'queued', queue: ev.queue });
            if (ev.total !== undefined) update(f.id, { status: 'working', progress: ev.progress, total: ev.total });
          },
        });
        update(f.id, {
          status: 'done', result: res.translatedText, pair, target: lang2, took: Date.now() - started, note: res.warning || '',
        });
        done++;
      } catch (err) {
        if (ac.signal.aborted) {
          update(f.id, { status: 'stopped', note: 'Stopped' });
          continue;
        }
        failed++;
        update(f.id, { status: 'error', note: err.message });
        if (FATAL.includes(err.code)) fatal = err;
      }
    }

    run.current = null;
    setBusy(false);
    if (fatal) setStatus({ kind: 'error', text: `${fatal.message}. The remaining files were skipped.` });
    else if (ac.signal.aborted) setStatus({ kind: 'error', text: `Stopped. ${done} translated.` });
    else if (failed) setStatus({ kind: 'error', text: `${done} translated, ${failed} failed, see the list.` });
    else setStatus({ kind: 'done', text: `All ${done} translated. Download them from the list or all at once.` });
  };

  const ready = present.filter((f) => f.status === 'done');

  const downloadAll = () => {
    if (!ready.length) {
      return setStatus(busy
        ? { kind: 'busy', text: 'Nothing is ready yet, files appear in the list as soon as they are done.' }
        : { kind: 'error', text: 'Nothing to download yet: translate some files first.' });
    }
    // browsers may ask once whether this site may download several files
    ready.forEach((f, i) => setTimeout(() => saveFile(outName(f.name, f.target), f.result), i * 400));
  };

  const sources = [{ code: 'auto', name: 'Auto-detect' }, ...languages];
  const pickerNote = languages.length ? 'Select language' : lt.error || langsFailed ? 'No languages' : 'Loading languages…';
  const ltOpen = engine === 'libretranslate';

  return (
    <div className="App">
      <header className="app-header">
        <div className="header-logo">
          <span className="header-tag"><LogoIcon size={18} /></span>
          <h1>Subtitle Translator</h1>
        </div>
        <div className="header-right">
          <a className="header-badge" href="https://github.com/Luvrok" target="_blank" rel="noreferrer">Powered by Luvrok</a>
          <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Switch theme">
            {theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
          </button>
        </div>
      </header>

      <main className="container-content">
        {/* ENGINE */}
        <section className="card card-engine reveal" style={{ '--i': 0 }}>
          <p className="card-label">01 — Engine</p>
          <h2>Translate with</h2>
          <div className="segmented" role="radiogroup" aria-label="Translation engine" style={{ '--index': ltOpen ? 1 : 0 }}>
            <span className="segmented-thumb" aria-hidden="true" />
            {[['google', 'Google Translate'], ['libretranslate', 'LibreTranslate']].map(([id, name]) => (
              <button key={id} type="button" role="radio" aria-checked={engine === id} disabled={busy} onClick={() => chooseEngine(id)}>
                {name}
              </button>
            ))}
          </div>
          <p className="engine-hint">
            {ltOpen
              ? 'Your own LibreTranslate server, or leave the address empty to use this site\'s server.'
              : 'Free Google Translate, straight from your browser. Nothing to set up.'}
          </p>
          <div className={`collapse${ltOpen ? ' is-open' : ''}`} {...(!ltOpen && { inert: '' })}>
            <div className="collapse-inner">
              <div className="engine-fields">
                <Field
                  label="Server address"
                  prompt="url"
                  placeholder="empty = this site's server"
                  value={ltUrl}
                  onChange={(e) => setLtUrl(e.target.value)}
                  disabled={busy}
                  hint={lt.error || (lt.url ? `Requests go from your browser to ${lt.url}` : 'Ask the owner of this site for a key')}
                />
                <Field
                  label={useServer ? 'API key' : 'API key, if the server wants one'}
                  prompt="key"
                  type="password"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={busy}
                  hint="Remembered only in this browser"
                />
              </div>
            </div>
          </div>
        </section>

        {/* FILES */}
        <section className="card card-files reveal" style={{ '--i': 1 }}>
          <p className="card-label">02 — Source files</p>
          <h2>Upload up to {MAX_FILES} subtitle files</h2>
          <div className={`file-upload-area${busy || present.length >= MAX_FILES ? ' is-disabled' : ''}${dragging ? ' is-dragging' : ''}`}>
            <UploadIcon size={30} />
            <p className="upload-text"><strong>Click to browse</strong> or drag & drop</p>
            <span className="upload-ext">.srt files only · {present.length}/{MAX_FILES}</span>
            <input
              type="file"
              name="file"
              accept=".srt"
              multiple
              onChange={addFiles}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDrop={() => setDragging(false)}
              disabled={busy || present.length >= MAX_FILES}
            />
          </div>
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.id} className={`file-item${f.leaving ? ' is-leaving' : ''}`}>
                  <div className="file-clip">
                    <div className={`file-row file-${f.status}`}>
                      <span className="file-icon"><StatusIcon status={f.status} /></span>
                      <div className="file-main">
                        <span className="file-name" title={f.name}>{f.name}</span>
                        <span className="file-note">{describe(f, busy, now)}</span>
                        {f.status === 'working' && f.total > 0 && (
                          <span className="file-bar"><span style={{ width: `${(100 * f.progress) / f.total}%` }} /></span>
                        )}
                      </div>
                      {f.status === 'done' && (
                        <FlashButton
                          className="file-btn file-save"
                          title={`Download ${outName(f.name, f.target)}`}
                          aria-label={`Download ${outName(f.name, f.target)}`}
                          onClick={() => saveFile(outName(f.name, f.target), f.result)}
                          doneIcon={<CheckIcon size={16} />}
                        >
                          <DownloadIcon size={16} />
                        </FlashButton>
                      )}
                      {!busy && (
                        <button type="button" className="file-btn file-remove" title="Remove from the list" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.id)} disabled={f.leaving}>
                          <CloseIcon size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* LANGUAGES */}
        <section className="card lang-block reveal" style={{ '--i': 2 }}>
          <p className="card-label">03 — Input language</p>
          <h3>Translate from</h3>
          <LangPicker prompt="from" value={lang1} options={sources} onChange={setLang1} disabled={busy || !languages.length} placeholder={pickerNote} />
        </section>
        <section className="card lang-block reveal" style={{ '--i': 3 }}>
          <p className="card-label">04 — Output language</p>
          <h3>Translate to</h3>
          <LangPicker prompt="to" value={lang2} options={languages} onChange={setLang2} disabled={busy || !languages.length} placeholder={pickerNote} />
        </section>

        {/* ACTIONS */}
        <section className="card container-actions reveal" style={{ '--i': 4 }}>
          <div className="action-info">
            <p>
              Files are translated <strong>one by one</strong>, a whole film takes a few minutes.
              Each file can be <strong>downloaded</strong> from the list as soon as it is done.
            </p>
            {status.text && <p key={status.text} className={`status status-${status.kind}`} role="status">{status.text}</p>}
          </div>
          <div className="action-buttons">
            <button type="button" className={`btn btn-translate${busy ? ' is-busy' : ''}`} onClick={translate}>
              {busy ? <StopIcon size={16} /> : <LogoIcon size={16} />}
              {busy ? 'Stop' : 'Translate'}
            </button>
            <FlashButton className={`btn btn-download${ready.length ? '' : ' is-disabled'}`} onClick={downloadAll}>
              <DownloadIcon size={16} />
              Download all{ready.length ? ` (${ready.length})` : ''}
            </FlashButton>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span>Subtitle Translator — v1.3</span>
        <span>{engine === 'google' ? 'Google Translate' : lt.url ? new URL(lt.url).host : 'LibreTranslate on this server'}</span>
      </footer>
    </div>
  );
}

export default App;
