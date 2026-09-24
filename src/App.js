import axios from 'axios';
import { useEffect, useState } from 'react';
import './App.css';

const API = process.env.PUBLIC_URL + '/api';

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// .srt files are often not UTF-8 (Russian ones are usually cp1251)
const decodeSubtitles = (buf) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
};

function App() {
  const [option, setOptions] = useState([]);
  const [lang1, setLang1] = useState('');
  const [lang2, setLang2] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState({ kind: 'idle', text: '' });

  const showFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFilename(file.name);
    setOutput('');
    setStatus({ kind: 'idle', text: '' });
    file.arrayBuffer().then((buf) => setInput(decodeSubtitles(buf)));
  };

  useEffect(() => {
    axios.get(API + '/languages', {
      headers: { accept: 'application/json' },
    })
      .then((res) => setOptions(res.data))
      .catch((err) => setStatus({ kind: 'error', text: `Could not load languages: ${err.response?.data?.error || err.message}` }));
  }, []);

  const translate = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!input) return setStatus({ kind: 'error', text: 'Choose an .srt file first.' });
    if (!lang1 || !lang2) return setStatus({ kind: 'error', text: 'Choose both languages.' });
    if (lang1 === lang2) return setStatus({ kind: 'error', text: 'Source and target languages are the same.' });

    const params = new URLSearchParams();
    params.append('q', input);
    params.append('source', lang1);
    params.append('target', lang2);

    setOutput('');
    setBusy(true);
    setElapsed(0);
    setStatus({ kind: 'busy', text: 'Translating… a whole film takes several minutes, keep this tab open.' });
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const res = await axios.post(API + '/translate', params, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
      });
      if (res.data.error) throw new Error(res.data.error);
      if (typeof res.data.translatedText !== 'string') throw new Error('unexpected response from server');
      setOutput(res.data.translatedText);
      const took = fmtTime(Math.round((Date.now() - started) / 1000));
      setStatus(res.data.warning
        ? { kind: 'error', text: `Done in ${took}, but ${res.data.warning}.` }
        : { kind: 'done', text: `Done in ${took}. Click Download.` });
    } catch (err) {
      setStatus({ kind: 'error', text: `Error: ${err.response?.data?.error || err.message}` });
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  };

  const download = (e) => {
    e.preventDefault();
    if (!output) {
      return setStatus(busy
        ? { kind: 'busy', text: 'Still translating, Download will work when it finishes.' }
        : { kind: 'error', text: 'Nothing to download yet: translate a file first.' });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([output], { type: 'application/x-subrip;charset=utf-8' }));
    a.download = `${filename.replace(/\.srt$/i, '') || 'subtitles'}.${lang2}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  const getLangName = (code) => (code === 'auto' ? 'Auto-detect' : option.find((o) => o.code === code)?.name || code);

  return (
    <div className="App">
      {/* HEADER */}
      <header className="container-header">
        <div className="header-logo">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 8l6 6" /><path d="M4 14l6-6 2-3" /><path d="M2 5h12" />
            <path d="M7 2h1" /><path d="M22 22l-5-10-5 10" /><path d="M14 18h6" />
          </svg>
          <h2>Subtitle Translator</h2>
        </div>
        <span className="header-badge">Powered by LibreTranslate</span>
      </header>

      {/* MAIN */}
      <main className="container-content">

        {/* FILE UPLOAD */}
        <div className="container-body card">
          <p className="card-label">Step 01 — Source File</p>
          <h2>Upload your subtitle file</h2>
          <div className="file-upload-area">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="upload-text"><strong>Click to browse</strong> or drag & drop</p>
            <span className="upload-ext">.srt files only</span>
            <input
              type="file"
              name="file"
              accept=".srt"
              onChange={showFile}
            />
          </div>
          {filename && (
            <div className="file-name-pill">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {filename}
            </div>
          )}
        </div>

        {/* LANGUAGE SELECTORS */}
        <div className="container-select">
          <div className="lang-block">
            <p className="card-label">Step 02 — Input Language</p>
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
            >
              <option value="" disabled>Select language…</option>
              <option value="auto">Auto-detect</option>
              {option.map((opt) => (
                <option key={opt.code} value={opt.code}>{opt.name}</option>
              ))}
            </select>
          </div>

          <div className="lang-block">
            <p className="card-label">Step 03 — Output Language</p>
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
              Upload an <strong>.srt file</strong>, choose your source and target languages,
              then hit <strong>Translate</strong>. When it is done, hit <strong>Download</strong>.
            </p>
            {status.text && (
              <p className={`status status-${status.kind}`} role="status">
                {status.text}
                {busy && ` ${fmtTime(elapsed)}`}
              </p>
            )}
          </div>
          <div className="action-buttons">
            <button className="btn-translate" onClick={translate} disabled={busy}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 8l6 6" /><path d="M4 14l6-6 2-3" /><path d="M2 5h12" />
                <path d="M7 2h1" /><path d="M22 22l-5-10-5 10" /><path d="M14 18h6" />
              </svg>
              {busy ? 'Translating…' : 'Translate'}
            </button>
            <a href="#download" onClick={download} className={`btn-download${output ? '' : ' is-disabled'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </a>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="app-footer">
        <span>Subtitle Translator — v1.0</span>
        <span>LibreTranslate API</span>
      </footer>
    </div>
  );
}

export default App;