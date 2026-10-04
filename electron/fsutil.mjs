import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';

export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.gradle',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.DS_Store',
]);

const BINARY_EXT = new Set(
  'png jpg jpeg gif bmp ico webp avif tiff psd pdf zip gz tgz bz2 xz 7z rar exe dll so dylib bin dat class jar war o a lib obj pdb woff woff2 ttf otf eot mp3 mp4 wav ogg flac mov avi mkv webm sqlite db pyc node wasm'.split(
    ' ',
  ),
);

export const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

export function extOf(p) {
  const e = path.extname(p).toLowerCase();
  return e ? e.slice(1) : '';
}

export function isProbablyBinaryPath(p) {
  return BINARY_EXT.has(extOf(p));
}

export function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Resolves a path given by the user/agent: relative paths are relative to the workspace root. */
export function resolvePath(root, p) {
  if (!p || p === '.') return root || process.cwd();
  let s = String(p).trim();
  if (s.startsWith('~')) s = path.join(process.env.HOME || process.env.USERPROFILE || '', s.slice(1));
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.normalize(path.join(root || process.cwd(), s));
}

export function relPath(root, abs) {
  if (!root) return abs;
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? toPosix(r) : abs;
}

// --- .gitignore support (basic, root-level only) -------------------------------------

const gitignoreCache = new Map();

export function loadGitignore(root) {
  if (!root) return () => false;
  const file = path.join(root, '.gitignore');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {}
  const cached = gitignoreCache.get(root);
  if (cached && cached.mtime === mtime) return cached.fn;
  let fn = () => false;
  if (mtime) {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    const matchers = [];
    for (let line of lines) {
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      const pattern = anchored ? line : '**/' + line;
      const m = picomatch(pattern, { dot: true });
      const inside = picomatch(pattern + '/**', { dot: true });
      matchers.push({ m, inside, dirOnly });
    }
    fn = (rel, isDir) => {
      for (const { m, inside, dirOnly } of matchers) {
        if (inside(rel)) return true;
        if (m(rel) && (!dirOnly || isDir)) return true;
      }
      return false;
    };
  }
  gitignoreCache.set(root, { mtime, fn });
  return fn;
}

/**
 * Walks a directory tree yielding files (absolute paths), skipping heavy/ignored folders.
 */
export async function* walkFiles(dir, { root = dir, useGitignore = true, maxFiles = 50000, signal } = {}) {
  const ignored = useGitignore ? loadGitignore(root) : () => false;
  const stack = [dir];
  let count = 0;
  while (stack.length) {
    if (signal?.aborted) return;
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(current, ent.name);
      const rel = toPosix(path.relative(root, abs));
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        if (ignored(rel, true)) continue;
        stack.push(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (ignored(rel, false)) continue;
        yield abs;
        if (++count >= maxFiles) return;
      }
    }
  }
}

export async function listAllFiles(root, opts = {}) {
  const out = [];
  for await (const f of walkFiles(root, { root, ...opts })) out.push(toPosix(path.relative(root, f)));
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegex({ query, isRegex, caseSensitive, wholeWord }) {
  let src = isRegex ? query : escapeRegExp(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

/**
 * Text search across the workspace. Returns [{ path, rel, matches: [{ line, col, text }] }].
 */
export async function searchText(root, opts) {
  const {
    query,
    dir = root,
    include,
    exclude,
    maxResults = 2000,
    maxPerFile = 100,
    signal,
  } = opts;
  if (!query) return { results: [], total: 0, truncated: false };
  const re = buildSearchRegex(opts);
  const inc = include ? picomatch(splitGlobs(include), { dot: true, basename: !/[\\/]/.test(include) }) : null;
  const exc = exclude ? picomatch(splitGlobs(exclude), { dot: true, basename: !/[\\/]/.test(exclude) }) : null;
  const results = [];
  let total = 0;
  let truncated = false;
  const queue = [];
  const CONCURRENCY = 16;

  const scan = async (abs) => {
    if (isProbablyBinaryPath(abs)) return;
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return;
    }
    if (stat.size > 2 * 1024 * 1024) return;
    let buf;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return;
    }
    if (isBinaryBuffer(buf)) return;
    const text = buf.toString('utf8');
    re.lastIndex = 0;
    if (!re.test(text)) return;
    const lines = text.split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < maxPerFile; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m) {
        const line = lines[i];
        matches.push({ line: i + 1, col: m.index + 1, length: m[0].length, text: line.length > 400 ? line.slice(0, 400) : line });
      }
    }
    if (matches.length) {
      total += matches.length;
      results.push({ path: abs, rel: toPosix(path.relative(root, abs)), matches });
    }
  };

  for await (const abs of walkFiles(dir, { root, signal })) {
    const rel = toPosix(path.relative(root, abs));
    if (inc && !inc(rel)) continue;
    if (exc && exc(rel)) continue;
    queue.push(scan(abs));
    if (queue.length >= CONCURRENCY) {
      await Promise.all(queue.splice(0));
      if (total >= maxResults) {
        truncated = true;
        break;
      }
    }
  }
  await Promise.all(queue);
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return { results, total, truncated };
}

function splitGlobs(s) {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function readTextFile(abs) {
  const buf = await fsp.readFile(abs);
  if (isBinaryBuffer(buf)) {
    const err = new Error('File appears to be binary');
    err.code = 'EBINARY';
    throw err;
  }
  return buf.toString('utf8');
}
