import { useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  Plus,
  History,
  X,
  ArrowUp,
  Square,
  AtSign,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  Search,
  Globe,
  SquareTerminal,
  Trash2,
  ExternalLink,
  GitCompare,
  Undo2,
  Brain,
  Loader2,
  AlertTriangle,
  CornerDownLeft,
  Pencil,
  RotateCcw,
  ArrowRightLeft,
  Activity,
  Infinity as InfinityIcon,
  MessageCircleQuestion,
  KeyRound,
  Sparkles,
  TextSelect,
  Settings2,
} from 'lucide-react';
import { useStore } from '../lib/store';
import { useChat } from '../lib/chat';
import { api, getPathForFile } from '../lib/api';
import { basename, dirname, relative } from '../lib/paths';
import { FileIcon } from '../lib/fileIcons.jsx';
import { Menu } from './Overlays.jsx';
import Markdown from './Markdown.jsx';
import { fuzzyScore } from './QuickOpen.jsx';

export function modelLabel(sel) {
  if (!sel) return '';
  const models = useStore.getState().models;
  return models[sel.provider]?.find((m) => m.id === sel.model)?.label || sel.model;
}

export default function ChatPanel() {
  const width = useStore((s) => s.layout.chatWidth);
  const chat = useChat((s) => s.chats.find((c) => c.id === s.activeChatId) || s.chats[0]);
  const running = useChat((s) => Object.values(s.runs).some((r) => r.chatId === chat?.id));
  const [showHistory, setShowHistory] = useState(false);
  const chatApi = useChat.getState;

  if (!chat) return null;
  return (
    <div className="chat" style={{ width }}>
      <div className="chat-header">
        <span className="chat-title" title={chat.title}>
          {chat.messages.length ? chat.title : 'New chat'}
        </span>
        <button className="icon-btn sm" title="New Chat (Ctrl+Shift+L)" onClick={() => chatApi().newChat()}>
          <Plus size={15} />
        </button>
        <button className={`icon-btn sm ${showHistory ? 'active' : ''}`} title="Chat History" onClick={() => setShowHistory((v) => !v)}>
          <History size={14} />
        </button>
        <button className="icon-btn sm" title="Close (Ctrl+Alt+B)" onClick={() => useStore.getState().setLayout({ chat: false })}>
          <X size={15} />
        </button>
      </div>
      {showHistory && <HistoryList onClose={() => setShowHistory(false)} />}
      <MessageList chat={chat} running={running} />
      <Composer running={running} chatId={chat.id} />
    </div>
  );
}

function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

function HistoryList({ onClose }) {
  const chats = useChat((s) => s.chats);
  const activeId = useChat((s) => s.activeChatId);
  const [q, setQ] = useState('');
  const list = chats.filter((c) => c.messages.length && c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="history-list">
      <div style={{ padding: '8px 10px 2px' }}>
        <input className="input" placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Escape' && onClose()} />
      </div>
      <div className="items">
        {list.length === 0 && <div className="empty-pane">No previous chats.</div>}
        {list.map((c) => (
          <div
            key={c.id}
            className={`history-item ${c.id === activeId ? 'active' : ''}`}
            onClick={() => {
              useChat.getState().selectChat(c.id);
              onClose();
            }}
          >
            <span className="t">{c.title}</span>
            <span className="d">{timeAgo(c.updatedAt || c.createdAt)}</span>
            <button
              className="icon-btn sm"
              title="Delete chat"
              onClick={(e) => {
                e.stopPropagation();
                useChat.getState().deleteChat(c.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- messages

function MessageList({ chat, running }) {
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const messages = chat.messages;
  const root = useStore((s) => s.root);

  const toolResults = useMemo(() => {
    const m = new Map();
    for (const msg of messages) if (msg.role === 'tool') m.set(msg.toolCallId, msg);
    return m;
  }, [messages]);

  // Index of the last message of each run, to place the "files changed" summary.
  const runEnds = useMemo(() => {
    const ends = new Map();
    messages.forEach((m, i) => m.runId && ends.set(m.runId, i));
    return ends;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  if (!messages.length) return <EmptyChat root={root} />;

  const activeRunId = useChat.getState().runIdFor(chat.id);
  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      {messages.map((m, i) => {
        let node = null;
        if (m.role === 'user') node = <UserMessage key={m.id} msg={m} running={running} />;
        else if (m.role === 'assistant') node = <AssistantMessage key={m.id} msg={m} toolResults={toolResults} chatId={chat.id} />;
        else if (m.role === 'notice')
          node = (
            <div key={m.id} className="msg-notice">
              {m.content}
            </div>
          );
        else if (m.role === 'error') node = <ErrorMessage key={m.id} msg={m} />;
        const showSummary = m.runId && runEnds.get(m.runId) === i && m.runId !== activeRunId;
        return (
          <div key={m.id}>
            {node}
            {showSummary && <RunSummary chat={chat} runId={m.runId} />}
          </div>
        );
      })}
      {running && <RunningIndicator chat={chat} />}
    </div>
  );
}

function RunningIndicator({ chat }) {
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'assistant' && last.streaming) return null;
  return (
    <div className="msg row muted" style={{ fontSize: 12 }}>
      <Loader2 size={13} className="spin" />
      <span className="shimmer">{last?.role === 'tool' ? 'Working…' : 'Thinking…'}</span>
    </div>
  );
}

function EmptyChat({ root }) {
  const keys = useStore((s) => s.keys);
  const noKeys = !keys.google.set && !keys.groq.set;
  const send = (t) => useChat.getState().send(t);
  const suggestions = root
    ? ['Explain how this project is structured', 'Find and fix bugs in the current file', 'Add tests for the main module and run them', 'Write a README for this project']
    : ['Create a new Vite + React app in a folder of my choice', 'Write a Python script that renames photos by date', 'Explain the difference between let, const and var'];
  return (
    <div className="chat-scroll">
      <div className="chat-empty">
        <div className="hero">
          <Sparkles size={22} />
        </div>
        <h2>Pointer Agent</h2>
        <div style={{ maxWidth: 300, fontSize: 12.5 }}>
          Ask anything about your code, or describe a task — the agent reads and edits files and runs commands on your machine.
        </div>
        {noKeys ? (
          <button className="btn primary" onClick={() => useStore.getState().openOverlay('settings', 'models')} style={{ marginTop: 6 }}>
            <KeyRound size={14} /> Add an API key
          </button>
        ) : (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={s} className="suggestion" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextChips({ context, root }) {
  if (!context) return null;
  const files = context.files || [];
  if (!files.length && !context.selection && !context.activeFile) return null;
  return (
    <div className="chips" style={{ padding: 0 }}>
      {context.selection && (
        <span className="chip" title={context.selection.text.slice(0, 500)}>
          <TextSelect size={12} />
          {basename(context.selection.path)} ({context.selection.startLine}-{context.selection.endLine})
        </span>
      )}
      {files.map((f) => (
        <span key={f} className="chip" title={f}>
          <FileIcon name={f} size={12} />
          <span className="ellipsis">{basename(f)}</span>
        </span>
      ))}
      {context.activeFile && !files.includes(context.activeFile) && (
        <span className="chip muted-chip" title={`Current file: ${context.activeFile}`}>
          <FileIcon name={context.activeFile} size={12} />
          <span className="ellipsis">{relative(root, context.activeFile) || basename(context.activeFile)}</span>
        </span>
      )}
    </div>
  );
}

function UserMessage({ msg, running }) {
  const root = useStore((s) => s.root);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(msg.content);
  if (editing) {
    return (
      <div className="msg">
        <div className="composer">
          <textarea
            value={text}
            autoFocus
            rows={Math.min(10, text.split('\n').length + 1)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                setEditing(false);
                useChat.getState().retryFrom(msg.id, text);
              }
            }}
          />
          <div className="composer-bar">
            <span className="faint" style={{ fontSize: 11, paddingLeft: 6 }}>
              Resending discards the messages after this one.
            </span>
            <div className="spacer" />
            <button className="btn sm ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn sm primary"
              onClick={() => {
                setEditing(false);
                useChat.getState().retryFrom(msg.id, text);
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-user">
      {msg.context && (msg.context.files?.length || msg.context.selection) ? (
        <div className="chips" style={{ padding: '0 0 6px' }}>
          <ContextChips context={{ ...msg.context, activeFile: null }} root={root} />
        </div>
      ) : null}
      {msg.content}
      {!running && (
        <div className="msg-actions">
          <button className="icon-btn sm" title="Edit and resend" onClick={() => setEditing(true)}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn sm" title="Retry" onClick={() => useChat.getState().retryFrom(msg.id)}>
            <RotateCcw size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorMessage({ msg }) {
  const open = useStore((s) => s.openOverlay);
  return (
    <div className="msg-error">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{msg.content}</span>
      </div>
      {(msg.code === 'no_key' || /api key/i.test(msg.content)) && (
        <div>
          <button className="btn sm" onClick={() => open('settings', 'models')}>
            <KeyRound size={12} /> Open API key settings
          </button>
        </div>
      )}
    </div>
  );
}

const AssistantMessage = memo(function AssistantMessage({ msg, toolResults, chatId }) {
  const calls = msg.toolCalls || [];
  const waiting = msg.streaming && !msg.content && !msg.thinking && !calls.length;
  return (
    <div className="msg msg-assistant">
      {msg.thinking && <Thinking text={msg.thinking} ms={msg.thinkingMs} active={msg.streaming && !msg.content && !calls.length} />}
      {msg.content && <Markdown text={msg.content} streaming={msg.streaming} />}
      {waiting && (
        <div className="row muted" style={{ fontSize: 12 }}>
          <Loader2 size={13} className="spin" />
          <span className="shimmer">{msg.status || 'Thinking…'}</span>
        </div>
      )}
      {msg.status && !waiting && <div className="msg-meta">{msg.status}</div>}
      {calls.map((c) => (
        <ToolCall key={c.id} call={c} result={toolResults.get(c.id)} runId={msg.runId} chatId={chatId} />
      ))}
      {msg.aborted && <div className="msg-meta">Stopped.</div>}
    </div>
  );
});

function Thinking({ text, ms, active }) {
  const [open, setOpen] = useState(false);
  const label = active ? 'Thinking' : ms ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s` : 'Thought';
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Brain size={13} />
        <span className={active ? 'shimmer' : ''}>{label}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </summary>
      <div className="body">{text}</div>
    </details>
  );
}

// ------------------------------------------------------------------------------- tool calls

function useToolStatus(call, result) {
  const s = useChat((st) => st.toolState[call.id]?.status);
  if (result) return result.rejected ? 'rejected' : result.isError ? 'error' : 'done';
  return s || 'cancelled';
}

function displayPath(p) {
  const root = useStore.getState().root;
  if (!p || p === '.' || p === './') return './';
  const rel = relative(root, p);
  if (rel === '' && root) return './';
  return rel || p;
}

function Spinner() {
  return <Loader2 size={13} className="spin" style={{ flexShrink: 0 }} />;
}

function ToolLine({ icon: Icon, children, onClick, status, expandable, expanded, onToggle, error }) {
  return (
    <div className={`tool-line ${onClick || expandable ? 'clickable' : ''} ${error ? 'error' : ''}`} onClick={expandable ? onToggle : onClick}>
      {status === 'running' || status === 'pending' ? <Spinner /> : <Icon size={13} style={{ flexShrink: 0 }} />}
      <span className="target">{children}</span>
      {expandable && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
    </div>
  );
}

function ToolCall({ call, result, runId, chatId }) {
  const status = useToolStatus(call, result);
  const [expanded, setExpanded] = useState(false);
  const args = call.args || {};
  const ui = result?.ui || {};
  const openFile = useStore((s) => s.openFile);

  if (result?.isError && !['run_command', 'write_file', 'edit_file', 'delete_path'].includes(call.name) && !result.rejected) {
    return (
      <>
        <ToolLine icon={AlertTriangle} error expandable expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
          {call.name.replace(/_/g, ' ')} failed: {(result.ui?.message || result.content || '').slice(0, 140)}
        </ToolLine>
        {expanded && <div className="tool-expand mono">{result.content}</div>}
      </>
    );
  }

  switch (call.name) {
    case 'read_file': {
      const p = ui.path || args.path;
      const range = ui.startLine ? (ui.endLine >= ui.totalLines && ui.startLine === 1 ? '' : ` L${ui.startLine}-${ui.endLine}`) : args.start_line ? ` L${args.start_line}-${args.end_line || ''}` : '';
      return (
        <ToolLine icon={FileText} status={status} onClick={() => ui.path && openFile(ui.path, { line: ui.startLine })}>
          {status === 'done' ? 'Read ' : 'Reading '}
          <b>{basename(p || '')}</b>
          <span className="faint">{range}</span>
        </ToolLine>
      );
    }
    case 'list_dir':
      return (
        <>
          <ToolLine icon={FolderTree} status={status} expandable={!!result} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
            {status === 'done' ? 'Listed ' : 'Listing '}
            <b>{displayPath(ui.path || args.path)}</b>
          </ToolLine>
          {expanded && result && <div className="tool-expand mono">{result.content}</div>}
        </>
      );
    case 'search_text':
    case 'find_files':
      return (
        <>
          <ToolLine icon={Search} status={status} expandable={!!result} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
            {status === 'done' ? (call.name === 'search_text' ? 'Searched ' : 'Found files for ') : 'Searching '}
            <b>“{args.pattern}”</b>
            {result && (
              <span className="faint">
                {' '}
                · {ui.count ?? 0} {call.name === 'search_text' ? 'matches' : 'files'}
              </span>
            )}
          </ToolLine>
          {expanded && result && <div className="tool-expand mono">{result.content}</div>}
        </>
      );
    case 'web_fetch':
      return (
        <>
          <ToolLine icon={Globe} status={status} expandable={!!result} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
            {status === 'done' ? 'Fetched ' : 'Fetching '}
            <b>{args.url}</b>
          </ToolLine>
          {expanded && result && <div className="tool-expand mono" style={{ whiteSpace: 'pre-wrap' }}>{result.content.slice(0, 5000)}</div>}
        </>
      );
    case 'process_control':
      return (
        <>
          <ToolLine icon={Activity} status={status} expandable={!!result} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
            {args.action === 'kill' ? 'Stopped' : args.action === 'list' ? 'Listed' : 'Checked'} background process{args.id ? ` #${args.id}` : 'es'}
          </ToolLine>
          {expanded && result && <div className="tool-expand mono">{result.content}</div>}
        </>
      );
    case 'move_path':
      return (
        <ToolLine icon={ArrowRightLeft} status={status}>
          {status === 'done' ? 'Moved ' : 'Moving '}
          <b>{displayPath(args.source)}</b> → <b>{displayPath(args.destination)}</b>
        </ToolLine>
      );
    case 'write_file':
    case 'edit_file':
      return <EditCard call={call} result={result} status={status} runId={runId} chatId={chatId} />;
    case 'delete_path':
      return <DeleteCard call={call} result={result} status={status} runId={runId} />;
    case 'run_command':
      return <CommandCard call={call} result={result} status={status} runId={runId} />;
    default:
      return (
        <ToolLine icon={Settings2} status={status}>
          {call.name}
        </ToolLine>
      );
  }
}

function DiffView({ diff }) {
  const lines = (diff || '').split('\n');
  return (
    <div className="diff mono">
      {lines.map((l, i) => {
        if (l.startsWith('\\')) return null;
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return (
          <div key={i} className={`dl ${cls}`}>
            {l || ' '}
          </div>
        );
      })}
    </div>
  );
}

async function openReview(runId, path) {
  const st = useStore.getState();
  const before = await api.agentCheckpoint(runId, path);
  if (before === undefined) {
    st.toast('The original version is no longer available (kept until Pointer restarts).', 'warning');
    await st.openFile(path);
    return;
  }
  st.openDiffTab({ path, original: before ?? '' });
}

function EditCard({ call, result, status, runId, chatId }) {
  const ui = result?.ui || {};
  const path = ui.path || call.args?.path || '';
  const diffLines = (ui.diff || '').split('\n').length;
  const [open, setOpen] = useState(null);
  const isOpen = open ?? (diffLines <= 40);
  const reverted = useChat((s) => s.chats.find((c) => c.id === chatId)?.runMeta?.[runId]);
  const fileReverted = reverted?.reverted || reverted?.revertedFiles?.includes(ui.path);
  const st = useStore.getState;

  if (result?.isError) {
    return (
      <div className="tool-line error">
        <AlertTriangle size={13} />
        <span className="target">
          Edit to <b>{basename(path)}</b> failed: {(ui.message || result.content).slice(0, 200)}
        </span>
      </div>
    );
  }

  return (
    <div className="tool-card">
      <div className="tool-card-head" onClick={() => result && setOpen(!isOpen)}>
        {status === 'done' ? <FileIcon name={path} size={14} /> : <Spinner />}
        <span className="name">{basename(path)}</span>
        <span className="faint ellipsis" style={{ fontSize: 11.5, minWidth: 0 }}>
          {ui.created ? 'new file' : displayPath(dirname(path))}
        </span>
        <span className="spacer" />
        {result && (
          <span className="stat">
            <span className="add">+{ui.added || 0}</span> <span className="del">-{ui.removed || 0}</span>
          </span>
        )}
        {fileReverted && <span className="badge-pill">reverted</span>}
        {result && (
          <>
            <button
              className="icon-btn sm"
              title="Open file"
              onClick={(e) => {
                e.stopPropagation();
                st().openFile(ui.path);
              }}
            >
              <ExternalLink size={13} />
            </button>
            <button
              className="icon-btn sm"
              title="Review changes (diff)"
              onClick={(e) => {
                e.stopPropagation();
                openReview(runId, ui.path);
              }}
            >
              <GitCompare size={13} />
            </button>
            {!fileReverted && (
              <button
                className="icon-btn sm"
                title="Undo this file's changes from this run"
                onClick={(e) => {
                  e.stopPropagation();
                  useChat.getState().revertRun(chatId, runId, ui.path);
                }}
              >
                <Undo2 size={13} />
              </button>
            )}
          </>
        )}
        {result && (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </div>
      {result && isOpen && ui.diff && (
        <div className="tool-card-body">
          <DiffView diff={ui.diff} />
        </div>
      )}
    </div>
  );
}

function Approval({ runId, toolCallId, label }) {
  const approve = useChat((s) => s.approve);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        approve(runId, toolCallId, 'approve');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runId, toolCallId]);
  return (
    <div className="approval">
      <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} />
      <span className="ellipsis">{label}</span>
      <span className="spacer" />
      <button className="btn sm ghost" onClick={() => approve(runId, toolCallId, 'reject')}>
        Skip
      </button>
      <button className="btn sm" title="Run this and every future command without asking (Settings → Agent)" onClick={() => approve(runId, toolCallId, 'always')}>
        Always allow
      </button>
      <button className="btn sm primary" onClick={() => approve(runId, toolCallId, 'approve')}>
        Run <CornerDownLeft size={11} />
      </button>
    </div>
  );
}

function DeleteCard({ call, result, status, runId }) {
  const path = result?.ui?.path || call.args?.path;
  const toolStatus = useChat((s) => s.toolState[call.id]);
  if (status === 'awaiting' || toolStatus?.status === 'awaiting') {
    return (
      <div className="tool-card">
        <div className="tool-card-head">
          <Trash2 size={13} />
          <span className="name">Delete {displayPath(path)}</span>
        </div>
        <Approval runId={toolStatus?.runId || runId} toolCallId={call.id} label="Allow the agent to delete this?" />
      </div>
    );
  }
  return (
    <ToolLine icon={Trash2} status={status} error={result?.isError && !result?.rejected}>
      {result?.rejected ? 'Skipped deleting ' : status === 'done' ? 'Deleted ' : status === 'error' ? 'Failed to delete ' : 'Deleting '}
      <b>{displayPath(path)}</b>
      {result?.isError && !result.rejected && <span> — {result.ui?.message}</span>}
    </ToolLine>
  );
}

function CommandCard({ call, result, status: baseStatus, runId }) {
  const ts = useChat((s) => s.toolState[call.id]);
  const status = result ? baseStatus : ts?.status || baseStatus;
  const ui = result?.ui || {};
  const live = ts?.output || '';
  const output = result ? ui.output ?? '' : live;
  const [open, setOpen] = useState(true);
  const outRef = useRef(null);
  const root = useStore((s) => s.root);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  let badge = null;
  if (status === 'awaiting') badge = <span className="badge-pill warn">needs approval</span>;
  else if (status === 'running' || status === 'pending') badge = <Spinner />;
  else if (result?.rejected) badge = <span className="badge-pill">skipped</span>;
  else if (status === 'cancelled') badge = <span className="badge-pill">cancelled</span>;
  else if (ui.background) badge = <span className="badge-pill ok">background #{ui.bgId}</span>;
  else if (ui.timedOut) badge = <span className="badge-pill bad">timed out</span>;
  else if (typeof ui.exitCode === 'number') badge = <span className={`badge-pill ${ui.exitCode === 0 ? 'ok' : 'bad'}`}>exit {ui.exitCode}</span>;

  const cwd = call.args?.cwd;
  return (
    <div className="tool-card">
      <div className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <SquareTerminal size={13} />
        <span className="name">{call.args?.background ? 'Background command' : 'Run command'}</span>
        {cwd && (
          <span className="faint ellipsis" style={{ fontSize: 11.5 }}>
            in {relative(root, cwd) || cwd}
          </span>
        )}
        <span className="spacer" />
        {badge}
        {output ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </div>
      <div className="cmd-line mono">
        <span className="prompt">$ </span>
        {call.args?.command}
      </div>
      {open && output && (
        <pre className="cmd-output mono" ref={outRef}>
          {output}
        </pre>
      )}
      {status === 'awaiting' && <Approval runId={ts?.runId || runId} toolCallId={call.id} label="Run this command on your machine?" />}
    </div>
  );
}

function RunSummary({ chat, runId }) {
  const meta = chat.runMeta?.[runId] || {};
  const changes = useMemo(() => {
    const files = new Map();
    for (const m of chat.messages) {
      if (m.role !== 'tool' || m.runId !== runId || m.isError) continue;
      const ui = m.ui || {};
      if (ui.kind === 'edit') {
        const f = files.get(ui.path) || { path: ui.path, added: 0, removed: 0, created: ui.created };
        f.added += ui.added || 0;
        f.removed += ui.removed || 0;
        files.set(ui.path, f);
      } else if (ui.kind === 'delete') files.set(ui.path, { path: ui.path, deleted: true, added: 0, removed: 0 });
    }
    return [...files.values()];
  }, [chat.messages, runId]);
  if (!changes.length) return null;
  const added = changes.reduce((a, f) => a + f.added, 0);
  const removed = changes.reduce((a, f) => a + f.removed, 0);
  return (
    <div className="run-summary">
      <span>
        {changes.length} file{changes.length === 1 ? '' : 's'} changed
      </span>
      <span className="stat mono" style={{ fontSize: 11.5 }}>
        <span className="add">+{added}</span> <span className="del">-{removed}</span>
      </span>
      <span className="spacer" />
      {meta.reverted ? (
        <span className="badge-pill">reverted</span>
      ) : (
        <>
          <button
            className="btn sm ghost"
            onClick={() => {
              for (const f of changes.filter((c) => !c.deleted).slice(0, 6)) openReview(runId, f.path);
            }}
          >
            <GitCompare size={12} /> Review
          </button>
          {meta.hasCheckpoint !== false && (
            <button className="btn sm" onClick={() => useChat.getState().revertRun(chat.id, runId)}>
              <Undo2 size={12} /> Undo all
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- composer

function Composer({ running, chatId }) {
  const draft = useChat((s) => s.draft);
  const mode = useChat((s) => s.mode);
  const focusTick = useChat((s) => s.focusTick);
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const keys = useStore((s) => s.keys);
  const root = useStore((s) => s.root);
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTab));
  const taRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [mention, setMention] = useState(null); // { query, start, items, index }
  const [dragOver, setDragOver] = useState(false);
  const chat = useChat.getState;

  useEffect(() => {
    if (focusTick) taRef.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(240, Math.max(42, ta.scrollHeight)) + 'px';
  }, [draft.text]);

  const activeFile = draft.includeActive && activeTab?.path && activeTab.kind === 'text' ? activeTab.path : null;

  const updateMention = async (text, caret) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) {
      setMention(null);
      return;
    }
    const query = m[2];
    const files = await useStore.getState().getFileList();
    const items = query
      ? files
          .map((f) => [f, fuzzyScore(query, f)])
          .filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([f]) => f)
      : files.slice(0, 12);
    setMention({ query, start: caret - query.length - 1, items, index: 0 });
  };

  const pickMention = (rel) => {
    const st = useStore.getState();
    const abs = st.root ? (st.root.includes('\\') ? `${st.root}\\${rel.replace(/\//g, '\\')}` : `${st.root}/${rel}`) : rel;
    chat().addFileToDraft(abs);
    if (mention) {
      const text = draft.text;
      const caret = taRef.current?.selectionStart ?? text.length;
      chat().setDraft({ text: text.slice(0, mention.start) + text.slice(caret) });
    }
    setMention(null);
    taRef.current?.focus();
  };

  const submit = () => {
    if (running || !draft.text.trim()) return;
    chat().send(draft.text);
  };

  const onKeyDown = (e) => {
    if (mention && mention.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMention((m) => ({ ...m, index: (m.index + d + m.items.length) % m.items.length }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mention.items[mention.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && running) {
      chat().stop(chatId);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const internal = e.dataTransfer.getData('application/x-pointer-path');
    if (internal) chat().addFileToDraft(internal);
    else for (const f of e.dataTransfer.files) {
      const p = getPathForFile(f);
      if (p) chat().addFileToDraft(p);
    }
  };

  const chatModel = settings.chatModel;
  const modelMenu = () => {
    const items = [];
    for (const p of ['google', 'groq']) {
      items.push({ header: p === 'google' ? 'Google Gemini' : 'Groq' });
      for (const m of models[p] || []) {
        items.push({
          label: (chatModel.provider === p && chatModel.model === m.id ? '✓ ' : '   ') + (m.label || m.id),
          hint: !keys[p].set ? 'no key' : undefined,
          onClick: () => useStore.getState().updateSettings({ chatModel: { provider: p, model: m.id } }),
        });
      }
    }
    items.push({ sep: true });
    items.push({ label: 'Refresh model lists', onClick: () => useStore.getState().refreshModels(null, true) });
    items.push({ label: 'Models & API keys…', onClick: () => useStore.getState().openOverlay('settings', 'models') });
    return items;
  };

  const open = (kind, e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items =
      kind === 'mode'
        ? [
            { label: 'Agent — edits files & runs commands', icon: InfinityIcon, keys: 'mod+i', onClick: () => chat().setMode('agent') },
            { label: 'Ask — read-only questions', icon: MessageCircleQuestion, onClick: () => chat().setMode('ask') },
          ]
        : modelMenu();
    setMenu({ x: r.left, y: r.top - 8 - Math.min(items.length * 28 + 10, 420), items });
  };

  const noKey = !keys[chatModel.provider]?.set;

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragOver ? 'dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {mention && (
          <div className="mention-pop">
            {mention.items.length === 0 && <div className="faint" style={{ padding: 8, fontSize: 12 }}>{root ? 'No matching files' : 'Open a folder to mention files'}</div>}
            {mention.items.map((f, i) => (
              <div key={f} className={`mention-item ${i === mention.index ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(f); }} onMouseEnter={() => setMention((m) => ({ ...m, index: i }))}>
                <FileIcon name={f} size={13} />
                <span>{basename(f)}</span>
                <span className="dir">{dirname(f) === f ? '' : f.slice(0, Math.max(0, f.length - basename(f).length - 1))}</span>
              </div>
            ))}
          </div>
        )}
        <div className="chips">
          <button
            className="chip chip-add"
            title="Add files as context (@)"
            onClick={() => {
              const ta = taRef.current;
              const caret = ta?.selectionStart ?? draft.text.length;
              const text = draft.text.slice(0, caret) + (caret && !/\s$/.test(draft.text.slice(0, caret)) ? ' @' : '@') + draft.text.slice(caret);
              chat().setDraft({ text });
              setTimeout(() => {
                ta?.focus();
                const pos = text.indexOf('@', caret) + 1;
                ta?.setSelectionRange(pos, pos);
                updateMention(text, pos);
              }, 0);
            }}
          >
            <AtSign size={11} />
          </button>
          {activeFile && !draft.files.includes(activeFile) && (
            <span className="chip muted-chip" title={`Current file (included as context): ${activeFile}`}>
              <FileIcon name={activeFile} size={12} />
              <span className="ellipsis">{basename(activeFile)}</span>
              <span className="faint" style={{ fontSize: 10.5 }}>current</span>
              <button className="chip-x" onClick={() => chat().setDraft({ includeActive: false })}>
                <X size={11} />
              </button>
            </span>
          )}
          {draft.selection && (
            <span className="chip" title={draft.selection.text.slice(0, 600)}>
              <TextSelect size={12} />
              <span className="ellipsis">
                {basename(draft.selection.path)} ({draft.selection.startLine}-{draft.selection.endLine})
              </span>
              <button className="chip-x" onClick={() => chat().setDraft({ selection: null })}>
                <X size={11} />
              </button>
            </span>
          )}
          {draft.files.map((f) => (
            <span key={f} className="chip" title={f}>
              <FileIcon name={f} size={12} />
              <span className="ellipsis">{basename(f)}</span>
              <button className="chip-x" onClick={() => chat().removeFileFromDraft(f)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={draft.text}
          placeholder={mode === 'agent' ? 'Plan, build, fix anything…  (@ to add files)' : 'Ask about your code…  (@ to add files)'}
          onChange={(e) => {
            chat().setDraft({ text: e.target.value });
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          spellCheck={false}
        />
        <div className="composer-bar">
          <button className="pill-select mode" onClick={(e) => open('mode', e)} title="Mode">
            {mode === 'agent' ? <InfinityIcon size={13} /> : <MessageCircleQuestion size={13} />}
            {mode === 'agent' ? 'Agent' : 'Ask'}
            <ChevronDown size={11} />
          </button>
          <button className="pill-select" onClick={(e) => open('model', e)} title="Model">
            {noKey && <AlertTriangle size={12} style={{ color: 'var(--warning)' }} />}
            <span className="ellipsis">{modelLabel(chatModel)}</span>
            <ChevronDown size={11} />
          </button>
          <span className="spacer" />
          {running ? (
            <button className="send-btn stop" title="Stop (Esc)" onClick={() => chat().stop(chatId)}>
              <Square size={10} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" title="Send (Enter)" disabled={!draft.text.trim()} onClick={submit}>
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span>⏎ send · ⇧⏎ new line</span>
        <span className="spacer" />
        {mode === 'agent' && (
          <span
            style={{ cursor: 'pointer' }}
            title="Click to toggle. Ask: the agent asks before running commands or deleting files. Auto: it runs everything itself."
            onClick={() => useStore.getState().updateSettings({ autoRun: settings.autoRun === 'auto' ? 'ask' : 'auto' })}
          >
            Commands: <b style={{ color: settings.autoRun === 'auto' ? 'var(--warning)' : 'var(--text-muted)', fontWeight: 500 }}>{settings.autoRun === 'auto' ? 'auto-run' : 'ask first'}</b>
          </span>
        )}
      </div>
      {menu && <Menu x={menu.x} y={Math.max(40, menu.y)} items={menu.items} onClose={() => setMenu(null)} minWidth={240} />}
    </div>
  );
}
