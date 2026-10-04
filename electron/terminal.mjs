import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { terminalInvocation, detectShell } from './shell.mjs';

const require = createRequire(import.meta.url);

let pty = null;
let ptyError = null;
try {
  pty = require('@lydell/node-pty');
} catch (err) {
  ptyError = err;
  console.warn('node-pty unavailable, falling back to pipes:', err?.message);
}

const sessions = new Map();
let nextId = 1;

function send(sender, channel, ...args) {
  if (!sender.isDestroyed()) sender.send(channel, ...args);
}

function createSession(sender, { cwd, cols = 100, rows = 30 }) {
  const id = nextId++;
  const [file, args] = terminalInvocation();
  const env = { ...process.env, TERM_PROGRAM: 'Pointer', COLORTERM: 'truecolor' };
  const dir = cwd || os.homedir();

  if (pty) {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dir,
      env,
      useConpty: true,
    });
    proc.onData((d) => send(sender, 'term:data', id, d));
    proc.onExit(({ exitCode }) => {
      sessions.delete(id);
      send(sender, 'term:exit', id, exitCode);
    });
    sessions.set(id, {
      owner: sender.id,
      write: (d) => proc.write(d),
      resize: (c, r) => {
        try {
          proc.resize(Math.max(c, 2), Math.max(r, 2));
        } catch {}
      },
      kill: () => {
        try {
          proc.kill();
        } catch {}
      },
    });
  } else {
    // Fallback without a PTY: line-buffered shell over pipes.
    const proc = spawn(file, args, { cwd: dir, env, windowsHide: true });
    const onOut = (d) => send(sender, 'term:data', id, d.toString('utf8').replace(/\r?\n/g, '\r\n'));
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('exit', (code) => {
      sessions.delete(id);
      send(sender, 'term:exit', id, code);
    });
    let line = '';
    sessions.set(id, {
      owner: sender.id,
      write: (d) => {
        for (const ch of d) {
          if (ch === '\r') {
            send(sender, 'term:data', id, '\r\n');
            proc.stdin.write(line + '\n');
            line = '';
          } else if (ch === '\x7f') {
            if (line) {
              line = line.slice(0, -1);
              send(sender, 'term:data', id, '\b \b');
            }
          } else if (ch === '\x03') {
            proc.kill('SIGINT');
          } else {
            line += ch;
            send(sender, 'term:data', id, ch);
          }
        }
      },
      resize: () => {},
      kill: () => proc.kill(),
    });
    send(sender, 'term:data', id, `\x1b[33m[Pointer] Limited terminal mode (no PTY): ${ptyError?.message || ''}\x1b[0m\r\n`);
  }
  return { id, shell: detectShell().name };
}

const trackedSenders = new Set();

export function registerTerminalIpc(ipcMain) {
  ipcMain.handle('term:create', (e, opts) => {
    const res = createSession(e.sender, opts || {});
    const senderId = e.sender.id;
    if (!trackedSenders.has(senderId)) {
      trackedSenders.add(senderId);
      e.sender.once('destroyed', () => {
        trackedSenders.delete(senderId);
        for (const [id, s] of sessions) {
          if (s.owner === senderId) {
            s.kill();
            sessions.delete(id);
          }
        }
      });
    }
    return res;
  });
  ipcMain.on('term:write', (_e, id, data) => sessions.get(id)?.write(data));
  ipcMain.on('term:resize', (_e, id, cols, rows) => sessions.get(id)?.resize(cols, rows));
  ipcMain.handle('term:kill', (_e, id) => {
    sessions.get(id)?.kill();
    sessions.delete(id);
  });
}

export function disposeTerminals() {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}
