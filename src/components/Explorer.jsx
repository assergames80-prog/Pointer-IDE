import { useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  ChevronsDownUp,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  Trash2,
  Copy,
  ExternalLink,
  TerminalSquare,
} from 'lucide-react';
import { useStore } from '../lib/store';
import { useChat } from '../lib/chat';
import { api, getPathForFile, isWin } from '../lib/api';
import { basename, dirname, join, relative, samePath, isInside } from '../lib/paths';
import { FileIcon, FolderIcon } from '../lib/fileIcons.jsx';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', 'coverage']);

function useRows() {
  const root = useStore((s) => s.root);
  const dirCache = useStore((s) => s.dirCache);
  const expanded = useStore((s) => s.expanded);
  return useMemo(() => {
    const rows = [];
    if (!root) return rows;
    const walk = (dir, depth) => {
      const entries = dirCache[dir];
      if (!entries) {
        if (depth > 0) rows.push({ loading: true, path: dir + '::loading', depth });
        return;
      }
      for (const e of entries) {
        rows.push({ ...e, depth });
        if (e.isDir && expanded[e.path]) walk(e.path, depth + 1);
      }
    };
    walk(root, 0);
    return rows;
  }, [root, dirCache, expanded]);
}

export default function Explorer() {
  const root = useStore((s) => s.root);
  const recent = useStore((s) => s.recent);
  const expanded = useStore((s) => s.expanded);
  const selected = useStore((s) => s.selectedPath);
  const activeTab = useStore((s) => s.activeTab);
  const dirty = useStore((s) => s.dirty);
  const st = useStore.getState;
  const rows = useRows();
  const treeRef = useRef(null);
  const [dropTarget, setDropTarget] = useState(null);

  if (!root) {
    return (
      <>
        <div className="pane-header">
          <span className="title">Explorer</span>
        </div>
        <div className="empty-pane">
          <div>You have not opened a folder yet.</div>
          <button className="btn primary" onClick={() => st().openFolder()}>
            <FolderOpen size={14} /> Open Folder
          </button>
          {recent.length > 0 && (
            <>
              <div className="faint" style={{ marginTop: 8, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Recent
              </div>
              {recent.slice(0, 8).map((p) => (
                <div key={p} className="recent-item" style={{ padding: '3px 4px' }} onClick={() => st().openFolder(p)} title={p}>
                  <FolderIcon />
                  <span className="ellipsis">{basename(p)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </>
    );
  }

  const select = (p) => useStore.setState({ selectedPath: p });
  const targetDir = () => {
    const sel = selected && rows.find((r) => r.path === selected);
    if (!sel) return root;
    return sel.isDir ? sel.path : dirname(sel.path);
  };

  const onRowClick = (row) => {
    select(row.path);
    if (row.isDir) st().toggleDir(row.path);
    else st().openFile(row.path);
  };

  const menuFor = (row, e) => {
    e.preventDefault();
    e.stopPropagation();
    select(row?.path || null);
    const isDir = row ? row.isDir : true;
    const path = row ? row.path : root;
    const dir = isDir ? path : dirname(path);
    const items = [];
    if (isDir) {
      items.push({ label: 'New File…', icon: FilePlus2, onClick: () => st().createFileIn(dir) });
      items.push({ label: 'New Folder…', icon: FolderPlus, onClick: () => st().createFileIn(dir, true) });
      items.push({ label: 'Open in Terminal', icon: TerminalSquare, onClick: () => openTerminalAt(dir) });
      items.push({ sep: true });
    } else {
      items.push({ label: 'Open', onClick: () => st().openFile(path) });
    }
    items.push({ label: 'Add to Chat', icon: MessageSquarePlus, onClick: () => addToChat(path) });
    items.push({ sep: true });
    items.push({ label: isWin ? 'Reveal in File Explorer' : 'Reveal in File Manager', icon: ExternalLink, onClick: () => api.reveal(path) });
    items.push({ label: 'Copy Path', icon: Copy, onClick: () => navigator.clipboard.writeText(path) });
    items.push({ label: 'Copy Relative Path', onClick: () => navigator.clipboard.writeText(relative(root, path) || '.') });
    if (row) {
      items.push({ sep: true });
      items.push({ label: 'Rename…', icon: Pencil, keys: 'f2', onClick: () => st().renamePath(path) });
      items.push({ label: 'Delete', icon: Trash2, danger: true, hint: 'Del', onClick: () => st().deletePath(path) });
    }
    st().showContextMenu(e.clientX, e.clientY, items);
  };

  const onKeyDown = (e) => {
    const idx = rows.findIndex((r) => r.path === selected);
    const row = rows[idx];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, idx + 1)];
      if (next && !next.loading) select(next.path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(0, idx - 1)];
      if (prev && !prev.loading) select(prev.path);
    } else if (e.key === 'ArrowRight' && row?.isDir) {
      e.preventDefault();
      if (!expanded[row.path]) st().toggleDir(row.path, true);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.isDir && expanded[row.path]) st().toggleDir(row.path, false);
      else if (!samePath(dirname(row.path), root)) select(dirname(row.path));
    } else if (e.key === 'Enter' && row) {
      e.preventDefault();
      onRowClick(row);
    } else if (e.key === 'F2' && row) {
      e.preventDefault();
      st().renamePath(row.path);
    } else if (e.key === 'Delete' && row) {
      e.preventDefault();
      st().deletePath(row.path);
    }
  };

  // Drag & drop: move inside the tree, or copy files dropped from the OS.
  const onDragStart = (row, e) => {
    e.dataTransfer.setData('application/x-pointer-path', row.path);
    e.dataTransfer.setData('text/plain', row.path);
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const onDrop = async (row, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const destDir = row ? (row.isDir ? row.path : dirname(row.path)) : root;
    const internal = e.dataTransfer.getData('application/x-pointer-path');
    try {
      if (internal) {
        if (samePath(dirname(internal), destDir) || samePath(internal, destDir) || isInside(internal, destDir)) return;
        await api.rename(internal, join(destDir, basename(internal)));
        await st().loadDir(dirname(internal));
      } else {
        for (const f of e.dataTransfer.files) {
          const p = getPathForFile(f);
          if (p) await api.copy(p, join(destDir, basename(p)));
        }
      }
      await st().loadDir(destDir);
      st().toggleDir(destDir, true);
      st().invalidateFileList();
    } catch (err) {
      st().toast(err.message, 'error');
    }
  };

  return (
    <>
      <div className="pane-header">
        <span className="title" title={root}>
          {basename(root)}
        </span>
        <div className="actions">
          <button className="icon-btn sm" title="New File" onClick={() => st().createFileIn(targetDir())}>
            <FilePlus2 size={14} />
          </button>
          <button className="icon-btn sm" title="New Folder" onClick={() => st().createFileIn(targetDir(), true)}>
            <FolderPlus size={14} />
          </button>
          <button
            className="icon-btn sm"
            title="Refresh"
            onClick={() => {
              for (const d of [root, ...Object.keys(expanded)]) st().loadDir(d);
              st().invalidateFileList();
            }}
          >
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn sm" title="Collapse All" onClick={() => st().collapseAll()}>
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
      <div
        className="tree"
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => menuFor(null, e)}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(root);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => onDrop(null, e)}
      >
        {rows.map((row) => {
          if (row.loading) {
            return (
              <div key={row.path} className="tree-row faint" style={{ paddingLeft: 8 + row.depth * 12 + 18 }}>
                Loading…
              </div>
            );
          }
          const isOpen = row.isDir && expanded[row.path];
          const isActive = !row.isDir && activeTab === row.path;
          return (
            <div
              key={row.path}
              className={`tree-row ${selected === row.path ? 'selected' : ''} ${isActive ? 'active-file' : ''} ${IGNORED.has(row.name) ? 'ignored' : ''} ${dropTarget === row.path ? 'drop-target' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              onClick={() => onRowClick(row)}
              onContextMenu={(e) => menuFor(row, e)}
              draggable
              onDragStart={(e) => onDragStart(row, e)}
              onDragOver={(e) => {
                if (!row.isDir) return;
                e.preventDefault();
                e.stopPropagation();
                setDropTarget(row.path);
              }}
              onDrop={(e) => onDrop(row, e)}
              title={row.path}
            >
              {Array.from({ length: row.depth }, (_, i) => (
                <span key={i} className="tree-guide" style={{ left: 15 + i * 12 }} />
              ))}
              <span className="chev">{row.isDir ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
              {row.isDir ? <FolderIcon open={isOpen} /> : <FileIcon name={row.name} />}
              <span className={`name ${dirty[row.path] ? 'dirty' : ''}`}>{row.name}</span>
            </div>
          );
        })}
        {rows.length === 0 && <div className="empty-pane">This folder is empty.</div>}
      </div>
    </>
  );
}

function addToChat(path) {
  useStore.getState().setLayout({ chat: true });
  useChat.getState().addFileToDraft(path);
  useChat.getState().focusComposer();
}

async function openTerminalAt(dir) {
  const { api: a } = await import('../lib/api');
  const st = useStore.getState();
  const { id, shell } = await a.termCreate({ cwd: dir });
  useStore.setState((s) => ({
    terminals: [...s.terminals, { id, title: shell?.split(' ')[0] || 'terminal', n: s.terminals.length + 1, cwd: dir }],
    activeTerminal: id,
    layout: { ...s.layout, panel: true },
  }));
  st.setLayout({ panel: true });
}
