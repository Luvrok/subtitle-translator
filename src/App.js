import { useEffect, useRef, useState } from 'react';
import './App.css';

const API = process.env.PUBLIC_URL + '/api';
const MAX_FILES = 10;
const KEY_STORAGE = 'libretranslate-api-key';

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const since = (t, now) => fmtTime(Math.max(0, Math.round((now - t) / 1000)));

// .srt files are often not UTF-8 (Russian ones are usually cp1251)
const decodeSubtitles = (buf) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
};

const loadKey = () => {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
};
const saveKey = (key) => {
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private mode: keep it in memory only */ }
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

const errorOf = (message, code) => Object.assign(new Error(message), { code });

// POST one file and follow the server's NDJSON event stream until the result arrives.
async function translateFile(body, signal, onEvent) {
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

let nextId = 1;

const Icon = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const LogoIcon = ({ size }) => (
  <Icon size={size}>
    <path d="M5 8l6 6" /><path d="M4 14l6-6 2-3" /><path d="M2 5h12" />
    <path d="M7 2h1" /><path d="M22 22l-5-10-5 10" /><path d="M14 18h6" />
  </Icon>
);

const DownloadIcon = ({ size }) => (
  <Icon size={size}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
);

function StatusIcon({ status }) {
  switch (status) {
    case 'working':
      return <span className="spinner" aria-label="translating" />;
    case 'queued':
      return <Icon><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></Icon>;
    case 'done':
      return <Icon><circle cx="12" cy="12" r="9" /><polyline points="8 12.5 11 15.5 16 9.5" /></Icon>;
    case 'error':
    case 'invalid':
      return <Icon><circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" /></Icon>;
    case 'stopped':
      return <Icon><circle cx="12" cy="12" r="9" /><line x1="8" y1="12" x2="16" y2="12" /></Icon>;
    default:
      return <Icon><circle cx="12" cy="12" r="9" /></Icon>;
  }
}

function describe(f, busy, now) {
  switch (f.status) {
    case 'pending': return busy ? 'Waiting for the previous file' : 'Ready';
    case 'queued': return `Server is busy, in queue #${f.queue} · ${since(f.started, now)}`;
    case 'working': return `Translating ${f.total ? `${f.progress}/${f.total}` : '…'} · ${since(f.started, now)}`;
    case 'done': return `Done in ${fmtTime(Math.round(f.took / 1000))}${f.note ? ` · ${f.note}` : ''}`;
    default: return f.note;
  }
}

function App() {
  const [option, setOptions] = useState([]);
  const [lang1, setLang1] = useState('');
  const [lang2, setLang2] = useState('');
  const [apiKey, setApiKey] = useState(loadKey);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const run = useRef(null); // AbortController of the running batch

  useEffect(() => {
    fetch(API + '/languages')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `server answered ${res.status}`);
        setOptions(data);
      })
      .catch((err) => setStatus({ kind: 'error', text: `Could not load languages: ${err.message}` }));
  }, []);

  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const update = (id, changes) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...changes } : f)));

  const addFiles = async (e) => {
    const picked = [...e.target.files];
    e.target.value = ''; // let the same file be picked again
    const room = Math.max(0, MAX_FILES - files.length);
    setStatus(picked.length > room
      ? { kind: 'error', text: `Up to ${MAX_FILES} files at once, ${picked.length - room} skipped.` }
      : { kind: 'idle', text: '' });
    const added = await Promise.all(picked.slice(0, room).map(async (file) => {
      const text = decodeSubtitles(await file.arrayBuffer());
      const ok = text.includes('-->');
      return { id: nextId++, name: file.name, text, status: ok ? 'pending' : 'invalid', note: ok ? '' : 'Not an .srt file: no timecodes inside' };
    }));
    setFiles((fs) => [...fs, ...added].slice(0, MAX_FILES));
  };

  const removeFile = (id) => setFiles((fs) => fs.filter((f) => f.id !== id));

  const translate = async (e) => {
    e.preventDefault();
    if (busy) {
      run.current?.abort();
      return;
    }
    const key = apiKey.trim();
    const pair = `${lang1}>${lang2}`;
    const todo = files.filter((f) => f.status !== 'invalid' && !(f.status === 'done' && f.pair === pair));
    if (!key) return setStatus({ kind: 'error', text: 'Enter your LibreTranslate API key first.' });
    if (!files.length) return setStatus({ kind: 'error', text: 'Add at least one .srt file.' });
    if (!lang1 || !lang2) return setStatus({ kind: 'error', text: 'Choose both languages.' });
    if (lang1 === lang2) return setStatus({ kind: 'error', text: 'Source and target languages are the same.' });
    if (!todo.length) return setStatus({ kind: 'done', text: 'Everything is already translated, hit Download.' });

    saveKey(key);
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
        const res = await translateFile(
          { q: f.text, source: lang1, target: lang2, api_key: key },
          ac.signal,
          (ev) => {
            if (ev.queue) update(f.id, { status: 'queued', queue: ev.queue });
            if (ev.total !== undefined) update(f.id, { status: 'working', progress: ev.progress, total: ev.total });
          },
        );
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
        if (['bad_key', 'rate_limit', 'busy'].includes(err.code)) fatal = err;
      }
    }

    run.current = null;
    setBusy(false);
    if (fatal) setStatus({ kind: 'error', text: `${fatal.message}. The remaining files were skipped.` });
    else if (ac.signal.aborted) setStatus({ kind: 'error', text: `Stopped. ${done} translated.` });
    else if (failed) setStatus({ kind: 'error', text: `${done} translated, ${failed} failed, see the list.` });
    else setStatus({ kind: 'done', text: `All ${done} translated. Download them from the list or all at once.` });
  };

  const downloadAll = (e) => {
    e.preventDefault();
    const ready = files.filter((f) => f.status === 'done');
    if (!ready.length) {
      return setStatus(busy
        ? { kind: 'busy', text: 'Nothing is ready yet, files appear in the list as soon as they are done.' }
        : { kind: 'error', text: 'Nothing to download yet: translate some files first.' });
    }
    // browsers may ask once whether this site may download several files
    ready.forEach((f, i) => setTimeout(() => saveFile(outName(f.name, f.target), f.result), i * 400));
  };

  const getLangName = (code) => (code === 'auto' ? 'Auto-detect' : option.find((o) => o.code === code)?.name || code);
  const readyCount = files.filter((f) => f.status === 'done').length;

  return (
    <div className="App">
      {/* HEADER */}
      <header className="container-header">
        <div className="header-logo">
          <LogoIcon size={22} />
          <h2>Subtitle Translator</h2>
        </div>
        <span className="header-badge">Powered by LibreTranslate</span>
      </header>

      {/* MAIN */}
      <main className="container-content">

        {/* API KEY */}
        <div className="container-key card">
          <p className="card-label">Step 01 — Access</p>
          <h2>Your LibreTranslate API key</h2>
          <input
            className="key-input"
            type="password"
            name="api-key"
            autoComplete="off"
            spellCheck="false"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy}
          />
          <p className="key-hint">Get a key from the owner of this server. It is remembered only in this browser.</p>
        </div>

        {/* FILE UPLOAD */}
        <div className="container-body card">
          <p className="card-label">Step 02 — Source Files</p>
          <h2>Upload up to {MAX_FILES} subtitle files</h2>
          <div className={`file-upload-area${busy || files.length >= MAX_FILES ? ' is-disabled' : ''}`}>
            <Icon size={32}>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </Icon>
            <p className="upload-text"><strong>Click to browse</strong> or drag & drop</p>
            <span className="upload-ext">.srt files only · {files.length}/{MAX_FILES}</span>
            <input
              type="file"
              name="file"
              accept=".srt"
              multiple
              onChange={addFiles}
              disabled={busy || files.length >= MAX_FILES}
            />
          </div>
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.id} className={`file-row file-${f.status}`}>
                  <span className="file-icon"><StatusIcon status={f.status} /></span>
                  <div className="file-main">
                    <span className="file-name" title={f.name}>{f.name}</span>
                    <span className="file-note">{describe(f, busy, now)}</span>
                    {f.status === 'working' && f.total > 0 && (
                      <span className="file-bar"><span style={{ width: `${(100 * f.progress) / f.total}%` }} /></span>
                    )}
                  </div>
                  {f.status === 'done' && (
                    <button type="button" className="file-btn file-save" title={`Download ${outName(f.name, f.target)}`} onClick={() => saveFile(outName(f.name, f.target), f.result)}>
                      <DownloadIcon size={16} />
                    </button>
                  )}
                  {!busy && (
                    <button type="button" className="file-btn file-remove" title="Remove from the list" onClick={() => removeFile(f.id)}>
                      <Icon size={16}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Icon>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* LANGUAGE SELECTORS */}
        <div className="container-select">
          <div className="lang-block">
            <p className="card-label">Step 03 — Input Language</p>
            <h3>
              Translate from
              <span className={`lang-badge ${!lang1 ? 'empty' : ''}`}>
                {lang1 ? getLangName(lang1) : '—'}
              </span>
            </h3>
            <select
              className="styled-select"
              name="lang"
              id="lang"
              onChange={(e) => setLang1(e.target.value)}
              defaultValue=""
              disabled={busy}
            >
              <option value="" disabled>Select language…</option>
              <option value="auto">Auto-detect</option>
              {option.map((opt) => (
                <option key={opt.code} value={opt.code}>{opt.name}</option>
              ))}
            </select>
          </div>

          <div className="lang-block">
            <p className="card-label">Step 04 — Output Language</p>
            <h3>
              Translate to
              <span className={`lang-badge ${!lang2 ? 'empty' : ''}`}>
                {lang2 ? getLangName(lang2) : '—'}
              </span>
            </h3>
            <select
              className="styled-select"
              onChange={(e) => setLang2(e.target.value)}
              defaultValue=""
              disabled={busy}
            >
              <option value="" disabled>Select language…</option>
              {option.map((opt) => (
                <option key={opt.code} value={opt.code}>{opt.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ACTIONS */}
        <div className="container-actions">
          <div className="action-info">
            <p>
              Files are translated <strong>one by one</strong>, a whole film takes a few minutes.
              Each file can be <strong>downloaded</strong> from the list as soon as it is done.
            </p>
            {status.text && (
              <p className={`status status-${status.kind}`} role="status">{status.text}</p>
            )}
          </div>
          <div className="action-buttons">
            <button type="button" className={`btn-translate${busy ? ' is-busy' : ''}`} onClick={translate}>
              {busy
                ? <Icon size={16}><rect x="6" y="6" width="12" height="12" rx="1" /></Icon>
                : <LogoIcon size={16} />}
              {busy ? 'Stop' : 'Translate'}
            </button>
            <a href="#download" onClick={downloadAll} className={`btn-download${readyCount ? '' : ' is-disabled'}`}>
              <DownloadIcon size={16} />
              Download all{readyCount ? ` (${readyCount})` : ''}
            </a>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="app-footer">
        <span>Subtitle Translator — v1.1</span>
        <span>LibreTranslate API</span>
      </footer>
    </div>
  );
}

export default App;
