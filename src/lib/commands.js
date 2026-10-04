import { useStore, activeEditor } from './store';
import { useChat } from './chat';
import { api, isMac } from './api';
import { relative } from './paths';

const S = () => useStore.getState();

function editorAction(id) {
  return () => {
    const ed = activeEditor;
    if (!ed) return;
    ed.focus();
    ed.trigger('pointer', id, null);
  };
}

/** Adds the current editor selection (or file) to the chat composer and focuses it. */
export function addSelectionToChat() {
  const st = S();
  const ed = activeEditor;
  st.setLayout({ chat: true });
  const tab = st.tabs.find((t) => t.id === st.activeTab);
  if (ed && tab?.path) {
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (sel && !sel.isEmpty() && model) {
      const text = model.getValueInRange(sel);
      useChat.getState().setDraft({
        selection: { path: relative(st.root, tab.path) || tab.path, absPath: tab.path, startLine: sel.startLineNumber, endLine: sel.endLineNumber, text },
      });
    }
  }
  useChat.getState().focusComposer();
}

export const COMMANDS = [
  { id: 'file.newFile', title: 'New File', category: 'File', keys: 'mod+n', run: () => S().newUntitled() },
  { id: 'file.openFile', title: 'Open File…', category: 'File', run: async () => {
      const files = await api.openFileDialog();
      for (const f of files) await S().openFile(f);
    } },
  { id: 'file.openFolder', title: 'Open Folder…', category: 'File', keys: 'mod+o', run: () => S().openFolder() },
  { id: 'file.closeFolder', title: 'Close Folder', category: 'File', run: () => S().closeFolder() },
  { id: 'file.save', title: 'Save', category: 'File', keys: 'mod+s', run: () => S().saveTab() },
  { id: 'file.saveAll', title: 'Save All', category: 'File', keys: 'mod+alt+s', run: () => S().saveAll() },
  { id: 'file.closeEditor', title: 'Close Editor', category: 'File', keys: 'mod+w', run: () => S().activeTab && S().closeTab(S().activeTab) },
  { id: 'file.closeAll', title: 'Close All Editors', category: 'File', run: () => S().closeAllTabs() },
  { id: 'file.newWindow', title: 'New Window', category: 'File', keys: 'mod+shift+n', run: () => api.newWindow() },
  { id: 'app.settings', title: 'Open Settings', category: 'Preferences', keys: 'mod+,', run: () => S().openOverlay('settings') },
  { id: 'app.quit', title: 'Exit', category: 'File', run: () => api.quit() },

  { id: 'view.quickOpen', title: 'Go to File…', category: 'Go', keys: 'mod+p', run: () => S().openOverlay('quickOpen', '') },
  { id: 'view.commandPalette', title: 'Command Palette', category: 'View', keys: 'mod+shift+p', alt: 'f1', run: () => S().openOverlay('quickOpen', '>') },
  { id: 'view.goToLine', title: 'Go to Line…', category: 'Go', keys: 'mod+g', run: () => S().openOverlay('quickOpen', ':') },
  { id: 'view.explorer', title: 'Show Explorer', category: 'View', keys: 'mod+shift+e', run: () => S().setLayout({ sidebar: true, sidebarView: 'explorer' }) },
  { id: 'view.search', title: 'Search in Files', category: 'View', keys: 'mod+shift+f', run: () => {
      S().setLayout({ sidebar: true, sidebarView: 'search' });
      setTimeout(() => document.querySelector('.search-panel input')?.focus(), 30);
    } },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', keys: 'mod+b', run: () => S().toggle('sidebar') },
  { id: 'view.toggleTerminal', title: 'Toggle Terminal', category: 'View', keys: 'mod+j', alt: 'mod+`', run: () => S().togglePanel() },
  { id: 'view.toggleChat', title: 'Toggle AI Chat', category: 'View', keys: 'mod+alt+b', run: () => S().toggle('chat') },
  { id: 'view.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', keys: 'alt+z', run: () => {
      const cur = S().settings.editor.wordWrap;
      S().updateSettings({ editor: { wordWrap: cur === 'on' ? 'off' : 'on' } });
    } },
  { id: 'view.toggleMinimap', title: 'Toggle Minimap', category: 'View', run: () => S().updateSettings({ editor: { minimap: !S().settings.editor.minimap } }) },
  { id: 'view.zoomIn', title: 'Zoom In', category: 'View', keys: 'mod+=', run: () => api.zoom(1) },
  { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', keys: 'mod+-', run: () => api.zoom(-1) },
  { id: 'view.zoomReset', title: 'Reset Zoom', category: 'View', keys: 'mod+0', run: () => api.zoom(0) },
  { id: 'view.nextTab', title: 'Next Editor', category: 'View', keys: 'ctrl+tab', run: () => S().cycleTab(1) },
  { id: 'view.prevTab', title: 'Previous Editor', category: 'View', keys: 'ctrl+shift+tab', run: () => S().cycleTab(-1) },
  { id: 'view.toggleTheme', title: 'Toggle Light/Dark Theme', category: 'Preferences', run: () => S().updateSettings({ theme: S().settings.theme === 'light' ? 'dark' : 'light' }) },

  { id: 'ai.newChat', title: 'New Chat', category: 'AI', keys: 'mod+shift+l', run: () => {
      S().setLayout({ chat: true });
      useChat.getState().newChat();
    } },
  { id: 'ai.addToChat', title: 'Add Selection to Chat', category: 'AI', keys: 'mod+l', run: addSelectionToChat },
  { id: 'ai.focusChat', title: 'Open Agent', category: 'AI', keys: 'mod+i', run: () => {
      S().setLayout({ chat: true });
      useChat.getState().setMode('agent');
      useChat.getState().focusComposer();
    } },
  { id: 'ai.inlineEdit', title: 'Edit with AI (Inline)', category: 'AI', keysLabel: 'mod+k', run: () => activeEditor?.trigger('pointer', 'pointer.inlineEdit', null) },
  { id: 'ai.toggleAutocomplete', title: 'Toggle AI Tab Autocomplete', category: 'AI', run: () => S().updateSettings({ autocompleteEnabled: !S().settings.autocompleteEnabled }) },
  { id: 'ai.stop', title: 'Stop Agent', category: 'AI', run: () => useChat.getState().stop() },

  { id: 'terminal.new', title: 'New Terminal', category: 'Terminal', keys: 'mod+shift+`', run: () => S().newTerminal() },
  { id: 'terminal.kill', title: 'Kill Terminal', category: 'Terminal', run: () => S().killTerminal() },

  { id: 'edit.undo', title: 'Undo', category: 'Edit', keysLabel: 'mod+z', run: editorAction('undo') },
  { id: 'edit.redo', title: 'Redo', category: 'Edit', keysLabel: 'mod+y', run: editorAction('redo') },
  { id: 'edit.find', title: 'Find', category: 'Edit', keysLabel: 'mod+f', run: editorAction('actions.find') },
  { id: 'edit.replace', title: 'Replace', category: 'Edit', keysLabel: 'mod+h', run: editorAction('editor.action.startFindReplaceAction') },
  { id: 'edit.format', title: 'Format Document', category: 'Edit', keysLabel: 'shift+alt+f', run: editorAction('editor.action.formatDocument') },
  { id: 'edit.commentLine', title: 'Toggle Line Comment', category: 'Edit', keysLabel: 'mod+/', run: editorAction('editor.action.commentLine') },
  { id: 'edit.selectAll', title: 'Select All', category: 'Edit', keysLabel: 'mod+a', run: editorAction('editor.action.selectAll') },

  { id: 'help.shortcuts', title: 'Keyboard Shortcuts', category: 'Help', run: () => S().openOverlay('shortcuts') },
  { id: 'help.devtools', title: 'Toggle Developer Tools', category: 'Help', keys: 'mod+shift+i', run: () => api.toggleDevTools() },
  { id: 'help.reload', title: 'Reload Window', category: 'Help', keys: 'mod+r', run: () => api.reload() },
  { id: 'help.about', title: 'About Pointer', category: 'Help', run: () => S().openOverlay('settings', 'about') },
];

export function runCommand(id) {
  const c = COMMANDS.find((x) => x.id === id);
  if (c) c.run();
}

export function formatKeys(keys) {
  if (!keys) return '';
  return keys
    .split('+')
    .map((k) => {
      if (k === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (k === 'shift') return isMac ? '⇧' : 'Shift';
      if (k === 'alt') return isMac ? '⌥' : 'Alt';
      if (k === 'ctrl') return isMac ? '⌃' : 'Ctrl';
      if (k === 'tab') return 'Tab';
      if (k.length === 1) return k.toUpperCase();
      return k[0].toUpperCase() + k.slice(1);
    })
    .join(isMac ? '' : '+');
}

function eventKey(e) {
  const parts = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('mod');
  if (isMac && e.ctrlKey) parts.push('ctrl');
  if (!isMac && e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (e.code === 'Backquote') k = '`';
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Slash') k = '/';
  else if (e.code?.startsWith('Key')) k = e.code.slice(3).toLowerCase();
  else if (e.code?.startsWith('Digit')) k = e.code.slice(5);
  else k = (k || '').toLowerCase();
  if (['control', 'shift', 'alt', 'meta'].includes(k)) return null;
  parts.push(k);
  // "ctrl+tab" is written with ctrl even on Windows where ctrl === mod.
  return parts.join('+');
}

const keyMap = new Map();
for (const c of COMMANDS) {
  for (const k of [c.keys, c.alt]) {
    if (!k) continue;
    const norm = isMac ? k : k.replace(/^ctrl\+/, 'mod+');
    keyMap.set(norm, c);
  }
}

export function installKeybindings() {
  const handler = (e) => {
    const key = eventKey(e);
    if (!key) return;
    const cmd = keyMap.get(key);
    if (!cmd) return;
    const inTerminal = e.target?.closest?.('.xterm');
    // Let the terminal keep keys it needs (Ctrl+R reverse search, Ctrl+W delete word, Ctrl+N/P history, …).
    if (inTerminal && ['help.reload', 'file.closeEditor', 'file.newFile', 'view.goToLine', 'file.openFolder', 'file.save'].includes(cmd.id)) return;
    const st = S();
    if (st.overlay && cmd.id !== 'view.quickOpen' && cmd.id !== 'view.commandPalette') return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run();
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
