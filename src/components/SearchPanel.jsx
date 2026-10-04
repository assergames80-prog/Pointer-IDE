import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CaseSensitive, Regex, WholeWord, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { basename, dirname, relative } from '../lib/paths';
import { FileIcon } from '../lib/fileIcons.jsx';

function highlight(text, m) {
  const start = Math.max(0, m.col - 1);
  const pre = text.slice(0, start);
  const hit = text.slice(start, start + m.length);
  const post = text.slice(start + m.length);
  const trimmedPre = pre.length > 30 ? '…' + pre.slice(-30).trimStart() : pre.trimStart();
  return (
    <>
      {trimmedPre}
      <mark>{hit}</mark>
      {post}
    </>
  );
}

export default function SearchPanel() {
  const root = useStore((s) => s.root);
  const openFile = useStore((s) => s.openFile);
  const [query, setQuery] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [opts, setOpts] = useState({ caseSensitive: false, isRegex: false, wholeWord: false });
  const [showFilters, setShowFilters] = useState(false);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [error, setError] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!root || !query) {
      setRes(null);
      setError(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        if (opts.isRegex) new RegExp(query);
        const r = await api.searchText(root, { query, include, exclude, ...opts });
        if (n === seq.current) setRes(r);
      } catch (e) {
        if (n === seq.current) setError(e.message.replace(/^Error invoking remote method[^:]*: /, ''));
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [root, query, include, exclude, opts]);

  const Toggle = ({ k, icon: Icon, title }) => (
    <button className={`toggle-chip ${opts[k] ? 'on' : ''}`} title={title} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}>
      <Icon size={14} />
    </button>
  );

  return (
    <div className="search-panel">
      <div className="pane-header">
        <span className="title">Search</span>
        <div className="actions visible">
          {query && (
            <button className="icon-btn sm" title="Clear" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {!root ? (
        <div className="empty-pane">Open a folder to search its files.</div>
      ) : (
        <>
          <div className="search-form">
            <div className="search-input-wrap">
              <input className="input" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus spellCheck={false} />
              <div className="search-toggles">
                <Toggle k="caseSensitive" icon={CaseSensitive} title="Match Case" />
                <Toggle k="wholeWord" icon={WholeWord} title="Match Whole Word" />
                <Toggle k="isRegex" icon={Regex} title="Use Regular Expression" />
              </div>
            </div>
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start', padding: '0 4px' }} onClick={() => setShowFilters((v) => !v)}>
              {showFilters ? <ChevronDown size={13} /> : <ChevronRight size={13} />} files to include/exclude
            </button>
            {showFilters && (
              <>
                <input className="input" placeholder="files to include (e.g. src/**, *.ts)" value={include} onChange={(e) => setInclude(e.target.value)} />
                <input className="input" placeholder="files to exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} />
              </>
            )}
            {error && <div className="status-bad">{error}</div>}
            {res && !error && (
              <div className="faint" style={{ fontSize: 12 }}>
                {busy ? 'Searching… ' : ''}
                {res.total} result{res.total === 1 ? '' : 's'} in {res.results.length} file{res.results.length === 1 ? '' : 's'}
                {res.truncated ? ' (truncated)' : ''}
              </div>
            )}
          </div>
          <div className="search-results">
            {res?.results.map((f) => (
              <div key={f.path}>
                <div className="search-file" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))} title={f.path}>
                  {collapsed[f.path] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <FileIcon name={f.path} size={14} />
                  <span className="ellipsis">{basename(f.path)}</span>
                  <span className="faint ellipsis" style={{ fontSize: 11.5 }}>
                    {relative(root, dirname(f.path))}
                  </span>
                  <span className="count">{f.matches.length}</span>
                </div>
                {!collapsed[f.path] &&
                  f.matches.map((m, i) => (
                    <div key={i} className="search-match mono" style={{ fontSize: 12 }} onClick={() => openFile(f.path, { line: m.line, col: m.col })}>
                      {highlight(m.text, m)}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
