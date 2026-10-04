// Agent tools. These act on the user's real machine: real files, real shell. No sandbox.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { shell } from 'electron';
import picomatch from 'picomatch';
import { diffLines, createTwoFilesPatch } from 'diff';
import {
  IGNORED_DIRS,
  isBinaryBuffer,
  listAllFiles,
  relPath,
  resolvePath,
  searchText,
  toPosix,
} from '../fsutil.mjs';
import { commandInvocation } from '../shell.mjs';

// ---------------------------------------------------------------------------------------
// Tool schemas (JSON Schema subset understood by both Gemini and Groq)
// ---------------------------------------------------------------------------------------

const S = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOL_DEFS = [
  {
    name: 'list_dir',
    readOnly: true,
    description:
      'List files and folders as a tree. Use it to explore the project structure. Heavy folders such as node_modules and .git are listed but not expanded.',
    parameters: S(
      {
        path: str('Directory path, relative to the workspace root or absolute. Defaults to the workspace root.'),
        depth: int('How many levels deep to list (1-5). Default 2.'),
      },
      [],
    ),
  },
  {
    name: 'read_file',
    readOnly: true,
    description:
      'Read a text file. Output lines are prefixed with "<line number>| " — the prefix is NOT part of the file. For large files, read specific ranges with start_line/end_line.',
    parameters: S(
      {
        path: str('File path, relative to the workspace root or absolute.'),
        start_line: int('First line to read (1-based, inclusive). Optional.'),
        end_line: int('Last line to read (1-based, inclusive). Optional.'),
      },
      ['path'],
    ),
  },
  {
    name: 'search_text',
    readOnly: true,
    description:
      'Search file contents across the project (like grep/ripgrep). Returns matching lines as "path:line: text". Respects .gitignore.',
    parameters: S(
      {
        pattern: str('Text or regular expression (JavaScript syntax) to search for.'),
        path: str('Directory to search in. Defaults to the workspace root.'),
        include: str('Optional glob(s) to limit files, comma separated, e.g. "*.ts,*.tsx" or "src/**".'),
        regex: bool('Treat pattern as a regular expression. Default true.'),
        case_sensitive: bool('Case-sensitive search. Default false.'),
      },
      ['pattern'],
    ),
  },
  {
    name: 'find_files',
    readOnly: true,
    description:
      'Find files by name or glob pattern (e.g. "**/*.test.js", "package.json", "button"). Plain text does a case-insensitive substring match on the path.',
    parameters: S({ pattern: str('Glob pattern or part of a file name/path.') }, ['pattern']),
  },
  {
    name: 'write_file',
    readOnly: false,
    description:
      'Create a new file or completely overwrite an existing one with the given content. Parent folders are created automatically. Prefer edit_file for small changes to existing files.',
    parameters: S(
      {
        path: str('File path, relative to the workspace root or absolute.'),
        content: str('The full content of the file.'),
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'edit_file',
    readOnly: false,
    description:
      'Edit an existing file by replacing an exact snippet. old_string must match the file exactly (including indentation) and be unique unless replace_all is true — include a few surrounding lines to make it unique. Do not include the line-number prefixes from read_file. To create a new file use write_file.',
    parameters: S(
      {
        path: str('File path, relative to the workspace root or absolute.'),
        old_string: str('The exact text to replace.'),
        new_string: str('The replacement text.'),
        replace_all: bool('Replace every occurrence of old_string. Default false.'),
      },
      ['path', 'old_string', 'new_string'],
    ),
  },
  {
    name: 'delete_path',
    readOnly: false,
    description: 'Delete a file or folder (it is moved to the Recycle Bin / Trash when possible).',
    parameters: S({ path: str('Path to delete, relative to the workspace root or absolute.') }, ['path']),
  },
  {
    name: 'move_path',
    readOnly: false,
    description: 'Move or rename a file or folder.',
    parameters: S(
      {
        source: str('Existing path.'),
        destination: str('New path.'),
      },
      ['source', 'destination'],
    ),
  },
  {
    name: 'run_command',
    readOnly: false,
    description:
      'Run a shell command on the user\'s machine and return its output and exit code. Use it to install dependencies, build, run tests, use git, etc. Commands must be non-interactive (pass flags like -y / --yes). For servers, watchers or anything that keeps running, set background to true.',
    parameters: S(
      {
        command: str('The command line to execute.'),
        cwd: str('Working directory, relative to the workspace root or absolute. Defaults to the workspace root.'),
        timeout_seconds: int('Kill the command after this many seconds (foreground only). Default 300.'),
        background: bool('Start the command in the background and return immediately with its initial output (for dev servers, watchers).'),
      },
      ['command'],
    ),
  },
  {
    name: 'process_control',
    readOnly: false,
    description: 'Inspect or stop background processes started with run_command(background: true).',
    parameters: S(
      {
        action: { type: 'string', enum: ['list', 'output', 'kill'], description: 'list | output | kill' },
        id: int('Background process id (for output / kill).'),
      },
      ['action'],
    ),
  },
  {
    name: 'web_fetch',
    readOnly: true,
    description: 'Fetch a web page or API URL and return its text content (HTML is converted to plain text). Useful for reading documentation.',
    parameters: S({ url: str('The http(s) URL to fetch.') }, ['url']),
  },
];

export function getToolDefs(mode) {
  const defs = mode === 'ask' ? TOOL_DEFS.filter((t) => t.readOnly) : TOOL_DEFS;
  return defs.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function requiresApproval(name, settings) {
  if (settings.autoRun === 'auto') return false;
  return name === 'run_command' || name === 'delete_path';
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const MAX_OUTPUT = 16000;

function truncateMiddle(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n... [${text.length - max} characters truncated] ...\n\n${text.slice(-tail)}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export function stripAnsi(s) {
  return s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function numbered(lines, start) {
  const width = String(start + lines.length - 1).length;
  return lines
    .map((l, i) => `${String(start + i).padStart(width)}| ${l.length > 2000 ? l.slice(0, 2000) + ' …[line truncated]' : l}`)
    .join('\n');
}

function makeDiff(rel, before, after) {
  const b = before ?? '';
  const a = after ?? '';
  if (b.length + a.length > 3_000_000) return { added: 0, removed: 0, diff: '(file too large to diff)' };
  let added = 0;
  let removed = 0;
  for (const part of diffLines(b, a)) {
    if (part.added) added += part.count || 0;
    else if (part.removed) removed += part.count || 0;
  }
  let patch = createTwoFilesPatch(rel, rel, b, a, '', '', { context: 3 });
  patch = patch
    .split('\n')
    .filter((l, i) => i > 3 || !(l.startsWith('===') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('Index:')))
    .join('\n');
  const lines = patch.split('\n');
  if (lines.length > 600) patch = lines.slice(0, 600).join('\n') + `\n… (${lines.length - 600} more diff lines)`;
  return { added, removed, diff: patch };
}

async function readMaybe(abs) {
  try {
    const buf = await fsp.readFile(abs);
    if (isBinaryBuffer(buf)) return { exists: true, binary: true };
    return { exists: true, text: buf.toString('utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false };
    throw e;
  }
}

function snippetAround(text, index, length) {
  const before = text.slice(0, index);
  const startLine = before.split('\n').length;
  const lines = text.split('\n');
  const endLine = startLine + text.slice(index, index + length).split('\n').length - 1;
  const from = Math.max(1, startLine - 3);
  const to = Math.min(lines.length, endLine + 3);
  return numbered(lines.slice(from - 1, to), from);
}

// ---------------------------------------------------------------------------------------
// Checkpoints (for "Undo" of agent edits)
// ---------------------------------------------------------------------------------------

const checkpoints = new Map(); // runId -> Map(absPath -> { before: string|null })

function recordCheckpoint(runId, abs, before) {
  if (!runId) return;
  if (!checkpoints.has(runId)) checkpoints.set(runId, new Map());
  const m = checkpoints.get(runId);
  if (!m.has(abs)) m.set(abs, { before });
}

export async function revertRun(runId, onlyPath) {
  const m = checkpoints.get(runId);
  if (!m) return { reverted: [], missing: true };
  const reverted = [];
  for (const [abs, { before }] of [...m.entries()].reverse()) {
    if (onlyPath && path.normalize(onlyPath) !== abs) continue;
    try {
      if (before === null) await fsp.rm(abs, { force: true });
      else {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, before, 'utf8');
      }
      reverted.push(abs);
      m.delete(abs);
    } catch (e) {
      console.warn('revert failed', abs, e.message);
    }
  }
  if (!m.size) checkpoints.delete(runId);
  return { reverted };
}

/** Content of a file before a run touched it: string, null (file was created), or undefined (unknown). */
export function getCheckpointBefore(runId, abs) {
  const entry = checkpoints.get(runId)?.get(path.normalize(abs));
  return entry ? entry.before : undefined;
}

export function hasCheckpoint(runId) {
  return checkpoints.has(runId) && checkpoints.get(runId).size > 0;
}

// ---------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 2500).unref?.();
  }
}

function commandEnv() {
  return {
    ...process.env,
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_yes: 'true',
    FORCE_COLOR: '0',
    TERM_PROGRAM: 'Pointer',
  };
}

const background = new Map(); // id -> { id, command, cwd, child, output, exitCode, startedAt }
let nextBgId = 1;

export function killAllBackground() {
  for (const p of background.values()) killTree(p.child);
  background.clear();
}

// ---------------------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------------------

const impl = {
  async list_dir(args, ctx) {
    const abs = resolvePath(ctx.root, args.path);
    const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 5);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return err(`Directory not found: ${abs}`);
    if (!stat.isDirectory()) return err(`Not a directory: ${abs}`);
    const lines = [];
    let count = 0;
    const LIMIT = 500;
    const walk = async (dir, level, indent) => {
      if (count >= LIMIT) return;
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const e of ents) {
        if (count >= LIMIT) {
          lines.push(`${indent}… (listing truncated)`);
          return;
        }
        count++;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) {
            lines.push(`${indent}${e.name}/ (not expanded)`);
            continue;
          }
          lines.push(`${indent}${e.name}/`);
          if (level < depth) await walk(p, level + 1, indent + '  ');
        } else {
          let size = '';
          try {
            size = ` (${formatSize((await fsp.stat(p)).size)})`;
          } catch {}
          lines.push(`${indent}${e.name}${size}`);
        }
      }
    };
    await walk(abs, 1, '');
    const rel = relPath(ctx.root, abs);
    return {
      output: `${rel === abs ? abs : rel === '' ? './' : rel + '/'}\n${lines.join('\n') || '(empty directory)'}`,
      ui: { kind: 'list', path: abs, rel, count },
    };
  },

  async read_file(args, ctx) {
    if (!args.path) return err('path is required');
    const abs = resolvePath(ctx.root, args.path);
    const r = await readMaybe(abs);
    if (!r.exists) return err(`File not found: ${abs}`);
    if (r.binary) return err(`${abs} is a binary file and cannot be read as text.`);
    const lines = r.text.split(/\r?\n/);
    const total = lines.length;
    let start = Math.max(1, Number(args.start_line) || 1);
    let end = Math.min(total, Number(args.end_line) || total);
    const MAX_LINES = 1500;
    let note = '';
    if (end - start + 1 > MAX_LINES) {
      end = start + MAX_LINES - 1;
      note = `\n\n[Showing lines ${start}-${end} of ${total}. Use start_line/end_line to read more.]`;
    }
    if (start > total) return err(`start_line ${start} is past the end of the file (${total} lines).`);
    let body = numbered(lines.slice(start - 1, end), start);
    if (body.length > 120000) {
      body = body.slice(0, 120000);
      note += '\n\n[Output truncated: file has very long lines.]';
    }
    const rel = relPath(ctx.root, abs);
    return {
      output: `${rel} (${total} lines)\n${body}${note}`,
      ui: { kind: 'read', path: abs, rel, startLine: start, endLine: end, totalLines: total },
    };
  },

  async search_text(args, ctx) {
    if (!args.pattern) return err('pattern is required');
    const dir = resolvePath(ctx.root, args.path);
    const root = ctx.root && dir.startsWith(ctx.root) ? ctx.root : dir;
    let res;
    try {
      res = await searchText(root, {
        query: args.pattern,
        dir,
        isRegex: args.regex !== false,
        caseSensitive: !!args.case_sensitive,
        include: args.include,
        maxResults: 300,
        maxPerFile: 30,
        signal: ctx.signal,
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        res = await searchText(root, { query: args.pattern, dir, isRegex: false, caseSensitive: !!args.case_sensitive, include: args.include, maxResults: 300, maxPerFile: 30, signal: ctx.signal });
      } else throw e;
    }
    const out = [];
    for (const f of res.results) {
      for (const m of f.matches) out.push(`${f.rel}:${m.line}: ${m.text.trim().slice(0, 300)}`);
    }
    const shown = out.slice(0, 250);
    let text = shown.join('\n') || 'No matches found.';
    if (out.length > shown.length || res.truncated) text += `\n\n[Results truncated — ${res.total}+ matches in ${res.results.length} files. Narrow the search.]`;
    return {
      output: text,
      ui: { kind: 'search', query: args.pattern, count: res.total, files: res.results.length },
    };
  },

  async find_files(args, ctx) {
    if (!args.pattern) return err('pattern is required');
    if (!ctx.root) return err('No workspace folder is open.');
    const files = await listAllFiles(ctx.root, { maxFiles: 60000, signal: ctx.signal });
    const pat = String(args.pattern).trim();
    let matches;
    if (/[*?[\]{}]/.test(pat)) {
      const isMatch = picomatch(pat, { dot: true, basename: !pat.includes('/'), nocase: true });
      matches = files.filter((f) => isMatch(f));
    } else {
      const q = pat.toLowerCase().replace(/\\/g, '/');
      matches = files.filter((f) => f.toLowerCase().includes(q));
    }
    const shown = matches.slice(0, 200);
    let text = shown.join('\n') || 'No files found.';
    if (matches.length > shown.length) text += `\n\n[${matches.length - shown.length} more results not shown]`;
    return { output: text, ui: { kind: 'find', pattern: pat, count: matches.length } };
  },

  async write_file(args, ctx) {
    if (!args.path) return err('path is required');
    if (typeof args.content !== 'string') return err('content must be a string');
    const abs = resolvePath(ctx.root, args.path);
    const prev = await readMaybe(abs);
    if (prev.exists && prev.binary) return err(`${abs} is a binary file; refusing to overwrite it with text.`);
    if (prev.exists && (await fsp.stat(abs)).isDirectory()) return err(`${abs} is a directory.`);
    let content = args.content;
    // Keep Windows line endings if the existing file uses them.
    if (prev.exists && /\r\n/.test(prev.text || '') && !/\r\n/.test(content)) content = content.replace(/\n/g, '\r\n');
    recordCheckpoint(ctx.runId, abs, prev.exists ? prev.text : null);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    ctx.onFileChanged?.(abs, content);
    const rel = relPath(ctx.root, abs);
    const d = makeDiff(rel, prev.exists ? prev.text : '', content);
    const lineCount = content.split('\n').length;
    return {
      output: prev.exists ? `Updated ${rel} (${lineCount} lines).` : `Created ${rel} (${lineCount} lines).`,
      ui: { kind: 'edit', path: abs, rel, created: !prev.exists, ...d },
    };
  },

  async edit_file(args, ctx) {
    if (!args.path) return err('path is required');
    const abs = resolvePath(ctx.root, args.path);
    const prev = await readMaybe(abs);
    const oldStr = args.old_string ?? '';
    const newStr = args.new_string ?? '';
    if (!prev.exists) {
      if (oldStr === '') return impl.write_file({ path: args.path, content: newStr }, ctx);
      return err(`File not found: ${abs}. Use write_file to create new files.`);
    }
    if (prev.binary) return err(`${abs} is a binary file.`);
    if (oldStr === newStr) return err('old_string and new_string are identical — nothing to change.');
    const text = prev.text;
    const crlf = /\r\n/.test(text);
    const fix = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
    const o = fix(oldStr);
    const n = fix(newStr);
    if (!o) return err('old_string is empty. To overwrite the whole file use write_file.');

    let next;
    let count = text.split(o).length - 1;
    let note = '';
    let idx = -1;
    if (count === 1 || (count > 1 && args.replace_all)) {
      idx = text.indexOf(o);
      next = args.replace_all ? text.split(o).join(n) : text.slice(0, idx) + n + text.slice(idx + o.length);
    } else if (count > 1) {
      return err(
        `old_string matches ${count} places in ${relPath(ctx.root, abs)}. Include more surrounding lines to make it unique, or set replace_all to true.`,
      );
    } else {
      // Fallback: match ignoring trailing whitespace / indentation differences, line by line.
      const eol = crlf ? '\r\n' : '\n';
      const fileLines = text.split(eol);
      const oldLines = o.split(eol);
      while (oldLines.length && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();
      const tryMatch = (norm) => {
        const target = oldLines.map(norm);
        const hits = [];
        for (let i = 0; i + target.length <= fileLines.length; i++) {
          let ok = true;
          for (let j = 0; j < target.length; j++) {
            if (norm(fileLines[i + j]) !== target[j]) {
              ok = false;
              break;
            }
          }
          if (ok) hits.push(i);
        }
        return hits;
      };
      let hits = tryMatch((l) => l.trimEnd());
      if (hits.length !== 1) hits = tryMatch((l) => l.trim());
      if (hits.length === 1 && oldLines.length) {
        const i = hits[0];
        const newLines = n.split(eol);
        if (newLines.length && newLines[newLines.length - 1].trim() === '' && n.endsWith(eol)) newLines.pop();
        const merged = [...fileLines.slice(0, i), ...newLines, ...fileLines.slice(i + oldLines.length)];
        next = merged.join(eol);
        idx = fileLines.slice(0, i).join(eol).length + (i > 0 ? eol.length : 0);
        count = 1;
        note = ' (matched ignoring whitespace differences — verify indentation)';
      } else {
        return err(
          `old_string was not found in ${relPath(ctx.root, abs)}. It must match the file content exactly, including whitespace and indentation. Read the file again (read_file) and retry with the exact text.`,
        );
      }
    }
    recordCheckpoint(ctx.runId, abs, text);
    await fsp.writeFile(abs, next, 'utf8');
    ctx.onFileChanged?.(abs, next);
    const rel = relPath(ctx.root, abs);
    const d = makeDiff(rel, text, next);
    const snippet = args.replace_all ? '' : `\n\nUpdated region:\n${snippetAround(next.replace(/\r\n/g, '\n'), next.slice(0, idx).replace(/\r\n/g, '\n').length, n.replace(/\r\n/g, '\n').length)}`;
    return {
      output: `Edited ${rel}: replaced ${count} occurrence${count === 1 ? '' : 's'}${note}.${snippet}`,
      ui: { kind: 'edit', path: abs, rel, created: false, ...d },
    };
  },

  async delete_path(args, ctx) {
    if (!args.path) return err('path is required');
    const abs = resolvePath(ctx.root, args.path);
    if (ctx.root && path.normalize(abs) === path.normalize(ctx.root)) return err('Refusing to delete the entire workspace folder.');
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return err(`Path not found: ${abs}`);
    if (stat.isFile()) {
      const prev = await readMaybe(abs);
      if (prev.text !== undefined) recordCheckpoint(ctx.runId, abs, prev.text);
    }
    let trashed = true;
    try {
      await shell.trashItem(abs);
    } catch {
      trashed = false;
      await fsp.rm(abs, { recursive: true, force: true });
    }
    ctx.onFileChanged?.(abs, null);
    const rel = relPath(ctx.root, abs);
    return {
      output: `Deleted ${rel}${stat.isDirectory() ? ' (folder)' : ''}${trashed ? ' — moved to the Recycle Bin/Trash' : ''}.`,
      ui: { kind: 'delete', path: abs, rel, isDir: stat.isDirectory() },
    };
  },

  async move_path(args, ctx) {
    if (!args.source || !args.destination) return err('source and destination are required');
    const from = resolvePath(ctx.root, args.source);
    const to = resolvePath(ctx.root, args.destination);
    if (!fs.existsSync(from)) return err(`Source not found: ${from}`);
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) return err(`Destination already exists: ${to}`);
    const stat = await fsp.stat(from);
    if (stat.isFile()) {
      const prev = await readMaybe(from);
      if (prev.text !== undefined) {
        recordCheckpoint(ctx.runId, from, prev.text);
        recordCheckpoint(ctx.runId, to, null);
      }
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    ctx.onFileChanged?.(from, null);
    ctx.onFileChanged?.(to, undefined);
    return {
      output: `Moved ${relPath(ctx.root, from)} → ${relPath(ctx.root, to)}.`,
      ui: { kind: 'move', from, to, fromRel: relPath(ctx.root, from), toRel: relPath(ctx.root, to) },
    };
  },

  async run_command(args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) return err('command is required');
    const cwd = resolvePath(ctx.root, args.cwd);
    if (!fs.existsSync(cwd)) return err(`Working directory does not exist: ${cwd}`);
    const [file, argv] = commandInvocation(command);
    const child = spawn(file, argv, {
      cwd,
      env: commandEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (args.background) {
      const id = nextBgId++;
      const entry = { id, command, cwd, child, output: '', exitCode: null, startedAt: Date.now() };
      background.set(id, entry);
      const onData = (d) => {
        entry.output = (entry.output + stripAnsi(d.toString('utf8'))).slice(-200000);
        ctx.onOutput?.(stripAnsi(d.toString('utf8')));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => (entry.exitCode = code ?? -1));
      child.on('error', (e) => {
        entry.output += `\n[spawn error] ${e.message}`;
        entry.exitCode = -1;
      });
      await new Promise((r) => {
        const t = setTimeout(r, 6000);
        child.once('exit', () => {
          clearTimeout(t);
          setTimeout(r, 100);
        });
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          r();
        });
      });
      const status = entry.exitCode === null ? `running (pid ${child.pid})` : `exited with code ${entry.exitCode}`;
      return {
        output: `Background process #${id} ${status}.\nCommand: ${command}\nOutput so far:\n${truncateMiddle(entry.output.trim(), 6000) || '(no output yet)'}\n\nUse process_control to check output or stop it.`,
        ui: { kind: 'command', command, cwd, background: true, bgId: id, exitCode: entry.exitCode, output: truncateMiddle(entry.output, 20000) },
      };
    }

    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || ctx.settings.commandTimeout || 300, 5), 3600);
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let pendingEmit = '';
    let emitTimer = null;
    const flushEmit = () => {
      emitTimer = null;
      if (pendingEmit) ctx.onOutput?.(pendingEmit);
      pendingEmit = '';
    };
    const onData = (d) => {
      const s = stripAnsi(d.toString('utf8'));
      if (output.length < 2_000_000) output += s;
      pendingEmit += s;
      if (!emitTimer) emitTimer = setTimeout(flushEmit, 80);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSec * 1000);
      const onAbort = () => {
        cancelled = true;
        killTree(child);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        output += `\n[Failed to start: ${e.message}]`;
        clearTimeout(timer);
        resolve(-1);
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(code ?? (sig ? 128 : -1));
      });
    });
    if (emitTimer) {
      clearTimeout(emitTimer);
      flushEmit();
    }
    let text = output.trim();
    if (timedOut) text += `\n\n[Command timed out after ${timeoutSec}s and was terminated. For long-running processes use background: true.]`;
    if (cancelled) text += '\n\n[Command cancelled by the user.]';
    return {
      output: `Exit code: ${exitCode}\n${truncateMiddle(text) || '(no output)'}`,
      isError: false,
      ui: { kind: 'command', command, cwd, exitCode, timedOut, cancelled, output: truncateMiddle(text, 30000) },
    };
  },

  async process_control(args) {
    const action = args.action;
    if (action === 'list') {
      if (!background.size) return { output: 'No background processes.', ui: { kind: 'process', action } };
      const rows = [...background.values()].map(
        (p) => `#${p.id} ${p.exitCode === null ? 'running' : `exited(${p.exitCode})`}  ${p.command}  (cwd: ${p.cwd})`,
      );
      return { output: rows.join('\n'), ui: { kind: 'process', action } };
    }
    const p = background.get(Number(args.id));
    if (!p) return err(`No background process with id ${args.id}.`);
    if (action === 'output') {
      return {
        output: `#${p.id} ${p.exitCode === null ? 'running' : `exited with code ${p.exitCode}`}\n${truncateMiddle(p.output.trim(), 10000) || '(no output)'}`,
        ui: { kind: 'process', action, id: p.id },
      };
    }
    if (action === 'kill') {
      killTree(p.child);
      background.delete(p.id);
      return { output: `Stopped background process #${p.id}.`, ui: { kind: 'process', action, id: p.id } };
    }
    return err(`Unknown action: ${action}`);
  },

  async web_fetch(args, ctx) {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return err('url must start with http:// or https://');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25000);
    ctx.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Pointer IDE agent)', Accept: 'text/html,application/json,text/plain,*/*' },
      });
      const type = res.headers.get('content-type') || '';
      let body = await res.text();
      if (/html/i.test(type)) body = htmlToText(body);
      return {
        output: `HTTP ${res.status} ${url}\n\n${truncateMiddle(body.trim(), 30000)}`,
        ui: { kind: 'fetch', url, status: res.status },
      };
    } catch (e) {
      return err(`Fetch failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  },
};

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}

function err(message) {
  return { output: `Error: ${message}`, isError: true, ui: { kind: 'error', message } };
}

export async function executeTool(name, args, ctx) {
  const fn = impl[name];
  if (!fn) return err(`Unknown tool "${name}". Available tools: ${TOOL_DEFS.map((t) => t.name).join(', ')}`);
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    return err(e?.message || String(e));
  }
}

export { toPosix };
