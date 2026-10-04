import { create } from 'zustand';
import { api, on } from './api';
import { useStore } from './store';
import * as models from './editorModels';
import { dirname } from './paths';

const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function newChat() {
  return { id: uid('chat'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [], runMeta: {} };
}

export const useChat = create((set, get) => ({
  root: undefined,
  chats: [newChat()],
  activeChatId: null,
  runs: {}, // runId -> { chatId }
  toolState: {}, // toolCallId -> { status, output }
  mode: 'agent',
  draft: { text: '', files: [], selection: null, includeActive: true },
  focusTick: 0,

  activeChat() {
    const s = get();
    return s.chats.find((c) => c.id === s.activeChatId) || s.chats[0];
  },
  isRunning(chatId = get().activeChat()?.id) {
    return Object.values(get().runs).some((r) => r.chatId === chatId);
  },
  runIdFor(chatId) {
    return Object.entries(get().runs).find(([, r]) => r.chatId === chatId)?.[0] || null;
  },

  setMode(mode) {
    set({ mode });
    api.setState({ chatMode: mode });
  },
  setDraft(patch) {
    set((s) => ({ draft: { ...s.draft, ...patch } }));
  },
  focusComposer() {
    set((s) => ({ focusTick: s.focusTick + 1 }));
  },
  addFileToDraft(path) {
    set((s) => (s.draft.files.includes(path) ? s : { draft: { ...s.draft, files: [...s.draft.files, path] } }));
  },
  removeFileFromDraft(path) {
    set((s) => ({ draft: { ...s.draft, files: s.draft.files.filter((f) => f !== path) } }));
  },

  newChat() {
    const cur = get().activeChat();
    if (cur && !cur.messages.length) {
      set({ activeChatId: cur.id });
      get().focusComposer();
      return;
    }
    const c = newChat();
    set((s) => ({ chats: [c, ...s.chats], activeChatId: c.id }));
    get().focusComposer();
    scheduleSave();
  },
  selectChat(id) {
    set({ activeChatId: id });
  },
  deleteChat(id) {
    const runId = get().runIdFor(id);
    if (runId) api.agentStop(runId);
    set((s) => {
      let chats = s.chats.filter((c) => c.id !== id);
      if (!chats.length) chats = [newChat()];
      return { chats, activeChatId: s.activeChatId === id ? chats[0].id : s.activeChatId };
    });
    scheduleSave();
  },
  renameChat(id, title) {
    updateChat(id, (c) => ({ ...c, title }));
  },

  async send(text) {
    const st = get();
    const app = useStore.getState();
    const chat = st.activeChat();
    if (!chat || st.isRunning(chat.id)) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const activeTab = app.tabs.find((t) => t.id === app.activeTab);
    const activeFile = st.draft.includeActive && activeTab?.path && activeTab.kind === 'text' ? activeTab.path : null;
    const context = {
      files: st.draft.files,
      selection: st.draft.selection,
      activeFile,
      cursorLine: activeFile ? app.cursor.line : undefined,
    };
    const runId = uid('run');
    const userMsg = { id: uid('msg'), role: 'user', content: trimmed, context, runId, createdAt: Date.now() };
    updateChat(chat.id, (c) => ({
      ...c,
      title: c.messages.length ? c.title : trimmed.replace(/\s+/g, ' ').slice(0, 48),
      messages: [...c.messages, userMsg],
      updatedAt: Date.now(),
    }));
    set((s) => ({
      runs: { ...s.runs, [runId]: { chatId: chat.id, startedAt: Date.now() } },
      draft: { text: '', files: [], selection: null, includeActive: true },
    }));
    const settings = app.settings;
    const history = toHistory(get().chats.find((c) => c.id === chat.id).messages);
    const openFiles = app.tabs.filter((t) => t.path && t.kind !== 'diff').map((t) => t.path);
    await api.agentStart({
      runId,
      messages: history,
      mode: st.mode,
      model: settings.chatModel,
      root: app.root,
      context: { openFiles },
    });
  },
  stop(chatId = get().activeChat()?.id) {
    const runId = get().runIdFor(chatId);
    if (runId) api.agentStop(runId);
  },
  approve(runId, toolCallId, decision) {
    setToolState(toolCallId, { status: decision === 'reject' ? 'rejected' : 'running' });
    api.agentApprove(runId, toolCallId, decision);
  },
  async revertRun(chatId, runId, path) {
    const res = await api.agentRevert(runId, path);
    for (const p of res.reverted || []) {
      if (models.getEntry(p)) await models.reloadFromDisk(p, { force: true });
      useStore.getState().loadDir(dirname(p));
    }
    updateChat(chatId, (c) => {
      const meta = { ...(c.runMeta[runId] || {}) };
      if (path) meta.revertedFiles = [...(meta.revertedFiles || []), ...(res.reverted || [])];
      else meta.reverted = true;
      return { ...c, runMeta: { ...c.runMeta, [runId]: meta } };
    });
    if (res.missing) useStore.getState().toast('Undo data is no longer available for this run (it is kept until Pointer restarts).', 'warning');
    else useStore.getState().toast(`Reverted ${res.reverted.length} file(s).`, 'success');
  },
  /** Resend from a user message: truncate after it and run again (optionally with new text). */
  async retryFrom(messageId, newText) {
    const chat = get().activeChat();
    if (!chat || get().isRunning(chat.id)) return;
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = chat.messages[idx];
    updateChat(chat.id, (c) => ({ ...c, messages: c.messages.slice(0, idx) }));
    set((s) => ({ draft: { ...s.draft, files: msg.context?.files || [], selection: msg.context?.selection || null } }));
    await get().send(newText ?? msg.content);
  },
}));

function toHistory(messages) {
  return messages
    .filter((m) => ['user', 'assistant', 'tool'].includes(m.role) && !m.streaming)
    .map((m) => {
      if (m.role === 'user') return { id: m.id, role: 'user', content: m.content, llmContent: m.llmContent, context: m.context };
      if (m.role === 'assistant') return { id: m.id, role: 'assistant', content: m.content, toolCalls: m.toolCalls, meta: m.meta, provider: m.provider, model: m.model };
      return { id: m.id, role: 'tool', toolCallId: m.toolCallId, name: m.name, content: m.content, isError: m.isError };
    });
}

function updateChat(chatId, fn) {
  useChat.setState((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? fn(c) : c)) }));
  scheduleSave();
}

function updateMessage(chatId, messageId, fn) {
  useChat.setState((s) => ({
    chats: s.chats.map((c) =>
      c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? fn(m) : m)) } : c,
    ),
  }));
}

function setToolState(id, patch) {
  useChat.setState((s) => ({ toolState: { ...s.toolState, [id]: { ...(s.toolState[id] || {}), ...patch } } }));
}

// ---------------------------------------------------------------------------- persistence

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1200);
}

function saveNow() {
  const { root, chats, activeChatId } = useChat.getState();
  if (root === undefined) return;
  const clean = chats
    .filter((c) => c.messages.length)
    .slice(0, 100)
    .map((c) => ({ ...c, messages: c.messages.filter((m) => !m.streaming) }));
  api.saveChats(root, { chats: clean, activeChatId });
}

export async function loadChatsForRoot(root) {
  saveNow();
  const data = await api.loadChats(root);
  let chats = data?.chats?.length ? data.chats : [];
  const fresh = newChat();
  chats = [fresh, ...chats];
  useChat.setState({ root, chats, activeChatId: fresh.id, toolState: {} });
}

window.addEventListener('beforeunload', saveNow);

// ---------------------------------------------------------------------------- agent events

// Text deltas arrive very quickly; batch them per animation frame.
const pending = new Map(); // messageId -> { chatId, text, thinking }
let frame = null;

function flush() {
  frame = null;
  if (!pending.size) return;
  const items = [...pending.entries()];
  pending.clear();
  useChat.setState((s) => ({
    chats: s.chats.map((c) => {
      const mine = items.filter(([, p]) => p.chatId === c.id);
      if (!mine.length) return c;
      return {
        ...c,
        messages: c.messages.map((m) => {
          const hit = mine.find(([id]) => id === m.id);
          if (!hit) return m;
          const p = hit[1];
          return { ...m, content: (m.content || '') + p.text, thinking: (m.thinking || '') + p.thinking, status: p.text ? undefined : m.status };
        }),
      };
    }),
  }));
}

function queueDelta(chatId, messageId, kind, text) {
  const p = pending.get(messageId) || { chatId, text: '', thinking: '' };
  p[kind] += text;
  pending.set(messageId, p);
  if (!frame) frame = requestAnimationFrame(flush);
}

on('agent:event', (ev) => {
  const st = useChat.getState();
  const run = st.runs[ev.runId];
  if (!run) return;
  const chatId = run.chatId;
  switch (ev.type) {
    case 'user_expanded':
      updateMessage(chatId, ev.messageId, (m) => ({ ...m, llmContent: ev.llmContent }));
      break;
    case 'assistant_start':
      updateChat(chatId, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          { id: ev.messageId, role: 'assistant', content: '', thinking: '', toolCalls: [], streaming: true, runId: ev.runId, provider: ev.provider, model: ev.model, startedAt: Date.now() },
        ],
      }));
      break;
    case 'text':
      queueDelta(chatId, ev.messageId, 'text', ev.text);
      break;
    case 'thinking':
      queueDelta(chatId, ev.messageId, 'thinking', ev.text);
      break;
    case 'status':
      updateMessage(chatId, ev.messageId, (m) => ({ ...m, status: ev.text }));
      break;
    case 'tool_call':
      flush();
      setToolState(ev.call.id, { status: 'pending', output: '', runId: ev.runId });
      updateMessage(chatId, ev.messageId, (m) => ({ ...m, toolCalls: [...(m.toolCalls || []), ev.call] }));
      break;
    case 'assistant_end':
      flush();
      updateMessage(chatId, ev.message.id, () => ({ ...ev.message, runId: ev.runId, streaming: false }));
      break;
    case 'assistant_discard':
      pending.delete(ev.messageId);
      updateChat(chatId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== ev.messageId) }));
      break;
    case 'approval_request':
      setToolState(ev.toolCallId, { status: 'awaiting' });
      break;
    case 'tool_start':
      setToolState(ev.toolCallId, { status: 'running' });
      break;
    case 'tool_output': {
      const cur = useChat.getState().toolState[ev.toolCallId]?.output || '';
      setToolState(ev.toolCallId, { output: (cur + ev.text).slice(-60000) });
      break;
    }
    case 'tool_result':
      setToolState(ev.message.toolCallId, { status: ev.message.rejected ? 'rejected' : ev.message.isError ? 'error' : 'done' });
      updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, { ...ev.message, runId: ev.runId }] }));
      break;
    case 'file_changed': {
      const app = useStore.getState();
      if (ev.content !== null && ev.content !== undefined) models.applyDiskContent(ev.path, ev.content);
      app.loadDir(dirname(ev.path));
      if (ev.content === null || ev.content === undefined) app.invalidateFileList();
      else if (!app.fileList?.length) app.invalidateFileList();
      break;
    }
    case 'notice':
      updateChat(chatId, (c) => ({ ...c, messages: [...c.messages, { id: uid('note'), role: 'notice', content: ev.text, runId: ev.runId }] }));
      break;
    case 'settings_changed':
      useStore.setState({ settings: ev.settings });
      break;
    case 'error':
      flush();
      updateChat(chatId, (c) => ({
        ...c,
        messages: [...c.messages.filter((m) => !(m.streaming && m.runId === ev.runId)), { id: uid('err'), role: 'error', content: ev.message, code: ev.code, runId: ev.runId }],
        runMeta: { ...c.runMeta, [ev.runId]: { ...(c.runMeta[ev.runId] || {}), hasCheckpoint: ev.hasCheckpoint } },
      }));
      finishRun(ev.runId);
      break;
    case 'done':
      flush();
      updateChat(chatId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.streaming && m.runId === ev.runId ? { ...m, streaming: false } : m)),
        runMeta: { ...c.runMeta, [ev.runId]: { ...(c.runMeta[ev.runId] || {}), hasCheckpoint: ev.hasCheckpoint, stopped: ev.stopped } },
        updatedAt: Date.now(),
      }));
      finishRun(ev.runId);
      break;
    default:
      break;
  }
});

function finishRun(runId) {
  useChat.setState((s) => {
    const runs = { ...s.runs };
    delete runs[runId];
    // Tool calls that never got a result (e.g. stopped) should not spin forever.
    const toolState = { ...s.toolState };
    for (const [k, v] of Object.entries(toolState)) {
      if (v.runId === runId && (v.status === 'pending' || v.status === 'running' || v.status === 'awaiting')) toolState[k] = { ...v, status: 'cancelled' };
    }
    return { runs, toolState };
  });
  scheduleSave();
}
