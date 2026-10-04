import { create } from 'zustand';
import { api, on } from './api';
import * as models from './editorModels';
import { basename, dirname, isInside, samePath, join } from './paths';

export const FALLBACK_MODELS = {
  google: [
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
  ],
};

let toastId = 1;

export const useStore = create((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  keys: { google: { set: false }, groq: { set: false } },
  models: FALLBACK_MODELS,
  modelErrors: {},

  root: null,
  branch: null,
  recent: [],

  layout: {
    sidebar: true,
    sidebarView: 'explorer',
    sidebarWidth: 260,
    panel: false,
    panelHeight: 260,
    chat: true,
    chatWidth: 420,
  },

  tabs: [],
  activeTab: null,
  dirty: {},
  cursor: { line: 1, col: 1, selected: 0 },
  editorInfo: { language: 'plaintext', eol: 'LF', tabSize: 2 },

  dirCache: {},
  expanded: {},
  selectedPath: null,
  fileList: null,

  overlay: null,
  overlayArg: null,
  toasts: [],
  contextMenu: null,
  dialog: null,

  terminals: [],
  activeTerminal: null,

  // ----------------------------------------------------------------------------------
  toast(message, kind = 'info', timeout = 4000) {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    if (timeout) setTimeout(() => get().dismissToast(id), timeout);
    return id;
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setLayout(patch) {
    set((s) => ({ layout: { ...s.layout, ...patch } }));
    persistLayout();
  },
  toggle(part) {
    const l = get().layout;
    get().setLayout({ [part]: !l[part] });
  },
  showSidebarView(view) {
    const l = get().layout;
    if (l.sidebar && l.sidebarView === view) get().setLayout({ sidebar: false });
    else get().setLayout({ sidebar: true, sidebarView: view });
  },

  openOverlay(overlay, arg = null) {
    set({ overlay, overlayArg: arg });
  },
  closeOverlay() {
    set({ overlay: null, overlayArg: null });
  },

  showContextMenu(x, y, items) {
    set({ contextMenu: { x, y, items } });
  },
  hideContextMenu() {
    set({ contextMenu: null });
  },

  /** In-app prompt dialog. Resolves with the entered string or null. */
  prompt({ title, value = '', placeholder = '', confirmLabel = 'OK', select }) {
    return new Promise((resolve) => {
      set({ dialog: { kind: 'prompt', title, value, placeholder, confirmLabel, select, resolve } });
    });
  },
  confirm({ title, message, confirmLabel = 'OK', danger = false }) {
    return new Promise((resolve) => {
      set({ dialog: { kind: 'confirm', title, message, confirmLabel, danger, resolve } });
    });
  },
  closeDialog(result) {
    const d = get().dialog;
    set({ dialog: null });
    d?.resolve(result);
  },

  // ---------------------------------------------------------------------------------- settings
  async updateSettings(patch) {
    const settings = await api.setSettings(patch);
    set({ settings });
    if (patch.theme) applyTheme(settings.theme);
    return settings;
  },
  async refreshKeys() {
    const keys = await api.getKeys();
    set({ keys });
    return keys;
  },
  async refreshModels(provider, refresh = false) {
    const providers = provider ? [provider] : ['google', 'groq'];
    await Promise.all(
      providers.map(async (p) => {
        const res = await api.models(p, { refresh });
        set((s) => ({
          models: { ...s.models, [p]: res.models },
          modelErrors: { ...s.modelErrors, [p]: res.error },
        }));
      }),
    );
  },

  // ---------------------------------------------------------------------------------- workspace
  async openFolder(folder) {
    if (!folder) {
      folder = await api.openFolderDialog();
      if (!folder) return;
    }
    const st = get();
    if (st.root && !samePath(st.root, folder)) {
      const dirtyTabs = st.tabs.filter((t) => st.dirty[t.id]);
      if (dirtyTabs.length) {
        const ok = await st.confirm({
          title: 'Unsaved changes',
          message: `You have ${dirtyTabs.length} unsaved file(s). Open the folder anyway and discard them?`,
          confirmLabel: 'Discard & Open',
          danger: true,
        });
        if (!ok) return;
      }
      await st.closeAllTabs(true);
    }
    set({ root: folder, dirCache: {}, expanded: { [folder]: true }, fileList: null, selectedPath: null, branch: null });
    api.setTitle(`${basename(folder)} — Pointer`);
    await get().loadDir(folder);
    api.watch(folder);
    api.addRecent(folder).then((recent) => set({ recent }));
    api.setState({ lastFolder: folder });
    api.gitBranch(folder).then((branch) => set({ branch }));
    const { loadChatsForRoot } = await import('./chat.js');
    await loadChatsForRoot(folder);
    // Restore the tabs that were open last time.
    const ws = await api.getWorkspaceState(folder);
    if (ws?.expanded) {
      const expanded = { [folder]: true };
      for (const p of ws.expanded) if (isInside(folder, p)) expanded[p] = true;
      set({ expanded });
      for (const p of Object.keys(expanded)) if (p !== folder) get().loadDir(p);
    }
    if (ws?.tabs?.length) {
      for (const p of ws.tabs) {
        if (await api.exists(p)) await get().openFile(p, { background: true });
      }
      if (ws.active && (await api.exists(ws.active))) await get().openFile(ws.active);
    }
  },
  async closeFolder() {
    const ok = await get().closeAllTabs();
    if (!ok) return;
    api.unwatch();
    set({ root: null, dirCache: {}, expanded: {}, fileList: null, branch: null });
    api.setTitle('Pointer');
    api.setState({ lastFolder: null });
    const { loadChatsForRoot } = await import('./chat.js');
    await loadChatsForRoot(null);
  },

  async loadDir(dir) {
    try {
      const entries = await api.readDir(dir);
      set((s) => ({ dirCache: { ...s.dirCache, [dir]: entries } }));
    } catch (e) {
      set((s) => {
        const dirCache = { ...s.dirCache };
        delete dirCache[dir];
        return { dirCache };
      });
    }
  },
  toggleDir(dir, force) {
    const expanded = { ...get().expanded };
    const next = force ?? !expanded[dir];
    if (next) {
      expanded[dir] = true;
      if (!get().dirCache[dir]) get().loadDir(dir);
    } else delete expanded[dir];
    set({ expanded });
    persistWorkspace();
  },
  collapseAll() {
    const root = get().root;
    set({ expanded: root ? { [root]: true } : {} });
    persistWorkspace();
  },
  async revealInTree(path) {
    const root = get().root;
    if (!root || !isInside(root, path)) return;
    const expanded = { ...get().expanded };
    let d = dirname(path);
    const toLoad = [];
    while (d && isInside(root, d)) {
      expanded[d] = true;
      if (!get().dirCache[d]) toLoad.push(d);
      d = dirname(d);
    }
    set({ expanded, selectedPath: path });
    await Promise.all(toLoad.map((x) => get().loadDir(x)));
  },
  async getFileList(force = false) {
    const { root, fileList } = get();
    if (!root) return [];
    if (fileList && !force) return fileList;
    const list = await api.listFiles(root);
    set({ fileList: list });
    return list;
  },

  // ---------------------------------------------------------------------------------- tabs
  async openFile(path, { line, col, background = false, preview = false } = {}) {
    const existing = get().tabs.find((t) => t.id === path);
    if (existing) {
      if (!background) set({ activeTab: path });
      if (line) revealLine(path, line, col);
      persistWorkspace();
      return;
    }
    let res;
    try {
      res = await models.openModel(path);
    } catch (e) {
      get().toast(`Could not open ${basename(path)}: ${e.message}`, 'error');
      return;
    }
    const tab = { id: path, path, title: basename(path), kind: res.kind };
    if (res.kind === 'image') tab.dataUrl = res.dataUrl;
    if (res.kind === 'binary' || res.kind === 'tooLarge') tab.size = res.size;
    set((s) => {
      if (s.tabs.find((t) => t.id === path)) return s;
      const idx = s.tabs.findIndex((t) => t.id === s.activeTab);
      const tabs = [...s.tabs];
      tabs.splice(idx >= 0 ? idx + 1 : tabs.length, 0, tab);
      return { tabs, activeTab: background && s.activeTab ? s.activeTab : path };
    });
    if (line) setTimeout(() => revealLine(path, line, col), 30);
    persistWorkspace();
  },
  newUntitled(content = '', language = 'plaintext') {
    const { key, title } = models.createUntitled(content, language);
    set((s) => ({ tabs: [...s.tabs, { id: key, path: null, title, kind: 'text', untitled: true }], activeTab: key }));
    if (content) set((s) => ({ dirty: { ...s.dirty, [key]: true } }));
  },
  setActiveTab(id) {
    set({ activeTab: id });
    persistWorkspace();
  },
  async closeTab(id, { force = false } = {}) {
    const st = get();
    const tab = st.tabs.find((t) => t.id === id);
    if (!tab) return true;
    if (!force && st.dirty[id]) {
      const choice = await api.confirm({
        message: `Do you want to save the changes you made to ${tab.title}?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ['Save', "Don't Save", 'Cancel'],
      });
      if (choice === 2) return false;
      if (choice === 0) {
        const saved = await get().saveTab(id);
        if (!saved) return false;
      }
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTab = s.activeTab;
      if (activeTab === id) activeTab = tabs[Math.min(idx, tabs.length - 1)]?.id || null;
      const dirty = { ...s.dirty };
      delete dirty[id];
      return { tabs, activeTab, dirty };
    });
    // Keep the model alive if a diff tab still uses it.
    const stillUsed = get().tabs.some((t) => t.kind === 'diff' && t.path === tab.path);
    if (tab.kind !== 'diff' && !stillUsed) models.disposeModel(id);
    if (tab.kind === 'diff') tab.dispose?.();
    persistWorkspace();
    return true;
  },
  async closeAllTabs(force = false) {
    for (const t of [...get().tabs]) {
      const ok = await get().closeTab(t.id, { force });
      if (!ok) return false;
    }
    return true;
  },
  async closeOtherTabs(id) {
    for (const t of [...get().tabs]) if (t.id !== id) if (!(await get().closeTab(t.id))) return;
  },
  async saveTab(id = get().activeTab) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    const key = tab.kind === 'diff' ? tab.path : id;
    const entry = models.getEntry(key);
    if (!entry) return false;
    if (entry.untitled) {
      const def = get().root ? join(get().root, tab.title) : tab.title;
      const target = await api.saveFileDialog(def);
      if (!target) return false;
      await api.writeFile(target, entry.model.getValue(), {});
      models.disposeModel(id);
      set((s) => {
        const dirty = { ...s.dirty };
        delete dirty[id];
        return { tabs: s.tabs.filter((t) => t.id !== id), dirty, activeTab: s.activeTab === id ? null : s.activeTab };
      });
      await get().openFile(target);
      return true;
    }
    try {
      const fmt = get().settings?.editor?.formatOnSave ? formatModel : undefined;
      await models.saveModel(key, { formatter: fmt });
      return true;
    } catch (e) {
      get().toast(`Failed to save ${tab.title}: ${e.message}`, 'error');
      return false;
    }
  },
  async saveAll() {
    for (const t of get().tabs) if (get().dirty[t.id]) await get().saveTab(t.id);
  },
  moveTab(fromId, toId) {
    set((s) => {
      const tabs = [...s.tabs];
      const from = tabs.findIndex((t) => t.id === fromId);
      const to = tabs.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0) return s;
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return { tabs };
    });
  },
  cycleTab(dir = 1) {
    const { tabs, activeTab } = get();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === activeTab);
    set({ activeTab: tabs[(i + dir + tabs.length) % tabs.length].id });
  },
  openDiffTab({ path, original, title, label }) {
    const id = `diff:${path}:${Date.now()}`;
    const tab = { id, path, title: title || `${basename(path)} (Review)`, kind: 'diff', original, label };
    set((s) => ({ tabs: [...s.tabs.filter((t) => !(t.kind === 'diff' && t.path === path)), tab], activeTab: id }));
  },

  // ---------------------------------------------------------------------------------- file ops
  async createFileIn(dir, isFolder = false) {
    const name = await get().prompt({ title: isFolder ? 'New folder name' : 'New file name', placeholder: isFolder ? 'folder' : 'file.ts' });
    if (!name) return;
    const target = join(dir, name);
    try {
      if (isFolder) await api.createDir(target);
      else await api.createFile(target);
      await get().loadDir(dirname(target));
      get().toggleDir(dir, true);
      if (!isFolder) await get().openFile(target);
      get().invalidateFileList();
    } catch (e) {
      get().toast(e.message, 'error');
    }
  },
  async renamePath(path) {
    const name = await get().prompt({ title: 'Rename', value: basename(path), confirmLabel: 'Rename', select: true });
    if (!name || name === basename(path)) return;
    const target = join(dirname(path), name);
    try {
      await api.rename(path, target);
      // Update open tabs that point to the renamed path (or files inside a renamed folder).
      const tabs = get().tabs.map((t) => {
        if (!t.path) return t;
        if (samePath(t.path, path) || isInside(path, t.path)) {
          const np = target + t.path.slice(path.length);
          models.renameModelPath(t.path, np);
          return { ...t, id: t.kind === 'diff' ? t.id : np, path: np, title: basename(np) };
        }
        return t;
      });
      const active = get().activeTab;
      const activeTab = active && (samePath(active, path) || isInside(path, active)) ? target + active.slice(path.length) : active;
      set({ tabs, activeTab });
      await get().loadDir(dirname(path));
      get().invalidateFileList();
    } catch (e) {
      get().toast(e.message, 'error');
    }
  },
  async deletePath(path) {
    const ok = await get().confirm({
      title: 'Delete',
      message: `Move "${basename(path)}" to the ${window.pointer?.platform === 'win32' ? 'Recycle Bin' : 'Trash'}?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(path);
      for (const t of get().tabs) if (t.path && (samePath(t.path, path) || isInside(path, t.path))) await get().closeTab(t.id, { force: true });
      await get().loadDir(dirname(path));
      get().invalidateFileList();
    } catch (e) {
      get().toast(e.message, 'error');
    }
  },
  invalidateFileList() {
    set({ fileList: null });
  },

  // ---------------------------------------------------------------------------------- terminals
  async newTerminal() {
    const st = get();
    const { id, shell } = await api.termCreate({ cwd: st.root || st.info?.home });
    const n = st.terminals.length + 1;
    set((s) => ({
      terminals: [...s.terminals, { id, title: shell?.split(' ')[0] || 'terminal', n }],
      activeTerminal: id,
      layout: { ...s.layout, panel: true },
    }));
    persistLayout();
    return id;
  },
  async killTerminal(id = get().activeTerminal) {
    if (id == null) return;
    await api.termKill(id);
    get().removeTerminal(id);
  },
  removeTerminal(id) {
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id);
      return {
        terminals,
        activeTerminal: s.activeTerminal === id ? terminals[terminals.length - 1]?.id ?? null : s.activeTerminal,
        layout: terminals.length ? s.layout : { ...s.layout, panel: false },
      };
    });
  },
  async togglePanel() {
    const st = get();
    if (!st.layout.panel && !st.terminals.length) {
      await st.newTerminal();
      return;
    }
    st.setLayout({ panel: !st.layout.panel });
  },
}));

// ------------------------------------------------------------------------------------ helpers

export let activeEditor = null;
export function setActiveEditor(ed) {
  activeEditor = ed;
}

function revealLine(path, line, col = 1) {
  const ed = activeEditor;
  if (!ed) return;
  const model = ed.getModel();
  if (!model || !samePath(model.uri.fsPath, path)) {
    setTimeout(() => {
      const m = activeEditor?.getModel();
      if (m && samePath(m.uri.fsPath, path)) revealLine(path, line, col);
    }, 60);
    return;
  }
  ed.revealLineInCenter(line);
  ed.setPosition({ lineNumber: line, column: col || 1 });
  ed.focus();
}

async function formatModel(model) {
  const ed = activeEditor;
  if (ed && ed.getModel() === model) {
    try {
      await ed.getAction('editor.action.formatDocument')?.run();
    } catch {}
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  api.setTitleBarTheme(theme);
  import('./monaco').then(({ monaco, monacoTheme }) => monaco.editor.setTheme(monacoTheme(theme)));
}

let layoutTimer = null;
function persistLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => api.setState({ layout: useStore.getState().layout }), 400);
}

let wsTimer = null;
export function persistWorkspace() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(() => {
    const { root, tabs, activeTab, expanded } = useStore.getState();
    if (!root) return;
    api.setWorkspaceState(root, {
      tabs: tabs.filter((t) => t.path && t.kind !== 'diff').map((t) => t.path),
      active: tabs.find((t) => t.id === activeTab && t.kind !== 'diff')?.path || null,
      expanded: Object.keys(expanded).filter((p) => p !== root),
    });
  }, 500);
}

// Track dirty state from Monaco models.
models.setDirtyListener((key, dirty) => {
  useStore.setState((s) => {
    if (!!s.dirty[key] === dirty) return s;
    const d = { ...s.dirty };
    if (dirty) d[key] = true;
    else delete d[key];
    return { dirty: d };
  });
  const st = useStore.getState();
  if (dirty && st.settings?.editor?.autoSave) scheduleAutoSave(key);
});

const autoSaveTimers = new Map();
function scheduleAutoSave(key) {
  clearTimeout(autoSaveTimers.get(key));
  autoSaveTimers.set(
    key,
    setTimeout(() => {
      const e = models.getEntry(key);
      if (e?.path && models.isDirty(key)) models.saveModel(key);
    }, 1000),
  );
}

// React to file-system changes (from the agent, the terminal or other programs).
let fsQueue = [];
let fsTimer = null;
on('fs:changed', (batch) => {
  fsQueue.push(...batch);
  if (!fsTimer) fsTimer = setTimeout(processFsQueue, 150);
});

async function processFsQueue() {
  fsTimer = null;
  const batch = fsQueue;
  fsQueue = [];
  const st = useStore.getState();
  const dirs = new Set();
  let structural = false;
  for (const ev of batch) {
    if (ev.type === 'change') {
      if (models.getEntry(ev.path)) models.reloadFromDisk(ev.path);
      continue;
    }
    structural = true;
    dirs.add(dirname(ev.path));
    if (ev.type === 'unlinkDir') dirs.add(ev.path);
  }
  for (const d of dirs) {
    if (st.dirCache[d]) st.loadDir(d);
  }
  if (structural) useStore.setState({ fileList: null });
}

on('term:exit', (id) => useStore.getState().removeTerminal(id));
