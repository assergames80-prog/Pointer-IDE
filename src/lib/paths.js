// Path helpers that work for both Windows ("C:\a\b") and POSIX ("/a/b") paths in the renderer.

export function sepOf(p) {
  return p && p.includes('\\') && !p.includes('/') ? '\\' : p && /^[A-Za-z]:/.test(p) ? '\\' : '/';
}

export function basename(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function dirname(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i <= 0) return p.slice(0, i + 1) || p;
  const d = p.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
}

export function join(base, ...parts) {
  const sep = sepOf(base);
  let out = base.replace(/[\\/]+$/, '');
  for (const part of parts) {
    if (!part) continue;
    out += sep + part.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep);
  }
  return out;
}

export function normalize(p) {
  return p ? p.replace(/[\\/]+$/, '') : p;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const na = normalize(a).replace(/\\/g, '/');
  const nb = normalize(b).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function isInside(parent, child) {
  if (!parent || !child) return false;
  const p = normalize(parent).replace(/\\/g, '/');
  const c = child.replace(/\\/g, '/');
  const win = /^[A-Za-z]:/.test(p);
  return win ? c.toLowerCase().startsWith(p.toLowerCase() + '/') : c.startsWith(p + '/');
}

export function relative(root, p) {
  if (!root || !p) return p || '';
  if (samePath(root, p)) return '';
  if (!isInside(root, p)) return p;
  return p.slice(normalize(root).length + 1).replace(/\\/g, '/');
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}
