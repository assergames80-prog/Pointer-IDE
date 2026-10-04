import { monaco, languageForPath } from './monaco';
import { api } from './api';
import { basename } from './paths';

// Monaco models live outside React. Key = absolute file path, or "untitled:N" for new files.
const entries = new Map();
let onDirtyChange = () => {};

export function setDirtyListener(fn) {
  onDirtyChange = fn;
}

function attach(key, entry) {
  entries.set(key, entry);
  let lastDirty = false;
  entry.disposeListener = entry.model.onDidChangeContent(() => {
    const dirty = isDirty(key);
    if (dirty !== lastDirty) {
      lastDirty = dirty;
      onDirtyChange(key, dirty);
    }
    entry.onChange?.();
  });
  entry.resetDirtyTracking = () => {
    lastDirty = false;
  };
}

export function getEntry(key) {
  return entries.get(key);
}

export function getModel(key) {
  return entries.get(key)?.model || null;
}

export function allEntries() {
  return [...entries.entries()];
}

/** Loads a file from disk into a Monaco model (or returns a non-text descriptor). */
export async function openModel(path) {
  const existing = entries.get(path);
  if (existing) return { kind: 'text', entry: existing };
  const res = await api.readFile(path);
  if (res.kind !== 'text') return res;
  // A model could have been created while we awaited.
  if (entries.get(path)) return { kind: 'text', entry: entries.get(path) };
  const uri = monaco.Uri.file(path);
  const stale = monaco.editor.getModel(uri);
  if (stale) stale.dispose();
  const model = monaco.editor.createModel(res.content, languageForPath(path), uri);
  model.setEOL(res.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  const entry = { model, savedVersion: model.getAlternativeVersionId(), eol: res.eol, bom: res.bom, mtime: res.mtime, viewState: null, path };
  attach(path, entry);
  return { kind: 'text', entry };
}

let untitledCounter = 1;
export function createUntitled(content = '', language = 'plaintext') {
  const n = untitledCounter++;
  const key = `untitled:${n}`;
  const model = monaco.editor.createModel(content, language, monaco.Uri.parse(`untitled:///Untitled-${n}`));
  const entry = { model, savedVersion: content ? -1 : model.getAlternativeVersionId(), eol: 'LF', bom: false, viewState: null, path: null, untitled: true };
  attach(key, entry);
  return { key, title: `Untitled-${n}` };
}

export function isDirty(key) {
  const e = entries.get(key);
  if (!e) return false;
  return e.model.getAlternativeVersionId() !== e.savedVersion;
}

export function markSaved(key) {
  const e = entries.get(key);
  if (!e) return;
  e.savedVersion = e.model.getAlternativeVersionId();
  e.resetDirtyTracking?.();
  onDirtyChange(key, false);
}

export async function saveModel(key, { formatter } = {}) {
  const e = entries.get(key);
  if (!e || !e.path) return false;
  if (formatter) await formatter(e.model);
  const content = e.model.getValue(monaco.editor.EndOfLinePreference.LF);
  const res = await api.writeFile(e.path, content, { eol: e.eol, bom: e.bom });
  e.mtime = res?.mtime;
  e.lastSavedContent = e.model.getValue();
  markSaved(key);
  return true;
}

/** Re-keys an untitled model to a real file path after "Save As". */
export function rekeyUntitled(key, path) {
  const e = entries.get(key);
  if (!e) return null;
  const content = e.model.getValue();
  e.disposeListener?.dispose();
  e.model.dispose();
  entries.delete(key);
  const uri = monaco.Uri.file(path);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(content, languageForPath(path), uri);
  const entry = { model, savedVersion: model.getAlternativeVersionId(), eol: 'LF', bom: false, viewState: null, path };
  attach(path, entry);
  return entry;
}

/**
 * Applies a disk change to an open model. The edit is pushed onto the undo stack so
 * agent edits can be undone with Ctrl+Z in the editor too.
 */
export function applyDiskContent(path, content) {
  const e = entries.get(path);
  if (!e || content == null) return false;
  const model = e.model;
  const normalized = content.replace(/\r\n/g, '\n');
  if (model.getValue(monaco.editor.EndOfLinePreference.LF) === normalized) {
    if (isDirty(path)) markSaved(path);
    return false;
  }
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  model.pushStackElement();
  markSaved(path);
  return true;
}

export async function reloadFromDisk(path, { force = false } = {}) {
  const e = entries.get(path);
  if (!e) return false;
  if (!force && isDirty(path)) return false;
  try {
    const res = await api.readFile(path);
    if (res.kind !== 'text') return false;
    return applyDiskContent(path, res.content);
  } catch {
    return false;
  }
}

export function disposeModel(key) {
  const e = entries.get(key);
  if (!e) return;
  e.disposeListener?.dispose();
  e.model.dispose();
  entries.delete(key);
}

export function renameModelPath(oldPath, newPath) {
  const e = entries.get(oldPath);
  if (!e) return;
  const content = e.model.getValue();
  const dirty = isDirty(oldPath);
  const viewState = e.viewState;
  disposeModel(oldPath);
  const uri = monaco.Uri.file(newPath);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(content, languageForPath(newPath), uri);
  const entry = { model, savedVersion: dirty ? -1 : model.getAlternativeVersionId(), eol: e.eol, bom: e.bom, viewState, path: newPath };
  attach(newPath, entry);
}

export function titleFor(key) {
  const e = entries.get(key);
  if (e?.path) return basename(e.path);
  return key;
}
