import { useEffect, useRef, useState } from 'react';
import { X, ChevronRight, FolderOpen, FilePlus2, Bot, KeyRound } from 'lucide-react';
import { monaco, monacoTheme, languageLabel } from '../lib/monaco';
import { useStore, setActiveEditor } from '../lib/store';
import * as models from '../lib/editorModels';
import { installInlineEdit } from '../lib/inlineEdit';
import { registerAutocomplete } from '../lib/autocomplete';
import { addSelectionToChat, formatKeys, runCommand } from '../lib/commands';
import { FileIcon } from '../lib/fileIcons.jsx';
import { basename, relative, dirname } from '../lib/paths';
import { api } from '../lib/api';
import Logo from './Logo.jsx';

function editorOptions(settings) {
  const e = settings?.editor || {};
  return {
    fontSize: e.fontSize || 14,
    fontFamily: e.fontFamily,
    fontLigatures: true,
    tabSize: e.tabSize || 2,
    wordWrap: e.wordWrap || 'off',
    minimap: { enabled: e.minimap !== false, renderCharacters: false, maxColumn: 100, scale: 1 },
  };
}

export default function EditorArea() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const settings = useStore((s) => s.settings);
  const root = useStore((s) => s.root);
  const hostRef = useRef(null);
  const diffHostRef = useRef(null);
  const editorRef = useRef(null);
  const diffRef = useRef(null);
  const currentKey = useRef(null);
  const diffOriginals = useRef(new Map());

  const tab = tabs.find((t) => t.id === activeTab) || null;

  // Create the editor once.
  useEffect(() => {
    const ed = monaco.editor.create(hostRef.current, {
      model: null,
      theme: monacoTheme(settings?.theme),
      automaticLayout: true,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      scrollBeyondLastLine: true,
      padding: { top: 6 },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      inlineSuggest: { enabled: true, showToolbar: 'onHover' },
      suggest: { preview: true },
      fixedOverflowWidgets: true,
      mouseWheelZoom: true,
      ...editorOptions(settings),
    });
    editorRef.current = ed;
    setActiveEditor(ed);
    installInlineEdit(ed);
    registerAutocomplete();

    ed.addAction({
      id: 'pointer.addToChat',
      label: 'Add Selection to Chat',
      contextMenuGroupId: '0_ai',
      contextMenuOrder: 2,
      run: () => addSelectionToChat(),
    });

    let cursorTimer = null;
    ed.onDidChangeCursorSelection(() => {
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!sel || !model) return;
        useStore.setState({
          cursor: {
            line: sel.positionLineNumber,
            col: sel.positionColumn,
            selected: sel.isEmpty() ? 0 : model.getValueLengthInRange(sel),
          },
        });
      }, 60);
    });
    ed.onDidChangeModel(() => {
      const model = ed.getModel();
      if (!model) return;
      useStore.setState({
        editorInfo: {
          language: languageLabel(model.getLanguageId()),
          languageId: model.getLanguageId(),
          eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
          tabSize: model.getOptions().tabSize,
          insertSpaces: model.getOptions().insertSpaces,
        },
      });
    });
    return () => {
      ed.dispose();
      diffRef.current?.dispose();
      setActiveEditor(null);
    };
  }, []);

  // Apply settings changes.
  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(settings));
    diffRef.current?.updateOptions({ ...editorOptions(settings), minimap: { enabled: false } });
  }, [settings?.editor]);

  // Switch the editor model when the active tab changes.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (currentKey.current) {
      const prev = models.getEntry(currentKey.current);
      if (prev && ed.getModel() === prev.model) prev.viewState = ed.saveViewState();
    }
    if (!tab || tab.kind !== 'text') {
      currentKey.current = null;
      if (!tab) ed.setModel(null);
      return;
    }
    const entry = models.getEntry(tab.id);
    if (!entry) return;
    if (ed.getModel() !== entry.model) {
      ed.setModel(entry.model);
      if (entry.viewState) ed.restoreViewState(entry.viewState);
    }
    currentKey.current = tab.id;
    requestAnimationFrame(() => ed.focus());
  }, [tab?.id, tab?.kind]);

  // Diff (review) tabs.
  useEffect(() => {
    if (!tab || tab.kind !== 'diff') return;
    let cancelled = false;
    (async () => {
      const res = await models.openModel(tab.path).catch(() => null);
      if (cancelled || !res || res.kind !== 'text') return;
      if (!diffRef.current) {
        diffRef.current = monaco.editor.createDiffEditor(diffHostRef.current, {
          theme: monacoTheme(settings?.theme),
          automaticLayout: true,
          renderSideBySide: true,
          originalEditable: false,
          ignoreTrimWhitespace: false,
          renderOverviewRuler: true,
          ...editorOptions(settings),
          minimap: { enabled: false },
        });
      }
      let original = diffOriginals.current.get(tab.id);
      if (!original) {
        original = monaco.editor.createModel(tab.original ?? '', res.entry.model.getLanguageId());
        diffOriginals.current.set(tab.id, original);
      }
      diffRef.current.setModel({ original, modified: res.entry.model });
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.id]);

  // Dispose original models of closed diff tabs.
  useEffect(() => {
    for (const [id, m] of diffOriginals.current) {
      if (!tabs.find((t) => t.id === id)) {
        if (diffRef.current?.getModel()?.original === m) diffRef.current.setModel(null);
        m.dispose();
        diffOriginals.current.delete(id);
      }
    }
  }, [tabs]);

  const showEditor = tab?.kind === 'text';
  const showDiff = tab?.kind === 'diff';

  return (
    <div className="editor-area">
      {tabs.length > 0 && <TabBar />}
      {tab && tab.path && (
        <div className="breadcrumbs">
          {(relative(root, tab.path) || tab.path)
            .split(/[\\/]/)
            .filter(Boolean)
            .map((part, i, arr) => (
              <span key={i} className="row" style={{ gap: 4 }}>
                {i === arr.length - 1 && <FileIcon name={part} size={13} />}
                <span className="crumb">{part}</span>
                {i < arr.length - 1 && <ChevronRight size={12} />}
              </span>
            ))}
          {tab.kind === 'diff' && <span className="badge-pill" style={{ marginLeft: 8 }}>{tab.label || 'Agent changes'} — left: before, right: now</span>}
        </div>
      )}
      <div className="editor-host">
        <div className="mount" ref={hostRef} style={{ visibility: showEditor ? 'visible' : 'hidden' }} />
        <div className="mount" ref={diffHostRef} style={{ visibility: showDiff ? 'visible' : 'hidden' }} />
        {tab?.kind === 'image' && (
          <div className="preview-pane">
            <img src={tab.dataUrl} alt={tab.title} />
            <div className="faint">{tab.path}</div>
          </div>
        )}
        {(tab?.kind === 'binary' || tab?.kind === 'tooLarge') && (
          <div className="preview-pane">
            <div>{tab.kind === 'binary' ? 'This file is binary and cannot be displayed.' : 'This file is too large to open in the editor.'}</div>
            <button className="btn" onClick={() => api.openPath(tab.path)}>
              Open with default app
            </button>
          </div>
        )}
        {!tab && <Welcome />}
      </div>
    </div>
  );
}

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const dirty = useStore((s) => s.dirty);
  const st = useStore.getState;
  const [dragOver, setDragOver] = useState(null);
  const barRef = useRef(null);

  useEffect(() => {
    const el = barRef.current?.querySelector('.tab.active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  return (
    <div
      className="tabbar"
      ref={barRef}
      onWheel={(e) => {
        if (barRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) barRef.current.scrollLeft += e.deltaY;
      }}
      onDoubleClick={(e) => e.target === e.currentTarget && st().newUntitled()}
    >
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTab ? 'active' : ''} ${dirty[t.id] || (t.kind === 'diff' && dirty[t.path]) ? 'dirty' : ''} ${dragOver === t.id ? 'drag-over' : ''}`}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              st().closeTab(t.id);
            } else if (e.button === 0) st().setActiveTab(t.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            st().showContextMenu(e.clientX, e.clientY, [
              { label: 'Close', keys: 'mod+w', onClick: () => st().closeTab(t.id) },
              { label: 'Close Others', onClick: () => st().closeOtherTabs(t.id) },
              { label: 'Close All', onClick: () => st().closeAllTabs() },
              { sep: true },
              ...(t.path
                ? [
                    { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(t.path) },
                    { label: 'Reveal in Explorer', onClick: () => st().revealInTree(t.path).then(() => st().setLayout({ sidebar: true, sidebarView: 'explorer' })) },
                  ]
                : []),
            ]);
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-pointer-tab', t.id);
            if (t.path) e.dataTransfer.setData('application/x-pointer-path', t.path);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-pointer-tab')) {
              e.preventDefault();
              setDragOver(t.id);
            }
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            const from = e.dataTransfer.getData('application/x-pointer-tab');
            setDragOver(null);
            if (from) st().moveTab(from, t.id);
          }}
          title={t.path || t.title}
        >
          <FileIcon name={t.path || t.title} size={14} />
          <span className="title" style={t.kind === 'diff' ? { fontStyle: 'italic' } : undefined}>
            {t.title}
          </span>
          <button
            className="close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              st().closeTab(t.id);
            }}
          >
            <span className="dot" />
            <X className="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Welcome() {
  const recent = useStore((s) => s.recent);
  const root = useStore((s) => s.root);
  const keys = useStore((s) => s.keys);
  const st = useStore.getState;
  const noKeys = !keys.google.set && !keys.groq.set;

  const shortcuts = [
    ['mod+i', 'Open the AI agent'],
    ['mod+k', 'Edit code with AI (in editor)'],
    ['mod+l', 'Add selection to chat'],
    ['mod+p', 'Go to file'],
    ['mod+shift+p', 'Command palette'],
    ['mod+j', 'Toggle terminal'],
    ['tab', 'Accept AI autocomplete'],
  ];

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>
          <Logo size={40} /> Pointer
        </h1>
        <div className="sub">The AI code editor — powered by Google Gemini and Groq.</div>
        {noKeys && (
          <div className="warning-box" style={{ cursor: 'pointer' }} onClick={() => st().openOverlay('settings', 'models')}>
            <KeyRound size={15} style={{ flexShrink: 0 }} />
            <div>
              <b>Add an API key to start.</b> Paste a Google AI Studio key (new <code>AQ.</code> keys work) and/or a Groq key in Settings → Models.
            </div>
          </div>
        )}
        <div className="welcome-actions">
          <button className="welcome-card" onClick={() => st().openFolder()}>
            <FolderOpen size={18} />
            <div>Open Folder</div>
            <div className="k">{formatKeys('mod+o')}</div>
          </button>
          <button className="welcome-card" onClick={() => st().newUntitled()}>
            <FilePlus2 size={18} />
            <div>New File</div>
            <div className="k">{formatKeys('mod+n')}</div>
          </button>
          <button className="welcome-card" onClick={() => runCommand('ai.focusChat')}>
            <Bot size={18} />
            <div>Ask the Agent</div>
            <div className="k">{formatKeys('mod+i')}</div>
          </button>
        </div>
        {!root && recent.length > 0 && (
          <div className="welcome-section">
            <h3>Recent folders</h3>
            {recent.slice(0, 6).map((p) => (
              <div key={p} className="recent-item" onClick={() => st().openFolder(p)}>
                <FolderOpen size={14} className="muted" />
                <span>{basename(p)}</span>
                <span className="path">{dirname(p)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="welcome-section">
          <h3>Shortcuts</h3>
          <div className="shortcut-grid">
            {shortcuts.map(([k, d]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span>
                  <kbd>{formatKeys(k)}</kbd>
                </span>
                <span>{d}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
