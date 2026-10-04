import { shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { watch } from 'chokidar';
import {
  IGNORED_DIRS,
  IMAGE_MIME,
  extOf,
  isBinaryBuffer,
  listAllFiles,
  searchText,
} from './fsutil.mjs';

const MAX_EDITOR_FILE = 15 * 1024 * 1024;

// One watcher per renderer (window).
const watchers = new Map();

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

async function readDir(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(abs)).isDirectory();
      } catch {}
    }
    out.push({ name: e.name, path: abs, isDir, isSymlink: e.isSymbolicLink() });
  }
  return sortEntries(out);
}

async function readFileForEditor(file) {
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) throw new Error('Is a directory');
  const ext = extOf(file);
  if (IMAGE_MIME[ext] && stat.size < 20 * 1024 * 1024) {
    const buf = await fsp.readFile(file);
    return { kind: 'image', size: stat.size, dataUrl: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`, mtime: stat.mtimeMs };
  }
  if (stat.size > MAX_EDITOR_FILE) return { kind: 'tooLarge', size: stat.size, mtime: stat.mtimeMs };
  const buf = await fsp.readFile(file);
  if (isBinaryBuffer(buf)) return { kind: 'binary', size: stat.size, mtime: stat.mtimeMs };
  let content = buf.toString('utf8');
  let bom = false;
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
    bom = true;
  }
  const lf = content.indexOf('\n');
  const eol = lf > 0 && content[lf - 1] === '\r' ? 'CRLF' : 'LF';
  return { kind: 'text', content, size: stat.size, eol, bom, mtime: stat.mtimeMs };
}

function startWatcher(sender, root) {
  stopWatcher(sender.id);
  if (!root) return;
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending.length || sender.isDestroyed()) return;
    const batch = pending;
    pending = [];
    sender.send('fs:changed', batch);
  };
  const w = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 30,
    ignored: (p) => {
      const parts = p.split(/[\\/]/);
      return parts.some((seg) => IGNORED_DIRS.has(seg) && seg !== path.basename(root));
    },
    awaitWriteFinish: false,
  });
  w.on('all', (type, p) => {
    pending.push({ type, path: p });
    if (!timer) timer = setTimeout(flush, 120);
  });
  w.on('error', (err) => console.warn('watcher error', err?.message));
  watchers.set(sender.id, w);
  sender.once('destroyed', () => stopWatcher(sender.id));
}

function stopWatcher(id) {
  const w = watchers.get(id);
  if (w) {
    w.close().catch(() => {});
    watchers.delete(id);
  }
}

export function disposeWatchers() {
  for (const id of [...watchers.keys()]) stopWatcher(id);
}

export function registerFsIpc(ipcMain) {
  ipcMain.handle('fs:readDir', (_e, dir) => readDir(dir));
  ipcMain.handle('fs:readFile', (_e, file) => readFileForEditor(file));
  ipcMain.handle('fs:readText', async (_e, file) => fsp.readFile(file, 'utf8'));
  ipcMain.handle('fs:writeFile', async (_e, file, content, { eol, bom } = {}) => {
    let text = content;
    if (eol === 'CRLF') text = text.replace(/\r?\n/g, '\r\n');
    if (bom) text = '﻿' + text;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
    const stat = await fsp.stat(file);
    return { mtime: stat.mtimeMs };
  });
  ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
  ipcMain.handle('fs:stat', async (_e, p) => {
    try {
      const s = await fsp.stat(p);
      return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  });
  ipcMain.handle('fs:createFile', async (_e, file) => {
    if (fs.existsSync(file)) throw new Error('A file or folder with that name already exists');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '');
    return true;
  });
  ipcMain.handle('fs:createDir', async (_e, dir) => {
    if (fs.existsSync(dir)) throw new Error('A file or folder with that name already exists');
    await fsp.mkdir(dir, { recursive: true });
    return true;
  });
  ipcMain.handle('fs:rename', async (_e, from, to) => {
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error('Destination already exists');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return true;
  });
  ipcMain.handle('fs:delete', async (_e, p) => {
    try {
      await shell.trashItem(p);
    } catch {
      await fsp.rm(p, { recursive: true, force: true });
    }
    return true;
  });
  ipcMain.handle('fs:copy', async (_e, from, to) => {
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    return true;
  });
  ipcMain.handle('fs:listFiles', (_e, root) => listAllFiles(root, { maxFiles: 30000 }));
  ipcMain.handle('fs:watch', (e, root) => startWatcher(e.sender, root));
  ipcMain.handle('fs:unwatch', (e) => stopWatcher(e.sender.id));
  ipcMain.handle('search:text', (_e, root, opts) => searchText(root, { ...opts, maxResults: 3000 }));
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('git:branch', (_e, root) =>
    new Promise((resolve) => {
      if (!root) return resolve(null);
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 3000, windowsHide: true }, (err, out) =>
        resolve(err ? null : String(out).trim() || null),
      );
    }),
  );
}
