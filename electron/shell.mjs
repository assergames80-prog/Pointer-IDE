import fs from 'node:fs';
import path from 'node:path';

// Detects the user's shell for both the integrated terminal and the agent's run_command tool.

let cached = null;

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

export function detectShell() {
  if (cached) return cached;
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    if (pwsh) {
      cached = { kind: 'pwsh', path: pwsh, name: 'PowerShell 7 (pwsh)' };
    } else {
      const root = process.env.SystemRoot || 'C:\\Windows';
      const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      cached = fs.existsSync(ps)
        ? { kind: 'powershell', path: ps, name: 'Windows PowerShell 5.1' }
        : { kind: 'cmd', path: process.env.ComSpec || 'cmd.exe', name: 'cmd.exe' };
    }
  } else {
    const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    cached = { kind: 'posix', path: sh, name: path.basename(sh) };
  }
  return cached;
}

/**
 * Windows PowerShell 5.1 does not understand `cmd1 && cmd2` / `cmd1 || cmd2`.
 * Models write those constantly, so translate them into PowerShell 5 equivalents.
 */
export function translateForPowerShell5(command) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if ((c === '&' || c === '|') && command[i + 1] === c) {
      parts.push(buf.trim(), c + c);
      buf = '';
      i++;
      continue;
    }
    buf += c;
  }
  parts.push(buf.trim());
  if (parts.length === 1) return command;
  let out = parts[parts.length - 1];
  for (let i = parts.length - 3; i >= 0; i -= 2) {
    const op = parts[i + 1];
    out = op === '&&' ? `${parts[i]}; if ($?) { ${out} }` : `${parts[i]}; if (-not $?) { ${out} }`;
  }
  return out;
}

/** Returns [file, args] to run a one-off command string non-interactively. */
export function commandInvocation(command) {
  const sh = detectShell();
  if (sh.kind === 'pwsh' || sh.kind === 'powershell') {
    const body = sh.kind === 'powershell' ? translateForPowerShell5(command) : command;
    const prelude =
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ";
    return [sh.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + body]];
  }
  if (sh.kind === 'cmd') return [sh.path, ['/d', '/s', '/c', command]];
  return [sh.path, ['-lc', command]];
}

/** Returns [file, args] for an interactive terminal session. */
export function terminalInvocation() {
  const sh = detectShell();
  if (sh.kind === 'pwsh' || sh.kind === 'powershell') return [sh.path, ['-NoLogo', '-ExecutionPolicy', 'Bypass']];
  if (sh.kind === 'cmd') return [sh.path, []];
  return [sh.path, ['-l']];
}
