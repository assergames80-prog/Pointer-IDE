import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerSettingsIpc, getSettings } from './settings.mjs';
import { registerFsIpc, disposeWatchers } from './fsService.mjs';
import { registerTerminalIpc, disposeTerminals } from './terminal.mjs';
import { registerAgentIpc, disposeAgentRuns } from './agent/agent.mjs';
import { registerStateIpc } from './state.mjs';
import { killAllBackground } from './agent/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.POINTER_DEV === '1';
const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

app.setName('Pointer');
if (process.platform === 'win32') app.setAppUserModelId('com.pointer.ide');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
]);

const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob: https:",
  "font-src 'self' app: data:",
  "worker-src 'self' app: blob:",
  "connect-src 'self' app:",
].join('; ');

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (!rel || rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(rendererDir, rel));
    if (!filePath.startsWith(rendererDir)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    if (filePath.endsWith('.html')) {
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  });
}

const windows = new Set();

export function createWindow() {
  const settings = getSettings();
  const dark = settings.theme !== 'light';
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 520,
    show: false,
    title: 'Pointer',
    backgroundColor: dark ? '#181818' : '#f8f8f8',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? true
        : { color: dark ? '#181818' : '#f3f3f3', symbolColor: dark ? '#cccccc' : '#333333', height: 36 },
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  windows.add(win);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => windows.delete(win));

  // Links clicked in chat/markdown open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !url.startsWith('http://localhost:5173')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadURL('app://pointer/index.html');
  return win;
}

function registerAppIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    electron: process.versions.electron,
    argvFolder: getArgvFolder(),
  }));
  ipcMain.handle('app:newWindow', () => {
    createWindow();
  });
  ipcMain.handle('app:toggleDevTools', (e) => e.sender.toggleDevTools());
  ipcMain.handle('app:reload', (e) => e.sender.reload());
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:zoom', (e, dir) => {
    const wc = e.sender;
    wc.setZoomLevel(dir === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + dir * 0.5)));
  });
  ipcMain.handle('app:setTitleBarTheme', (e, theme) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || process.platform === 'darwin') return;
    try {
      win.setTitleBarOverlay(
        theme === 'light'
          ? { color: '#f3f3f3', symbolColor: '#333333' }
          : { color: '#181818', symbolColor: '#cccccc' },
      );
      win.setBackgroundColor(theme === 'light' ? '#f8f8f8' : '#181818');
    } catch {}
  });
  ipcMain.handle('app:setTitle', (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setTitle(title);
  });
  ipcMain.handle('dialog:openFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:saveFile', async (e, defaultPath) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('dialog:confirm', async (e, { message, detail, buttons }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      message,
      detail,
      buttons: buttons || ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: (buttons || ['OK', 'Cancel']).length - 1,
    });
    return r.response;
  });
}

/** A folder passed on the command line (e.g. `Pointer.exe C:\code\project`). */
function getArgvFolder() {
  const args = process.argv.slice(1).filter((a) => !a.startsWith('-') && a !== '.');
  const appPath = path.resolve(app.getAppPath());
  for (const a of args) {
    try {
      const p = path.resolve(a);
      if (p === appPath || p === path.dirname(process.execPath)) continue;
      if (fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = windows;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }
    nativeTheme.themeSource = getSettings().theme === 'light' ? 'light' : 'dark';
    registerAppProtocol();
    registerAppIpc();
    registerSettingsIpc(ipcMain);
    registerStateIpc(ipcMain);
    registerFsIpc(ipcMain);
    registerTerminalIpc(ipcMain);
    registerAgentIpc(ipcMain);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    disposeAgentRuns();
    disposeTerminals();
    disposeWatchers();
    killAllBackground();
  });
}
