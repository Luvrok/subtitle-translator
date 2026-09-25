import { useEffect, useId, useMemo, useRef, useState } from 'react';

// dmenu-like language picker: a prompt-style field, and a list that filters as you type.
// Arrows / PageUp / PageDown / Home / End move, Enter picks, Escape closes; typing on the
// closed field opens it with that letter already in the filter.
export default function LangPicker({ prompt, value, options, onChange, disabled, placeholder = 'Select language' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const field = useRef(null);
  const list = useRef(null);
  const id = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const starts = [];
    const contains = [];
    for (const o of options) {
      const name = o.name.toLowerCase();
      if (name.startsWith(q) || o.code.toLowerCase() === q) starts.push(o);
      else if (name.includes(q)) contains.push(o);
    }
    return [...starts, ...contains];
  }, [options, query]);

  const current = options.find((o) => o.code === value);

  const show = (initial = '') => {
    if (disabled) return;
    setQuery(initial);
    setActive(initial ? 0 : Math.max(0, options.findIndex((o) => o.code === value)));
    setOpen(true);
  };
  const close = (refocus) => {
    setOpen(false);
    if (refocus) field.current?.focus();
  };
  const choose = (o) => {
    onChange(o.code);
    close(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (!root.current?.contains(e.target)) close(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onFieldKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      show(e.key);
    }
  };

  const onFilterKey = (e) => {
    const last = matches.length - 1;
    const move = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + 8, PageUp: active - 8, Home: 0, End: last }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      setActive(Math.min(Math.max(move, 0), Math.max(last, 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className={`picker${open ? ' is-open' : ''}`} ref={root}>
      <button
        type="button"
        ref={field}
        className="picker-field"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onFieldKey}
      >
        <span className="picker-prompt">{prompt}</span>
        <span className={`picker-value${current ? '' : ' is-empty'}`}>{current?.name ?? placeholder}</span>
        {current && <span className="picker-code">{current.code}</span>}
        <span className="picker-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="picker-panel">
          <div className="picker-search">
            <span className="picker-search-mark" aria-hidden="true">/</span>
            <input
              autoFocus
              className="picker-filter"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={matches[active] ? `${id}-${matches[active].code}` : undefined}
              aria-label={`${prompt} language, type to filter`}
              placeholder="type to filter"
              spellCheck="false"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onFilterKey}
            />
            <span className="picker-count">{matches.length}</span>
          </div>
          <ul className="picker-list" role="listbox" id={`${id}-list`} ref={list}>
            {matches.map((o, i) => (
              <li
                key={o.code}
                id={`${id}-${o.code}`}
                role="option"
                aria-selected={o.code === value}
                className={`picker-option${i === active ? ' is-active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              >
                <span>{o.name}</span>
                <span className="picker-option-code">{o.code}</span>
              </li>
            ))}
            {!matches.length && <li className="picker-empty">nothing matches “{query}”</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
