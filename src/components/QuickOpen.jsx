import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, activeEditor } from '../lib/store';
import { COMMANDS, formatKeys } from '../lib/commands';
import { basename, join } from '../lib/paths';
import { FileIcon } from '../lib/fileIcons.jsx';

/** Simple fuzzy matcher: subsequence match with bonuses for consecutive and basename hits. */
export function fuzzyScore(query, target) {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const t = target.toLowerCase();
  if (!q) return 1;
  const base = t.slice(t.lastIndexOf('/') + 1);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  const idx = t.indexOf(q);
  if (idx !== -1) return 600 - idx - t.length * 0.1 + (base.includes(q) ? 100 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return Math.max(1, score - t.length * 0.05);
}

function Highlight({ text, query }) {
  if (!query) return text;
  const q = query.toLowerCase();
  const out = [];
  let qi = 0;
  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && text[i].toLowerCase() === q[qi]) {
      out.push(<mark key={i}>{text[i]}</mark>);
      qi++;
    } else out.push(text[i]);
  }
  return out;
}

export default function QuickOpen() {
  const initial = useStore((s) => s.overlayArg) ?? '';
  const close = useStore((s) => s.closeOverlay);
  const root = useStore((s) => s.root);
  const tabs = useStore((s) => s.tabs);
  const [query, setQuery] = useState(initial);
  const [files, setFiles] = useState([]);
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    useStore.getState().getFileList().then(setFiles);
  }, []);

  const mode = query.startsWith('>') ? 'commands' : query.startsWith(':') ? 'line' : 'files';

  const results = useMemo(() => {
    if (mode === 'commands') {
      const q = query.slice(1).trim();
      return COMMANDS.map((c) => ({ c, s: fuzzyScore(q, `${c.category}: ${c.title}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (q ? b.s - a.s : 0))
        .slice(0, 60)
        .map(({ c }) => ({ kind: 'command', id: c.id, label: c.title, cat: c.category, keys: c.keys || c.keysLabel, run: c.run }));
    }
    if (mode === 'line') return [];
    const [q, line] = query.split(':');
    const recentPaths = tabs.filter((t) => t.path).map((t) => t.path);
    if (!q.trim()) {
      const recent = recentPaths.map((p) => ({ kind: 'file', abs: p, rel: root && p.startsWith(root) ? p.slice(root.length + 1).replace(/\\/g, '/') : p, line }));
      const rest = files.filter((f) => !recent.find((r) => r.rel === f)).slice(0, 40).map((f) => ({ kind: 'file', rel: f, line }));
      return [...recent, ...rest];
    }
    return files
      .map((f) => [f, fuzzyScore(q.trim(), f)])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([f]) => ({ kind: 'file', rel: f, line }));
  }, [query, files, mode, tabs, root]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.res.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (r) => {
    close();
    if (!r) return;
    if (r.kind === 'command') setTimeout(() => r.run(), 0);
    else if (r.kind === 'file') {
      const abs = r.abs || (root ? join(root, r.rel) : r.rel);
      useStore.getState().openFile(abs, { line: r.line ? Number(r.line) : undefined });
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'line') {
        const n = Number(query.slice(1));
        close();
        if (n && activeEditor) {
          activeEditor.revealLineInCenter(n);
          activeEditor.setPosition({ lineNumber: n, column: 1 });
          activeEditor.focus();
        }
        return;
      }
      choose(results[index]);
    }
  };

  const placeholder = mode === 'commands' ? 'Type a command' : root ? 'Search files by name (type > for commands, : for a line)' : 'Type > for commands';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} spellCheck={false} />
        <div className="results" ref={listRef}>
          {mode === 'line' && <div className="empty">Type a line number and press Enter to go to it.</div>}
          {mode === 'files' && !root && <div className="empty">Open a folder to search files — or type &gt; to run a command.</div>}
          {mode !== 'line' && results.length === 0 && (root || mode === 'commands') && <div className="empty">No results.</div>}
          {results.map((r, i) =>
            r.kind === 'command' ? (
              <div key={r.id} className={`res ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(r)}>
                <span className="cat">{r.cat}:</span>
                <span>
                  <Highlight text={r.label} query={query.slice(1).trim()} />
                </span>
                {r.keys && <span className="kbd-hint">{formatKeys(r.keys)}</span>}
              </div>
            ) : (
              <div key={r.rel} className={`res ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(r)}>
                <FileIcon name={r.rel} size={14} />
                <span>
                  <Highlight text={basename(r.rel)} query={query.split(':')[0].trim()} />
                </span>
                <span className="dir">{r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : ''}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
