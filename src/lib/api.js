// Thin wrapper around the preload bridge (window.pointer).

const bridge = window.pointer;

export const platform = bridge?.platform || 'linux';
export const isMac = platform === 'darwin';
export const isWin = platform === 'win32';

export const invoke = (channel, ...args) => bridge.invoke(channel, ...args);
export const on = (channel, cb) => bridge.on(channel, cb);
export const send = (channel, ...args) => bridge.send(channel, ...args);
export const getPathForFile = (file) => bridge.getPathForFile(file);

export const api = {
  info: () => invoke('app:info'),
  newWindow: () => invoke('app:newWindow'),
  toggleDevTools: () => invoke('app:toggleDevTools'),
  reload: () => invoke('app:reload'),
  quit: () => invoke('app:quit'),
  openExternal: (url) => invoke('app:openExternal', url),
  setTitleBarTheme: (t) => invoke('app:setTitleBarTheme', t),
  setTitle: (t) => invoke('app:setTitle', t),

  openFolderDialog: () => invoke('dialog:openFolder'),
  openFileDialog: () => invoke('dialog:openFile'),
  saveFileDialog: (defaultPath) => invoke('dialog:saveFile', defaultPath),
  confirm: (opts) => invoke('dialog:confirm', opts),

  readDir: (dir) => invoke('fs:readDir', dir),
  readFile: (file) => invoke('fs:readFile', file),
  readText: (file) => invoke('fs:readText', file),
  writeFile: (file, content, opts) => invoke('fs:writeFile', file, content, opts),
  exists: (p) => invoke('fs:exists', p),
  stat: (p) => invoke('fs:stat', p),
  createFile: (p) => invoke('fs:createFile', p),
  createDir: (p) => invoke('fs:createDir', p),
  rename: (a, b) => invoke('fs:rename', a, b),
  remove: (p) => invoke('fs:delete', p),
  copy: (a, b) => invoke('fs:copy', a, b),
  listFiles: (root) => invoke('fs:listFiles', root),
  watch: (root) => invoke('fs:watch', root),
  unwatch: () => invoke('fs:unwatch'),
  searchText: (root, opts) => invoke('search:text', root, opts),
  reveal: (p) => invoke('shell:reveal', p),
  openPath: (p) => invoke('shell:openPath', p),
  gitBranch: (root) => invoke('git:branch', root),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  getKeys: () => invoke('settings:keys'),
  setKey: (provider, key) => invoke('settings:setKey', provider, key),

  getState: () => invoke('state:get'),
  setState: (patch) => invoke('state:set', patch),
  recent: () => invoke('recent:get'),
  addRecent: (p) => invoke('recent:add', p),
  removeRecent: (p) => invoke('recent:remove', p),
  loadChats: (root) => invoke('chats:load', root),
  saveChats: (root, data) => invoke('chats:save', root, data),
  getWorkspaceState: (root) => invoke('workspace:state:get', root),
  setWorkspaceState: (root, data) => invoke('workspace:state:set', root, data),

  termCreate: (opts) => invoke('term:create', opts),
  termWrite: (id, data) => send('term:write', id, data),
  termResize: (id, cols, rows) => send('term:resize', id, cols, rows),
  termKill: (id) => invoke('term:kill', id),

  agentStart: (payload) => invoke('agent:start', payload),
  agentStop: (runId) => invoke('agent:stop', runId),
  agentApprove: (runId, toolCallId, decision) => invoke('agent:approve', runId, toolCallId, decision),
  agentRevert: (runId, path) => invoke('agent:revert', runId, path),
  agentCheckpoint: (runId, path) => invoke('agent:checkpoint', runId, path),
  models: (provider, opts) => invoke('ai:models', provider, opts),
  testKey: (provider, key) => invoke('ai:testKey', provider, key),
  inlineEdit: (req) => invoke('ai:inlineEdit', req),
  autocomplete: (req) => invoke('ai:autocomplete', req),
  hasKeys: () => invoke('ai:hasKeys'),
  zoom: (dir) => invoke('app:zoom', dir),
};
