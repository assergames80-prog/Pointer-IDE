import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Small JSON stores in userData: UI state, recent folders, and per-workspace chat history.

function dataDir(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function workspaceId(root) {
  return crypto.createHash('sha1').update(String(root || 'no-workspace').toLowerCase()).digest('hex').slice(0, 16);
}

export function registerStateIpc(ipcMain) {
  const stateFile = dataDir('state.json');

  ipcMain.handle('state:get', () => readJson(stateFile, {}));
  ipcMain.handle('state:set', (_e, patch) => {
    const next = { ...readJson(stateFile, {}), ...patch };
    writeJson(stateFile, next);
    return next;
  });

  ipcMain.handle('recent:get', () => readJson(dataDir('recent.json'), []).filter((p) => fs.existsSync(p)));
  ipcMain.handle('recent:add', (_e, folder) => {
    const list = readJson(dataDir('recent.json'), []).filter((p) => p !== folder);
    list.unshift(folder);
    writeJson(dataDir('recent.json'), list.slice(0, 15));
    try {
      app.addRecentDocument(folder);
    } catch {}
    return list;
  });
  ipcMain.handle('recent:remove', (_e, folder) => {
    const list = readJson(dataDir('recent.json'), []).filter((p) => p !== folder);
    writeJson(dataDir('recent.json'), list);
    return list;
  });

  ipcMain.handle('chats:load', (_e, root) => readJson(dataDir('chats', workspaceId(root) + '.json'), null));
  ipcMain.handle('chats:save', (_e, root, data) => {
    writeJson(dataDir('chats', workspaceId(root) + '.json'), data);
    return true;
  });

  ipcMain.handle('workspace:state:get', (_e, root) => readJson(dataDir('workspaces', workspaceId(root) + '.json'), {}));
  ipcMain.handle('workspace:state:set', (_e, root, data) => {
    writeJson(dataDir('workspaces', workspaceId(root) + '.json'), data);
    return true;
  });
}
