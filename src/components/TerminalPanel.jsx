import { useEffect, useRef } from 'react';
import { Plus, Trash2, X, SquareTerminal, ChevronDown } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useStore } from '../lib/store';
import { api, on } from '../lib/api';

// xterm instances survive React re-renders; keyed by terminal id.
const instances = new Map();

function themeFor(theme) {
  return theme === 'light'
    ? { background: '#ffffff', foreground: '#2b2b2b', cursor: '#2b2b2b', selectionBackground: '#2563eb33', black: '#000000', brightBlack: '#666666' }
    : {
        background: '#181818',
        foreground: '#d6d6d6',
        cursor: '#e6e6e6',
        selectionBackground: '#3e8bff44',
        black: '#1e1e1e',
        red: '#f2655d',
        green: '#3fb950',
        yellow: '#e3b341',
        blue: '#5a9cff',
        magenta: '#c792ea',
        cyan: '#56d4dd',
        white: '#d6d6d6',
        brightBlack: '#6e7681',
        brightRed: '#ff8f88',
        brightGreen: '#6fdd8b',
        brightYellow: '#f2cc60',
        brightBlue: '#82aaff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#89ddff',
        brightWhite: '#ffffff',
      };
}

function getInstance(id, settings) {
  let inst = instances.get(id);
  if (inst) return inst;
  const term = new Terminal({
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
    fontSize: settings?.terminal?.fontSize || 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: themeFor(settings?.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)));
  term.onData((d) => api.termWrite(id, d));
  term.onResize(({ cols, rows }) => api.termResize(id, cols, rows));
  // Copy on Ctrl+Shift+C / paste on Ctrl+Shift+V (and Ctrl+C copies when there is a selection).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (mod && e.code === 'KeyV') {
      navigator.clipboard.readText().then((t) => t && term.paste(t));
      return false;
    }
    return true;
  });
  const el = document.createElement('div');
  el.style.height = '100%';
  inst = { term, fit, el, opened: false };
  instances.set(id, inst);
  return inst;
}

on('term:data', (id, data) => {
  const inst = instances.get(id);
  if (inst) inst.term.write(data);
  else {
    // Data can arrive before React mounts the terminal; buffer it.
    const pending = (window.__termPending ||= new Map());
    pending.set(id, (pending.get(id) || '') + data);
  }
});
on('term:exit', (id) => {
  const inst = instances.get(id);
  if (inst) {
    inst.term.dispose();
    instances.delete(id);
  }
});

export default function TerminalPanel() {
  const terminals = useStore((s) => s.terminals);
  const active = useStore((s) => s.activeTerminal);
  const height = useStore((s) => s.layout.panelHeight);
  const settings = useStore((s) => s.settings);
  const hostRef = useRef(null);
  const st = useStore.getState;

  useEffect(() => {
    if (!terminals.length) st().newTerminal();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || active == null) return;
    const inst = getInstance(active, settings);
    host.innerHTML = '';
    host.appendChild(inst.el);
    if (!inst.opened) {
      inst.term.open(inst.el);
      inst.opened = true;
      const pending = window.__termPending?.get(active);
      if (pending) {
        inst.term.write(pending);
        window.__termPending.delete(active);
      }
    }
    const doFit = () => {
      try {
        inst.fit.fit();
      } catch {}
    };
    requestAnimationFrame(() => {
      doFit();
      inst.term.focus();
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);
    return () => ro.disconnect();
  }, [active]);

  useEffect(() => {
    for (const inst of instances.values()) {
      inst.term.options.theme = themeFor(settings?.theme);
      inst.term.options.fontSize = settings?.terminal?.fontSize || 13;
    }
  }, [settings?.theme, settings?.terminal?.fontSize]);

  return (
    <div className="panel" style={{ height }}>
      <div className="panel-header">
        {terminals.map((t) => (
          <div key={t.id} className={`panel-tab ${t.id === active ? 'active' : ''}`} onClick={() => useStore.setState({ activeTerminal: t.id })}>
            <SquareTerminal size={13} />
            <span>
              {t.title} {terminals.length > 1 ? t.n : ''}
            </span>
            <X
              size={12}
              onClick={(e) => {
                e.stopPropagation();
                st().killTerminal(t.id);
              }}
            />
          </div>
        ))}
        <div className="spacer" />
        <button className="icon-btn sm" title="New Terminal (Ctrl+Shift+`)" onClick={() => st().newTerminal()}>
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Kill Terminal" onClick={() => st().killTerminal()}>
          <Trash2 size={13} />
        </button>
        <button className="icon-btn sm" title="Hide Panel (Ctrl+J)" onClick={() => st().setLayout({ panel: false })}>
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="panel-body">
        <div className="term-host" ref={hostRef} />
      </div>
    </div>
  );
}
